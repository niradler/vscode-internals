# Recipes

Multi-step workflows that chain endpoints. Each recipe assumes `BASE=http://127.0.0.1:7891` and a valid `TOKEN`. Examples use bash-style `-d '...'`; on Windows PowerShell, swap to the `--data-binary "@-"` here-string pattern shown in SKILL.md.

## Recipe 1: Rename the symbol under the user's cursor, with confirmation

The user says "rename what I'm pointing at". You need: the active editor, the cursor position, a proposed new name, then a preview-then-apply rename.

```bash
# 1. Get the active editor + cursor.
ED=$(curl -sS -H "Authorization: Bearer $TOKEN" $BASE/window/activeTextEditor)
URI=$(echo "$ED" | jq -r '.document.uri.toString')
LINE=$(echo "$ED" | jq -r '.selection.active.line')
CHAR=$(echo "$ED" | jq -r '.selection.active.character')

# 2. Confirm the symbol with hover (so you're renaming what the user meant).
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"uri\":\"$URI\",\"position\":{\"line\":$LINE,\"character\":$CHAR}}" \
  $BASE/languages/hover

# 3. Preview: rename without applying. The response shows every file that would change.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"uri\":\"$URI\",\"position\":{\"line\":$LINE,\"character\":$CHAR},\"newName\":\"newName\",\"apply\":false}" \
  $BASE/languages/rename

# 4. Apply once the user agrees.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"uri\":\"$URI\",\"position\":{\"line\":$LINE,\"character\":$CHAR},\"newName\":\"newName\",\"apply\":true}" \
  $BASE/languages/rename
```

Why preview first: rename touches every reference and can spread across files you didn't expect. Surfacing the edit summary lets the user catch surprises.

## Recipe 2: Open a file at a specific symbol

The user says "open `getUser` in the project". Use workspace symbols, then jump to its location.

```bash
RESULTS=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"query":"getUser"}' $BASE/languages/workspaceSymbols)

# Pick the first match (or prompt the user with showQuickPick for multiple).
URI=$(echo "$RESULTS" | jq -r '.[0].location.uri.toString')
RANGE=$(echo "$RESULTS" | jq -c '.[0].location.range')

curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"uri\":\"$URI\",\"selection\":$RANGE}" \
  $BASE/window/showTextDocument
```

For multiple matches, route them through `/window/showQuickPick`:

```bash
LABELS=$(echo "$RESULTS" | jq -c '[.[] | "\(.name)  ·  \(.containerName)  ·  \(.location.uri.fsPath)"]')
PICKED=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"items\":$LABELS,\"placeHolder\":\"Pick a symbol\"}" \
  $BASE/window/showQuickPick | jq -r .selected)
```

## Recipe 3: Bulk-edit files matching a pattern

The user says "in every `*.ts` under `src/`, replace `oldLogger` with `newLogger` at imports". Combine `findFiles` + `getDocumentText` + `applyEdit`.

```bash
FILES=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"include":"src/**/*.ts","exclude":"**/node_modules/**","maxResults":1000}' \
  $BASE/workspace/findFiles)

EDITS='[]'
for URI in $(echo "$FILES" | jq -r '.[].toString'); do
  TEXT=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    -d "{\"uri\":\"$URI\"}" $BASE/workspace/getDocumentText | jq -r .text)

  # Compute line/char of each occurrence in $TEXT (e.g. with awk), build change entries,
  # and append to $EDITS. Build the full WorkspaceEdit, then submit once:
done

curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"edits\":$EDITS}" $BASE/workspace/applyEdit
```

Always prefer one big `applyEdit` over many small ones — it's atomic, it's one undo step, and language clients only run their analysis once.

## Recipe 4: Wait for a save, then run a check

