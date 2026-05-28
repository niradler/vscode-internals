# Events (SSE + long-poll)

React to user activity (saves, selection changes, diagnostics, debug sessions, tabs, file changes) instead of polling. Two access patterns over the same event bus:

- **`/events`** — Server-Sent Events; connection stays open, server pushes. Good for shell pipelines and persistent stream consumers.
- **`/events/wait`** — long-poll: single blocking request that returns on first matching event (or timeout). **Good for turn-based agent loops** that can't hold a stream open across tool calls.

Assumes `BASE=http://127.0.0.1:7891` and `TOKEN=vscint_…`.

## Connect

```bash
# Authoritative list of subscribable events on this build
vsc $BASE/events/available
# → { events: ["onDidSaveTextDocument", "onDidChangeDiagnostics", ...] }

# Subscribe to one or more events. The connection stays open until you close it.
vsc -N "$BASE/events?subscribe=onDidSaveTextDocument,onDidChangeActiveTextEditor"
```

`/events/available` typically returns 30+ events spanning editor, tabs/window, files, languages (diagnostics), debug (sessions + breakpoints), notebooks, tasks, terminals, extensions/LM, and config.

## Wire format

Standard SSE: `event: <name>\n` then `data: <json>\n\n`.

- First frame is always `event: ready` (no `data`) — handshake complete.
- Heartbeat every 25 seconds as a `: <comment>` line you can ignore.
- One event can fan in: e.g. `onDidChangeDiagnostics` payload is `{ uris: [Uri, ...] }`, multiple files at once.

Example wire:

```text
event: ready
data:

event: onDidSaveTextDocument
data: {"uri":{"scheme":"file","path":"/g/p/x.ts","toString":"file:///g:/p/x.ts","fsPath":"g:/p/x.ts"},"languageId":"typescript","version":42,"isDirty":false}

: keepalive
```

## Common events by category

Always re-check `/events/available` — this is a snapshot.

**Editor**: `onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection`, `onDidChangeTextEditorVisibleRanges`, `onDidChangeVisibleTextEditors`, `onDidOpenTextDocument`, `onDidCloseTextDocument`, `onDidSaveTextDocument`, `onDidChangeTextDocument`

**Tabs / window**: `onDidChangeTabs`, `onDidChangeTabGroups`, `onDidChangeActiveTerminal`, `onDidChangeActiveColorTheme`, `onDidChangeWindowState`

**Files**: `onDidCreateFiles`, `onDidDeleteFiles`, `onDidRenameFiles`, `onDidChangeWorkspaceFolders`

**Languages**: `onDidChangeDiagnostics` — `data: { uris: [Uri, ...] }`

**Debug**: `onDidStartDebugSession`, `onDidTerminateDebugSession`, `onDidChangeActiveDebugSession`, `onDidChangeBreakpoints`, `onDidReceiveDebugSessionCustomEvent` (DAP-level: `stopped`, `continued`, `output`, `breakpoint`, `thread`, …)

**Notebooks**: `onDidOpenNotebookDocument`, `onDidCloseNotebookDocument`, `onDidChangeNotebookDocument`

**Tasks / terminals**: `onDidStartTask`, `onDidEndTask`, `onDidEndTaskProcess`, `onDidOpenTerminal`, `onDidCloseTerminal`

**Config / extensions / LM**: `onDidChangeConfiguration`, `onDidChangeExtensions`, `onDidChangeChatModels`

## Reading the stream (bash)

```bash
vsc -N "$BASE/events?subscribe=onDidSaveTextDocument,onDidChangeDiagnostics" |
while IFS= read -r LINE; do
  case "$LINE" in
    "event: "*)
      EVT="${LINE#event: }"
      ;;
    "data: "*)
      PAYLOAD="${LINE#data: }"
      case "$EVT" in
        onDidSaveTextDocument)
          URI=$(echo "$PAYLOAD" | jq -r '.uri.toString')
          # ... act on save
          ;;
        onDidChangeDiagnostics)
          # PAYLOAD is { uris: [Uri,...] }
          # ... fetch /languages/diagnostics per uri
          ;;
      esac
      ;;
  esac
done
```

## Reading the stream (PowerShell)

