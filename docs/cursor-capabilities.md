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

## Probe log — area by area

This section is the verified ground truth. Each row is a real probe run via `/dev/eval` against a running Cursor 1.105.1 EDH. Updated as areas are probed.

### Area #1: Agents lifecycle ✅ probed

| Capability | Result | Evidence |
| --- | --- | --- |
| List all loaded composers + per-agent state | ✅ works via `composer.getComposerHandleById(seedId).manager.loadedComposers.byId` | Returns object map of UUID → full state record (~70 fields each: text, conversationMap, modelConfig, status, todos, capabilities, diff stats, timestamps) |
| Get currently-selected agent ids | ✅ `composer.getOrderedSelectedComposerIds` | Returns array of UUIDs |
| Get one agent's full state | ✅ same path | Use seed id, then index byId[targetId] |
| Detect "is this agent generating?" | ✅ `state.status` | "none" / "generating" / etc. |
| Read input box content | ✅ `state.text` / `state.richText` | |
| Read messages (conversation) | ✅ clean via targeted field extraction on `state.conversationMap` | Verified on a live "hello" exchange: bubble fields `bubbleId`/`type`/`text`/`richText`/`createdAt`/`tokenCount`/`modelName`/`finishReason`. `type:1` = user, `type:2` = assistant. Turn duration in `conversationHeaders[i].grouping.turnDurationMs`. Raw `conversationMap` would explode (24MB observed) — sanitized field-pick is what works. |
| Read current model selection | ✅ `state.modelConfig` | `{modelName, maxMode, selectedModels:[{modelId, parameters}]}` |
| Read agent's pending todos | ✅ `state.todos` | Cursor agent task list |
| Read diff stats | ✅ `state.totalLinesAdded/Removed`, `state.addedFiles/removedFiles` | |
| Read worktree state | ✅ `state.isCreatingWorktree`, `isApplyingWorktree`, `applied` flags | |
| List glass cloud agents (separate from composers) | ⚠️ no public listing. Cloud-agent state lives in a file-backed store revealed by `glass.agentStore.revealDir`. File-read approach would work but wasn't pursued here. | |
| Open new agent (empty) | ❌ `glass.newAgent` returns undefined; no observable state change in `byId` map | UI side-effect only — possibly requires UI focus context |
| Open new agent with prompt | ❌ `glass.newAgentWithQuery("prompt")` same — no state change | |
| Submit prompt to existing agent | ❌ none of `composer.sendToAgent`, `composer.startComposerPrompt`, `composer.startComposerPrompt2` produce observable effect across 12 arg-shape variants. No `composer.submit` / `composer.send` exists. Manager prototype has no send/submit method. | Direct field write (`c.text = "..."`) propagates in JS but doesn't reach the UI; `vscode.commands.executeCommand("type", {text})` doesn't reach the webview input either. |
| Switch model | (probed in area #2) | |
| Archive agent | ✅ `glass.archiveActiveAgent` (no return) | UI side-effect; archives the focused agent |
| Open agent by id | ✅ `glass.openAgentById(uuid)` (no return) | UI side-effect; opens the agent tab |
| Cmd-K inline edit | (probed in area #6) | |
| Tab autocomplete | (out of scope per Nir) | |

**Bottom line for area #1.** The READ side is rich — we get full agent state including model, **the actual conversation text in both directions**, todos, diff stats, and worktree state. The WRITE side is essentially closed: no public path to programmatically dispatch a prompt to a composer. UI-visible state-change commands (`glass.newAgent`, `glass.archiveActiveAgent`, `glass.openAgentById`) work as side effects but return nothing useful.

### Area #2: Model selection ⚠️ low-value (stopped early)

| Capability | Result |
| --- | --- |
| List available models | ❌ `vscode.lm.selectChatModels()` returns `[]` — Cursor proprietary LM, not VSCode-LM-compatible |
| Read agent's selected model | ⚠️ `state.modelConfig.modelName` always `"default"` even after a real exchange — placeholder meaning "use whatever Cursor decides". Real model not exposed. |
| Read which model answered a given message | ❌ Assistant bubbles only carry `tokenCount`, no `modelName` field present |
| Switch model via command | ❌ `glass.cursorai.action.switchToModelSlug(slug)` tried with 8 real Claude/GPT slugs — `modelConfig.modelName` unchanged. UI-only. |

**Stopped here per Nir's call.** Bottom line: model selection is essentially a black box from outside the built-in API. The `modelConfig` field already surfaces through `/cursor/agents` for callers who care; no dedicated `/cursor/models` endpoint earns its keep because there's nothing real to expose beyond `"default"`. Switching is impossible. If Cursor adds a public API later, revisit.

### Area #3: LLM call from extension ❌ closed by design

| Capability | Result |
| --- | --- |
| `vscode.lm.selectChatModels()` (any selector) | Returns `[]`. Cursor doesn't surface its LLM through standard vscode.lm API. |
| `vscode.lm.computeEmbeddings` | ❌ `embeddings` proposed API gated to built-in extensions. |
| `vscode.lm.invokeTool` + `vscode.lm.tools` | Function callable, but `tools` array is empty — no MCP/LM tools in the standard registry (Cursor's MCP tools live in the private `vscode.cursor.*` namespace). |
| `cursorai.action.generateInTerminal` | UI-only — accepts arg shapes, returns null, no observable effect. |
| `vscode.chat.createChatParticipant("vscint", handler)` | ✅ creation succeeds. **Unverified** whether Cursor's glass UI actually routes `@vscint` to a third-party participant. Would need a persistent registration + manual `@vscint` test in the chat. |

**Stopped here per Nir's call.** Net: no "extension asks Cursor's LLM" path. Deliberate moat — Cursor doesn't want third-party extensions consuming its credits. The only door that's *open* is the inverse direction (Cursor invokes our `chat.createChatParticipant` handler) and it's uncertain in Cursor's UI; revisit if a real use case demands it.

### Area #4: Codebase indexing ❌ mostly closed

| Capability | Result |
| --- | --- |
| Trigger repo indexing | ✅ `cursorai.action.repo.indexMainRepository` (returns null, no completion signal) |
| Read indexing status / events | ❌ `vscode.cursor.onDidChangeIndexingStatus`, `shouldIndexNewRepos`, `indexingGrepEnabled` all gated |
| Trigger semantic search programmatically | ❌ `vscode.cursor.getSemanticSearchResultsFromServer` gated |
| Read `cursor.semanticSearch.*` config | ✅ standard `vscode.workspace.getConfiguration("cursor.semanticSearch")` — already reachable via `/workspace/configuration?section=cursor.semanticSearch` |
| Get ripgrep binary path | ✅ `vscode.cursor.rgPath` — one of the few non-function cursor.* properties not gated. Returns `c:\Users\…\cursor\resources\app\node_modules\@vscode\ripgrep\bin\rg.exe`. |
| `cursor.checkOkToIndexLink` | ⚠️ **interactive** — timed out at 10s during probe. Shows a permission dialog. Not safe to expose without explicit user-consent handling. |

**Nothing earns its keep here.** Triggering indexing is one `/commands/execute cursorai.action.repo.indexMainRepository` away. Status reading is closed. The `rgPath` is reachable via `/dev/eval` if anyone needs it; not worth a permanent endpoint.

### Area #5: MCP tool invocation ❌ completely closed

| Capability | Result |
| --- | --- |
| List enabled MCP server IDs | ❌ `vscode.cursor.getEnabledMcpServerIds()` gated |
| List enabled MCP tools | ❌ `vscode.cursor.getEnabledMcpTools()` gated |
| Get MCP snapshot per server | ❌ `getMcpSnapshot(s)`, `getMcpSnapshotTools`, `getMcpServerTools` all gated |
| Call an MCP tool by name | ❌ `vscode.cursor.callMcpLeaseTool` gated |
| Read MCP lease resources/prompts/instructions | ❌ `getMcpLeaseServers/Resources/Prompt(s)/Instructions`, `readMcpLeaseResource` all gated |
| `vscode.lm.tools` registry (standard) | ❌ empty even with active MCP servers — Cursor doesn't bridge MCP tools to the standard LM registry |
| `mcp.*` commands (19 total) | ⚠️ system-level only (probe/refresh/oauth/diskKV/elicitation) — no "call a tool" entry point |

**Trigger commands** that work (no return value, no observable effect from outside): `mcp.probeAllServers`, `mcp.refreshSnapshot`, `mcp.reloadClient`, `mcp.retryExhaustedServers`.

**What's reachable through existing endpoints (recipes):**

- Configured servers: `/workspace/readFile` on `~/.cursor/mcp.json` (warn re: secrets in response)
- Active servers (best-effort): filter `/commands/list` for `workbench.action.output.show.anysphere.cursor-mcp.MCP <id>.workspaceId-…`

**Verdict.** No endpoint to build. Cursor's MCP is a closed subsystem for third-party extensions. If you need to actually CALL an MCP tool from agent automation, the path is to talk to the MCP server directly (stdio/http per the `mcp.json` config) rather than through Cursor.

### Area #6: Cmd-K inline edit ❌ closed

| Capability | Result |
| --- | --- |
| Trigger Cmd-K inline edit programmatically | ❌ `aipopup.action.modal.generate` returns null for all 6 arg shapes (string, `{prompt}`, `{query}`, `{text}`, `{input}`, undefined). UI-only. |
| Read suggested diff | ❌ no extraction command |
| Accept generated edit | ❌ no `accept` command — only `aipopup.action.closePromptBar` |

**Net:** Cmd-K is locked behind UI keyboard events. The 9 `aipopup.*`/`cmdK.*` commands available are all UI dispatchers, not callable workflows.

### Area #7: Cursor Rules ⚠️ file-based recipe

| Capability | Result |
| --- | --- |
| `vscode.cursor.registerCursorRulesProvider` / `updateCursorRules(InBatches)` / `onDidChangeCursorIgnoredFiles` | ❌ all gated |
| Read / write rules | ✅ **file-based** — `<workspace>/.cursor/rules/*.mdc` (modern) and `<workspace>/.cursorrules` (legacy), plus `~/.cursor/rules/` user-level. All reachable via existing `/workspace/readFile`, `/workspace/findFiles`, `/workspace/writeFile`. |
| `cursor.createRuleFromSelection` / `workbench.action.newCursorRule` | ✅ commands exist (UI-only) — open the rule editor |

**Recipe** (no endpoint needed):

```bash
vsc -d '{"include":"**/.cursor/rules/**/*.mdc"}' $BASE/workspace/findFiles
vsc -d '{"uri":"file:///<workspace>/.cursor/rules/my-rule.mdc"}' $BASE/workspace/readFile
```

### Area #8: Hooks ⚠️ file-based recipe

| Capability | Result |
| --- | --- |
| `vscode.cursor.getConfiguredHooks` / `getHookExecutor` / `onDidChangeHooks` | ❌ all gated |
| `cursor.hooks.initializeUserHooks` command | ✅ initializes the user's hooks directory — UI-side |
| Read configured hooks | ✅ **file-based** — `~/.cursor/hooks/` and workspace `.cursor/hooks/` directories. Reachable via existing `/workspace/readFile`/`findFiles`. |

Same pattern as Rules — recipe, no dedicated endpoint.

### Area #9: Background composers ⚠️ mostly UI

| Capability | Result |
| --- | --- |
| Read background composer info | ✅ `composer.getBackgroundComposerInfo` returns null when none running; presumably returns state when one is. Reachable via `/commands/execute composer.getBackgroundComposerInfo`. |
| Apply / archive / checkout / open cloud agent | ✅ commands exist but UI-only (`workbench.action.backgroundComposer.{applyChangesLocally,archive,checkoutLocally,openCloudAgentById,openMachine,openForwardedPort}`). Run via `/commands/execute` with proper args (unverified shape). |
| Stream background-composer progress | ❌ no public event source |

**Verdict.** The info-read is a one-line `/commands/execute` recipe. The control commands are reachable via `/commands/execute` but would need arg-shape verification under a real cloud-agent session. No dedicated endpoint earns its keep yet.

### Area #10: Sub-agents ✅ already covered

| Capability | Result |
| --- | --- |
| `vscode.cursor.registerSubagentsProvider` | ❌ gated |
| List sub-agents per composer | ✅ already in `/cursor/agents` — fields `subagentComposerIds` + `subComposerIds`, count via `subAgentCount` |
| `glass.openSubagentPreviewInAgentsTray` | ✅ UI command |

**Verdict.** Nothing new — already covered by area #1's endpoint.

### Open follow-up: new event source `onCursorAgentChanged` on the existing bus

Not a new endpoint or SSE stream — just one more name registered on the shared `EventBus`, alongside `onDebugAdapterEvent`, `onDidSaveTextDocument`, etc. Callers reach it via the existing `/events?subscribe=onCursorAgentChanged` and `/events/wait?subscribe=onCursorAgentChanged&filter=…`.

Two implementation candidates:

1. **Direct subscribe.** `composer.getComposerHandleById().manager` is a vscode-emitter-like object — methods may include `onDidChange*`-style hooks somewhere in its disposable graph. Need to inspect the prototype for a public event we can dispose safely. Highest fidelity, most fragile.
2. **Polled-emit.** Inside the extension host, set up a small poll loop on `loadedComposers.byId`, diff against the last-seen state, emit `onCursorAgentChanged` with the delta (added/changed message ids, new status, etc.). Predictable, doesn't depend on Cursor internals beyond what `/cursor/agents` already uses.

Probably (2) — same fragility profile as the snapshot endpoint, no new private-API dependency. Defer until probe-loop finishes; build last so we don't keep restarting Cursor EDH while probing other areas.

### What we'd need to build vs. what's a recipe

| Use case | Status / where |
| --- | --- |
| Detect host is Cursor vs VSCode | ✅ `/env/info` → `appName === "Cursor"` (or check `cursorVersion` field) |
| Enumerate Cursor command surface | ✅ `/commands/list` filtered by namespace prefix |
| List configured MCP servers | ✅ `/workspace/readFile` on `~/.cursor/mcp.json` |
| List active MCP servers | ✅ recipe in this doc (filter `/commands/list`) |
| MCP tool list per server | ❌ gated to built-in extensions or talk-to-server directly |
| List & read all agents | ✅ **`GET /cursor/agents`** (new, this PR) — relies on private internals, may break on Cursor updates |
| Get one agent's full state | ✅ **`GET /cursor/agents?id=<uuid>&include=conversation,todos,capabilities`** |
| Open new agent / send prompt | ❌ no public path (verified). Recipe via `/commands/execute glass.newAgent` works as UI side-effect only |
| Read agent response messages | ⚠️ via `/cursor/agents?id=…&include=conversation` — best-effort field extraction from internal conversation map |
| Stream agent response | ❌ no public surface |
| Accept agent's proposed edits | ✅ **`POST /cursor/chatEditing {action:"accept", path?}`** |
| Discard agent's proposed edits | ✅ **`POST /cursor/chatEditing {action:"discard", path?}`** |
| Register our own chat participant in Cursor's chat | ✅ `vscode.chat.createChatParticipant` works (inverse direction — Cursor invokes us). Out of scope here; would be its own feature. |

## Extension additions in this PR

All `/cursor/*` routes are **only registered when the host is Cursor** — they're invisible in `/openapi.json` on VSCode, not just "supported:false". `/env/info` gains a nullable `cursorVersion` field on every host (null on VSCode).

- **`GET /cursor/agents?id=<uuid>&include=conversation,todos,capabilities,context`** — lists all loaded composer agents with per-agent state summary; `?id=` filters to one; `?include=` adds bulky fields. Reads from Cursor's private extension-host registry (`composer.getComposerHandleById().manager.loadedComposers.byId`). Returns `{error:"shape_changed", detail}` if the internal shape drifts on a future Cursor release.
- **`POST /cursor/chatEditing {action: "accept"|"discard", path?: string}`** — accept or discard the agent's pending edits. With no `path` → `chatEditing.acceptAllFiles` / `discardAllFiles`. With `path` → `chatEditing.acceptFile` / `discardFile` after wrapping `string → vscode.Uri.file(path)`. The Uri wrap is the load-bearing part: `/commands/execute` passes JSON args verbatim, and there's no way to construct a `vscode.Uri` over JSON.
- **`GET /env/info.cursorVersion`** — Cursor's build version (distinct from VSCode base `version`). Null on stock VSCode. Caller computes `isCursor = appName === "Cursor"` themselves.

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
