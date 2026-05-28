# Cross-extension RPC

Call methods on other extensions' exported APIs without writing a new extension yourself. The escape hatch into `vscode.git`, `ms-python.python`, Jupyter, K8s, AWS, Go, EditorConfig, Copilot Chat, and anything else installed.

Uses the `vsc` wrapper from `SKILL.md`.

## Discover what's installed

```bash
# Installed extensions (non-builtin by default)
vsc $BASE/extensions/list | jq '.[] | {id, name: .packageJSON.displayName, isActive}' | head -50

# Detailed info on one
vsc "$BASE/extensions/get?id=ms-python.python" | jq '{id, isActive, version: .packageJSON.version}'

# Activate an extension before calling into it
vsc -d '{"id":"ms-python.python"}' $BASE/extensions/activate
```

## Discover which export programmatic APIs

This is the most valuable call — `?activate=true` force-activates so the export shape is visible.

```bash
# Just IDs of extensions that export an API
vsc "$BASE/extensions/apis?activate=true" | jq -r '.[].id'

# Per-extension top-level export keys
vsc "$BASE/extensions/apis" | jq -c '.[] | {id, keys: (.keys // .shape | keys)}'
```

Typical machine surfaces 20-30 APIs. Examples from a real install:

| Extension | Useful entry point |
|---|---|
| `vscode.git` | `getAPI(1)` → `.repositories[0]` (status, diff, commit, push, branches) |
| `ms-python.python` | `environments.getActiveEnvironmentPath()`, `debug`, `jupyter`, `settings`, `pylance` |
| `ms-toolsai.jupyter` | `kernels.getKernel(uri)`, `openNotebook(uri)`, `addRemoteJupyterServer(...)` |
| `GitHub.vscode-pull-request-github` | `repositoriesManager` → PRs, comments |
| `GitHub.copilot-chat` | `getAPI()` — direct Copilot Chat plumbing |
| `ms-kubernetes-tools.vscode-kubernetes-tools` | `get(...)` → cluster API |
| `amazonwebservices.aws-toolkit-vscode` | `getApi()` → AWS handles |
| `golang.go` | `settings` (active toolchain) |
| `EditorConfig.EditorConfig` | `resolveCoreConfig(uri)` |
| `vscode.typescript-language-features` | `getAPI()` |
| `ms-vscode.js-debug` | `registerDebugTerminalOptionsProvider` |

## Invoke a method

`path` is a dot-walk on `exports`. If the resolved value is a function, it's called with `args`.

```bash
# vscode.git → getAPI(1) → repositories[0].state.workingTreeChanges
vsc -d '{"id":"vscode.git","path":"getAPI","args":[1]}' $BASE/extensions/invoke | \
  jq '.result | {repositories: [.repositories[] | {rootUri: .rootUri.fsPath, head: .state.HEAD.name}]}'

# Active Python interpreter path
vsc -d '{"id":"ms-python.python","path":"environments.getActiveEnvironmentPath"}' \
  $BASE/extensions/invoke | jq -r '.result.path // .value.path'

# EditorConfig for the active file
vsc -d '{"id":"EditorConfig.EditorConfig","path":"resolveCoreConfig","args":["file:///g:/p/x.ts"]}' \
  $BASE/extensions/invoke | jq '.result // .value'
```

Response shape:
- Function call: `{ kind:"invoked", result: <value> }`
- Property read (non-function): `{ kind:"value", value: <value> }`

Non-serializable returns (Disposables, EventEmitters, opaque class instances) come back as `{__type:"ClassName", ...}` — you still get a useful object, you just can't round-trip it.

## Convenience SCM endpoints (no `/extensions/invoke` needed)

```bash
# Faster path to git status — uses the built-in git extension under the hood
vsc $BASE/scm/git/repositories | jq '.repositories[] | {head: .headBranch, changes: .workingTreeChanges}'
vsc -d '{}'                     $BASE/scm/git/status
```

For anything more advanced (diff, log, blame, commit), use `/extensions/invoke` against `vscode.git` or `/commands/execute` with `git.*` commands.

## Composition

**Walk a git repo's working changes:**

```text
POST /extensions/invoke { id:"vscode.git", path:"getAPI", args:[1] }
→ repo = result.repositories[0]
→ for each c in repo.state.workingTreeChanges: { uri, status }
POST /workspace/getDocumentText { uri }   # current contents
POST /commands/execute { command:"git.openChange", args:[uri] }   # show diff in VSCode
```

**Use the active Python interpreter for an LSP-aware lint:**

```text
POST /extensions/invoke ms-python.python.environments.getActiveEnvironmentPath
→ envPath
POST /window/createTerminal { name:"lint", cwd:"…" }
POST /window/terminalSendText { name:"lint", text:"<envPath>/python -m pylint …" }
```

**Open a Jupyter notebook + execute a cell via the Jupyter API:**

```text
POST /notebooks/openNotebookDocument { uri }
POST /extensions/invoke { id:"ms-toolsai.jupyter", path:"kernels.getKernel", args:[uri] }
→ then drive the kernel handle (executeCode, etc.)
```

## Gotchas

- Extension exports are **version-dependent**. Always `/extensions/apis` first to confirm shape on *this* user's machine — don't hard-code.
- `getAPI()` is a common pattern (TS, git, Copilot Chat) — the *real* API is the call return, not `exports` itself.
- Passing complex objects as `args` works for plain JSON; non-JSON values (functions, classes) can't be passed in.
- Force-activating heavy extensions (`?activate=true`) can be slow — only do it once at startup.
- If an extension is disabled or uninstalled, `/extensions/get?id=…` returns 404. Check before invoking.
