---
name: vscode-automation
description: Drive the user's running VSCode editor through a local REST API exposed by the niradler.vscode-internals extension on http://127.0.0.1:7891. Use whenever the user refers to "my editor", "the file I have open", "the active file", "my selection", "my workspace", "go to definition", "find references", "run the task", "run my tests", "the debug session", "the terminal in VSCode", or anything else that reads or mutates live VSCode state instead of just operating on files on disk. Prefer this skill over plain file reads/edits when the user is clearly working inside VSCode and the action depends on editor state (selection, open document, language services, tasks, debug, SCM, terminals, notebooks). Also use for inter-extension RPC (/extensions/invoke), calling Copilot/Claude/GPT chat models via /lm/* (vscode.lm API), watching editor events via SSE, port forwarding/tunnels, clipboard, and authentication sessions.
---

# VSCode Automation

The extension `niradler.vscode-internals` exposes the full `vscode.*` API as ~117 REST endpoints across 15 tags, plus an SSE event stream and a live OpenAPI 3.1 spec. This SKILL gives you setup, the mental model, and a navigation table to the right use-case reference.

**Load only what you need.** This file is the index — domain-specific reference files in `references/` are loaded on demand based on the table below.

## Setup: server + token

Confirm the server is up:

```bash
curl -sS http://127.0.0.1:7891/health    # → {"ok":true,"version":"...","pid":...,"port":7891,"startedAt":"...","vscode":{...},"workspace":{...}}
```

If this fails the extension isn't running — ask the user to open VSCode and confirm `niradler.vscode-internals` is installed and active. Don't try to install or start it yourself.

**Discovering open windows.** `~/.vscode-internals/instances.json` lists every live window with `{pid, url, workspaceFolders, ...}`. Read it first to pick the `url` matching the workspace you want to drive; `curl $url/health` to confirm before using (a hard-killed window can leave a stale row until the next boot).

**Non-default port.** The user may have remapped the bind via the `vscodeInternals.port` setting or the `VSCODE_INTERNALS_PORT` env var (e.g. dev hosts run on `7892` to coexist with a marketplace install on `7891`). If `instances.json` is empty or `/health` 404s/connection-refuses on `7891`, ask the user for the right port and substitute it into `BASE` below. Examples in this skill default to `7891` for readability — swap as needed.

**Get the token.** Generated on first activation (`vscint_` + 32 random bytes), stored in VSCode's `SecretStorage`, persists across restarts. Every non-public call needs `Authorization: Bearer <token>`. Public endpoints (no auth): `GET /health`, `GET /openapi.json`, `GET /docs`, `GET /docs/assets/*`.

Order of preference:
1. **Ask the user.** Command Palette → **VSCode Internals: Copy Token to Clipboard** → paste back.
2. **Extension Development Host only** (this repo via `F5`): token is written to `<tmpdir>/niradler.vscode-internals.dev.json`. Marketplace builds never write this file.
3. **Rotate**: Command Palette → **VSCode Internals: Regenerate Token**.

Note: `/env/clipboard` requires auth, so it can't bootstrap the first token.

## Calling convention

**One-time setup.** Put the token + base URL in a `.env` file you source, and define a `vsc` wrapper so examples don't repeat headers.

```bash
# .env  (gitignore this)
export BASE=http://127.0.0.1:7891
export TOKEN=vscint_…

# Once per shell:
source .env
vsc() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" "$@"; }
```

Then every example collapses to:

```bash
vsc $BASE/window/state                                       # GET
vsc -d '{"include":"**/*.ts"}' $BASE/workspace/findFiles     # POST
vsc -X POST $BASE/tests/runAll                               # POST without body
vsc -N "$BASE/events?subscribe=onDidSaveTextDocument"        # SSE (stream)
```

All examples in `references/*.md` use this `vsc` wrapper. If you don't define it, expand each call back to `curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json"`.

**PowerShell**: same idea, with a function. PS mangles inline `-d '{...}'` — pipe JSON via a here-string + `--data-binary "@-"` and use `curl.exe` (not the PS alias).

