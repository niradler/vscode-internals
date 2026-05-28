# Changelog

All notable changes to **VSCode Internals** are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.1.0] — 2026-05-28

Initial public release.

### Added

- Token-protected local HTTP server (`127.0.0.1:7891` by default) exposing the full `vscode.*` API.
- Bearer-token auth with constant-time comparison; token stored in `context.secrets` (SecretStorage), never in settings.
- Public unauthenticated endpoints: `GET /health`, `GET /openapi.json`, `GET /docs`, `GET /docs/assets/*`.
- Dynamic OpenAPI 3.1 spec generated from the live endpoint registry.
- Bundled Swagger UI at `/docs` (offline, no CDN).
- SSE event stream at `/events` with 25-second heartbeat.
- Baseline routes across 14 tags: `workspace`, `window`, `tabs`, `languages`, `commands`, `debug`, `tasks`, `scm`, `tests`, `notebooks`, `env`, `ports`, `authentication`, `extensions`, plus `lm` for the Language Model API (Copilot / Claude / GPT / others).
- Public extension API `registerEndpoint(def)` so other extensions can contribute routes that participate in the same auth, dispatcher, and OpenAPI spec.
- Commands: Show / Copy / Regenerate Token, Open API Docs, Restart Server, Show Server Status.
- Output channel (`VSCode Internals`) with configurable log level.

### Security

- Loopback bind by default. Changing `vscodeInternals.host` to a non-loopback address surfaces a warning and is reflected in the status bar.
- Token format: `vscint_` + 32 random bytes hex-encoded.

### Known limitations

- Webview / custom-editor content is not exposed.
- `/tests/*` bridges to the testing UI commands only — no structured per-test results yet.
- `/scm/*` is empty if the built-in git extension is disabled.
- `/env/tunnels` / `/env/openTunnel` require enabling the `tunnels` proposed API.
