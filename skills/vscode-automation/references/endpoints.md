# Endpoint Catalog

All paths are relative to `http://127.0.0.1:7891`. Every non-public endpoint requires `Authorization: Bearer <token>`. POST bodies are JSON. This catalog is the baseline shipped with `niradler.vscode-internals` — the live truth is `GET /openapi.json`, which can grow at runtime as other extensions register endpoints.

Note on the spec: `/openapi.json` enumerates only registry-tracked routes. The four public paths below (`/health`, `/openapi.json`, `/docs`, `/docs/assets/*`) and the `/events/*` SSE endpoints are wired directly into the HTTP server and do **not** appear under `spec.paths`. Don't assert on their presence in the spec.

## Public (no auth)

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Liveness + instance metadata. Returns `{ ok, version, pid, host, port, startedAt, uptimeMs, vscode:{appName,appHost,version,remoteName,uriScheme,sessionId}, workspace:{name,folders[]} }`. Same shape as the per-window record in `~/.vscode-internals/instances.json`. |
| GET | `/openapi.json` | Live OpenAPI 3.1 spec built from the registry. Excludes public paths and `/events/*`. |
| GET | `/docs` | Swagger UI (bundled, offline). |
| GET | `/docs/assets/*` | Swagger UI static assets. |

## events

Not in `/openapi.json`. Token still required for the SSE stream itself.

| Method | Path | Notes |
|---|---|---|
| GET | `/events/available` | List all subscribable event names. Returns `{ events: [...] }`. |
| GET | `/events?subscribe=a,b,c` | SSE stream. First frame is `event: ready`. 25-second heartbeat as `: comment` lines. 400 if `subscribe` is missing. |

The current source set spans editor (`onDidChangeActiveTextEditor`, `onDidChangeTextEditorSelection`, `onDidChangeTextEditorVisibleRanges`, `onDidChangeVisibleTextEditors`, `onDidOpenTextDocument`, `onDidCloseTextDocument`, `onDidSaveTextDocument`, `onDidChangeTextDocument`), tabs/window (`onDidChangeTabs`, `onDidChangeTabGroups`, `onDidChangeActiveTerminal`, `onDidChangeActiveColorTheme`, `onDidChangeWindowState`), files (`onDidCreateFiles`, `onDidDeleteFiles`, `onDidRenameFiles`, `onDidChangeWorkspaceFolders`), languages (`onDidChangeDiagnostics`), debug (`onDidStartDebugSession`, `onDidTerminateDebugSession`, `onDidChangeActiveDebugSession`, `onDidChangeBreakpoints`), notebooks (`onDidOpenNotebookDocument`, `onDidCloseNotebookDocument`, `onDidChangeNotebookDocument`), tasks/terminals (`onDidStartTask`, `onDidEndTask`, `onDidEndTaskProcess`, `onDidOpenTerminal`, `onDidCloseTerminal`), config (`onDidChangeConfiguration`), extensions/LM (`onDidChangeExtensions`, `onDidChangeChatModels`). Always hit `/events/available` for the authoritative list.

## workspace

