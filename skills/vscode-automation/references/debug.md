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
  "$BASE/events?subscribe=onDidStartDebugSession,onDidTerminateDebugSession,onDidChangeActiveDebugSession,onDidChangeBreakpoints"
```

Beyond the session-lifecycle events, `onDidReceiveDebugSessionCustomEvent` carries the DAP-level events from the adapter itself — `stopped`, `continued`, `output`, `breakpoint`, `thread`, `module`. Payload shape: `{ sessionId, sessionType, event, body }`. This is what tells the agent the program *actually* halted after a step, not just that the step request was acknowledged.

## Autonomous step loop (long-poll, agent-friendly)

For turn-based agents that can't hold an SSE connection across tool calls. The pattern: fire a DAP request, then block on `/events/wait` until the adapter emits the event you care about.

```bash
# 1. Step over
vsc -d '{"command":"next","args":{"threadId":1}}' $BASE/debug/customRequest

# 2. Block until the next 'stopped' event (or 10s timeout). Server-side filter, no agent post-filter.
FILTER=$(printf '%s' '{"event":"stopped"}' | jq -sRr @uri)
vsc "$BASE/events/wait?subscribe=onDidReceiveDebugSessionCustomEvent&filter=$FILTER&timeoutMs=10000"
# → { eventName, payload: { sessionId, event:"stopped", body:{ reason, threadId, ... } }, waitedMs }

# 3. Now read state — frameId/variablesReference are fresh
vsc -d '{"command":"stackTrace","args":{"threadId":1}}' $BASE/debug/customRequest
```

A timeout (`{timeout:true}`) means the program is still running — call `pause` or wait again. See [events.md](events.md) for the full `/events/wait` reference.

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

## Gotchas

- `customRequest` only works against the active session unless you pass `sessionId`. VSCode doesn't expose a session registry — for non-active sessions, only the one you launched is reliably reachable.
- `frameId` and `variablesReference` are session-scoped and short-lived — they invalidate when the session continues. Fetch them fresh per stop.
- Logpoints don't pause; great for adding instrumentation without restarts.
- After modifying breakpoints, the change applies immediately to live sessions if the debug adapter supports `breakpointLocations`.
- `noDebug:true` skips the debug adapter entirely — useful for "just run this config" without stepping. Tasks-with-problem-matchers may be cleaner for that.
