# Cursor capabilities — verified findings & extension gaps

Cursor is a VSCode fork. The extension installs and runs unchanged inside Cursor's EDH (`cursor --extensionDevelopmentPath=…`). The full vscode/built-in API surface works as in VSCode (5526 commands, 80 extensions in default profile, `onDebugAdapterEvent` fires, debug loop runs ~1s after warmup).

This doc was rewritten after a live exploration session using the new dev-only `/dev/eval` endpoint. Everything below is verified against a running Cursor 1.105.1 EDH unless explicitly marked TODO.

## How to explore Cursor's internals — `/dev/eval`

When `context.extensionMode === Development`, the extension exposes a code-injection endpoint that runs arbitrary JS inside the extension host. Master key for exploring undocumented namespaces.

```bash
vsc -d '{
  "code": "return Object.keys(vscode.cursor).sort()",
  "timeoutMs": 5000
}' $BASE/dev/eval
# → { result: [...], logs: [...] }
```

Scope vars: `vscode`, `args`, `logger`, `registry`, `events`, `ctx`, `console`, `fs`, `os`, `path`, `require`, `process`. Async — `await` freely. Console output captured into `logs`. Result is JSON-safe (Uri → `{__type:"Uri",toString,fsPath}`, functions → `"<function name>"`, circular → `"<circular>"`, undefined → null). Default timeout 10s, max 60s.

`GET /dev/info` returns host info: `{appName, appHost, appRoot, uriScheme, version, cursorVersion?, pid, platform, nodeVersion, electronVersion}`. Use it to branch behavior based on host.

**Security:** these routes are NEVER registered on marketplace builds. They check `context.extensionMode === Development` at activation. Still bearer-token-gated; anyone with the token can read secrets from disk. Treat the token as sensitive.

## What's actually exposed in Cursor

### `vscode.cursor` — Cursor's private namespace (~130 keys, gated)

Keys returned by `Object.keys(vscode.cursor)`. **All function calls throw** `"Extension cannot use API proposal: cursor. Note: the cursor and control proposals are ONLY available for built-in extensions"` for non-built-in extension IDs. Even `--enable-proposed-api` doesn't unlock it; the runtime gate is an allow-list of built-in IDs.

