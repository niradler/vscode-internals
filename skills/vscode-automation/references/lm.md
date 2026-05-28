# Chat models (`/lm/*`)

Wraps `vscode.lm` — every chat model VSCode sees (Copilot, Copilot CLI, Claude Code, GitHub Models, local providers) is callable through the user's existing auth. **No API keys to manage.**

Uses the `vsc` wrapper from `SKILL.md`. Pipe responses through `jq` to extract only what you need.

## First-call consent

The very first `/lm/*` call from this extension triggers a modal **"Allow vscode-internals to use language models?"**. Subsequent calls run silently. For unattended scripts, send a trivial warm-up first interactively, or expect a `NoPermissions` error on the first stream.

## Discover available models

```bash
# All models — just the fields that matter for selection
vsc $BASE/lm/models | jq '.models[] | {id, vendor, family, maxInputTokens}'

# Narrow by selector (same {models:[…]} wrapper)
vsc -d '{"vendor":"copilot"}' $BASE/lm/selectChatModels | jq '.models[].family' | sort -u

# Just Claude-family
vsc -d '{"family":"claude-sonnet-4.6"}' $BASE/lm/selectChatModels | jq '.models[] | .id'
```

Typical machine has 25-30 models across vendors: `copilot`, `copilotcli`, `claude-code`, `github`, …

## Send a non-streaming request

```bash
vsc -d '{
  "selector":{"vendor":"copilot","family":"claude-sonnet-4.6"},
  "messages":[
    {"role":"user","content":"In one sentence: what does this file do?\n\n<contents>"}
  ],
  "modelOptions":{"temperature":0.2},
  "justification":"Explain code for the user"
}' $BASE/lm/sendRequest | jq -r '.text'
```

Returns `{ model: {...}, text: "..." }` — `jq -r '.text'` extracts the reply.

## Stream a response (SSE)

```bash
vsc -N -H "Content-Type: application/json" \
  --data-binary '{
    "selector":{"vendor":"copilot","family":"claude-sonnet-4.6"},
    "messages":[{"role":"user","content":"Walk through this architecture"}]
  }' \
  "$BASE/lm/sendRequestStream" |
while IFS= read -r LINE; do
  case "$LINE" in
    "event: chunk") read -r DATA; printf '%s' "$(echo "${DATA#data: }" | jq -r '.text // empty')" ;;
    "event: done")  read -r DATA; echo; echo "[done: $(echo "${DATA#data: }" | jq -r '.totalChars') chars]" ;;
    "event: error") read -r DATA; echo "ERROR: $(echo "${DATA#data: }" | jq -r '.message')" ;;
  esac
done
```

Events on the stream: `model` (opener with model metadata), `chunk` (many, with `{text}`), `done` (`{totalText, totalChars}`), `error` (`{message, code, name}`).

## Count tokens before sending

`maxInputTokens` is per-model and varies wildly (12k for utility models, 270k for codex). Tokenizers differ — Claude and GPT-4o disagree by 10-20%.

```bash
PROMPT=$(cat ./big-file.ts | jq -Rs .)
vsc -d "{\"selector\":{\"family\":\"gpt-5.4\"},\"text\":$PROMPT}" \
  $BASE/lm/countTokens | jq '.tokens'
```

## Choosing a model

| Use case | Try |
|---|---|
| Speed-critical, short context (clipboard, classify, single-file explain) | `claude-haiku-4.5`, `copilot-utility`, `gpt-5-mini` |
| Reasoning over a repo / long context (PR review, multi-file refactor) | `claude-sonnet-4.6`, `gpt-5.4`, `gpt-5.4-codex` |
| Code generation / edits | `gpt-5.3-codex`, `gpt-5.2-codex` |
| Vendor preference | `vendor:"copilotcli"` (Copilot CLI surface), `vendor:"claude-code"` (Claude Code-provided), `vendor:"copilot"` (in-IDE Copilot) |

If your selector matches nothing, `.models` is `[]` — typos in `family` are silent. Always list first.

## Watch for model availability changes

```bash
vsc -N "$BASE/events?subscribe=onDidChangeChatModels"
```

Copilot rotates families periodically. Long-running processes should re-check.

## Composition

**Stream into output channel:**

```text
POST /window/outputChannel/create  { name: "Agent" }
on chunk: POST /window/outputChannel/append { name: "Agent", text: chunk, newline: false }
on done:  POST /window/outputChannel/append { name: "Agent", text: "\n[done]" }
```

**Multi-turn with prior responses as context:**

```json
{"messages":[
  {"role":"user","content":"What is X?"},
  {"role":"assistant","content":"<prior reply>"},
  {"role":"user","content":"Now apply it to Y"}
]}
```

## Gotchas

- `selectChatModels` returns `{models:[…]}`, NOT a bare array.
- `LanguageModelError.NoPermissions` on the first call means consent was denied. Re-prompt with `justification` set.
- Streaming connection must stay open until `event: done` or `event: error`. Cancel client-side disconnects the request (server uses `AbortController`).
- `modelOptions` is passed through verbatim — model-specific (`temperature`, `topP`, …). Bad options can error or be silently ignored depending on the vendor.