```powershell
# Save as setup.ps1, dot-source it:  . .\setup.ps1
$env:BASE  = 'http://127.0.0.1:7891'
$env:TOKEN = 'vscint_…'
function vsc { curl.exe -sS -H "Authorization: Bearer $env:TOKEN" -H "Content-Type: application/json" @args }

# JSON-body POST:
@'
{"include":"**/*.ts","maxResults":50}
'@ | vsc --data-binary "@-" "$env:BASE/workspace/findFiles"
```

**Discoverability**: `/openapi.json` is the live source of truth — it grows at runtime as other extensions register endpoints. If a route 404s when you expected it, re-fetch.

## Mental model

VSCode is now a multi-tenant runtime the agent shares with the user, with three superpowers stapled on:

- **LSP across the open workspace** — types, references, symbols, diagnostics, code actions, rename, format — all via `/languages/*`.
- **User-bound LLMs** — every chat model VSCode sees (Copilot, Copilot CLI, Claude Code, GitHub Models, local providers) is callable through `/lm/*` using the user's existing auth. No keys to manage.
- **Inter-extension RPC** — `vscode.git`, `ms-python.python`, `GitHub.copilot-chat`, `ms-kubernetes-tools`, `ms-toolsai.jupyter`, AWS Toolkit, Go, EditorConfig — anything that exports an API is callable via `/extensions/invoke`. Discover what's installed via `GET /extensions/apis`.

Compose flows as a pipeline:

1. **Read** editor state → know what the user is on.
2. **Enrich** via LSP → make the LLM smart.
3. **Reach into other extensions** → talk to git/python/jupyter/k8s/...
4. **Decide** via the user's LLMs → use their models, not yours.
5. **Confirm** with the user → modal for destructive, status bar / output channel for ambient.
6. **Mutate atomically** → one undo step.
7. **React, don't poll** → SSE on `onDidSaveTextDocument`, `onDidChangeDiagnostics`, etc.

## Navigation — load the reference you need

| If the agent needs to... | Load |
|---|---|
| Read editor state (active file, selection, tabs, visible editors, open documents) and **modify files** (applyEdit, openTextDocument, writeFile, format) | [`references/editor.md`](references/editor.md) |
| Use **language services** (hover, definition, references, symbols, diagnostics, code actions, rename) | [`references/lsp.md`](references/lsp.md) |
| **Debug code** — discover `launch.json`, start sessions, set breakpoints, drive via DAP, dump program state to LLM | [`references/debug.md`](references/debug.md) |
| Run **tasks or tests** and watch their lifecycle | [`references/tasks.md`](references/tasks.md) |
| **Talk to the user** — notifications with buttons, quick pick, input box, file dialogs, status bar, output channels | [`references/interactivity.md`](references/interactivity.md) |
| **React to user activity** via SSE — saves, selection changes, diagnostics, debug, file changes | [`references/events.md`](references/events.md) |
| Call **chat models** (Copilot / Copilot CLI / Claude Code / GitHub Models) via the user's existing auth | [`references/lm.md`](references/lm.md) |
| Call **other extensions' APIs** (vscode.git, ms-python.python, ms-toolsai.jupyter, k8s, AWS, Go, EditorConfig, Copilot Chat) | [`references/extensions.md`](references/extensions.md) |
| Forward **ports / tunnels**, open external URLs, share localhost externally | [`references/ports.md`](references/ports.md) |
| Work with **git / SCM** | [`references/scm.md`](references/scm.md) |
| **Clipboard**, env info, **authentication** sessions, **terminals**, **command-palette** execution, **Jupyter notebooks** | [`references/misc.md`](references/misc.md) |
| Look up an exact endpoint signature | [`references/endpoints.md`](references/endpoints.md) |
| Look up a vscode type ↔ JSON mapping (Uri, Position, Range, Selection, TextDocument, Diagnostic, Symbol, Hover, …) | [`references/serialization.md`](references/serialization.md) |
| Copy-paste a long, multi-step shell recipe | [`references/recipes.md`](references/recipes.md) |

Each use-case reference is self-contained — it includes the endpoints, the URI/position/range shape notes it needs, and small composed examples. You shouldn't need to load more than one or two of them for a typical task.

Live OpenAPI: `GET /openapi.json`. Swagger UI: `http://127.0.0.1:7891/docs`. Project README: [../../README.md](../../README.md).