| Method | Path | Summary |
|---|---|---|
| GET  | `/workspace/folders` | List workspace folders. |
| GET  | `/workspace/name` | Workspace name, workspace file URI, root path. |
| POST | `/workspace/findFiles` | Glob search. Params: `include` (required), `exclude`, `maxResults` (default 1000). |
| POST | `/workspace/readFile` | Read via `vscode.workspace.fs`. Params: `uri`, `encoding` (`utf8`\|`base64`). |
| POST | `/workspace/writeFile` | Write via fs (bypasses editor). Params: `uri`, `content`, `encoding`. |
| POST | `/workspace/stat` | Stat a file/dir. Returns `{type, size, ctime, mtime}`. |
| POST | `/workspace/readDirectory` | List children: `[{name, type}]`. |
| POST | `/workspace/createDirectory` | Recursive mkdir. |
| POST | `/workspace/delete` | Delete file/dir. Params: `uri`, `recursive`, `useTrash`. |
| POST | `/workspace/copy` | Copy file/dir. Params: `source`, `target`, `overwrite`. |
| POST | `/workspace/rename` | Rename/move. Params: `source`, `target`, `overwrite`. |
| GET  | `/workspace/textDocuments` | List all currently open text documents (includes unfocused). |
| POST | `/workspace/openTextDocument` | Open (does not focus). Either `uri`, or `content` + optional `language` for untitled. Returns text document metadata. |
| POST | `/workspace/getDocumentText` | Full or ranged text of a document. Params: `uri`, optional `range`. |
| POST | `/workspace/getWorkspaceFolder` | Which workspace folder owns a URI. Params: `uri`. |
| POST | `/workspace/asRelativePath` | URI/path → workspace-relative path. Params: `path`, `includeWorkspaceFolder`. |
| POST | `/workspace/saveAll` | Save all dirty documents. Params: `includeUntitled`. |
| POST | `/workspace/applyEdit` | Atomic multi-file edit. Goes through the editor pipeline (formatters, language clients see it). |
| POST | `/workspace/updateWorkspaceFolders` | Add/remove/replace workspace folders. Params: `start`, `deleteCount`, `folders:[{uri,name?}]`. |
| GET  | `/workspace/configuration` | Read a setting. Params: `section`, `scopeUri`. With no section returns the top-level keys. |
| POST | `/workspace/updateConfiguration` | Update a setting. Params: `section`, `value`, `target` (`global`\|`workspace`\|`workspaceFolder`), `scopeUri`. |

## window

| Method | Path | Summary |
|---|---|---|
| GET  | `/window/activeTextEditor` | Active editor or `null`. |
| GET  | `/window/visibleTextEditors` | All visible editors. |
| GET  | `/window/selectionText` | Selected text (or full document if no selection). `{text, hasSelection}`. |
| POST | `/window/showTextDocument` | Open and focus. Params: `uri`, `viewColumn`, `preserveFocus`, `preview`, `selection`. |
| POST | `/window/setSelection` | Replace selections. Params: `selections: [{anchor, active}]`. |
| POST | `/window/revealRange` | Scroll to a range. Params: `range`, `revealType` (`Default`\|`InCenter`\|`InCenterIfOutsideViewport`\|`AtTop`). |
| POST | `/window/showInformationMessage` | Notification + optional buttons; returns picked item. |
| POST | `/window/showWarningMessage` | Warning notification. |
| POST | `/window/showErrorMessage` | Error notification. |
| POST | `/window/showQuickPick` | Quick pick prompt. Params: `items`, `canPickMany`, `placeHolder`, `title`. |
| POST | `/window/showInputBox` | Input box. Params: `prompt`, `value`, `placeHolder`, `password`, `title`. |
| POST | `/window/showOpenDialog` | Native open-file/folder dialog. Params: `defaultUri`, `canSelectFiles`, `canSelectFolders`, `canSelectMany`, `openLabel`, `title`, `filters`. Returns `{uris:[]}`. |
| POST | `/window/showSaveDialog` | Native save dialog. Params: `defaultUri`, `saveLabel`, `title`, `filters`. Returns `{uri}`. |
| POST | `/window/showWorkspaceFolderPick` | Prompt user to pick a workspace folder. Returns the folder or `null`. |
| GET  | `/window/state` | `{focused, active}`. |
| GET  | `/window/activeColorTheme` | Theme kind. |
| GET  | `/window/terminals` | List open terminals (name, exitStatus). |
| POST | `/window/createTerminal` | Params: `name`, `cwd`, `shellPath`, `shellArgs`, `show`. |
| POST | `/window/terminalSendText` | Params: `name` (default active terminal), `text`, `addNewLine`. Fire-and-forget. |
| POST | `/window/terminalShow` | Focus terminal by name. |
| POST | `/window/terminalDispose` | Close terminal by name. |
| POST | `/window/setStatusBarMessage` | Transient status bar text. Params: `text`, `hideAfterMs`. |
| GET  | `/window/outputChannels` | List channels created through this API. |
| POST | `/window/outputChannel/create` | Create or fetch a named channel. Params: `name`, `languageId`. |
| POST | `/window/outputChannel/append` | Write to a channel (creates on demand). Params: `name`, `text`, `newline` (default true), `show`, `preserveFocus`. |
| POST | `/window/outputChannel/show` | Reveal channel panel. Params: `name`, `preserveFocus`. |
| POST | `/window/outputChannel/clear` | Clear channel. Params: `name`. |
| POST | `/window/outputChannel/dispose` | Delete channel. Params: `name`. |

