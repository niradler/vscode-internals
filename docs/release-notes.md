# Release Notes

Post-release notes that aren't tracked in `CHANGELOG.md`: surprises encountered during a release, and follow-ups that didn't make the cut.

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
