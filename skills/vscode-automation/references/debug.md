# Debug

Discover `launch.json` configurations, start sessions, manage breakpoints, drive the active session via DAP custom requests, watch session lifecycle via SSE.

Assumes `BASE=http://127.0.0.1:7891` and `TOKEN=vscint_…`.

## Discover launch.json before starting

There's no dedicated launch-configs endpoint — read it as a workspace configuration section:

```bash
vsc "$BASE/workspace/configuration?section=launch"
# Returns:
# {
#   "section":"launch",
#   "value":{"version":"0.2.0","configurations":[ {name,type,request,...}, ... ],"compounds":[...] },
#   "inspect":{...}    // who set what (global vs workspace)
# }
```

## Start a debug session

```bash
# Start by name (matches against launch.json `configurations[].name` or `compounds[].name`)
vsc -d '{"nameOrConfig":"Run Extension"}' $BASE/debug/start

# Start with an inline DebugConfiguration (no launch.json needed)
vsc -d '{"nameOrConfig":{
  "type":"node","request":"launch","name":"ad-hoc",
  "program":"${workspaceFolder}/src/index.ts",
  "outFiles":["${workspaceFolder}/out/**/*.js"]
}}' $BASE/debug/start

# Run without debugger (skips breakpoints; just launches)
vsc -d '{"nameOrConfig":"Run Extension","noDebug":true}' $BASE/debug/start

# Target a specific folder in a multi-root workspace
vsc -d '{"nameOrConfig":"Run Extension","workspaceFolderUri":"file:///g:/p/api"}' $BASE/debug/start

# Stop active session (or pass sessionId)
vsc -d '{}' $BASE/debug/stop
```

`preLaunchTask` in the config is honored — VSCode runs it before the session, same as `F5`. To observe the session start/stop, subscribe to events (see below).

## Active session

```bash
vsc $BASE/debug/activeSession
# → { id, name, type, configuration } | null
```

## Breakpoints

```bash
# List all current breakpoints
vsc $BASE/debug/breakpoints

# Add a source breakpoint (line is 0-indexed)
vsc -d '{"uri":"file:///g:/p/server.ts","line":42}' $BASE/debug/addBreakpoint

# Conditional breakpoint
vsc -d '{"uri":"...","line":42,"condition":"req.userId == null"}' $BASE/debug/addBreakpoint

# Hit-count
vsc -d '{"uri":"...","line":42,"hitCondition":"5"}' $BASE/debug/addBreakpoint

# Logpoint (no stop; just logs a message at runtime, expressions in {})
vsc -d '{"uri":"...","line":42,"logMessage":"x={x} ts={Date.now()}"}' $BASE/debug/addBreakpoint

# Remove by id
vsc -d '{"ids":["<bp-id>"]}' $BASE/debug/removeBreakpoints
```

## Drive the session via DAP

`/debug/customRequest` sends any DAP request to the active session (or pass `sessionId`). The full DAP spec applies: <https://microsoft.github.io/debug-adapter-protocol/specification>.

```bash
# Threads + stack
vsc -d '{"command":"threads"}'                                    $BASE/debug/customRequest
vsc -d '{"command":"stackTrace","args":{"threadId":1}}'          $BASE/debug/customRequest

# Scopes for a frame (use frameId from stackTrace response)
vsc -d '{"command":"scopes","args":{"frameId":1000}}'            $BASE/debug/customRequest

# Variables in a scope
vsc -d '{"command":"variables","args":{"variablesReference":5}}' $BASE/debug/customRequest

# Evaluate an expression in a frame
vsc -d '{"command":"evaluate","args":{"frameId":1000,"expression":"req.body","context":"watch"}}' \
  $BASE/debug/customRequest

# Stepping
vsc -d '{"command":"continue","args":{"threadId":1}}'            $BASE/debug/customRequest
vsc -d '{"command":"next","args":{"threadId":1}}'                $BASE/debug/customRequest  # step over
vsc -d '{"command":"stepIn","args":{"threadId":1}}'              $BASE/debug/customRequest
vsc -d '{"command":"stepOut","args":{"threadId":1}}'             $BASE/debug/customRequest
vsc -d '{"command":"pause","args":{"threadId":1}}'               $BASE/debug/customRequest
```

## Watch debug events (SSE)

Subscribe before calling `/debug/start` so you don't miss the session-start event.

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  "$BASE/events?subscribe=onDidStartDebugSession,onDidTerminateDebugSession,onDidChangeActiveDebugSession,onDidChangeBreakpoints,onDebugAdapterEvent"
```

Session-lifecycle events (`onDidStart/Terminate/ChangeActiveDebugSession`, `onDidChangeBreakpoints`) tell you *when* a session begins/ends or breakpoints change. They do NOT tell you when the program halts at a breakpoint.

`onDebugAdapterEvent` forwards **every standard DAP `event` message** from the adapter — `stopped`, `continued`, `terminated`, `output`, `breakpoint`, `thread`, `module`, `loadedSource`, … This is the only way to learn the program actually halted at a breakpoint or after a step (the response to a step request is just an ack, not a halt notification).

Payload shape: `{ sessionId, sessionType, sessionName, event, body }`. The `body` is the raw DAP event body (see <https://microsoft.github.io/debug-adapter-protocol/specification#Events>).

> `onDidReceiveDebugSessionCustomEvent` is for adapter-defined **custom** events only — standard DAP events (`stopped`, `continued`, …) are intercepted by VSCode and not delivered through that hook. Use `onDebugAdapterEvent` for those.

## Autonomous step loop (long-poll, agent-friendly)

For turn-based agents that can't hold an SSE connection across tool calls. The pattern: fire a DAP request, then block on `/events/wait` until the adapter emits the event you care about. `onDebugAdapterEvent` is registered eagerly at activation, so trackers attach to sessions before you've subscribed — you can't miss events.

```bash
# 1. Step over
vsc -d '{"command":"next","args":{"threadId":1}}' $BASE/debug/customRequest

