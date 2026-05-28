---
name: vscode-automation
description: Drive the user's running VSCode editor through a local REST API exposed by the niradler.vscode-internals extension on http://127.0.0.1:7891. Use whenever the user refers to "my editor", "the file I have open", "the active file", "my selection", "my workspace", "go to definition", "find references", "run the task", "run my tests", "the debug session", "the terminal in VSCode", or anything else that reads or mutates live VSCode state instead of just operating on files on disk. Prefer this skill over plain file reads/edits when the user is clearly working inside VSCode and the action depends on editor state (selection, open document, language services, tasks, debug, SCM, terminals, notebooks). Also use for inter-extension RPC (/extensions/invoke), calling Copilot/Claude/GPT chat models via /lm/* (vscode.lm API), and watching editor events via SSE.
---

# VSCode Automation

## What this enables

Talk to a running VSCode through a token-protected HTTP service. The extension `niradler.vscode-internals` exposes the full `vscode.*` API as ~115+ REST endpoints across 14 tags (workspace, window, tabs, languages, commands, debug, tasks, scm, tests, notebooks, env, ports, authentication, extensions), plus an SSE event stream and a live OpenAPI 3.1 spec. You can read editor state (active file, selection, tabs, diagnostics), search and edit files, drive language services (hover/definition/references/rename), run tasks/tests/debug sessions, control terminals, manage tab groups, write to output channels, read git status, forward local ports, invoke other extensions' exported APIs, and execute any command in the command palette — all without writing a one-off extension.

## Setup check

Before doing anything else, confirm the server is up and that you have the bearer token.

```bash
curl -sS http://127.0.0.1:7891/health
```

Expected: `{"ok":true,...}`. If the request fails, the extension isn't running — ask the user to open VSCode and to confirm the `niradler.vscode-internals` extension is installed and active. Don't try to install or start it yourself.

To get the token:

- Ask the user, **or**
- Tell the user to run Command Palette → **VSCode Internals: Copy Token to Clipboard**, then read it from the clipboard with `/env/clipboard` (only works after the user has put it there) or have them paste it.

The token starts with `vscint_`. Every non-public request must send `Authorization: Bearer <token>`. Public endpoints (no auth) are: `GET /health`, `GET /openapi.json`, `GET /docs`, `GET /docs/assets/*`.

## Core workflow

1. Set base URL and token once: `BASE=http://127.0.0.1:7891` and `TOKEN=<vscint_…>`.
2. For any uncertain endpoint, fetch the live spec — it's the source of truth and grows at runtime as other extensions register their own endpoints:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/openapi.json | jq '.paths | keys'
```

3. If a call returns 404 even though you saw the path in docs, re-fetch `/openapi.json` before retrying. New routes (e.g. from `/extensions/invoke` or `/ports/*` namespaces) can appear at runtime.
4. Always include `Content-Type: application/json` on POSTs.

### PowerShell pattern

Windows PowerShell mangles inline `-d '{...}'` quoting. Pipe JSON in via a here-string and `--data-binary "@-"`:

```powershell
@'
{"include":"**/*.ts","maxResults":50}
'@ | curl.exe -sS -H "Authorization: Bearer $env:TOKEN" -H "Content-Type: application/json" --data-binary "@-" "$env:BASE/workspace/findFiles"
```

(Use `curl.exe`, not the PS `curl` alias which is `Invoke-WebRequest`.) On bash/zsh, plain `-d '{...}'` is fine.

## Common tasks

### See what the user is working on

```bash
# Active editor: file URI, selection, visible ranges, language, dirty state
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/window/activeTextEditor

# Just the selected text (falls back to full doc text if nothing is selected)
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/window/selectionText

# All visible editors (multi-pane layouts)
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/window/visibleTextEditors

# Workspace folders + name
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/workspace/folders
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/workspace/name

# Window focus / theme / env
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/window/state
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/env/info
```

### Search, read, edit files

```bash
# Glob search
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"include":"src/**/*.ts","exclude":"**/node_modules/**","maxResults":200}' \
  $BASE/workspace/findFiles

# Read file (utf8 default, base64 for binary)
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uri":"file:///g:/Projects/foo/src/index.ts"}' \
  $BASE/workspace/readFile

