# Editor state & file edits

Reading what the user is working on, and modifying files / opening documents.

Assumes `BASE=http://127.0.0.1:7891` and `TOKEN=vscint_…`. All POSTs need `Authorization: Bearer $TOKEN` and `Content-Type: application/json`.

## Shape notes

- **URIs**: accept either a URI string (`file:///g:/path/x.ts`) or an absolute path (`g:/path/x.ts`). Outbound URIs are objects: `{ scheme, authority, path, query, fragment, fsPath, toString }`. Round-trip with `.toString` or `.fsPath`.
- **Positions** are 0-indexed: `{ line, character }`.
- **Ranges**: `{ start, end }`.
- **Selections** add `{ anchor, active, isReversed, isEmpty }` on top of a range.

## Read editor state

```bash
# Active editor: file URI, selections, visible ranges, language, dirty state
vsc $BASE/window/activeTextEditor

# Selected text — falls back to full doc text if nothing is selected
vsc $BASE/window/selectionText
# → { text, hasSelection }

# All visible editors (multi-pane layouts)
vsc $BASE/window/visibleTextEditors

# Workspace folders + name
vsc $BASE/workspace/folders
vsc $BASE/workspace/name

# Window focus / theme
vsc $BASE/window/state
vsc $BASE/window/activeColorTheme

# Currently open text documents (even unfocused)
vsc $BASE/workspace/textDocuments
```

## Tabs (richer than editors — diff/webview/custom/notebook/terminal)

```bash
# All tab groups + their tabs + which group is active
vsc $BASE/tabs/groups

# Flat list across all groups
vsc $BASE/tabs/list

# Active tab in active group
vsc $BASE/tabs/active

# Close by uri | label | viewColumn+index
vsc -d '{"uri":"file:///g:/p/x.ts"}'           $BASE/tabs/close
vsc -d '{"label":"x.ts","preserveFocus":true}' $BASE/tabs/close
vsc -d '{"viewColumn":1,"index":0}'            $BASE/tabs/close

# Close an entire group
vsc -d '{"viewColumn":2}' $BASE/tabs/closeGroup
```

Each tab's `input` has a discriminator `kind` (`text`, `diff`, `custom`, `webview`, `notebook`, `notebookDiff`, `terminal`, `unknown`) — filter by `kind` before closing.

## Search files

```bash
vsc -d '{"include":"src/**/*.ts","exclude":"**/node_modules/**","maxResults":200}' \
  $BASE/workspace/findFiles
```

## Read files

```bash
# utf8 default; "base64" for binary
vsc -d '{"uri":"file:///g:/p/x.ts","encoding":"utf8"}' $BASE/workspace/readFile

# Get text via the editor pipeline (sees dirty buffers)
vsc -d '{"uri":"file:///g:/p/x.ts"}'                 $BASE/workspace/getDocumentText
vsc -d '{"uri":"file:///g:/p/x.ts","range":{"start":{"line":10,"character":0},"end":{"line":20,"character":0}}}' \
  $BASE/workspace/getDocumentText

# Open a document without focusing — useful before applyEdit, references, etc.
vsc -d '{"uri":"file:///g:/p/x.ts"}'                 $BASE/workspace/openTextDocument
# Untitled buffer with content:
vsc -d '{"content":"hello","language":"markdown"}'   $BASE/workspace/openTextDocument

# Stat / list directory / metadata
vsc -d '{"uri":"file:///g:/p"}'                      $BASE/workspace/stat
vsc -d '{"uri":"file:///g:/p"}'                      $BASE/workspace/readDirectory
```

## Edit files (prefer applyEdit)

`applyEdit` goes through VSCode's edit pipeline so undo, dirty state, formatters, and language clients all see the change. `writeFile` bypasses the editor — only use it for files that aren't open.

```bash
# Atomic multi-file edit. One undo step.
vsc -d '{
  "edits":[
    {"uri":"file:///g:/p/a.ts","changes":[
      {"range":{"start":{"line":10,"character":0},"end":{"line":10,"character":5}},"newText":"const"}
    ]},
    {"uri":"file:///g:/p/b.ts","changes":[ ... ]}
  ]
}' $BASE/workspace/applyEdit

# Write via fs (bypasses editor — formatters/language clients won't see it)
vsc -d '{"uri":"file:///g:/p/x.ts","content":"...","encoding":"utf8"}' $BASE/workspace/writeFile

# Save all dirty buffers
vsc -d '{"includeUntitled":false}' $BASE/workspace/saveAll

# Create/delete/copy/rename
vsc -d '{"uri":"file:///g:/p/new"}'                          $BASE/workspace/createDirectory
vsc -d '{"uri":"file:///g:/p/old","recursive":true,"useTrash":true}' $BASE/workspace/delete
vsc -d '{"source":"file:///a","target":"file:///b","overwrite":false}' $BASE/workspace/copy
vsc -d '{"source":"file:///a","target":"file:///b","overwrite":false}' $BASE/workspace/rename
```

