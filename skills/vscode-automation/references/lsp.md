# Language services (LSP)

Hover, definition, references, symbols, diagnostics, code actions, rename, format. All position-based endpoints take 0-indexed `{line, character}`. Results are LSP-shaped JSON.

Assumes `BASE=http://127.0.0.1:7891` and `TOKEN=vscint_…`.

## Hover, navigation, references

```bash
# Hover: types + JSDoc/MDN at position
vsc -d '{"uri":"file:///g:/p/x.ts","position":{"line":42,"character":10}}' $BASE/languages/hover

# Go-to-definition / type-definition / implementation
vsc -d '{"uri":"...","position":{...}}' $BASE/languages/definition
vsc -d '{"uri":"...","position":{...}}' $BASE/languages/typeDefinition
vsc -d '{"uri":"...","position":{...}}' $BASE/languages/implementation

# Find references (call sites). Pass includeDeclaration:false to skip the definition.
vsc -d '{"uri":"...","position":{...},"includeDeclaration":true}' $BASE/languages/references
```

## Symbols

```bash
# Outline of a file (hierarchical) — most stable way to reason about line numbers across edits.
vsc -d '{"uri":"file:///g:/p/x.ts"}' $BASE/languages/documentSymbols

# Search symbols workspace-wide by query string
vsc -d '{"query":"UserService"}' $BASE/languages/workspaceSymbols
```

## Diagnostics

```bash
# Per-file diagnostics
vsc -d '{"uri":"file:///g:/p/x.ts"}' $BASE/languages/diagnostics
# → [ { range, message, severity, source, code }, ... ]

# Full workspace diagnostics (one call!) — omit uri or POST {}
vsc -d '{}' $BASE/languages/diagnostics
# → Record<uriString, Diagnostic[]>
```

`severity` is a string: `error` | `warning` | `information` | `hint`.

## Code actions (quick fix, refactor, source action)

```bash
# Actions in a range. `only` filters by CodeActionKind: "quickfix" | "refactor" | "source" | …
vsc -d '{"uri":"file:///g:/p/x.ts","range":{...},"only":"quickfix"}' $BASE/languages/codeActions
```

Each result is a `CodeAction` or `Command`:
- If it has an inline `edit` (a `WorkspaceEdit`), pass that to `/workspace/applyEdit`.
- If it has only `command`, route through `/commands/execute`.

## Rename & format

```bash
# Preview a rename (apply:false) — response shows every file that would change
vsc -d '{"uri":"...","position":{...},"newName":"foo","apply":false}' $BASE/languages/rename

# Apply once confirmed
vsc -d '{"uri":"...","position":{...},"newName":"foo","apply":true}'  $BASE/languages/rename

# Format an entire document. apply:true writes the edits.
vsc -d '{"uri":"file:///g:/p/x.ts","apply":true}' $BASE/languages/formatDocument
```

## Completions, signatures

```bash
vsc -d '{"uri":"...","position":{...},"triggerCharacter":"."}' $BASE/languages/completions
vsc -d '{"uri":"...","position":{...}}'                        $BASE/languages/signatureHelp
```

## Misc

```bash
# All registered language IDs
vsc $BASE/languages/all

# Force a document's language id (e.g. retype a .txt as markdown)
vsc -d '{"uri":"...","languageId":"markdown"}' $BASE/languages/setTextDocumentLanguage

# Score a DocumentSelector against a doc
vsc -d '{"uri":"...","selector":[{"language":"typescript","scheme":"file"}]}' $BASE/languages/match
```

## Composition patterns

**Cursor-aware explain.** Read editor → hover → definition → small range of definition file → references sample → hand it all to an LLM.

```
GET  /window/activeTextEditor             → uri, position
POST /languages/hover                     → type info
POST /languages/definition                → uri + range of the declaration
POST /workspace/getDocumentText           → text of that range or file
POST /languages/references                → first N call sites
POST /lm/sendRequestStream                → stream explanation to an output channel
```

**Symbol-driven nav with quick pick.**

```
POST /languages/workspaceSymbols { query }
POST /window/showQuickPick { items: [labels] }
POST /window/showTextDocument  { uri, selection: <picked symbol range> }
```

**Bulk-edit with preview.** `documentSymbols` is the most stable way to locate a symbol across edits — prefer it over hard line numbers.

## Gotchas

- Diagnostics update asynchronously. After an edit, the next `onDidChangeDiagnostics` event signals fresh data; polling immediately may return stale results.
- Workspace symbols depend on the language server having indexed the project. For huge repos it may be incomplete on first call.
- `codeActions` returns *available* actions — applying one still requires you to either submit its `edit` to `/workspace/applyEdit` or execute its `command`. Inspect the action shape first.
- Rename can touch dozens of files. Always `apply:false` first and surface the file list to the user before committing.
