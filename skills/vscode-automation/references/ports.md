# Ports, tunnels, external URIs

Forward a localhost port, expose it externally (in Codespaces / remote tunnels), open URLs in the OS browser, share localhost with collaborators.

Uses the `vsc` wrapper from `SKILL.md`.

## Forward a local port

```bash
# Forward port 3000 — in remote/codespaces contexts this opens a real tunnel,
# in local Desktop it returns the same localhost URI.
vsc -d '{"port":3000,"protocol":"http","label":"dev"}' $BASE/ports/forward
# → { local, external, panelForwarded, label }

vsc -d '{"port":3000,"protocol":"http","label":"dev"}' $BASE/ports/forward | jq '.external'
```

## Stop forwarding

```bash
vsc -d '{"port":3000}' $BASE/ports/stopForwarding
```

## Reveal the Ports panel

```bash
vsc -X POST $BASE/ports/showPanel
```

## Map any URI to external

```bash
vsc -d '{"uri":"http://localhost:8080/app"}' $BASE/ports/asExternalUri | jq -r '.external'
```

`/env/asExternalUri` does the same and works for non-HTTP URIs (e.g. `vscode://`).

## Open in OS default handler

```bash
vsc -d '{"url":"https://github.com/niradler/vscode-internals"}' $BASE/env/openExternal
```

Use for: handing the user a URL, opening a dashboard, launching a doc.

## Tunnels (feature-detected — Codespaces / Remote-Tunnels)

```bash
# Active tunnels list. Returns {supported:false} on older builds / local desktop.
vsc $BASE/env/tunnels | jq

# Open a tunnel to a remote port (proposed API)
vsc -d '{"remoteHost":"my-vm","remotePort":3000,"localPort":3000,"label":"vm-dev"}' \
  $BASE/env/openTunnel
```

If `{supported:false}` comes back, the user isn't in a tunneling context — fall back to plain port forward or skip.

## Composition

**Forward + share with one notification:**

```text
POST /ports/forward { port: 3000 }
→ external
POST /window/showInformationMessage {
  message: "Dev server at "+external,
  items: ["Copy","Open","Stop"]
}
  "Copy":  POST /env/clipboard      { text: external }
  "Open":  POST /env/openExternal   { url: external }
  "Stop":  POST /ports/stopForwarding { port: 3000 }
```

**Auto-forward all running dev servers:**

```text
# When a task starts a server on a known port
SUBSCRIBE onDidStartTask
  on task name "dev:server":
    POST /ports/forward { port: 3000 }
    POST /window/setStatusBarMessage { text: "$(globe) dev → "+external }
```

## Gotchas

- In **local Desktop** (no remote/tunnel context), `/ports/forward` is essentially a no-op — `external` will equal `local`. Don't rely on it for anything beyond surfacing the URL.
- `protocol` defaults to `http`. For HTTPS servers pass `"https"` so the external URL has the right scheme.
- `panelForwarded:true` means VSCode added it to the Ports panel; `false` means the forward exists but isn't surfaced in the UI.
- Tunnels (`/env/tunnels`, `/env/openTunnel`) use VSCode's proposed API — they may break across releases. Always check the `supported` field.
- `openExternal` runs the URL through the user's default browser/handler — it can't be intercepted by VSCode. Don't pass user-controlled URLs without validation.
