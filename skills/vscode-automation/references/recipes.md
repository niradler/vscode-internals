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