## tabs

`vscode.window.tabGroups` is richer than text editors — includes diff editors, custom editors, webviews, notebooks, terminals.

| Method | Path | Summary |
|---|---|---|
| GET  | `/tabs/groups` | All tab groups + their tabs + which group is active. Returns `{ activeGroupViewColumn, groups: [...] }`. |
| GET  | `/tabs/list` | Flat list of every tab across groups, with `groupViewColumn`. Returns a bare array. |
| GET  | `/tabs/active` | Active tab in the active group. |
| POST | `/tabs/close` | Close tab(s) by `uri`, `label`, or `viewColumn+index`. Optional `preserveFocus`, `force`. |
| POST | `/tabs/closeGroup` | Close a whole group. Params: `viewColumn`, `preserveFocus`. |

Each tab `input` has a discriminator `kind` of `text`, `diff`, `custom`, `webview`, `notebook`, `notebookDiff`, `terminal`, or `unknown`.

## languages

All position-based endpoints take 0-indexed `{line, character}`. Results are LSP-shaped JSON.

| Method | Path | Summary |
|---|---|---|
| GET  | `/languages/all` | All registered language IDs. Returns `{ languages: [...] }`. |
| POST | `/languages/setTextDocumentLanguage` | Change a document's language ID. Params: `uri`, `languageId`. |
| POST | `/languages/match` | Score a DocumentSelector against a document. Params: `uri`, `selector` (string, filter, or array). |
| POST | `/languages/diagnostics` | Per-file or full workspace diagnostics. |
| POST | `/languages/hover` | Hover info. |
| POST | `/languages/definition` | Go-to-definition. |
| POST | `/languages/typeDefinition` | Go-to-type-definition. |
| POST | `/languages/implementation` | Go-to-implementation. |
| POST | `/languages/references` | Find references. |
| POST | `/languages/documentSymbols` | Document outline (hierarchical or flat). |
| POST | `/languages/workspaceSymbols` | Search symbols by query string. |
| POST | `/languages/completions` | Completions at position. Params include optional `triggerCharacter`. |
| POST | `/languages/signatureHelp` | Signature help. |
| POST | `/languages/codeActions` | Code actions in range. Params include optional `only` (CodeActionKind). |
| POST | `/languages/rename` | Compute (and optionally apply with `apply:true`) a rename edit. |
| POST | `/languages/formatDocument` | Compute (and optionally apply) formatting edits. |

## commands

| Method | Path | Summary |
|---|---|---|
| GET  | `/commands/list` | Params: `filterInternal` (default true), `filter` (substring). Returns `{ count, commands: [...] }`. |
| POST | `/commands/execute` | Params: `command`, `args` (positional array). The universal escape hatch. |

## debug