The user is iterating on a file. You want to lint it every time they save.

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  "$BASE/events?subscribe=onDidSaveTextDocument" |
while IFS= read -r LINE; do
  case "$LINE" in
    "event: onDidSaveTextDocument") ;;
    "data: "*)
      PAYLOAD=${LINE#data: }
      URI=$(echo "$PAYLOAD" | jq -r '.uri.toString')
      [ "$URI" != "null" ] && curl -sS -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "{\"uri\":\"$URI\"}" $BASE/languages/diagnostics
      ;;
  esac
done
```

SSE keeps the connection open. The 25-second heartbeat appears as `: <comment>` lines you can ignore.

## Recipe 5: Reproduce a bug — set a breakpoint, start debug, inspect variables

```bash
# 1. Add a conditional breakpoint.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uri":"file:///g:/p/server.ts","line":42,"condition":"req.userId == null"}' \
  $BASE/debug/addBreakpoint

# 2. Start a named launch config.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"nameOrConfig":"Launch Server"}' $BASE/debug/start

# 3. Subscribe to onDidStartDebugSession in another shell, or poll /debug/activeSession.

# 4. Once the breakpoint hits, get the stack and variables via DAP.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"command":"stackTrace","args":{"threadId":1}}' $BASE/debug/customRequest

# Grab a frameId from the response, then:
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"command":"scopes","args":{"frameId":1000}}' $BASE/debug/customRequest

# 5. Read variables of a scope.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"command":"variables","args":{"variablesReference":5}}' $BASE/debug/customRequest

# 6. Step or continue.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"command":"continue","args":{"threadId":1}}' $BASE/debug/customRequest
```

The `customRequest` payload is whatever the underlying debug adapter expects — refer to the DAP spec for the field names.

## Recipe 6: Build then test, with structured task lifecycle

```bash
# Start the build task.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"build"}' $BASE/tasks/execute

# Watch for it finishing.
curl -N -H "Authorization: Bearer $TOKEN" \
  "$BASE/events?subscribe=onDidEndTaskProcess" |