```powershell
curl.exe -N -H "Authorization: Bearer $env:TOKEN" `
  "$env:BASE/events?subscribe=onDidSaveTextDocument" |
  ForEach-Object {
    if ($_ -like 'event: *') { $script:evt = $_.Substring(7) }
    elseif ($_ -like 'data: *') {
      $payload = $_.Substring(6) | ConvertFrom-Json
      switch ($script:evt) {
        'onDidSaveTextDocument' { Write-Host "saved: $($payload.uri.fsPath)" }
      }
    }
  }
```

## Long-poll: `/events/wait` for agent loops

Same event bus as `/events`, different access pattern. One blocking request per event you're waiting for — no held SSE connection in the agent's tool surface.

```bash
# Wait up to 10s for any matching event; returns the first one.
vsc "$BASE/events/wait?subscribe=onDidSaveTextDocument&timeoutMs=10000"
# → 200 { eventName, payload, waitedMs }      on match
# → 200 { timeout: true, waitedMs }           on timeout
```

Query params:

- `subscribe=name1,name2` — event names (required)
- `filter=<json>` — optional **shallow-equality filter** on the payload, URL-encoded JSON. The server only returns events where every key in `filter` equals the same key on `payload`. Saves an agent post-filter pass.
- `match=first` (default) — return on the first matching event (200 JSON)
- `match=all` — stream all matching events over SSE until timeout, then close
- `timeoutMs` — `1000`–`300000`, default `30000`

Pattern: agent stepping a debug session and waiting for the next stop.

```bash
# Fire the step
vsc -d '{"command":"next","args":{"threadId":1}}' $BASE/debug/customRequest

# Block until the adapter emits a 'stopped' DAP event (or 10s timeout)
FILTER=$(printf '%s' '{"event":"stopped"}' | jq -sRr @uri)
vsc "$BASE/events/wait?subscribe=onDidReceiveDebugSessionCustomEvent&filter=$FILTER&timeoutMs=10000"
```

The server-side filter is shallow: `filter={"event":"stopped","sessionId":"abc"}` matches when `payload.event === "stopped"` AND `payload.sessionId === "abc"`. No deep paths, no regex, no negation — keep filters simple.

**Gotcha — past events aren't replayed.** `/events/wait` only sees events that arrive *during* the wait. If you need "what happened since I last checked", build a counter on your side via SSE or poll an aggregate endpoint like `/languages/diagnostics`.

## Patterns

**Save-then-lint.**

```text
SUBSCRIBE onDidSaveTextDocument
  POST /languages/diagnostics { uri }
  POST /window/setStatusBarMessage { text: "$(check) 0 errors" | "$(error) N errors" }
```

**Diagnostics-driven autofix.**

```text
SUBSCRIBE onDidChangeDiagnostics
  for each uri in payload.uris:
    POST /languages/diagnostics { uri }
    for each diagnostic:
      POST /languages/codeActions { uri, range, only:"quickfix" }
      if action has inline edit → POST /workspace/applyEdit
      else if command → POST /commands/execute
```

Debounce per URI — diagnostics fire on every keystroke.

**Debug session lifecycle.**

```text
SUBSCRIBE onDidStartDebugSession,onDidTerminateDebugSession
  on start: open output channel "Debug Trace", begin polling stack via customRequest
  on terminate: append final state, close channel or summarize
```

**Live tab tracker.**

```text
SUBSCRIBE onDidChangeTabs,onDidChangeTabGroups
  re-render a model of what's open; surface stale/dirty/diff tabs to the user
```

## Gotchas

- The connection has no built-in reconnect — if VSCode reloads or your client drops, you must re-subscribe.
- 25-second heartbeats keep the connection alive through stateful proxies but appear as `: <comment>` lines you must skip.
- Some events fire very frequently (`onDidChangeTextDocument` on every keystroke, `onDidChangeTextEditorSelection` on every caret move). Filter or debounce before acting.
- `onDidChangeDiagnostics` is fan-in: one event can list many URIs. Don't assume one event = one diagnostic.
- Subscribing to an event name that isn't in `/events/available` is silent — verify first.
- The first `ready` frame has no `data` line — your parser must tolerate empty data.