# Apply multi-file edits atomically
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"edits":[{"uri":"file:///g:/Projects/foo/a.ts","changes":[{"range":{"start":{"line":10,"character":0},"end":{"line":10,"character":5}},"newText":"const"}]}]}' \
  $BASE/workspace/applyEdit

# Save all dirty buffers
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"includeUntitled":false}' $BASE/workspace/saveAll

# Open and focus a file in the editor (jump to a range optional)
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uri":"file:///g:/Projects/foo/a.ts","selection":{"start":{"line":42,"character":0},"end":{"line":42,"character":10}}}' \
  $BASE/window/showTextDocument
```

Prefer `/workspace/applyEdit` over `/workspace/writeFile` for in-document edits — it goes through VSCode's edit pipeline so undo, dirty state, formatters, and language clients all see the change.

### Use language services

These return structured LSP results, not just navigation side-effects. Always pass a URI string (file path or `file://`) and a `{line, character}` position (0-indexed).

```bash
# Hover (types/docs at cursor)
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uri":"file:///g:/p/f.ts","position":{"line":42,"character":10}}' \
  $BASE/languages/hover

# Go-to-definition / type-definition / implementation
$BASE/languages/definition
$BASE/languages/typeDefinition
$BASE/languages/implementation

# References (call sites)
$BASE/languages/references

# Symbols
curl ... -d '{"uri":"file:///..."}'  $BASE/languages/documentSymbols
curl ... -d '{"query":"UserService"}' $BASE/languages/workspaceSymbols

# Diagnostics (errors/warnings) — omit uri for full-workspace
curl ... -d '{"uri":"file:///..."}'  $BASE/languages/diagnostics

# Rename a symbol — `apply:true` actually writes the edits
curl ... -d '{"uri":"file:///..","position":{"line":1,"character":4},"newName":"foo","apply":true}' \
  $BASE/languages/rename

# Format an entire document (apply:true to write)
curl ... -d '{"uri":"file:///..","apply":true}' $BASE/languages/formatDocument
```

Use `documentSymbols` to map a file's structure before reasoning about line numbers — symbol ranges are more stable than offsets across edits.

### Run tasks, tests, debug

```bash
# List discovered tasks (from tasks.json + task providers)
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/tasks/list

# Execute a task by name
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"build"}' $BASE/tasks/execute

# What's currently running, and how to stop it
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/tasks/executions
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"build"}' $BASE/tasks/terminate

# Tests (these bridge to the testing UI commands)
$BASE/tests/runAll   $BASE/tests/runCurrentFile   $BASE/tests/debugAll
$BASE/tests/refresh  $BASE/tests/cancelRun        $BASE/tests/showOutput

# Debug: see current session, start a named config, add a breakpoint, send DAP
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/debug/activeSession
curl ... -d '{"nameOrConfig":"Launch Server"}' $BASE/debug/start
curl ... -d '{"uri":"file:///..","line":42,"condition":"x > 0"}' $BASE/debug/addBreakpoint
curl ... -d '{"command":"stackTrace","args":{"threadId":1}}' $BASE/debug/customRequest
```

`/debug/customRequest` is the lever for stepping, variables, scopes — any DAP command. It only works on the active session unless you have a session ID.

### Control terminals

```bash
# List + create + send text
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/window/terminals
curl ... -d '{"name":"build","cwd":"g:/Projects/foo","show":true}' $BASE/window/createTerminal
curl ... -d '{"name":"build","text":"npm run build","addNewLine":true}' $BASE/window/terminalSendText
curl ... -d '{"name":"build"}' $BASE/window/terminalShow
curl ... -d '{"name":"build"}' $BASE/window/terminalDispose
```

Terminals do not return their output over the API — `terminalSendText` is fire-and-forget. To capture output, write to a file and read it back, or use a task whose `presentation` writes to the output channel.

### Read git status / SCM

```bash
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/scm/git/repositories
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{}' $BASE/scm/git/status
```

The data comes from the built-in git extension's public API. If that extension is disabled, you'll get `available: false`. For complex git ops, shell out via a terminal.

### Run any command in the palette

`/commands/execute` is the universal escape hatch — anything in the command palette is reachable.

