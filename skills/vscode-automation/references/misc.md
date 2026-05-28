# Misc: clipboard, env, auth, terminals, commands, notebooks

Smaller surfaces grouped together. Use the `vsc` wrapper from `SKILL.md`.

## Clipboard

```bash
vsc $BASE/env/clipboard | jq -r '.text'                       # read
vsc -d '{"text":"hello"}' $BASE/env/clipboard                 # write
```

Use case: read-transform-write loop. Read clipboard → LLM → write back → notify the user what happened.

## Env info

```bash
vsc $BASE/env/info | jq '{appName, appHost, machineId, remoteName, shell, uiKind, isTelemetryEnabled}'
```

Useful to detect: remote / codespaces (`remoteName != null`), web vs desktop (`uiKind`), default shell.

## Authentication (GitHub / Microsoft / providers)

Borrow the user's already-signed-in session instead of asking for a PAT.

```bash
# List accounts signed into a provider
vsc "$BASE/authentication/accounts?providerId=github" | jq '.accounts'

# Get a session (silent = no prompt; null if no consent yet)
vsc -d '{"providerId":"github","scopes":["repo"],"silent":true}' \
  $BASE/authentication/getSession | jq '{accessToken: .accessToken, account: .account.label, scopes}'

# Prompt the user for consent (interactive)
vsc -d '{"providerId":"github","scopes":["repo","read:org"],"createIfNone":true}' \
  $BASE/authentication/getSession
```

Providers VSCode ships with: `github`, `github-enterprise`, `microsoft`. Other extensions can register their own.

Security: the `accessToken` leaves VSCode's sandbox once you have it. Don't log, don't persist, treat as one-shot.

## Terminals

```bash
vsc $BASE/window/terminals | jq '.[] | {name, exitStatus}'
vsc -d '{"name":"build","cwd":"g:/Projects/foo","show":true}' $BASE/window/createTerminal
vsc -d '{"name":"build","text":"npm run build","addNewLine":true}' $BASE/window/terminalSendText
vsc -d '{"name":"build"}' $BASE/window/terminalShow
vsc -d '{"name":"build"}' $BASE/window/terminalDispose
```

`terminalSendText` is fire-and-forget — terminals **don't return their output** over the API. To capture output:
- Redirect to a file: `npm run build > /tmp/build.log 2>&1`
- Use a **task** with a problem matcher instead — task lifecycle events give you exit codes
- Use a process-API spawn outside VSCode if you need stdout

`/window/terminals` only reports `exitStatus` after the process ends — it doesn't expose running output.

## Commands (the universal escape hatch)

Anything in the command palette is reachable.

```bash
# Discover
vsc "$BASE/commands/list?filter=workbench.action.files" | jq '.count, .commands[:20]'

# Execute. Positional args go in `args` array.
vsc -d '{"command":"workbench.action.files.save"}'                          $BASE/commands/execute
vsc -d '{"command":"editor.action.formatDocument"}'                         $BASE/commands/execute
vsc -d '{"command":"workbench.action.gotoLine"}'                            $BASE/commands/execute
vsc -d '{"command":"vscode.diff","args":["file:///before","file:///after","Title"]}' \
  $BASE/commands/execute

# Open Copilot Chat with a pre-filled query
vsc -d '{"command":"workbench.action.chat.open","args":[{"query":"explain this codebase"}]}' \
  $BASE/commands/execute
```

Useful command discovery filters: `workbench.action`, `editor.action`, `git.`, `python.`, `jupyter.`, `markdown.`, `vscode.`, `editor.action.formatDocument`, etc.

`filterInternal` defaults to `true` (hides private commands). Pass `?filterInternal=false` to see everything.

## Notebooks

```bash
# Open documents
vsc $BASE/notebooks/open

# Open by URI
vsc -d '{"uri":"file:///g:/p/exp.ipynb"}' $BASE/notebooks/openNotebookDocument

# Cells (code/markup, language, text, outputs metadata)
vsc -d '{"uri":"file:///g:/p/exp.ipynb"}' $BASE/notebooks/cells | \
  jq '.[] | {kind, language, text: (.text[:80]), outputs: (.outputs | length)}'

# Specific cell range
vsc -d '{"uri":"file:///g:/p/exp.ipynb","start":0,"end":3}' $BASE/notebooks/cells
```

For cell **execution** (not just reading), go through Jupyter via `/extensions/invoke`:

```bash
vsc -d '{"id":"ms-toolsai.jupyter","path":"kernels.getKernel","args":["file:///g:/p/exp.ipynb"]}' \
  $BASE/extensions/invoke
```

The kernel handle (non-serializable) is best driven via palette commands:

```bash
vsc -d '{"command":"notebook.cell.execute"}'           $BASE/commands/execute
vsc -d '{"command":"notebook.cell.executeAndSelectBelow"}' $BASE/commands/execute
vsc -d '{"command":"jupyter.runallcells"}'             $BASE/commands/execute
```

## Composition

**Clipboard transform pipeline:**

```text
GET  /env/clipboard                                → { text }
POST /lm/sendRequest selector:claude-haiku-4.5     → { text: transformed }
POST /env/clipboard { text: transformed }
POST /window/showInformationMessage {
  message: "Transformed clipboard ("+len+" chars)",
  items: ["Insert at cursor","Undo","Done"]
}
```

**GitHub-authenticated action without a PAT:**

```text
POST /authentication/getSession { providerId:"github", scopes:["repo"], silent:true }
→ accessToken
# Use accessToken directly against api.github.com from the agent host
```

**Run command + read its emitted state:**

```text
POST /commands/execute { command:"workbench.action.openSettings", args:["editor.formatOnSave"] }
# Wait for user to change it (or not)
GET  /workspace/configuration?section=editor.formatOnSave   # confirm
```
