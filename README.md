# VSCode Internals

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/niradler.vscode-internals.svg?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=niradler.vscode-internals) [![Installs](https://img.shields.io/visual-studio-marketplace/i/niradler.vscode-internals.svg)](https://marketplace.visualstudio.com/items?itemName=niradler.vscode-internals) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A thin VSCode extension that exposes the full `vscode.*` API as a **token-protected local HTTP service** with REST endpoints, Server-Sent Events, and a dynamic OpenAPI 3.1 spec. Spiritual successor to the unmaintained [vs-rest-api](https://github.com/mkloubert/vs-rest-api).

Built so that scripts, CLIs, agents, and other extensions can drive a running VSCode instance — read editor state, edit files, run commands, invoke language services, watch events — without writing a new extension every time.

## Why

The VSCode extension API is enormous (`workspace`, `window`, `languages`, `debug`, `tasks`, `scm`, `tests`, `notebooks`, `env`, `authentication`, `extensions`, `commands`). Existing MCP servers cover a useful slice but not the full surface. This extension exposes **all of it** behind one consistent HTTP interface, with:

- **Bearer token auth** — token lives in VSCode SecretStorage, never in settings or workspace files
- **Loopback by default** — binds to `127.0.0.1`; opt-in to other interfaces with a clear warning
- **Dynamic OpenAPI** — spec is built from the live endpoint registry, so docs always match what's running
- **Swagger UI bundled** — `/docs` works offline, no CDN
- **SSE event stream** — subscribe to editor events without polling
- **Extensible** — other extensions can register their own endpoints through the public API and they show up in the same OpenAPI spec under the same auth

## Marketplace

Install from the VS Code Marketplace: [niradler.vscode-internals](https://marketplace.visualstudio.com/items?itemName=niradler.vscode-internals).

From the command line:

```bash
code --install-extension niradler.vscode-internals
```

Or open the Extensions view in VSCode and search for **VSCode Internals**.

## Install / Build

```bash
cd vscode/vscode-internals
npm install
npm run compile
```

To run during development: open this folder in VSCode and press F5 (Run Extension). To package as a `.vsix`:

```bash
npx @vscode/vsce package
code --install-extension vscode-internals-0.1.0.vsix
```

## First Run

On activation the extension:

1. Generates a token (if none exists) and stores it in SecretStorage.
2. Starts an Express server on `127.0.0.1:7891`.
3. Adds a status bar item showing the port.

Get your token:

- Command Palette → **VSCode Internals: Copy Token to Clipboard**
- Or **VSCode Internals: Show Token** to display it
- Or **VSCode Internals: Regenerate Token** to rotate it

Open the API docs:

- Command Palette → **VSCode Internals: Open API Docs (Swagger UI)** → opens `http://127.0.0.1:7891/docs`
- Click **Authorize** in Swagger UI and paste your token

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `vscodeInternals.port` | `7891` | Restart required. |
| `vscodeInternals.host` | `127.0.0.1` | Loopback only. `0.0.0.0` exposes you over the network — only do this if you understand the implications. |
| `vscodeInternals.autoStart` | `true` | Set false to start manually via the restart command. |
| `vscodeInternals.maxBodySizeBytes` | `10485760` | 10 MiB. Increase to send large file contents. |
| `vscodeInternals.logLevel` | `info` | `error` / `warn` / `info` / `debug`. See the **VSCode Internals** output channel. |

## Security model

- The token is a 32-byte random value, hex-encoded, prefixed `vscint_`. Stored in `context.secrets`.
- Every non-public request must send `Authorization: Bearer <token>`. Comparison is constant-time.
- Public paths (no auth): `GET /health`, `GET /openapi.json`, `GET /docs`, `GET /docs/assets/*`.
- Bind is loopback by default. If you change `host`, the extension warns and the status bar reflects the non-loopback bind.
- The extension has no concept of users or roles. **Anyone who has the token can do anything the extension can do**, including running shell commands via tasks and terminals. Treat the token like an SSH key.

## Endpoint catalog (summary)

Generated dynamically — see `/docs` for the live spec, or `GET /openapi.json` for the raw schema. The shipped baseline covers:

| Tag | Endpoints |
|---|---|
| `workspace` | `GET /workspace/folders`, `GET /workspace/name`, `GET /workspace/textDocuments`, `POST /workspace/findFiles`, `POST /workspace/readFile`, `POST /workspace/writeFile`, `POST /workspace/stat`, `POST /workspace/readDirectory`, `POST /workspace/createDirectory`, `POST /workspace/delete`, `POST /workspace/copy`, `POST /workspace/rename`, `POST /workspace/openTextDocument`, `POST /workspace/getDocumentText`, `POST /workspace/getWorkspaceFolder`, `POST /workspace/asRelativePath`, `POST /workspace/saveAll`, `POST /workspace/applyEdit`, `POST /workspace/updateWorkspaceFolders`, `GET /workspace/configuration`, `POST /workspace/updateConfiguration` |
| `window` | `GET /window/activeTextEditor`, `GET /window/visibleTextEditors`, `GET /window/selectionText`, `GET /window/state`, `GET /window/activeColorTheme`, `POST /window/showTextDocument`, `POST /window/setSelection`, `POST /window/revealRange`, `POST /window/showInformationMessage`, `POST /window/showWarningMessage`, `POST /window/showErrorMessage`, `POST /window/showQuickPick`, `POST /window/showInputBox`, `POST /window/showOpenDialog`, `POST /window/showSaveDialog`, `POST /window/showWorkspaceFolderPick`, `POST /window/setStatusBarMessage`, `GET /window/terminals`, `POST /window/createTerminal`, `POST /window/terminalSendText`, `POST /window/terminalShow`, `POST /window/terminalDispose`, `GET /window/outputChannels`, `POST /window/outputChannel/create`, `POST /window/outputChannel/append`, `POST /window/outputChannel/show`, `POST /window/outputChannel/clear`, `POST /window/outputChannel/dispose` |
| `tabs` | `GET /tabs/groups`, `GET /tabs/list`, `GET /tabs/active`, `POST /tabs/close`, `POST /tabs/closeGroup` |
| `languages` | `GET /languages/all`, `POST /languages/setTextDocumentLanguage`, `POST /languages/match`, `POST /languages/diagnostics`, `POST /languages/hover`, `POST /languages/definition`, `POST /languages/typeDefinition`, `POST /languages/implementation`, `POST /languages/references`, `POST /languages/documentSymbols`, `POST /languages/workspaceSymbols`, `POST /languages/completions`, `POST /languages/signatureHelp`, `POST /languages/codeActions`, `POST /languages/rename`, `POST /languages/formatDocument` |
| `commands` | `GET /commands/list`, `POST /commands/execute` |
| `debug` | `GET /debug/activeSession`, `POST /debug/start`, `POST /debug/stop`, `GET /debug/breakpoints`, `POST /debug/addBreakpoint`, `POST /debug/removeBreakpoints`, `POST /debug/customRequest` |
| `tasks` | `GET /tasks/list`, `POST /tasks/execute`, `GET /tasks/executions`, `POST /tasks/terminate` |
| `scm` | `GET /scm/git/repositories`, `GET /scm/git/status`, `POST /scm/inputBox` |
| `tests` | `POST /tests/runAll`, `POST /tests/runCurrentFile`, `POST /tests/debugAll`, `POST /tests/refresh`, `POST /tests/cancelRun`, `POST /tests/showOutput` |
| `notebooks` | `GET /notebooks/open`, `POST /notebooks/openNotebookDocument`, `POST /notebooks/cells` |
| `env` | `GET /env/info`, `GET /env/clipboard`, `POST /env/clipboard`, `POST /env/openExternal`, `POST /env/asExternalUri`, `GET /env/tunnels`, `POST /env/openTunnel` |
| `ports` | `POST /ports/forward`, `POST /ports/asExternalUri`, `POST /ports/showPanel`, `POST /ports/stopForwarding` |
| `authentication` | `POST /authentication/getSession`, `GET /authentication/accounts` |
| `extensions` | `GET /extensions/list`, `GET /extensions/get`, `POST /extensions/activate`, `GET /extensions/apis`, `POST /extensions/invoke` |
| `lm` | `GET /lm/models`, `POST /lm/selectChatModels`, `POST /lm/sendRequest`, `POST /lm/sendRequestStream` (SSE), `POST /lm/countTokens` |

## Language models (`/lm/*`)

Wraps `vscode.lm` (public since VSCode 1.90) so any local caller can use the chat models the user has access to — Copilot (gpt-4o, gpt-4.1, claude-sonnet, o1, …) and other providers. Auth piggybacks on the user's existing Copilot / provider sign-in; we just gate the HTTP surface with our bearer token.

```bash
# Pick a model and stream a response
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"selector":{"vendor":"copilot","family":"gpt-4o"},"messages":[{"role":"user","content":"summarize the last commit"}]}' \
  http://127.0.0.1:7891/lm/sendRequestStream
```

First call triggers VSCode's consent prompt ("Allow vscode-internals to use language models?"). Subsequent calls are remembered per-extension. Quota errors surface as `LanguageModelError.Blocked` in the SSE `error` event (or HTTP 500 for non-streaming).

## Events (SSE)

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:7891/events?subscribe=onDidChangeActiveTextEditor,onDidSaveTextDocument"
```

Available subscriptions: `GET /events/available`. A 25-second heartbeat keeps the connection alive. Each message is a standard SSE `event: <name>` / `data: <json>` pair.

Sources include editor/document changes (`onDidChange{Active,Visible}TextEditor`, `onDidOpen/Close/Save/ChangeTextDocument`, `onDidChangeTextEditorSelection/VisibleRanges`), workspace state (`onDidChangeWorkspaceFolders`, `onDidChangeConfiguration`, `onDidCreate/Delete/RenameFiles`), windowing (`onDidChangeWindowState`, `onDidChangeTabs`, `onDidChangeTabGroups`, `onDidChangeActiveTerminal`, `onDidOpen/CloseTerminal`, `onDidChangeActiveColorTheme`), debug (`onDidStart/TerminateDebugSession`, `onDidChangeActiveDebugSession`, `onDidChangeBreakpoints`), tasks (`onDidStart/EndTask`, `onDidEndTaskProcess`), languages (`onDidChangeDiagnostics`), notebooks (`onDidOpen/Close/ChangeNotebookDocument`), extensions (`onDidChangeExtensions`), and language models (`onDidChangeChatModels`).

## Example calls

```bash
TOKEN=$(code --no-sandbox --remote-cli 2>/dev/null) # or use the Copy Token command

# active editor + selection
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7891/window/activeTextEditor
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7891/window/selectionText

# search files
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"include":"**/*.ts","maxResults":50}' \
  http://127.0.0.1:7891/workspace/findFiles

# go-to-definition
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uri":"file:///path/to/file.ts","position":{"line":42,"character":10}}' \
  http://127.0.0.1:7891/languages/definition

# run a VSCode command
curl -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"command":"workbench.action.files.save"}' \
  http://127.0.0.1:7891/commands/execute
```

## Extending from another extension

The extension exports a public API. Any other extension can call `registerEndpoint` — the endpoint participates in the same auth, validation, dispatcher, and OpenAPI spec.

```typescript
import * as vscode from 'vscode';

interface VSCodeInternalsAPI {
  getToken(): Promise<string>;
  getServerUrl(): string;
  registerEndpoint(def: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    summary: string;
    description?: string;
    tag?: string;
    params?: object; // JSONSchema
    response?: object; // JSONSchema
    handler: (params: unknown, ctx: {
      vscode: typeof vscode;
      logger: { info(m: string): void; debug(m: string): void };
      serializer: { uri(u: vscode.Uri): string; toUri(s: string): vscode.Uri };
      req: { headers: Record<string, string | string[] | undefined> };
    }) => unknown | Promise<unknown>;
  }): vscode.Disposable;
}

