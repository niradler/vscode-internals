# Serialization

vscode types ↔ JSON. Everything the API returns is JSON-safe (no class instances). Inbound parameters are forgiving where possible — URIs accept strings, positions/ranges accept their JSON shape.

## URIs

**Inbound** (you send): either form works.

```jsonc
"file:///g:/Projects/foo/src/index.ts"
"g:/Projects/foo/src/index.ts"        // plain absolute path → vscode.Uri.file
{ "scheme": "untitled", "path": "scratch.ts" }
```

The inbound parser:
1. If it's a string that starts with `<scheme>:`, parses as URI.
2. If it's a string with no scheme, treats as a file path.
3. If it's an object with `scheme === 'file'` and `fsPath`, uses `Uri.file(fsPath)`.
4. If it's an object with a `toString` string, parses that.
5. Otherwise reconstructs via `Uri.from({ scheme, authority, path, query, fragment })`.

**Outbound** (you receive): always an object.

```json
{
  "scheme": "file",
  "authority": "",
  "path": "/g:/Projects/foo/src/index.ts",
  "query": "",
  "fragment": "",
  "fsPath": "g:\\Projects\\foo\\src\\index.ts",
  "toString": "file:///g%3A/Projects/foo/src/index.ts"
}
```

When you need to feed an outbound URI back in, send `uri.toString` (the percent-encoded canonical form) or `uri.fsPath` (the platform path).

## Position

0-indexed.

```json
{ "line": 42, "character": 10 }
```

## Range

```json
{ "start": { "line": 10, "character": 0 }, "end": { "line": 10, "character": 5 } }
```

Both endpoints inclusive at line level, exclusive at the end character (LSP convention).

## Selection

Inbound (for `/window/setSelection`) only needs `anchor` and `active`:

```json
{ "anchor": { "line": 0, "character": 0 }, "active": { "line": 0, "character": 5 } }
```

Outbound includes the normalized range and flags:

```json
{
  "anchor": { "line": 0, "character": 0 },
  "active": { "line": 0, "character": 5 },
  "start":  { "line": 0, "character": 0 },
  "end":    { "line": 0, "character": 5 },
  "isReversed": false,
  "isEmpty": false
}
```

`isReversed: true` means the cursor (active) is before the anchor.

## Location

```json
{ "uri": { /* UriJSON */ }, "range": { /* RangeJSON */ } }
```

Definitions/implementations can also return `LocationLink`-shaped objects when the provider supports them — same `uri` + `range` keys, plus optional `selectionRange` and `originSelectionRange`.

## TextDocument (metadata)

```json
{
  "uri":        { /* UriJSON */ },
  "languageId": "typescript",
  "version":    27,
  "lineCount":  412,
  "isDirty":    true,
  "isUntitled": false,
  "isClosed":   false,
  "eol":        "LF",
  "fileName":   "g:\\Projects\\foo\\src\\index.ts"
}
```

The API never streams full file content as part of `textDocumentMeta`. Use `/workspace/readFile` or `/workspace/getDocumentText` when you need the text.

## TextEditor

```json
{
  "document":      { /* TextDocumentMeta */ },
  "selections":    [ /* SelectionJSON, … */ ],
  "selection":     { /* primary SelectionJSON */ },
  "visibleRanges": [ /* RangeJSON, … */ ],
  "options":       { "tabSize": 2, "insertSpaces": true, "cursorStyle": 1, "lineNumbers": 1 },
  "viewColumn":    1
}
```

## Diagnostic

```json
{
  "range":    { /* RangeJSON */ },
  "message":  "Cannot find name 'foo'.",
  "severity": "error",                // "error" | "warning" | "information" | "hint"
  "source":   "ts",
  "code":     2304,                   // or { value, target: UriJSON } for linkable codes
  "tags":     [1],                    // 1 = Unnecessary, 2 = Deprecated
  "relatedInformation": [
    { "location": { /* LocationJSON */ }, "message": "…" }
  ]
}
```

## SymbolInformation (flat)

```json
{
  "name":          "doThing",
  "kind":          "Function",
  "containerName": "MyClass",
  "location":      { /* LocationJSON */ }
}
```

## DocumentSymbol (hierarchical)

```json
{
  "name":           "MyClass",
  "detail":         "",
  "kind":           "Class",
  "range":          { /* full span incl. body */ },
  "selectionRange": { /* identifier */ },
  "children":       [ /* DocumentSymbol, … */ ]
}
```

`/languages/documentSymbols` returns one shape or the other depending on whether the provider supports hierarchical symbols.

## Hover

```json
{
  "range":    { /* RangeJSON | null */ },
  "contents": [ "markdown string …", "more …" ]
}
```

Markdown strings are unwrapped to their `value`.

## Completion item (subset)

```json
{
  "label":         "toString",
  "kind":          "Method",
  "detail":        "(method) Object.toString(): string",
  "documentation": "Returns a string representation of an object.",
  "insertText":    "toString()",
  "sortText":      "11",
  "filterText":    "toString",
  "preselect":     false
}
```

## WorkspaceEdit (inbound to `/workspace/applyEdit`)

```json
{
  "edits": [
    {
      "uri": "file:///g:/p/a.ts",
      "changes": [
        { "range": { "start": {"line":1,"character":0}, "end": {"line":1,"character":5} }, "newText": "const" }
      ]
    },
    {
      "uri": "file:///g:/p/b.ts",
      "changes": [ /* … */ ]
    }
  ]
}
```

All changes are applied atomically through the editor pipeline (formatters, language clients, undo all see it).

## Rename response

```json
{
  "applied": true,
  "edits": [
    {
      "uri": { /* UriJSON */ },
      "changes": [
        { "range": { /* RangeJSON */ }, "newText": "newName" }
      ]
    }
  ]
}
```

`applied: false` when called with `apply: false` (preview mode) or when no provider returned an edit.

## Notebook cell

```json
{
  "index":            0,
  "kind":             "code",          // "code" | "markup"
  "languageId":       "python",
  "text":             "print('hi')",
  "metadata":         { /* … */ },
  "executionSummary": { "executionOrder": 3, "success": true },
  "outputs": [
    { "items": [ { "mime": "text/plain", "length": 3 } ], "metadata": { /* … */ } }
  ],
  "uri":              { /* UriJSON of the cell document */ }
}
```

Output `data` is not inlined — only `mime` + byte `length` are reported. To get cell output bytes, run the cell through the kernel and re-read.
