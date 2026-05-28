# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A VSCode extension that exposes the full `vscode.*` API as a token-protected local HTTP service (REST + SSE + dynamic OpenAPI). The HTTP surface is the product — every endpoint maps to one or more `vscode.*` calls. See [README.md](README.md) for end-user docs and [docs/backlog.md](docs/backlog.md) for the open work queue.

## Commands

```bash
npm run compile        # tsc → out/
npm run lint           # tsc --noEmit (this is the lint step CI runs)
npm run e2e            # smoke suite against a running dev host (see Self-test loop below)
npm run package        # produces .vsix via @vscode/vsce
npm run watch          # tsc -watch (incremental compile during dev)
```

There is no separate test framework — `scripts/e2e.mjs` is the test suite. It reads the dev handshake file, hits `/health`, then runs ~32 endpoint smoke tests sequentially. Each test is a `t.run('name', async () => {...})` block; copy that shape to add new ones.

CI (`.github/workflows/ci.yml`) runs only `compile` + `lint` on push/PR to `main` for `ubuntu-latest` and `windows-latest`. The e2e suite needs a live VSCode host and is run locally.

## Self-test loop (autonomous validation)

This is the chain that lets you develop and verify changes without asking the user to reload:

1. **Marketplace install on 7891** drives `/debug/start { nameOrConfig: "Run Extension" }`.
2. That launches a fresh Extension Development Host loading the dev code from `out/`.
3. Dev host activates with `VSCODE_INTERNALS_PORT=7892` (set in [`.vscode/launch.json`](.vscode/launch.json) `env`), binds 7892, and writes the dev handshake to `<tmpdir>/niradler.vscode-internals.dev.json`.
4. `npm run e2e` reads that handshake and runs the suite against 7892.

The bearer token is the same across marketplace and dev installs because both share `niradler.vscode-internals` as the extension id (one SecretStorage entry). Reading the handshake gives you `{url, token, pid}`.

Full chain from PowerShell:

```powershell
$tok = (Get-Content (Join-Path $env:TEMP 'niradler.vscode-internals.dev.json') | ConvertFrom-Json).token
$hdr = @{Authorization="Bearer $tok"; "Content-Type"="application/json"}
Remove-Item (Join-Path $env:TEMP 'niradler.vscode-internals.dev.json') -Force -ErrorAction Ignore
Invoke-RestMethod -Uri 'http://127.0.0.1:7891/debug/start' -Method Post -Headers $hdr `
  -Body (@{ nameOrConfig = "Run Extension" } | ConvertTo-Json -Compress)
# Poll <tmpdir>/niradler.vscode-internals.dev.json until it exists, then poll /health on the new url
```

After editing source: `npm run compile`, then either relaunch the dev host (as above) or have it reload. The marketplace install is unchanged by your edits — only the dev host loads `out/`.

## Architecture invariants

The architecture section in [README.md](README.md#architecture) shows the file tree. The non-obvious bits:

- **`EndpointRegistry` is the source of truth.** Routes register through `reg({method, path, summary, params, handler, tag, description})`. The dispatcher in `server.ts` and the OpenAPI builder in `openapi.ts` both read from the registry — adding an endpoint anywhere makes it appear in both. Do **not** add direct `app.get(...)` routes in `server.ts` for normal endpoints; that bypasses auth, OpenAPI, and the registry. The only direct express routes are `/health`, `/openapi.json`, `/docs`, `/events`, `/events/wait`, `/events/available` — they handle their own response lifecycle (SSE, long-poll, static HTML).
- **Routes are namespaced by `vscode.*` surface.** One file per namespace under [src/routes/](src/routes/) — `window.ts` for everything reachable via `vscode.window.*`, `workspace.ts` for `vscode.workspace.*`, etc. `TextEditor` methods live under `/window/*` (not `/editor/*`) because that matches how vscode itself names them.
- **`Serializer` is bidirectional and JSON-clean.** Outbound (vscode → JSON): never return vscode instances from handlers; use `ctx.serializer.uri/range/position/textDocumentMeta/...` so the response is structurally stable. Inbound (JSON → vscode): use `ctx.serializer.toUri/toPosition/toRange` to coerce client input. Don't manually `new vscode.Range(new vscode.Position(...))` in handlers — call `toRange` so the shape contract stays in one place.
- **`EventBus` is lazy.** Listeners on `vscode.*` events are attached only when a client subscribes via `/events` or `/events/wait`. Factory functions in `events.ts` translate each event payload through the serializer before emit. Adding a new event source = one `bus.registerEventSource('name', emit => vscode.x.onDidY(...))` block.
- **Two access patterns over the same EventBus.** `/events` is SSE (push, persistent connection — good for streaming consumers). `/events/wait` is long-poll with server-side `filter` and `match=first|all` — fits turn-based agent loops. Both reach the same factory.
- **`extension.ts` exports a `VSCodeInternalsAPI`.** Other extensions can call `registerEndpoint` to add their own routes that participate in the same auth, dispatcher, and OpenAPI spec. The disposable returned auto-unregisters on the caller's deactivation. Keep this surface stable (semver).
- **Token comparison is constant-time** ([`src/auth.ts`](src/auth.ts)). Don't add features that compare tokens with `===`.

## Adding a new endpoint

The shortest workflow:

1. Find the right file in [src/routes/](src/routes/) (or add one and register it in `routes/index.ts`).
2. Call `reg({method, path: '/namespace/action', summary, description?, params?, handler})`. `params` is JSON-Schema (used for both validation and OpenAPI). `handler: (raw, ctx) => result | Promise<result>`. Return JSON-safe values; throw `Error` for 4xx/5xx with a message.
3. `npm run lint` to type-check.
4. Run the self-test loop above; the e2e suite picks up new routes automatically only if you add a test block. Copy an existing `t.run` and assert the shape you care about.

When the endpoint has user-visible behavior (anything that mutates editor state, opens UI, etc.), prefer a route description that documents the alternative `/commands/execute` command form alongside the endpoint, so callers can pick the lower-level path. See [src/routes/window.ts](src/routes/window.ts) `/window/insertSnippet` for the pattern (Pattern A endpoint + Pattern B command form in `description`).

## Skill files

The repository ships an agent skill under [skills/vscode-automation/](skills/vscode-automation/) that documents the HTTP surface for downstream agent use. When you add or change an endpoint that crosses a use-case boundary (editor, lsp, debug, tasks, events, …), update the matching `references/<topic>.md` file. The skill is the user-facing API doc for agents; the route `description` field is its source of truth for what the endpoint does.