# 2. Block until the next 'stopped' event (or 10s timeout). Server-side filter, no agent post-filter.
FILTER=$(printf '%s' '{"event":"stopped"}' | jq -sRr @uri)
vsc "$BASE/events/wait?subscribe=onDebugAdapterEvent&filter=$FILTER&timeoutMs=10000"
# → { eventName, payload:{ sessionId, sessionType, event:"stopped", body:{ reason, threadId, allThreadsStopped, ... } }, waitedMs }

# 3. Now read state — frameId/variablesReference are fresh
vsc -d '{"command":"stackTrace","args":{"threadId":1}}' $BASE/debug/customRequest
```

A timeout (`{timeout:true}`) means no event arrived — either the program is still running (call `pause` or wait again), or it already exited (check `/debug/activeSession`). See [events.md](events.md) for the full `/events/wait` reference.

## Launch + first-stop pattern

The full "I want to drive a program to its first breakpoint" loop, with no sleeps:

```bash
# Set the breakpoint
vsc -d '{"uri":"file:///path/to/file.js","line":42}' $BASE/debug/addBreakpoint

# In one terminal: subscribe to the first stopped event
FILTER=$(printf '%s' '{"event":"stopped"}' | jq -sRr @uri)
vsc "$BASE/events/wait?subscribe=onDebugAdapterEvent&filter=$FILTER&match=first&timeoutMs=20000" &
WAIT_PID=$!

# In another: launch the session (you can do this seconds later; tracker is already armed)
vsc -d '{"nameOrConfig":{"type":"node","request":"launch","name":"x","program":"/path/to/file.js"}}' \
  $BASE/debug/start

wait $WAIT_PID    # returns the moment the breakpoint hits
```

Measured end-to-end on a tiny node script: ~600ms from `/debug/start` to "stopped at BP" payload in hand. Subsequent steps (`next`, `stepIn`, `stepOut`) each return in 10–30ms.

## Composition patterns

**Pick a launch config and run.**

```text
GET  /workspace/configuration?section=launch
POST /window/showQuickPick { items: configs[].name + compounds[].name }
POST /debug/start { nameOrConfig: picked }
```

**Debug-state to LLM.** Stop at a breakpoint, dump everything DAP exposes, hand to a chat model for explanation.

```text
GET  /debug/activeSession
POST /debug/customRequest threads → stackTrace → for each frame: scopes → variables
POST /lm/sendRequestStream  selector:claude-sonnet-4.6
  messages: ["Explain this program state at a breakpoint", <stringified dump>]
POST /window/outputChannel/append → stream chunks live
```

**Reproduce-then-inspect loop.**

```text
POST /debug/addBreakpoint { condition: "...user-supplied..." }
POST /debug/start { nameOrConfig: "..." }
# subscribe onDidStartDebugSession; on first hit:
POST /debug/customRequest evaluate / variables
POST /window/showInformationMessage { items: ["Continue","Step over","Stop"] }
```

## Full human-like debug loop

End-to-end: write a target → set a breakpoint → launch → hit → inspect locals → step in → step over → evaluate an expression → continue → exit. All event-driven, no sleeps. Measured ~1.2s for the whole sequence on a tiny node script.

```text
1. POST /debug/addBreakpoint { uri, line }                # 0-indexed line
2. /events/wait subscribe=onDebugAdapterEvent filter={"event":"stopped"} &   # background
3. POST /debug/start { nameOrConfig: <inline cfg or name> }
4. Receive (2) → payload.body.threadId (or fall back to /debug/customRequest{threads})
5. customRequest stackTrace → scopes → variables          # inspect at BP
6. /events/wait ... filter={"event":"stopped"} & ; customRequest stepIn ; await    # step in
7. customRequest stackTrace → scopes → variables          # inspect again
8. customRequest evaluate { frameId, expression }         # watch-style eval
9. /events/wait ... filter={"event":"terminated"} & ; customRequest continue ; await
10. removeBreakpoints { ids: [bpId] }
```

Each step except (3) and (10) returns in tens of ms. Step (3) is bounded by adapter+process startup (~500–700ms for node).

## Gotchas

- `customRequest` only works against the active session unless you pass `sessionId`. VSCode doesn't expose a session registry — for non-active sessions, only the one you launched is reliably reachable.
- `frameId` and `variablesReference` are session-scoped and short-lived — they invalidate when the session continues. Fetch them fresh per stop.
- **threadId in `stopped` payloads can be `0` / missing** when the adapter signals `allThreadsStopped` or only has one thread. Always fall back: if `payload.body.threadId` isn't a positive integer, call `customRequest{command:"threads"}` and use `result.threads[0].id`.
- **js-debug spawns a parent + child session.** `/debug/start` returns the parent's id; the real DAP traffic flows through the child. `onDebugAdapterEvent.sessionType === "pwa-node"` (or `"pwa-chrome"`, etc.) marks the child. If you need to scope a filter, filter on `sessionType` rather than the parent id from `/debug/start`'s response.
- Logpoints don't pause; great for adding instrumentation without restarts.
- After modifying breakpoints, the change applies immediately to live sessions if the debug adapter supports `breakpointLocations`.
- `noDebug:true` skips the debug adapter entirely — useful for "just run this config" without stepping. Tasks-with-problem-matchers may be cleaner for that.
- Do not subscribe to `onDebugAdapterEvent` and then unsubscribe before launching — that works for this source (it's eagerly registered) but it's a footgun to rely on. Keep one subscription alive across the whole sequence with `match=first` (returns then re-arm) or use SSE if you need a continuous stream.