```bash
# List & filter
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/commands/list?filter=workbench.action.files"

# Execute (positional args go in `args`)
curl ... -d '{"command":"workbench.action.files.save"}' $BASE/commands/execute
curl ... -d '{"command":"editor.action.formatDocument"}' $BASE/commands/execute
curl ... -d '{"command":"workbench.action.gotoLine","args":[]}' $BASE/commands/execute
```

Use this when no dedicated endpoint exists.

### Manage tabs

Tabs (`vscode.window.tabGroups`) include more than text editors — diff editors, webviews, custom editors, notebooks, terminals. Use these when the user says "close that tab", "close everything except…", "what's open?".

```bash
# All tab groups (editor columns) with their tabs
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/tabs/groups

# Flat list across all groups
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/tabs/list

# Close a tab by URI (matches across all groups), or by label, or by position
curl ... -d '{"uri":"file:///g:/p/x.ts"}' $BASE/tabs/close
curl ... -d '{"label":"x.ts","preserveFocus":true}' $BASE/tabs/close
curl ... -d '{"viewColumn":1,"index":0}' $BASE/tabs/close

# Close an entire group
curl ... -d '{"viewColumn":2}' $BASE/tabs/closeGroup
```

Each tab `input` has a `kind` discriminator (`text`, `diff`, `custom`, `webview`, `notebook`, `notebookDiff`, `terminal`) so you can filter before closing.

### Write to output channels

For long-form structured logs the user can read in the **Output** panel, prefer an output channel over notifications. Channels created via this API persist for the session.

```bash
curl ... -d '{"name":"My Tool","languageId":"log"}' $BASE/window/outputChannel/create
curl ... -d '{"name":"My Tool","text":"Starting analysis...","show":true}' $BASE/window/outputChannel/append
curl ... -d '{"name":"My Tool"}' $BASE/window/outputChannel/clear
```

### Forward a local port

```bash
# Get an externally reachable URI for a local dev server. In remote/codespaces/tunnel
# contexts this opens a real forward and shows it in the Ports panel; in Desktop it
# usually returns the same localhost URI.
curl ... -d '{"port":3000,"protocol":"http","label":"dev"}' $BASE/ports/forward
curl ... -d '{"port":3000}' $BASE/ports/stopForwarding
curl -X POST -H "Authorization: Bearer $TOKEN" $BASE/ports/showPanel

# /env/tunnels and /env/openTunnel are feature-detected (proposed API)
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/env/tunnels
```

### Interact with other extensions

```bash
# List active extensions that export a programmatic API, with key shapes
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/extensions/apis?activate=true"

# Call a method on another extension's exports. `path` is a dot-walk on the exports object.
# Returns { kind:'invoked', result: ... } or { kind:'value', value: ... }.
curl ... -d '{"id":"vscode.git","path":"getAPI","args":[1]}' $BASE/extensions/invoke
curl ... -d '{"id":"ms-python.python","path":"environments.getActiveEnvironmentPath"}' $BASE/extensions/invoke
```

Non-serializable return values (Disposables, EventEmitters, opaque class instances) come back as `{__type:'ClassName', ...}`. Use `/extensions/apis` first to discover what's safe to call.

Other extensions can also register their own custom endpoints under their own tag through the public `registerEndpoint` API; those appear in `/openapi.json` like any baseline route. **If a call you expected to work 404s, re-fetch the spec — the catalog can grow at runtime.**

### Call chat models (Copilot, Claude, GPT, ...)

`/lm/*` wraps `vscode.lm` (public since VSCode 1.90). The user gets one consent prompt on the first call; afterwards every chat model VSCode has access to is callable through the same bearer token.

```bash
# List every model VSCode currently sees (vendor, family, version, id, maxInputTokens)
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/lm/models

# Narrow by selector
curl ... -d '{"vendor":"copilot","family":"claude-haiku-4.5"}' $BASE/lm/selectChatModels

# Non-streaming: collect the whole response into one string
curl ... -d '{"selector":{"vendor":"copilot","family":"claude-haiku-4.5"},
              "messages":[{"role":"user","content":"reply with PONG"}]}' \
  $BASE/lm/sendRequest
# → { "model": {...}, "text": "PONG" }

# Streaming: SSE chunks as the model emits them
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary '{"selector":{"vendor":"copilot","family":"gpt-4o"},
                  "messages":[{"role":"user","content":"explain this codebase"}]}' \
  "$BASE/lm/sendRequestStream"
# event: model     → { id, vendor, family, ... }
# event: chunk     → { text: "..." }   (many)
# event: done      → { totalText, totalChars }
# event: error     → { message, code, name }

# Token-count a prompt before sending (each model has its own tokenizer)
curl ... -d '{"selector":{"family":"gpt-4o"},"text":"..."}' $BASE/lm/countTokens
```