| Method | Path | Summary |
|---|---|---|
| GET  | `/debug/activeSession` | Active session metadata or `null`. |
| POST | `/debug/start` | Params: `nameOrConfig` (launch config name or inline `DebugConfiguration`), `workspaceFolderUri`, `parentSessionId`, `noDebug`. |
| POST | `/debug/stop` | Params: `sessionId` (default active). |
| GET  | `/debug/breakpoints` | List all breakpoints. |
| POST | `/debug/addBreakpoint` | Source breakpoint. Params: `uri`, `line`, `column`, `condition`, `hitCondition`, `logMessage`, `enabled`. |
| POST | `/debug/removeBreakpoints` | Params: `ids: [string]`. |
| POST | `/debug/customRequest` | Send any DAP request. Params: `sessionId`, `command` (e.g. `stackTrace`, `scopes`, `variables`, `continue`, `next`, `stepIn`, `stepOut`), `args`. |

## tasks

| Method | Path | Summary |
|---|---|---|
| GET  | `/tasks/list` | Tasks from tasks.json + task providers. |
| POST | `/tasks/execute` | Run by name (first match wins). |
| GET  | `/tasks/executions` | Currently running task executions. |
| POST | `/tasks/terminate` | Terminate a running task by name. |

## scm

| Method | Path | Summary |
|---|---|---|
| GET  | `/scm/inputBox` | Probe whether SCM (git extension) is available. |
| GET  | `/scm/git/repositories` | All git repos VSCode knows about (rootUri, HEAD, remotes, change counts). |
| POST | `/scm/git/status` | Detailed working-tree / index / merge status. Params: `rootUri` (default first repo). |

## tests

These bridge to the testing UI commands; output is shown in the test panel, not returned over the wire.

| Method | Path | Summary |
|---|---|---|
| POST | `/tests/runAll` | Run all tests. |
| POST | `/tests/runCurrentFile` | Run tests in the active file. |
| POST | `/tests/debugAll` | Debug all tests. |
| POST | `/tests/refresh` | Re-discover tests. |
| POST | `/tests/cancelRun` | Cancel current run. |
| POST | `/tests/showOutput` | Reveal test output panel. |

## notebooks

| Method | Path | Summary |
|---|---|---|
| GET  | `/notebooks/open` | List open notebook documents. |
| POST | `/notebooks/openNotebookDocument` | Open by URI. |
| POST | `/notebooks/cells` | Cells of a notebook. Params: `uri`, optional `start`/`end` indices. Returns code/markup, language, text, outputs metadata. |

## env

| Method | Path | Summary |
|---|---|---|
| GET  | `/env/info` | App name, host, language, machineId, remote name, shell, UI kind, telemetry flag. |
| GET  | `/env/clipboard` | Read clipboard text. |
| POST | `/env/clipboard` | Write clipboard text. |
| POST | `/env/openExternal` | Open a URL in the OS default handler. |
| POST | `/env/asExternalUri` | Translate a localhost URI to a publicly reachable form (tunnels). |
| GET  | `/env/tunnels` | Active tunnels list. Feature-detected — returns `{supported:false}` on older builds. |
| POST | `/env/openTunnel` | Open a tunnel to a remote port. Params: `remoteHost`, `remotePort`, `localPort`, `label`. Feature-detected. |

## ports

Local port introspection and forwarding. `/ports/forward` is the one-call helper; in remote/codespaces/tunnel contexts it triggers a real forward, in Desktop it usually returns the same URI.

| Method | Path | Summary |
|---|---|---|
| POST | `/ports/forward` | Forward a local port. Params: `port` (required), `protocol` (`http`\|`https`), `host`, `label`. Returns `{local, external, panelForwarded, label}`. |
| POST | `/ports/asExternalUri` | Map any URI to its external form. Params: `uri`. Returns `{input, external}`. |
| POST | `/ports/showPanel` | Focus the Ports panel. |
| POST | `/ports/stopForwarding` | Stop forwarding a port. Params: `port`. |

## lm

Wraps `vscode.lm` (public since VSCode 1.90). First call from this extension triggers a one-time consent prompt; the user can revoke later via the Trust / LM settings.

