# Release Notes

Post-release notes: surprises encountered during a release, and follow-ups that didn't make the cut. The per-version commit list is generated on demand from git tags (see [publishing.md](publishing.md#generate-the-release-notes)) and is not duplicated here.

## v0.1.0 — 2026-05-28

Shipped:

- Marketplace listing live: <https://marketplace.visualstudio.com/items?itemName=niradler.vscode-internals>
- Source: <https://github.com/niradler/vscode-internals>, tag `v0.1.0`.
- `.vsix` size 1.7 MB (437 files); deps bundled, sensitive files excluded.

### Issues / surprises

- **Restart-via-API deadlock (fixed)** — `vscodeInternals.restart` invoked via `POST /commands/execute` hung because the command body `await`-ed `server.stop()` on the same socket that was serving the request. Fixed by scheduling the restart on `setImmediate` and returning `{restarting: true}` synchronously so the calling HTTP response can complete.
- **Restart dev-only** — restart command is only registered when `context.extensionMode === Development`. End users who change `port` / `host` / `maxBodySizeBytes` see a "Reload Window" prompt instead.
- **.env almost shipped (caught by vsce)** — first `vsce package` attempt blocked on `.env` being included. Added `.env`, `.env.*`, `.github/**`, and node_modules trimming patterns to `.vscodeignore`. Always inspect `vsce ls --tree` before publishing.
- **Test-shape mismatches** — first E2E run was 24/29: assertions had wrong response shapes for `/tabs/groups`, `/languages/all`, `/lm/models`, `/authentication/accounts` (missing `?providerId=github`), and one openapi check assumed `/health` was in the spec when it isn't (only registry-tracked routes are). All test-side; no extension behavior was wrong.

### Follow-ups

- README "Example calls" `code --no-sandbox --remote-cli` snippet is misleading — replace with a `Copy Token` instruction.
- Bundle the extension with esbuild to drop the ~5 MB `node_modules` payload (vsce warning).
- Add a Swagger UI screenshot to the marketplace listing (re-publish with `images/swagger.png` referenced in README).
- Wire `docs/backlog.md` tier-1 items into a v0.2 milestone — diagnostics-push, file watcher, more SSE events, tunnels proposed API.

## v0.1.2 — 2026-05-29

Shipped:

- PR [#2](https://github.com/niradler/vscode-internals/pull/2) (squash) — Cursor capabilities probe + `/dev/eval` code-injection endpoint + `onDebugAdapterEvent` bus source.
- E2E suite ran 32/32 green against a fresh EDH before publish.

### v0.1.2 issues / surprises

- **`EXTENSION_VERSION` is hardcoded** — [src/extension.ts:13](../src/extension.ts#L13) declares `const EXTENSION_VERSION = '0.1.0'`. `/health`, `/dev/info`, and the OpenAPI `info.version` field all report `0.1.0` while `package.json` is now at `0.1.2`. Pre-existing drift, noticed mid-release but not blocking. Source the version from `package.json` (e.g. `import pkg from '../package.json'` with `resolveJsonModule`) in a follow-up so it can never drift again.
- **`gh release create --notes "$notes"` parses dashes as flags** — when release notes are passed via `--notes` and contain leading-dash bullets, gh interprets them as shorthand flags and fails. Workaround: write notes to a temp file and use `--notes-file`. The publishing doc's inline `--notes "$notes"` recipe should be updated to use `--notes-file` (or stdin via `--notes-file -`) for any future release whose notes contain bullet lines.

### v0.1.2 follow-ups

- De-hardcode `EXTENSION_VERSION` (above). One-line change + tsconfig flag; touches `/health` and `/dev/info` consumers but the value only ever appears in responses, never in route logic.
- Update [docs/publishing.md](publishing.md) step 6 to use `gh release create --notes-file` to avoid the dash-shorthand issue.
