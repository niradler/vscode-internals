# Release Plan — vscode-internals v0.1.0

Tracking everything required to ship the first public version of `niradler.vscode-internals` to the VSCode Marketplace and validate it end-to-end.

## Status snapshot (2026-05-28)

- **Marketplace name**: `niradler.vscode-internals` — **available** (verified via gallery API).
- **Bare name `vscode-internals`**: not in use by any publisher.
- **Publisher**: `niradler` exists on the marketplace.
- **Local repo**: `.git` initialized; not pushed to GitHub yet.
- **Build artifacts**: no `out/` (never compiled in this checkout).
- **Server**: not currently running on `127.0.0.1:7891`.
- **Missing release assets**: `LICENSE`, `CHANGELOG.md`, `icon.png`, marketplace images, `.vscodeignore`.

## Open decisions (need Nir input)

1. **Marketplace publish credentials** — do you have a `VSCE_PAT` (Azure DevOps PAT scoped to Marketplace → Manage), or should we stop at building the `.vsix` for manual upload?
2. **GitHub repository** — create new public repo `niradler/vscode-internals`? Confirm the slug. Existing repo URL if different.
3. **Icon / branding** — do you have an icon, or generate a placeholder SVG/PNG?
4. **E2E scope** — smoke (health + auth + a few core endpoints) or broader (every namespace)?
5. **Self-debug loop** — autonomous restart-and-validate. Confirmed approach below.

## Workstreams

### 1. Pre-release hygiene

- [ ] Add `repository`, `bugs`, `homepage`, `license`, `icon`, `keywords`, `galleryBanner` to `package.json`
- [ ] Add `LICENSE` (MIT — README already states MIT)
- [ ] Add `CHANGELOG.md` with v0.1.0 entry
- [ ] Add `.vscodeignore` (exclude `src/`, `node_modules/`, `*.md` except README/CHANGELOG/LICENSE, `tsconfig.json`, `BACKLOG.md`, `RELEASE.md`, `skills/`)
- [ ] Add `.gitignore` (out/, node_modules/, *.vsix)
- [ ] Add lint/format tooling (decision: `prettier` + `eslint` minimal config, OR `tsc --noEmit` only)
- [ ] `npm run compile` clean
- [ ] Confirm `engines.vscode` matches actually-used APIs

### 2. Assets

- [ ] `icon.png` (128x128 minimum, 256x256 recommended)
- [ ] `gallery banner` color in `package.json` (`#1e1e1e` to match VSCode dark)
- [ ] At least one screenshot for marketplace listing (Swagger UI)
- [ ] README badges (version, marketplace, license)

### 3. Skill improvements (`skills/vscode-automation`)

- [ ] Rename concept from "automation" to match the deployed extension domain (review wording)
- [ ] Add a recipe for "diagnostics-driven autofix" loop
- [ ] Add a recipe for "drive Copilot/Claude via /lm/* from a script"
- [ ] Add a recipe for "self-test the extension after install" (mirrors §5 below)
- [ ] Update `references/endpoints.md` against current `/openapi.json`
- [ ] Verify SKILL.md examples match current PowerShell + bash patterns

### 4. Repo on GitHub

- [ ] Create remote `niradler/vscode-internals`
- [ ] Commit current state (no AI attribution per global rules)
- [ ] Push `main`
- [ ] Add GitHub Actions: build + lint on PR

### 5. Self-debug & E2E validation

The extension can drive itself once running. The autonomous flow:

1. Build (`npm run compile`)
2. Launch a fresh VSCode Extension Development Host with this folder (`code --extensionDevelopmentPath=. --new-window`)
3. Poll `GET /health` until ready
4. Fetch token via VSCode CLI or the extension's output channel
5. Run E2E suite against the running instance: workspace/findFiles, applyEdit roundtrip, openapi.json shape, /lm/models presence, SSE heartbeat
6. On failure → fetch logs via `/window/outputChannel/...`, fix code, recompile, call `/commands/execute {command: 'vscodeInternals.restart'}` to reload the server, re-run failed test
7. Repeat until green
8. Report results

Tasks:

