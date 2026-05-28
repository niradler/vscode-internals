# Backlog

Tracks gaps in the exposed VSCode surface and rough priority. Ordered roughly by leverage.
Evidence behind these items comes from live `/commands/list`, `/extensions/list`,
`/extensions/apis`, `/env/info` probes against a running instance — not from speculation.

## Tier 1 — high leverage, simple to add

- [x] **`/lm/*`** — `vscode.lm` Language Model API. List models, send requests (non-streaming and SSE-streamed), count tokens. Public API since 1.90. Unlocks Copilot / Claude / GPT for any local caller via the user's existing subscription.
- [ ] **`onDidChangeDiagnostics` SSE event** — wrap `vscode.languages.onDidChangeDiagnostics`. Closes the biggest gap in the diagnostics-driven autofix loop (currently must poll).
- [ ] **More SSE events** — `onDidChangeTabs`, `onDidChangeActiveTerminal`, `onDidChangeActiveColorTheme`, `onDidCreateFiles`, `onDidDeleteFiles`, `onDidRenameFiles`, `onDidChangeActiveDebugSession`, `onDidOpenNotebookDocument`, `onDidChangeNotebookDocument`, `onDidChange(Active)Extensions`.
- [ ] **`/files/watch`** — wrap `workspace.createFileSystemWatcher` as a glob-scoped SSE source. Lets agents watch arbitrary patterns without polling `findFiles`.
- [ ] **`/languages/diagnostics/push`** — wrap `languages.createDiagnosticCollection`. Lets external agents put their own findings into the VSCode Problems panel.
- [ ] **Enable `tunnels` proposed API** — add `"enabledApiProposals": ["tunnels"]` to package.json and launch with `--enable-proposed-api niradler.vscode-internals`. Fixes `/env/tunnels` and `/env/openTunnel` (currently 500 — proposed-API error, not a remote-context issue).

## Tier 2 — useful, slightly more design

- [ ] **`/window/withProgress`** — show a progress notification while an external job runs; agent reports increments via repeated calls.
- [ ] **`/editor/insertSnippet`** — snippet expansion with `$1` tab stops (current `/workspace/applyEdit` can't do this).
- [ ] **Env getters** — `/env/shell`, `/env/machineId`, `/env/sessionId`, `/env/logLevel`, `/env/onDidChangeLogLevel` (SSE).
- [ ] **`/extensions/invokeApi`** — call richer extension APIs that need named methods (e.g. `copilot-chat.getAPI()` exports). The current `/extensions/invoke` works for flat functions but not the wrapped API objects exported by some extensions.
- [ ] **`/notebooks/openNotebookDocument` / `showNotebookDocument`** + cell mutation (`replaceCells`, `setCellOutput`).
- [ ] **`/tabs/move`** — currently we have close but not move; tab reordering is useful for window layouts.
- [ ] **`/commands/describe`** — best-effort schema for a command's arguments (so agents stop guessing — e.g. `chat.openSessionWithPrompt.claude-code` requires a URI, not a string).

## Tier 3 — needs session-scoped state (callbacks via SSE), bigger lift

- [ ] **`/webview/create`** + `postMessage` + receive — agent-driven UI panels. Returns a session id; messages flow over SSE.
- [ ] **`/commands/register`** — let an agent register a command that fires an SSE event when invoked from VSCode UI. Closes the loop in both directions (agent → VSCode and VSCode → agent).
- [ ] **`/tests/controllers`** — structured test results from the TestController API. The other big gap from the dev-cycle evidence pass (current `/tests/*` only triggers runs; you can't read per-test pass/fail/duration/stack).
- [ ] **`/comments`** — comment threads, useful for code-review agents.
- [ ] **Chat-response readback** — chat commands are fire-and-forget today. Either wrap `copilot-chat.getAPI()` via `/extensions/invokeApi` (needs the extension to actually return a usable API) or fall back to `debug.exportPromptLogsAsJson` → `workspace/readFile`.

## Explicitly skipping

- **`languages.registerXxxProvider`** (custom hover/completion/etc.) — needs us to host the provider; complexity not worth it vs. LSP-via-commands we already use (`vscode.executeXxxProvider`).
- **`chat.registerChatParticipant`** — same reason; participants must be extensions, not HTTP callers.
- **`registerFileSystemProvider`, `registerTextDocumentContentProvider`** — same; virtual filesystems require the extension to be the host.
- **`registerDebugAdapterDescriptorFactory`** — same; debug adapters must be extensions.

## Notes from evidence passes

Three exploration agents (port/tunnel, prompt-files/chat, dev-cycle) confirmed:
- `/ports/forward` is passthrough on Desktop (`external === local`) but auto-upgrades in Remote-SSH/Codespaces. Still useful as a canonical URI emitter.
- `/ports/showPanel` works via `workbench.view.remote` fallback even though `~remote.forwardedPortsContainer.focus` isn't in some builds.
- 180+ `workbench.action.chat.*` commands are reachable via `/commands/execute` — chat is push-only today (can fire prompts, can't read responses).
- Configured prompt-file locations live in `chat.promptFilesLocations`, `chat.modeFilesLocations`, `chat.instructionsFilesLocations`. The relevant commands are `chat.run.prompt`, `chat.save-as-prompt`, `chat.configure.prompts`, `workbench.command.new.untitled.prompt`.
- 84 `testing.*` commands reachable including `testing.runAll`, `testing.reRunFailedFromLastRun`, `testing.coverageAll`.
- `/languages/diagnostics {}` returns workspace-wide LSP findings — fast because the language servers are already warm.
- `/extensions/invoke` against `vscode.git` works for real git operations (branch, stash, blame).