export async function activate(context: vscode.ExtensionContext) {
  const ext = vscode.extensions.getExtension<VSCodeInternalsAPI>('niradler.vscode-internals');
  if (!ext) return;
  const api = await ext.activate();

  const disposable = api.registerEndpoint({
    method: 'GET',
    path: '/my-extension/hello',
    summary: 'Say hello from my-extension',
    tag: 'my-extension',
    handler: () => ({ message: 'hello' }),
  });
  context.subscriptions.push(disposable);
}
```

The disposable is auto-released when your extension deactivates. Tokens are owned by `vscode-internals` — your extension never sees them unless you call `getToken()` (which itself requires that your extension is trusted in this VSCode instance).

## Architecture

```text
src/
├── extension.ts        activation, commands, public API export
├── server.ts           express, auth gate, SSE, dynamic dispatcher
├── auth.ts             token storage + middleware
├── registry.ts         endpoint registry (the source of truth)
├── serializer.ts       vscode <-> JSON shapes (Uri, Range, TextDocument, ...)
├── openapi.ts          dynamic spec + Swagger UI HTML
├── events.ts           SSE event bus, standard vscode events
├── logger.ts           output channel logger
└── routes/             one file per vscode namespace
    ├── workspace.ts  window.ts  tabs.ts       languages.ts
    ├── commands.ts   debug.ts   tasks.ts      scm.ts
    ├── tests.ts      notebooks.ts             env.ts
    ├── ports.ts      authentication.ts        extensions.ts
    └── index.ts      (barrel)
```

The registry is intentionally the only thing the dispatcher and OpenAPI builder know about — adding a new endpoint is one `register(...)` call and it appears in the spec on the next refresh.

## Limitations

- Webview and custom editor content isn't exposed yet — those APIs need the extension to *be* the webview host, not just read it. Open to suggestions.
- The `tests` namespace mostly bridges to the testing UI commands (`testing.runAll` etc.); a structured "list tests / run by id" surface would need to track test controllers and is on the roadmap.
- The git extension is reached via the public `vscode.git` API. If you've disabled the built-in git extension, `/scm/*` will return an empty result.

## Contributing

Issues and pull requests are welcome at [github.com/niradler/vscode-internals](https://github.com/niradler/vscode-internals/issues). Bug reports, endpoint requests, and patches are all useful.

See `BACKLOG.md` for ideas that are queued up but not yet started — a good place to pick something to work on.

## License

MIT.