- [ ] Write `scripts/e2e.mjs` using the live API
- [ ] Write `scripts/launch-host.ps1` that boots a dev host and waits for `/health`
- [ ] Implement self-restart command path through `/commands/execute`
- [ ] Capture logs through `/window/outputChannel/...` for failing tests
- [ ] Surface a final pass/fail summary

### 6. Publish

- [ ] `npx @vscode/vsce package` → `vscode-internals-0.1.0.vsix`
- [ ] Install locally and run E2E once more against installed (not dev-host) build
- [ ] `npx @vscode/vsce publish` (requires `VSCE_PAT`)
- [ ] Verify listing on `https://marketplace.visualstudio.com/items?itemName=niradler.vscode-internals`
- [ ] Tag git `v0.1.0` and push

## Decisions made

- **Marketplace creds**: Generate guidance + .vsix. I prep everything up to `vsce publish`; Nir runs publish once he creates the PAT.
- **GitHub repo**: Create new public `niradler/vscode-internals` via `gh` CLI.
- **Icon**: Generate a placeholder PNG (clean monochrome on `#1E1E1E` banner).
- **E2E scope**: Smoke + one happy-path call per namespace + `/openapi.json` shape + SSE heartbeat.
- **Name availability**: confirmed `vscode-internals` is unused by any publisher across the marketplace; no collisions for sibling names either.

## Issues / surprises

- **Restart-via-API deadlock (fixed)** — `vscodeInternals.restart` invoked via `POST /commands/execute` hung because the command body `await`-ed `server.stop()` on the same socket that was serving the request. Fixed by scheduling the restart on `setImmediate` and returning `{restarting: true}` synchronously so the calling HTTP response can complete.
- **Restart dev-only (Nir's call)** — the restart command is now only registered when `context.extensionMode === Development`. End users who change `port` / `host` / `maxBodySizeBytes` see a "Reload Window" prompt instead. Cleaner UX, smaller production surface.
- **.env almost shipped (caught by vsce)** — first `vsce package` attempt blocked on `.env` being included. Added `.env`, `.env.*`, `.github/**`, and node_modules trimming patterns to `.vscodeignore`. Always inspect `vsce ls --tree` before publishing.
- **Test-shape mismatches** — first E2E run was 24/29: assertions had wrong response shapes for `/tabs/groups`, `/languages/all`, `/lm/models`, `/authentication/accounts` (missing `?providerId=github`), and one openapi check assumed `/health` was in the spec when it isn't (only registry-tracked routes are). All test-side; no extension behavior was wrong.

## What shipped

- v0.1.0 source on GitHub: <https://github.com/niradler/vscode-internals> (initial commit `0bb9bdc`, branch `main`).
- CI: `.github/workflows/ci.yml` running `npm ci && npm run compile && npm run lint` on ubuntu-latest + windows-latest, Node 20.
- `vscode-internals-0.1.0.vsix` built in the repo root (1.7 MB, 437 files, deps included, sensitive files excluded).
- Skill `skills/vscode-automation/` updated: three new recipes (diagnostics-loop, lm, self-test) + refreshed endpoint catalog reflecting the live OpenAPI spec.
- Release docs: `PUBLISHING.md` with the exact `vsce` PAT-and-publish flow; `CHANGELOG.md` for v0.1.0; `LICENSE` (MIT); marketplace icon at `icon.png` (256x256).
- E2E suite at `scripts/e2e.mjs` (29 checks) + `scripts/launch-host.ps1` (boots Extension Development Host and runs the suite end-to-end). Last green run: 29/29 in ~1.6s after the dev-host reload.

## Next steps for Nir

1. Source the PAT and run `npx @vscode/vsce publish` (see `PUBLISHING.md`).
2. After successful publish: `git tag v0.1.0 && git push origin v0.1.0`.
3. Verify the listing at <https://marketplace.visualstudio.com/items?itemName=niradler.vscode-internals>.
4. Optional follow-ups noted by reviewers:
   - README "Example calls" `code --no-sandbox --remote-cli` snippet is misleading — replace with a `Copy Token` instruction.
   - Consider bundling the extension with esbuild to drop the 5 MB+ `node_modules` payload (vsce warning).
   - Run `vsce ls --tree` if you suspect extra files are landing in the package.