## Show / focus / navigate

```bash
# Open + focus a file; optional selection jumps the cursor
vsc -d '{
  "uri":"file:///g:/p/x.ts",
  "selection":{"start":{"line":42,"character":0},"end":{"line":42,"character":10}},
  "viewColumn":1,"preview":false,"preserveFocus":false
}' $BASE/window/showTextDocument

# Replace the active editor's selection
vsc -d '{"selections":[{"anchor":{"line":0,"character":0},"active":{"line":0,"character":10}}]}' \
  $BASE/window/setSelection

# Scroll active editor to reveal a range
vsc -d '{"range":{"start":{"line":100,"character":0},"end":{"line":100,"character":0}},"revealType":"InCenter"}' \
  $BASE/window/revealRange
```

## Snippets (insert templated text with tab stops)

Use snippets when the agent wants the user to tab through and complete the inserted code (parameter names, defaults, ambiguous choices). Plain `/workspace/applyEdit` is atomic and faster — pick it when there's nothing for the user to fill in.

Syntax: `$1`, `$2` (tab stops), `${1:default}` (placeholder), `${1|a,b,c|}` (choice list), `$0` (final cursor).

```bash
# Ad-hoc snippet at the active editor's cursor / selection.
vsc -d '{"snippet":"console.log(\"${1:msg}\", ${2:value})$0"}' $BASE/window/insertSnippet

# Target a non-active visible editor by URI.
vsc -d '{"uri":"file:///g/p/x.ts","snippet":"// TODO: $1"}' $BASE/window/insertSnippet

# Multi-cursor — array of Positions or Ranges.
vsc -d '{
  "snippet":"// $1",
  "location":[{"line":10,"character":0},{"line":20,"character":0}]
}' $BASE/window/insertSnippet
```

Returns `{ok: boolean}`. Cursor lands at `$1` (or `$0` if there are no numbered stops). The user tabs forward through stops; on the last tab, focus lands at `$0` and the snippet session ends.

### Persistent named snippets (define once, reuse via IntelliSense)

For snippets the user (or agent) will reuse across files: write a `.code-snippets` JSON file, then trigger by name.

```bash
# 1. Write a workspace-scoped snippet file
vsc -d '{
  "uri":"file:///g/p/.vscode/agent.code-snippets",
  "content":"{\n  \"log error\": {\n    \"scope\": \"javascript,typescript\",\n    \"prefix\": \"logerr\",\n    \"body\": [\"console.error(\\\"${1:msg}\\\", ${2:err});\", \"$0\"],\n    \"description\": \"Log an error\"\n  }\n}"
}' $BASE/workspace/fs/writeFile

# 2. Trigger by name (user can also type "logerr" + Tab in the editor)
vsc -d '{"command":"editor.action.insertSnippet","args":[{"name":"log error"}]}' $BASE/commands/execute
# Or pin to a language: args:[{"langId":"typescript","name":"log error"}]
```

Other snippet drivers (still via `/commands/execute`):

- `editor.action.surroundWithSnippet` — palette picker that wraps the current selection
- `jumpToNextSnippetPlaceholder` / `jumpToPrevSnippetPlaceholder` / `leaveSnippet` — drive an in-flight snippet without keyboard

## Settings / configuration

```bash
# Read a configuration section (e.g. "editor", "files", "launch", "tasks")
vsc "$BASE/workspace/configuration?section=editor"

# Update a setting; target = global | workspace | workspaceFolder
vsc -d '{"section":"editor.formatOnSave","value":true,"target":"workspace"}' \
  $BASE/workspace/updateConfiguration
```

## Workspace folders

```bash
vsc $BASE/workspace/folders
vsc -d '{"uri":"file:///g:/p/x.ts"}' $BASE/workspace/getWorkspaceFolder
vsc -d '{"path":"g:/p/x.ts","includeWorkspaceFolder":false}' $BASE/workspace/asRelativePath

# Add/remove/replace folders. `start` is the insertion index.
vsc -d '{"start":0,"deleteCount":0,"folders":[{"uri":"file:///g:/new","name":"New"}]}' \
  $BASE/workspace/updateWorkspaceFolders
```

## Gotchas

- Always prefer one big `applyEdit` over many small ones — atomic, one undo step, language clients re-analyze once.
- `getDocumentText` reads from the editor (sees dirty buffers); `readFile` reads from disk. If the user has unsaved changes, choose accordingly.
- `setSelection` only affects the active editor — if focus moved, your call no-ops or errors. Re-fetch `/window/activeTextEditor` first when unsure.
- `showTextDocument` with `preview:true` (default in some flows) replaces the previous preview tab — set `preview:false` to pin.
