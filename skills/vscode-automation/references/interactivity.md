# Talking to the user

How an agent surfaces info, asks questions, gets confirmation, shows progress, writes long output. These are the primary agent ↔ user primitives.

Assumes `BASE=http://127.0.0.1:7891` and `TOKEN=vscint_…`. All are POSTs with `Content-Type: application/json` unless noted.

## Notifications with optional buttons

Returns the user's pick (`{ selected }`) or `{ selected: null }` if dismissed.

```bash
# Info / warning / error — same shape across all three
vsc -d '{"message":"Apply 3 quick fixes?","items":["Apply","Skip"]}' \
  $BASE/window/showInformationMessage

vsc -d '{"message":"Build had warnings","items":["Show output"]}' \
  $BASE/window/showWarningMessage

vsc -d '{"message":"Build failed","items":["Show","Retry","Cancel"]}' \
  $BASE/window/showErrorMessage

# Modal — blocks the user until they answer. Use for destructive actions.
vsc -d '{"message":"Delete 12 files?","items":["Delete","Cancel"],"modal":true}' \
  $BASE/window/showWarningMessage
```

Without `items`, the message appears with just an X button — fire-and-forget.

## Quick pick (choose from a list)

```bash
# Single pick — { selected: "string" | null }
vsc -d '{"items":["a","b","c"],"placeHolder":"Pick one","title":"Choose"}' \
  $BASE/window/showQuickPick

# Multi pick — { selected: ["a","c"] | null }
vsc -d '{"items":["a","b","c"],"canPickMany":true,"placeHolder":"Pick many"}' \
  $BASE/window/showQuickPick
```

## Free-text input

```bash
vsc -d '{"prompt":"New symbol name","value":"foo","placeHolder":"e.g. MyClass","title":"Rename"}' \
  $BASE/window/showInputBox

# Secret input
vsc -d '{"prompt":"API key","password":true}' $BASE/window/showInputBox
```

## Native file / folder dialogs

```bash
# Open file/folder picker
vsc -d '{
  "canSelectFiles":true,"canSelectFolders":false,"canSelectMany":false,
  "openLabel":"Pick TypeScript",
  "filters":{"TypeScript":["ts","tsx"],"All":["*"]}
}' $BASE/window/showOpenDialog
# → { uris: [Uri, ...] }

# Save dialog
vsc -d '{"defaultUri":"file:///g:/p/out.json","saveLabel":"Export","filters":{"JSON":["json"]}}' \
  $BASE/window/showSaveDialog
# → { uri: Uri | null }

# Workspace folder pick (multi-root scenarios)
vsc -d '{"placeHolder":"Pick a folder"}' $BASE/window/showWorkspaceFolderPick
```

## Status bar (ambient progress)

Fire-and-forget. Supports product icons via `$(name)` and `~spin` suffix for spinning.

```bash
vsc -d '{"text":"$(sync~spin) Indexing…","hideAfterMs":10000}' \
  $BASE/window/setStatusBarMessage

vsc -d '{"text":"$(check) Done"}' $BASE/window/setStatusBarMessage
# No hideAfterMs → message stays until replaced or VSCode reload.
```

Icon names: `sync`, `check`, `error`, `warning`, `info`, `flame`, `rocket`, `loading`, `gear`, `bell`, `eye`, `play`, `debug-alt`, … (the [product icon reference](https://code.visualstudio.com/api/references/icons-in-labels) has the full list).

## Output channels (structured logs the user can read later)

Channels persist for the session; scrollable, copyable, syntax-highlightable.

```bash
# Create / fetch a channel. languageId enables syntax highlighting (e.g. "log", "json", "markdown").
vsc -d '{"name":"My Agent","languageId":"log"}' $BASE/window/outputChannel/create

# Append text. Creates the channel on demand if missing. newline defaults to true.
vsc -d '{"name":"My Agent","text":"step 1 done","show":true,"preserveFocus":true}' \
  $BASE/window/outputChannel/append

# Reveal / clear / dispose
vsc -d '{"name":"My Agent","preserveFocus":true}' $BASE/window/outputChannel/show
vsc -d '{"name":"My Agent"}'                      $BASE/window/outputChannel/clear
vsc -d '{"name":"My Agent"}'                      $BASE/window/outputChannel/dispose

# List channels you've created (built-in/extension channels aren't enumerable)
vsc $BASE/window/outputChannels
```

## When to use what

| User surface | Use when |
|---|---|
| `setStatusBarMessage` | Ambient progress that doesn't require attention. Build status, indexing, "saved". |
| `showInformationMessage` (no items) | Brief one-shot info. Toast-style. |
| `showInformationMessage` with `items` | Confirm-then-act. Branch on the response. |
| `showInformationMessage` `modal:true` | Destructive confirmation. Blocks the user. |
| `showQuickPick` | More than 3 options or list comes from data (files, symbols, configs). |
| `showInputBox` | Free-text input (new name, query, URL). |
| `showOpenDialog` / `showSaveDialog` | The user needs to point at a file/folder. |
| Output channel | Long-form structured output the user will read & scroll. LLM streams. |

## Composition patterns

**Multi-step wizard.** Each step can `null` out on dismissal — propagate cancel.

```
PICK_FILE   = /window/showQuickPick   { items: from findFiles }
PICK_STYLE  = /window/showQuickPick   { items: ["Rename","Extract","Inline"] }
NEW_NAME    = /window/showInputBox    { prompt: "New name?" }
CONFIRM     = /window/showInformationMessage { items:["Apply","Cancel"], modal:true }
```

**Confirm-then-act with preview.**

```
POST /window/showInformationMessage  { items: ["Apply","Preview","Cancel"] }
  "Apply":   POST /workspace/applyEdit
  "Preview": POST /commands/execute  { command: "vscode.diff", args: [beforeUri, afterUri, "Proposed"] }
  null/Cancel: log to output channel, no mutation
```

**Stream long output without blocking.**

```
POST /window/outputChannel/create  { name: "Agent", languageId: "markdown" }
# As LLM chunks arrive on SSE:
POST /window/outputChannel/append  { name: "Agent", text: chunk, newline: false }
POST /window/outputChannel/show    { name: "Agent", preserveFocus: true }
```

## Gotchas

- Dismissal (Esc / X) returns `null` for everything. Treat `null` as "no", never as "yes".
- Quick pick and input box are *active editor* prompts — they block input on the editor until answered. Don't chain too many in a row.
- Notifications without `items` cannot be awaited meaningfully — they fire and return immediately with `{ selected: null }`.
- Status bar messages are FIFO replaced; the latest call wins.
- Output channels can't be read back over the API — they're write-only from the agent's side.
- For *secret* input, set `password:true` so the input is masked; but the value still comes back in cleartext over HTTP.
