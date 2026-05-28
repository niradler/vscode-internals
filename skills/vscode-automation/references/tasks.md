# Tasks & tests

Run tasks from `tasks.json` (and task providers), watch their lifecycle, run the testing UI.

Assumes `BASE=http://127.0.0.1:7891` and `TOKEN=vscint_…`.

## Tasks

```bash
# Discover tasks (from tasks.json + task providers like npm, gulp, etc.)
vsc $BASE/tasks/list
# → [ { name, source, definition, group, detail, scope }, ... ]

# Execute by name. First match wins.
vsc -d '{"name":"build"}' $BASE/tasks/execute

# Currently running
vsc $BASE/tasks/executions

# Terminate by name
vsc -d '{"name":"build"}' $BASE/tasks/terminate
```

The task itself doesn't return output over HTTP — capture it via the task's own `presentation` (terminal output, file, problem-matcher). To detect completion, subscribe to events:

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  "$BASE/events?subscribe=onDidStartTask,onDidEndTask,onDidEndTaskProcess"
```

`onDidEndTaskProcess` carries `{ exitCode }` — that's how you know if it succeeded.

## Tests (testing panel UI)

These bridge to the testing UI commands. Output appears in the test panel, not over the wire.

```bash
vsc -X POST $BASE/tests/runAll
vsc -X POST $BASE/tests/runCurrentFile
vsc -X POST $BASE/tests/debugAll
vsc -X POST $BASE/tests/refresh
vsc -X POST $BASE/tests/cancelRun
vsc -X POST $BASE/tests/showOutput
```

For programmatic test results, either:
- Run tests as a **task** (e.g. `npm test`) with a problem matcher and watch `onDidEndTaskProcess`.
- Subscribe to `onDidChangeDiagnostics` after the run — test failures often surface as diagnostics.
- Read the test runner's own output file if it writes JSON/junit XML.

## Composition patterns

**Build → test chain.**

```
POST /tasks/execute { name: "build" }
SUBSCRIBE onDidEndTaskProcess
  on { name:"build", exitCode:0 }:
    POST /tests/runAll
  on exitCode != 0:
    POST /window/showErrorMessage { message: "Build failed", items: ["Show output"] }
```

**Reactive test watcher.** Re-run tests on save, explain failures via LLM.

```
SUBSCRIBE onDidSaveTextDocument
  on save of *.test.ts:
    POST /tasks/execute { name: "test:current" }
SUBSCRIBE onDidEndTaskProcess
  if exitCode != 0:
    POST /languages/diagnostics { uri }
    POST /lm/sendRequestStream  # diagnostics + failing source → explanation
    POST /window/showInformationMessage { items: ["Apply fix","Show details","Ignore"] }
```

Debounce. `onDidSaveTextDocument` can fire repeatedly (auto-save); rate-limit per file path.

**Surface progress.**

```
POST /window/setStatusBarMessage { text: "$(loading~spin) Building…", hideAfterMs: 60000 }
# on finish, clear or replace:
POST /window/setStatusBarMessage { text: "$(check) Build green", hideAfterMs: 4000 }
```

## Gotchas

- `tasks/execute` matches by `name`. If two tasks share a name (e.g. `npm: build` from a provider vs `build` in tasks.json), the first found wins — disambiguate by inspecting `/tasks/list` and matching on `definition` or `source`.
- A task's `terminate` is best-effort; some long-running tasks ignore signals and need to be killed in their terminal.
- For tests with rich UI state (per-suite progress, per-assertion failures), inspecting the test runner's own JSON output beats screen-scraping `/tests/showOutput`.
- The testing endpoints work only if the user's project has a registered test provider (Vitest/Jest/PyTest/etc. extension installed). Without one, `runAll` is a no-op.