| Method | Path | Summary |
|---|---|---|
| GET  | `/lm/models` | All chat models VSCode currently sees. Returns `{ models: [{id, vendor, family, version, name, maxInputTokens}] }`. |
| POST | `/lm/selectChatModels` | Filter models by `{vendor, family, version, id}`. Returns `{ models: [...] }`. |
| POST | `/lm/sendRequest` | Non-streaming. Params: `selector?`, `messages:[{role,content}]`, `modelOptions?`, `justification?`. Returns `{model, text}`. |
| POST | `/lm/sendRequestStream` | Streams as SSE. Events: `model`, `chunk` (`{text}`), `done` (`{totalText,totalChars}`), `error` (`{message,code,name}`). Connection stays open until completion or client disconnect (`AbortController` cancels the model request). |
| POST | `/lm/countTokens` | Per-model tokenizer. Params: `selector?`, `text`. Returns `{model, tokens}`. |

`messages` roles: `user` \| `assistant` (multi-turn chat history is OK). `modelOptions` is passed through to `LanguageModelChatRequestOptions.modelOptions` (e.g. `{temperature: 0.2}`).

## authentication

| Method | Path | Summary |
|---|---|---|
| POST | `/authentication/getSession` | Get an auth session. Params: `providerId` (`github`, `microsoft`, …), `scopes`, `createIfNone`, `silent`, `clearSessionPreference`. May prompt the user. Returns `{id, accessToken, account, scopes}` — handle the token securely. |
| GET  | `/authentication/accounts` | List accounts for a provider. Returns `{supported:false}` on older VSCode versions. |

## extensions

| Method | Path | Summary |
|---|---|---|
| GET  | `/extensions/list` | Installed extensions. Params: `includeBuiltin` (default false). |
| GET  | `/extensions/get` | Single extension details. Params: `id`. |
| POST | `/extensions/activate` | Activate an extension by ID. |
| GET  | `/extensions/apis` | Active extensions that export an API. Lists top-level keys and shapes. Params: `activate` (force-activate first, default false). |
| POST | `/extensions/invoke` | Call a method on another extension's exports. Params: `id`, `path` (dot-separated walk on `exports`), `args` (array). Returns `{kind: 'invoked' \| 'value', result/value}`. Non-serializable values become best-effort JSON via `{__type:'...'}` markers. |

### How `/extensions/invoke` works

1. Activates the extension if needed.
2. Walks `path` segments on `exports` — e.g. `path: "getAPI"` reads `exports.getAPI`, `path: "settings.get"` reads `exports.settings.get`.
3. If the resolved value is a function, calls it with `args` and awaits.
4. Serializes the result. `Uri`, `Position`, `Range` get proper JSON. Disposables, EventEmitters, and unknown class instances become `{__type: 'ClassName', ...}`. Circular refs become `{__type:'circular'}`.

Common known extension APIs:

- `vscode.git` — call `getAPI(1)` to get the Git API, then walk into repositories.
- `ms-python.python` — exports `{environments, jupyter, ...}`.
- `GitHub.copilot` — exports vary by version; inspect via `/extensions/apis`.

Workflow: hit `GET /extensions/apis?activate=true`, read the `keys`/`shape` for the extension you care about, then invoke specific paths.

## Discoverability

Other extensions can register their own routes through the public `registerEndpoint` API. **If you expected an endpoint and got 404, re-fetch `/openapi.json`** — the registry is dynamic.

## Commands available to `/commands/execute`

The extension itself contributes a handful of palette commands:

- `vscodeInternals.showToken` — prompt with truncated token + "Copy"/"Reveal" actions.
- `vscodeInternals.copyToken` — copy the bearer token to the clipboard.
- `vscodeInternals.regenerateToken` — invalidate the current token and mint a new one (copied to clipboard).
- `vscodeInternals.openDocs` — open `/docs` in the external browser.
- `vscodeInternals.showStatus` — info popup with server URL, endpoint count, and event-source count.
- `vscodeInternals.restart` — **dev-only**. Registered only when `context.extensionMode === Development`; in marketplace builds this command does not exist. End users reload the window instead.