`messages` is a chat history with `role: 'user' | 'assistant'`. `modelOptions` is passed through to `LanguageModelChatRequestOptions.modelOptions` (e.g. `{temperature: 0.2}`); `justification` is shown to the user in the consent prompt. If no model matches the selector, the call errors with the selector in the message so you can refine it.

Use this when you want the user's already-authenticated Copilot/Claude/GPT to do work for you from outside VSCode — code explanations, ad-hoc generation, summarization — without proxying through your own keys.

### Watch events (SSE)

```bash
# Subscribe to one or more events; the connection stays open
curl -N -H "Authorization: Bearer $TOKEN" \
  "$BASE/events?subscribe=onDidChangeActiveTextEditor,onDidSaveTextDocument"
```

Standard SSE format: `event: <name>\n` then `data: <json>\n\n`. A 25-second heartbeat keeps the connection alive. `GET /events/available` returns the live list — always check that for the source of truth. The current set spans:

- **Editor**: `onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection`, `onDidChangeVisibleTextEditors`, `onDidOpenTextDocument`, `onDidCloseTextDocument`, `onDidSaveTextDocument`, `onDidChangeTextDocument`
- **Tabs / window**: `onDidChangeTabs`, `onDidChangeTabGroups`, `onDidChangeActiveTerminal`, `onDidChangeActiveColorTheme`, `onDidChangeWindowState`
- **Files**: `onDidCreateFiles`, `onDidDeleteFiles`, `onDidRenameFiles`, `onDidChangeWorkspaceFolders`
- **Languages**: `onDidChangeDiagnostics` (data: `{ uris }`)
- **Debug**: `onDidStartDebugSession`, `onDidTerminateDebugSession`, `onDidChangeActiveDebugSession`
- **Notebooks**: `onDidOpenNotebookDocument`, `onDidCloseNotebookDocument`, `onDidChangeNotebookDocument`
- **Extensions / LM**: `onDidChangeExtensions`, `onDidChangeChatModels`
- **Tasks / terminals**: `onDidStartTask`, `onDidEndTask`, `onDidEndTaskProcess`, `onDidOpenTerminal`, `onDidCloseTerminal`
- **Config**: `onDidChangeConfiguration`, `onDidChangeBreakpoints`, `onDidChangeTextEditorVisibleRanges`

Use this when you need to react to user activity rather than polling — e.g. wait for `onDidSaveTextDocument`, then run a check; or watch `onDidChangeDiagnostics` for the diagnostics-autofix loop (see `references/recipes.md`).

## Notes on shapes and gotchas

- URIs accept either a URI string (`file:///g:/path/x.ts`) or a plain absolute path (`g:/path/x.ts`). Outbound URIs are objects: `{ scheme, authority, path, query, fragment, fsPath, toString }`. Use `.toString` or `.fsPath` to round-trip.
- Positions and ranges are 0-indexed: `{ line, character }` and `{ start, end }`.
- Selections add `{ anchor, active, isReversed, isEmpty }` on top of a range.
- `applyEdit` is atomic across files; `writeFile` bypasses the editor and won't trigger formatters or update open buffers.
- Diagnostics include `severity` as a string (`error`/`warning`/`information`/`hint`).

See `references/serialization.md` for full type shapes and inbound/outbound examples.

## References

- `references/endpoints.md` — complete endpoint catalog by tag with one-line summaries.
- `references/serialization.md` — vscode type ↔ JSON mapping (Uri, Position, Range, Selection, TextDocument, Diagnostic, Symbol, Hover, etc.).
- `references/recipes.md` — multi-step workflows (rename a symbol with confirmation; bulk-edit files matching a pattern; subscribe to events and react; structured test-then-debug).

Live OpenAPI: `GET /openapi.json`. Swagger UI: `http://127.0.0.1:7891/docs`. Project README: `g:/Projects/skills/vscode/vscode-internals/README.md`.
