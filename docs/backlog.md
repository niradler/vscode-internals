# Backlog

Tracks gaps in the exposed VSCode surface and rough priority. Ordered roughly by leverage.
Evidence behind these items comes from live `/commands/list`, `/extensions/list`,
`/extensions/apis`, `/env/info` probes against a running instance — not from speculation.

## Tier 1 — high leverage, simple to add

- [x] **`/lm/*`** — `vscode.lm` Language Model API. List models, send requests (non-streaming and SSE-streamed), count tokens. Public API since 1.90. Unlocks Copilot / Claude / GPT for any local caller via the user's existing subscription.
- [x] **`onDidChangeDiagnostics` SSE event** — wraps `vscode.languages.onDidChangeDiagnostics`. Closes the biggest gap in the diagnostics-driven autofix loop.
- [x] **More SSE events** — `onDidChangeTabs`, `onDidChangeActiveTerminal`, `onDidChangeActiveColorTheme`, `onDidCreateFiles`, `onDidDeleteFiles`, `onDidRenameFiles`, `onDidChangeActiveDebugSession`, `onDidOpenNotebookDocument`, `onDidChangeNotebookDocument`, `onDidChangeExtensions` — all wired in [../src/events.ts](../src/events.ts).
- [x] **`onDidReceiveDebugSessionCustomEvent` SSE event** — DAP-level events from the debug adapter (`stopped`, `continued`, `output`, `breakpoint`, `thread`). Closes the autonomous-debugging loop: step → wait for `stopped` → inspect → step.
- [x] **`GET /events/wait`** — long-poll with server-side `filter` and `match=first|all`. Agent-friendly bridge over the same EventBus as `/events` — fits turn-based loops without holding an SSE connection.
- [ ] **`/files/watch`** — wrap `workspace.createFileSystemWatcher` as a glob-scoped SSE source. Lets agents watch arbitrary patterns without polling `findFiles`.
- [ ] **`/languages/diagnostics/push`** — wrap `languages.createDiagnosticCollection`. Lets external agents put their own findings into the VSCode Problems panel.
- [ ] ~~Enable `tunnels` proposed API~~ — **Skipped.** `enabledApiProposals` blocks marketplace publishing. `/env/tunnels` and `/env/openTunnel` remain feature-detected and return `{supported:false}` on marketplace builds; `asExternalUri` covers the common case.

## Tier 2 — useful, slightly more design

- [ ] **`/window/withProgress`** — show a progress notification while an external job runs; agent reports increments via repeated calls. Only worth shipping with the `CancellationToken` exposed via SSE/long-poll — otherwise it's a vanity feature.
- [x] **`/window/insertSnippet`** — `TextEditor.insertSnippet` with `$1` tab stops, `${1:default}` placeholders, `${1|a,b,c|}` choice lists, `$0` final cursor. Multi-cursor via `location` array. Pattern A (ad-hoc) shipped; Pattern B (persistent named snippets) documented via `/workspace/fs/writeFile` + `/commands/execute editor.action.insertSnippet`.
- [ ] **Env getters** — `/env/logLevel`, `/env/onDidChangeLogLevel` (SSE). The others (`shell`, `machineId`, `sessionId`) are already exposed via `/env/info`.
- [ ] **`/extensions/invokeApi`** — call richer extension APIs that need named methods (e.g. `copilot-chat.getAPI()` exports). The current `/extensions/invoke` works for flat functions but not the wrapped API objects exported by some extensions.
- [x] **`/notebooks/openNotebookDocument` / `showNotebookDocument`** — open + show shipped. Cell mutation (`replaceCells`, `setCellOutput`) still open.
- [ ] **`/tabs/move`** — currently we have close but not move; tab reordering is useful for window layouts.
- [ ] **`/commands/describe`** — best-effort schema for a command's arguments (so agents stop guessing — e.g. `chat.openSessionWithPrompt.claude-code` requires a URI, not a string).
- [ ] **`/tasks/runShell`** — ad-hoc shell task via `ShellExecution` so agents can run commands as real VSCode tasks (Terminal panel + problem-matchers + lifecycle) without editing `tasks.json`. Pair with shell-integration-based output capture so the agent can read what the task printed.

## Tier 3 — needs session-scoped state (callbacks via SSE), bigger lift

- [ ] **`/webview/create`** + `postMessage` + receive — agent-driven UI panels. Returns a session id; messages flow over SSE.
- [ ] **`/commands/register`** — let an agent register a command that fires an SSE event when invoked from VSCode UI. Closes the loop in both directions (agent → VSCode and VSCode → agent).
- [ ] **`/tests/controllers`** — structured test results from the TestController API. The other big gap from the dev-cycle evidence pass (current `/tests/*` only triggers runs; you can't read per-test pass/fail/duration/stack).
- [ ] **`/comments`** — comment threads, useful for code-review agents.
- [ ] **Chat-response readback** — chat commands are fire-and-forget today. Either wrap `copilot-chat.getAPI()` via `/extensions/invokeApi` (needs the extension to actually return a usable API) or fall back to `debug.exportPromptLogsAsJson` → `workspace/readFile`.

## Dev / infra

- [x] **`VSCODE_INTERNALS_PORT` / `VSCODE_INTERNALS_HOST` env vars** — precede workspace settings so the dev host can coexist with a marketplace install on the default port. Wired into [.vscode/launch.json](../.vscode/launch.json) (dev host binds 7892).

## Explicitly skipping

- **`languages.registerXxxProvider`** (custom hover/completion/etc.) — needs us to host the provider; complexity not worth it vs. LSP-via-commands we already use (`vscode.executeXxxProvider`).
- **`chat.registerChatParticipant`** — same reason; participants must be extensions, not HTTP callers.
- **`registerFileSystemProvider`, `registerTextDocumentContentProvider`** — same; virtual filesystems require the extension to be the host.
- **`registerDebugAdapterDescriptorFactory`** — same; debug adapters must be extensions.