while read -r LINE; do
  case "$LINE" in
    "data: "*)
      PAYLOAD=${LINE#data: }
      NAME=$(echo "$PAYLOAD" | jq -r '.name')
      CODE=$(echo "$PAYLOAD" | jq -r '.exitCode')
      [ "$NAME" = "build" ] && [ "$CODE" = "0" ] && {
        curl -sS -H "Authorization: Bearer $TOKEN" -X POST $BASE/tests/runAll
        break
      }
      ;;
  esac
done
```

## Recipe 7: Show progress to the user with the status bar

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"text":"$(loading~spin) Indexing…","hideAfterMs":10000}' \
  $BASE/window/setStatusBarMessage
```

VSCode supports product icons in `$(name)` syntax and `~spin` for spinning. For longer-running work, prefer a notification with buttons via `/window/showInformationMessage`.

## Recipe 8: Diagnostics autofix loop

Watch diagnostics change for the active file, fetch them, ask Copilot/Claude for code actions, apply them. This is the highest-leverage dev-cycle workflow — the language server already knows what's wrong; you're just routing the fix.

```bash
# 1. Subscribe to onDidChangeDiagnostics. The payload is { uris: [...] }.
curl -N -H "Authorization: Bearer $TOKEN" \
  "$BASE/events?subscribe=onDidChangeDiagnostics" |
while IFS= read -r LINE; do
  case "$LINE" in
    "data: "*)
      PAYLOAD=${LINE#data: }
      URI=$(echo "$PAYLOAD" | jq -r '.uris[0].toString')
      [ "$URI" = "null" ] && continue

      # 2. Pull the actual diagnostics for that file.
      DIAGS=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d "{\"uri\":\"$URI\"}" $BASE/languages/diagnostics)

      # 3. For each error, ask for code actions (LSP quick fixes) at the diagnostic's range.
      ACTIONS=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        -d "{\"uri\":\"$URI\",\"range\":$(echo "$DIAGS" | jq '.[0].range'),\"only\":\"quickfix\"}" \
        $BASE/languages/codeActions)

      # 4. If no automatic quickfix, hand the diagnostic + surrounding code to Copilot.
      [ "$(echo "$ACTIONS" | jq 'length')" = "0" ] && {
        SRC=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
          -d "{\"uri\":\"$URI\"}" $BASE/workspace/getDocumentText | jq -r .text)
        curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
          -d "{\"selector\":{\"vendor\":\"copilot\",\"family\":\"claude-haiku-4.5\"},
               \"messages\":[{\"role\":\"user\",
                              \"content\":\"Fix this diagnostic: $(echo $DIAGS | jq -c .[0]) in:\n$SRC\"}]}" \
          $BASE/lm/sendRequest
      }
      ;;
  esac
done
```

The pattern: language server flags problems → diagnostics endpoint gives you the structured error → code actions handles known fixes → LM handles novel ones. All using the user's already-signed-in Copilot.

## Recipe 9: Stream a Copilot completion into a file

The user says "explain this file in a comment at the top". Stream the LM response so the user sees output incrementally, then apply once.

```bash
SRC=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"uri":"file:///g:/p/foo.ts"}' $BASE/workspace/getDocumentText | jq -r .text)

OUT=""
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary "{\"selector\":{\"vendor\":\"copilot\",\"family\":\"gpt-4o\"},
                  \"messages\":[{\"role\":\"user\",\"content\":\"Write a top-of-file JSDoc block explaining:\n$SRC\"}]}" \
  "$BASE/lm/sendRequestStream" |
while IFS= read -r LINE; do
  case "$LINE" in
    "data: "*)
      CHUNK=$(echo "${LINE#data: }" | jq -r '.text // empty')
      [ -n "$CHUNK" ] && OUT="$OUT$CHUNK" && printf '%s' "$CHUNK"
      ;;
  esac
done

# Once the stream finishes, prepend $OUT to the file via applyEdit.
```

`event: done` carries the full `totalText` — you can use that instead of accumulating chunks yourself if you don't care about progress.

## Recipe 10: Discover what's possible right now

```bash
# Full live OpenAPI.
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/openapi.json | jq '.paths | keys'

# All known events.
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/events/available

# All command IDs containing "format".
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/commands/list?filter=format" | jq '.commands'
```

If a route you expected is missing, re-check `/openapi.json` — other extensions can register their own endpoints at runtime under their own tag, and that's also where future `/ports/*` and `/extensions/invoke` namespaces will appear.

## Recipe 11: Diagnostics-driven autofix loop

Goal: react to every diagnostics change, fetch the current diagnostics for the affected file, ask the language server for available code actions per diagnostic, and (optionally) apply the chosen action through `/workspace/applyEdit`. This is what an "always-on linter assistant" looks like — no polling, no rescanning, just LSP results routed through quick-fix.

The shape of an `onDidChangeDiagnostics` SSE payload is `{ uris: [Uri, ...] }` — one event can mention several files at once. `/languages/diagnostics` returns a bare array of `Diagnostic` for a single URI (or a `Record<uriString, Diagnostic[]>` if you POST `{}`). `/languages/codeActions` returns a bare array of `CodeAction` / `Command` objects, each potentially carrying an `edit` (a `WorkspaceEdit`) you can hand straight to `/workspace/applyEdit`.

```bash
BASE=http://127.0.0.1:7891

curl -N -H "Authorization: Bearer $TOKEN" \
  "$BASE/events?subscribe=onDidChangeDiagnostics" |
while IFS= read -r LINE; do
  case "$LINE" in
    "data: "*)
      PAYLOAD=${LINE#data: }
      # Each event lists one or more URIs that just changed.
      for URI in $(echo "$PAYLOAD" | jq -r '.uris[]?.toString // empty'); do
        DIAGS=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
          -d "{\"uri\":\"$URI\"}" $BASE/languages/diagnostics)
        COUNT=$(echo "$DIAGS" | jq 'length')
        [ "$COUNT" = "0" ] && continue
        echo "=== $URI : $COUNT diagnostics ==="

        # For each diagnostic, ask for quick-fix code actions at its range.
        echo "$DIAGS" | jq -c '.[]' | while IFS= read -r DIAG; do
          RANGE=$(echo "$DIAG" | jq -c '.range')
          MSG=$(echo "$DIAG" | jq -r '.message')
          ACTIONS=$(curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
            -d "{\"uri\":\"$URI\",\"range\":$RANGE,\"only\":\"quickfix\"}" \
            $BASE/languages/codeActions)
          N=$(echo "$ACTIONS" | jq 'length')
          echo "  [$MSG] → $N quick fixes"

          # Auto-apply the first action that carries an inline WorkspaceEdit. Skip
          # actions that are command-only (they'd need /commands/execute instead).
          EDIT=$(echo "$ACTIONS" | jq -c 'map(select(.edit)) | .[0].edit // empty')
          if [ -n "$EDIT" ] && [ "$EDIT" != "null" ]; then
            curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
              -d "{\"edits\":$(echo "$EDIT" | jq '.documentChanges // .changes')}" \
              $BASE/workspace/applyEdit
          fi
        done
      done
      ;;
  esac
done
```

Watch out for:

- Debounce. `onDidChangeDiagnostics` fires often — every keystroke can trigger one. If your loop calls an LM per diagnostic you will burn through quota fast. Filter by severity (`error` only) or coalesce by URI before acting.
- Loops. Applying an edit causes new diagnostics, which re-fires the event. Either ignore events you triggered (track a "just applied" set) or set a minimum quiet interval before acting on the same URI again.
- Command-only actions. A `CodeAction` can carry `command` instead of `edit` — to invoke those you POST `/commands/execute` with `{command, args}` rather than `applyEdit`. Inspect the action shape first.
- `/workspace/applyEdit` expects either an `edits: [{uri, changes}]` array or a `WorkspaceEdit`-shaped object; the code above pulls whichever the action provided.

For one-off (non-streaming) use, swap the SSE loop for a polling `curl -d '{}' $BASE/languages/diagnostics` and walk the returned `Record<uriString, Diagnostic[]>` instead.

## Recipe 12: Drive Copilot / Claude through `/lm/*` from an external script

Goal: have the user's already-signed-in Copilot or Claude model do work for you — explanation, refactor proposal, summarization, classification — without proxying through your own API keys. The user pays the consent cost once; after that every chat model VSCode sees is reachable through the same bearer token.

Step 1 — discover models. Both list endpoints return an object wrapper, not a bare array:

```bash
BASE=http://127.0.0.1:7891

# All models (object: { models: [...] }).
curl -sS -H "Authorization: Bearer $TOKEN" $BASE/lm/models | jq '.models[] | {id, vendor, family, maxInputTokens}'

# Narrow by selector (same wrapper shape).
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"vendor":"copilot"}' $BASE/lm/selectChatModels | jq '.models[].family'

# All Claude-family models the user has access to.
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"family":"claude-sonnet-4.5"}' $BASE/lm/selectChatModels
```

Step 2 — token-count the prompt before sending. `maxInputTokens` from `/lm/models` is the ceiling; if you exceed it the model errors. `/lm/countTokens` uses that specific model's tokenizer (Claude and GPT-4o disagree by 10-20%):

```bash
PROMPT=$(cat ./big-file.ts | jq -Rs .)
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"selector\":{\"family\":\"gpt-4o\"},\"text\":$PROMPT}" \
  $BASE/lm/countTokens
# → {"model":{...},"tokens":12873}
```

Step 3a — non-streaming request. `/lm/sendRequest` collects the whole reply and returns `{ model, text }`:

```bash
curl -sS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "selector": {"vendor":"copilot","family":"claude-sonnet-4.5"},
    "messages": [
      {"role":"user","content":"In one sentence: what does this file do?\n\n<file contents>"}
    ],
    "modelOptions": {"temperature": 0.2},
    "justification": "Summarizing source for the user from an external script"
  }' \
  $BASE/lm/sendRequest
# → { "model": { id, vendor, family, ... }, "text": "..." }
```

Step 3b — streaming request. `/lm/sendRequestStream` is SSE; you get an `event: model` opener, many `event: chunk` lines, then `event: done` (or `event: error`). Use this for any reply long enough to be worth showing the user incrementally, or when you want to short-circuit early:

```bash
curl -N -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary '{
    "selector": {"vendor":"copilot","family":"claude-sonnet-4.5"},
    "messages": [{"role":"user","content":"Walk through this codebase architecture"}]
  }' \
  "$BASE/lm/sendRequestStream" |
while IFS= read -r LINE; do
  case "$LINE" in
    "event: model") read -r DATA; echo "model: $(echo "${DATA#data: }" | jq -r '.family')" ;;
    "event: chunk") read -r DATA; printf '%s' "$(echo "${DATA#data: }" | jq -r '.text // empty')" ;;
    "event: done")  read -r DATA; echo; echo "[done: $(echo "${DATA#data: }" | jq -r '.totalChars') chars]" ;;
    "event: error") read -r DATA; echo "ERROR: $(echo "${DATA#data: }" | jq -r '.message')" ;;
  esac
done
```

PowerShell equivalent for the non-streaming POST (avoiding the inline-quoting trap):

```powershell
@'
{"selector":{"vendor":"copilot","family":"claude-sonnet-4.5"},
 "messages":[{"role":"user","content":"reply with PONG"}]}
'@ | curl.exe -sS -H "Authorization: Bearer $env:TOKEN" -H "Content-Type: application/json" `
  --data-binary "@-" "$env:BASE/lm/sendRequest"
```

Watch out for:

- First-call consent. The very first `/lm/*` call from this extension shows a modal prompt to the user ("Allow vscode-internals to use language models?"). If your script is unattended, send a trivial warm-up request once interactively first, or expect a `LanguageModelError.NoPermissions`-shaped error on stream `event: error`.
- Selector misses. An empty `.models` array from `/lm/selectChatModels` means no model matched — typos in `family` are silent. Always list first.
- Model availability drifts. Copilot rotates families; subscribe to `onDidChangeChatModels` if you're a long-running process.
- The `LanguageModelError` surfaces on `event: error` for streaming and as a non-2xx response (with `{message, code, name}`) for `sendRequest`. The error name (`Blocked`, `NoPermissions`, `NotFound`) is the actionable bit — log it.

## Recipe 13: Self-test the extension after install

Goal: a third-party script that wants to depend on `niradler.vscode-internals` should verify on startup that the extension is up, the bearer token is valid, the namespaces it cares about are present, and SSE works — then bail out with a clear message if anything's off. This mirrors what `scripts/e2e.mjs` does in this repo; lift it as a template.

```bash
BASE=http://127.0.0.1:7891
# TOKEN must already be set. See "Getting the token" below.

# 1. Liveness — public, no auth.
curl -sS --fail "$BASE/health" >/dev/null || { echo "extension not running at $BASE"; exit 1; }

# 2. Live OpenAPI — public, no auth. Confirm the namespaces you depend on.
SPEC=$(curl -sS "$BASE/openapi.json")
for ns in workspace window languages lm extensions; do
  echo "$SPEC" | jq -e --arg p "/$ns/" '.paths | keys[] | select(startswith($p))' >/dev/null \
    || { echo "missing namespace: $ns"; exit 1; }
done

# 3. Auth gate — invalid token must 401.
CODE=$(curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer vscint_bogus" "$BASE/workspace/folders")
[ "$CODE" = "401" ] || { echo "auth gate broken (got $CODE)"; exit 1; }

# 4. Representative read-only call per namespace.
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/workspace/folders"        | jq -e 'type=="array"' >/dev/null
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/window/state"             | jq -e '.focused | type=="boolean"' >/dev/null
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/env/info"                 | jq -e '.appName | type=="string"' >/dev/null
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/extensions/list"          | jq -e 'map(select(.id=="niradler.vscode-internals")) | length==1' >/dev/null

# 5. SSE handshake — subscribe briefly to onDidChangeWindowState. The server emits
# event: ready as the first frame; bail as soon as we see it.
timeout 4 curl -sS -N -H "Authorization: Bearer $TOKEN" \
  "$BASE/events?subscribe=onDidChangeWindowState" | grep -q "^event: ready" \
  || { echo "SSE handshake failed"; exit 1; }

echo "vscode-internals self-test OK"
```

`scripts/e2e.mjs` in this repo is the canonical fleshed-out version (with per-namespace assertions, structured pass/fail counts, JSON results output, and a startup-timeout retry on `/health`). Crib from it when you want more than a smoke test.

Getting the token — this is the part that surprises people:

- **Production / marketplace install.** There is no handshake file. The user must run Command Palette → **VSCode Internals: Copy Token to Clipboard** (or **Show Token**) and hand the token to your script (env var, prompt, paste). Your script must not assume it can find the token anywhere on disk.
- **Extension Development Host only.** When the extension runs in dev mode (`F5` from this repo, or `scripts/launch-host.ps1`), it drops `{url, token, pid, writtenAt}` into `<tmpdir>/niradler.vscode-internals.dev.json` (`%TEMP%` on Windows, `/tmp` on Linux/macOS). The E2E runner reads that file directly. **This file is never written by an installed marketplace build** — `context.extensionMode === Development` is the gate.

Watch out for:

- `/openapi.json` lists only registry-tracked endpoints — the four public paths (`/health`, `/openapi.json`, `/docs`, `/docs/assets/*`) are not in `spec.paths`. Don't assert on them.
- A 404 on a route you saw in earlier docs is not necessarily a regression: other extensions can register their own endpoints via `registerEndpoint`, so the catalog grows and shrinks across reloads. Re-fetch `/openapi.json` if anything's surprising.
- Don't try to start or restart the extension yourself. `vscodeInternals.restart` is registered only in Extension Development Host mode; in a normal install it doesn't exist. If you need a clean state, ask the user to run **Developer: Reload Window**.