Notable surface (informational — we can't call them):

- **MCP**: `getEnabledMcpServerIds`, `getEnabledMcpTools`, `getMcpSnapshot(s)`, `getMcpSnapshotTools`, `getMcpServerTools`, `getAllMcpProviders`, `getMcpToolEnablementPolicy`, `callMcpLeaseTool`, `getMcpLease{Servers,Resources,Prompts,Instructions,Prompt}`, `pushMcpSnapshots`, `onDidChangeMcpSnapshots`, `onDidRegisterMcpProvider`, `onDidUnregisterMcpProvider`, `mcp`, `mcpOAuthStore`, `mcpSharedOAuth`
- **Auth**: `getCursorAuthToken`, `getCursorCreds`, `getAuthId`, `membershipType`, `triggerRefreshCursorAuthToken`, `onDidChangeCursorAuthToken`
- **Agents**: `registerAgentProvider`, `registerAgentExecProvider`, `registerSubagentsProvider`, `getManagedSkills`, `updateAgentSkills(InBatches)`
- **Workspace/repo**: `getRepoInfo`, `workspaceId`, `getTeamRepos`, `getTeamAdminSettings`, `getSearchExcludes`, `cursorVersion`, `cursorServerCommit`
- **Telemetry/logging**: `metricsIncrement`, `metricsDistribution`, `metricsGauge`, `logStructuredInfo/Warn/Error/Debug`, `captureException`, `publicLogCapture`
- **Misc**: `getCppEnabled`/`onDidChangeCppEnabled` (Tab/inline AI), `isGlass` (Cursor's chat UI codename), `glassWorkspaceRole`, `getConfiguredHooks`, `getEffectiveUserPlugins`

### `vscode.ai` — minimal AI helpers (callable)

- `getRelatedInformation`
- `registerEmbeddingVectorProvider`
- `registerRelatedInformationProvider`

### `vscode.lm` — language model API (mostly callable)

Standard vscode-lm surface plus Cursor-specific additions. `vscode.lm.tools` is **empty** in Cursor — Cursor's MCP tools are NOT registered through this standard API; they live in `vscode.cursor.getEnabledMcpTools()`.

- `selectChatModels`, `registerChatModelProvider`, `registerLanguageModelChatProvider`
- `tools` (array — empty in Cursor), `registerTool`, `invokeTool`
- `embeddingModels`, `computeEmbeddings`, `registerEmbeddingsProvider`
- `onDidChangeChatModels`, `onDidChangeEmbeddingModels`
- `fileIsIgnored`, `registerIgnoredFileProvider`
- `registerMcpConfigurationProvider`, `registerMcpServerDefinitionProvider` ← MCP register-side is public, but listing isn't

### `vscode.chat` — chat participant API (callable)

- `createChatParticipant`, `createDynamicChatParticipant`
- `onDidDisposeChatSession`
- `registerChatParticipantDetectionProvider`, `registerChatResponseProvider`
- `registerMappedEditsProvider`, `registerMappedEditsProvider2`, `registerRelatedFilesProvider`

### Top-level constants

- `vscode.cursorVersion` → `"3.5.38"` (Cursor build version)
- `vscode.version` → `"1.105.1"` (VSCode base)
- `vscode.env.uriScheme` → `"cursor"` (distinguishes from `"vscode"`)
- `vscode.env.appName` → `"Cursor"`

## Reachable Cursor commands (via `/commands/execute`)

**407 AI/composer/agent commands** show up in `/commands/list`. Working examples:

| Command | Behavior |
|---|---|
| `composer.getCurrentWorkspaceRepoUrl` | Returns repo URL string (verified: returned `github.com/niradler/vscode-internals`) |
| `composer.getOrderedSelectedComposerIds` | Returns array of currently-selected composer UUIDs |
| `composer.getComposerHandleById` (id) | Returns internal handle `{composerId, manager, __GC_COMPOSER_DATA_HANDLE__}`. `manager` is a deep mess of vscode-private state — exposes data via property walks but serializing it explodes (24MB observed). Fragile. |
| `composer.createNew` | Opens a new composer chat tab. Returns null. Side effect only. |
| `composer.exportChatAsMd` | Returns undefined regardless of arg shape. Likely requires the chat to be focused in the UI, or is gated by additional state. **Not a viable read-side API.** |
| `glass.newAgentWithQuery` (prompt) | **Best "send a prompt" entry point.** Opens the agents view with the given query string. Returns null. Mirrors what the user does pressing the new-chat button. |
| `mcp.refreshSnapshot` / `mcp.probeAllServers` | No-throw, returns null. Refresh internal MCP state. |

### MCP — confirmed surface

The standard vscode.lm has MCP register hooks but no public listing. Cursor's `vscode.cursor.getMcpSnapshots()` would give us live state but is gated.

**Workable approach:** read `~/.cursor/mcp.json` directly from disk via `/dev/eval`. Verified — returned the user's full MCP server config (4 servers: shadcn-ui, context7, dependency-checker, github HTTP-transport with bearer auth). Workspace-level `<repo>/.cursor/mcp.json` also supported but not present in this repo.

The 11 actually-active MCP servers were also discoverable from output-channel command names in `/commands/list` (`workbench.action.output.show.anysphere.cursor-mcp.MCP <server-name>.workspaceId-…`).

### Agents view — confirmed entry points

Cursor's chat agents (codenamed "glass" internally) are reachable via 80+ `glass.*` commands:

- `glass.newAgent` — open new agent
- `glass.newAgentWithQuery` (string) — open new agent with initial prompt **← user-equivalent path**
- `glass.newAgentWithContext`, `glass.newAgentWithModel`
- `glass.openAgentById`, `glass.openCloudAgentById`
- `glass.copyAgentDeeplink`, `glass.openActiveAgentInNewWindow`
- `glass.archiveActiveAgent`, `glass.deleteCloudAgentCache`
- `glass.nextAgent`, `glass.agentNavigateBack/Forward`

The agents view itself = the `glass` webview. No introspection API for messages without going through the private composer-handle internals.

## What we can drive vs. what we'd need to build

| Use case | Status |
| --- | --- |
| Detect host is Cursor vs VSCode | ✅ `/dev/info` → check `appName === "Cursor"` or `uriScheme === "cursor"` or `cursorVersion` global |
| Enumerate Cursor command surface | ✅ `/commands/list` filtered by `composer.*`, `glass.*`, `aichat.*`, `mcp.*`, `chatEditing.*`, `cmdK.*` |
| List configured MCP servers | ✅ read `~/.cursor/mcp.json` + `<ws>/.cursor/mcp.json` from disk |
| List active MCP servers | ⚠️ scrape output-channel command names; no direct API for non-built-in extensions |
| MCP tool list per server | ❌ `vscode.cursor.getMcpSnapshotTools()` gated; would need to talk to each MCP server via its own transport directly |
| Open new agent | ✅ `glass.newAgent` |
| Open new agent with prompt | ✅ `glass.newAgentWithQuery("prompt")` |
| Open existing agent by id | ✅ `glass.openAgentById` |
| List active agents | ✅ `composer.getOrderedSelectedComposerIds` |
| Send follow-up message to existing agent | ⚠️ `composer.sendToAgent` accepts args but unverified whether it actually dispatches. Needs sentinel-prompt test that also verifies the response side. |
| Read agent response messages | ❌ `composer.exportChatAsMd` returns undefined; private internals (`composer.getComposerHandleById` → manager) are fragile. No clean API. |
| Stream agent response | ❌ No public surface. Cursor's streaming is internal. |
| Accept agent's proposed edits | ✅ `chatEditing.acceptAllFiles` / `chatEditing.acceptFile` |
| Discard agent's proposed edits | ✅ `chatEditing.discardAllFiles` / `chatEditing.discardFile` |
| Cmd-K inline edit | ✅ via `aipopup.action.modal.generate` (signature unverified) |
| Trigger/accept/reject Tab autocomplete | ❌ no programmatic command surface found |

## Extension additions in this PR

Two changes — one new route, one additive field. Everything else is a recipe via existing endpoints; no duplication, no harm to VSCode (additive field + safe-on-vscode route).

- **`POST /cursor/chatEditing {action: "accept"|"discard", path?: string}`** — the *only* dedicated Cursor route. With no `path` → `chatEditing.acceptAllFiles` / `discardAllFiles`. With `path` → `chatEditing.acceptFile` / `discardFile` after wrapping `string → vscode.Uri.file(path)`. The Uri wrap is the load-bearing part: `/commands/execute` passes JSON args verbatim, and there's no way to construct a `vscode.Uri` over JSON. Returns `{supported:false}` on non-Cursor hosts — no exception, callers on VSCode get a clean signal.
- **`GET /env/info`** — augmented with `cursorVersion` (Cursor's build version, distinct from VSCode base `version`). Null on stock VSCode. Caller computes `isCursor = appName === "Cursor"` themselves.

## Recipes — using existing endpoints to cover Cursor flows

Each operation that didn't earn a dedicated route, done via what's already on the surface:

```bash
# Detect host
APPNAME=$(vsc $BASE/env/info | jq -r .appName)
IS_CURSOR=$([ "$APPNAME" = "Cursor" ] && echo true || echo false)
CURSOR_VER=$(vsc $BASE/env/info | jq -r .cursorVersion)

# Read MCP config (configured servers).
# WARNING: the response contains plaintext bearer tokens / API keys. Don't log it to LLM-visible
# transcripts. If you're piping to an LLM, redact yourself before passing along.
USER_MCP=$(vsc -d '{"uri":"file:///c:/Users/'$USERNAME'/.cursor/mcp.json"}' $BASE/workspace/readFile)
WS_MCP=$(vsc -d '{"uri":"file:///<workspace-root>/.cursor/mcp.json"}' $BASE/workspace/readFile)

# List active MCP servers — scrape output-channel command names
vsc $BASE/commands/list | jq -r '.commands[]
  | select(startswith("workbench.action.output.show.anysphere.cursor-mcp.MCP "))
  | ltrimstr("workbench.action.output.show.anysphere.cursor-mcp.MCP ")
  | split(".workspaceId-")[0]' | sort -u

# Open a new agent (empty)
vsc -d '{"command":"glass.newAgent"}' $BASE/commands/execute

# Open a new agent pre-filled with a prompt (user-equivalent path)
vsc -d '{"command":"glass.newAgentWithQuery","args":["What is 5+5?"]}' $BASE/commands/execute

# Currently-selected agent ids
vsc -d '{"command":"composer.getOrderedSelectedComposerIds"}' $BASE/commands/execute

# Open an existing agent by id
vsc -d '{"command":"glass.openAgentById","args":["7ec8ee75-…"]}' $BASE/commands/execute
```

### Tier 2 — needs more verification first

- **`POST /cursor/composer/sendPrompt`** — wrap `composer.sendToAgent`. Currently unverified whether it actually fires. Validate with sentinel prompt + UI inspection.
- **`POST /cursor/cmdK/run`** — wrap `aipopup.action.modal.generate`. Args shape unverified.
- **`GET /cursor/composer/messages/{id}`** — read messages from a composer. **No clean API exists.** Would require either (a) digging into `composer.getComposerHandleById().manager` internals (fragile), (b) submitting a PR/issue to Cursor asking for a public API, or (c) intercepting WebSocket/transport traffic.

### Tier 3 — gated, would need built-in extension status

- Anything from `vscode.cursor.*` (MCP snapshots, auth, agents API). Would require shipping as a Cursor-built-in extension or finding a sanctioned proposed-API path.

## Open questions

- **`composer.sendToAgent` arg shape and effect** — does it actually dispatch a prompt when called via `/commands/execute`? Test plan: fire with a sentinel like "reply with literally ALPHA", then watch the UI / poll for response in some readable form.
- **`aipopup.action.modal.generate` arg shape** — does it take `{uri, range, prompt}` or just a prompt? Need source inspection or trial-and-error.
- **Stream agent response** — Cursor surfaces nothing for this through commands. Could maybe register a `chat.createChatParticipant` and route prompts through that, but that's a different model than driving Cursor's UI.
- **Cursor-published events** — none of `vscode.cursor.onDid*` events are reachable from a non-built-in extension. Without them, `/cursor/agents/list` requires polling.
- **MCP tool list** — short of talking to each MCP server directly via its declared transport (stdio/http), no API path. Worth investigating later if/when there's a real use case.

## Skill updates

- Add `skills/vscode-automation/references/cursor.md` describing the four `/cursor/*` routes, the `appName === "Cursor"` host-detection pattern, and the `/commands/execute` recipes above for the operations without dedicated routes.
- Cross-link from `endpoints.md` and `SKILL.md`.
- Document `/dev/eval` in a separate `skills/vscode-automation/references/dev.md` — dev-mode only — with the host-detection precondition and the security warning about secret leakage.
