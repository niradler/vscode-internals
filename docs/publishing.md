# Publishing to the VSCode Marketplace

End-to-end steps to publish `niradler.vscode-internals` from this checkout.

## Prerequisites — one-time setup

1. **Publisher** — already exists as `niradler` on the marketplace. No action needed.

2. **Personal Access Token (PAT)** — required to authenticate `vsce`. The token must be **Azure DevOps**, not GitHub.
   - Open https://dev.azure.com/ and sign in with the Microsoft account that owns the `niradler` publisher.
   - Top-right user menu → **Personal access tokens** → **New Token**.
   - Settings:
     - **Name**: anything (e.g. `vsce-niradler`).
     - **Organization**: **All accessible organizations** ← critical. The most common publish failure is picking a single org here.
     - **Expiration**: your choice (1 year is typical).
     - **Scopes** → **Custom defined** → check **Marketplace > Manage**.
   - **Copy the token** immediately. Azure DevOps shows it only once.

3. **Store the PAT.** Two options:
   - **Recommended** — `npx @vscode/vsce login niradler` once, paste the PAT. vsce stores it in the OS credential manager (verifiable via `npx @vscode/vsce ls-publishers`). No `.env` required afterwards.
   - **Per-shell fallback** — put `VSCE_PAT=<token>` in `.env` (gitignored) and load it before publishing:

     ```powershell
     $env:VSCE_PAT = (Get-Content .env | Select-String '^VSCE_PAT=').ToString().Split('=',2)[1].Trim()
     ```

## Release flow (per version)

From the repo root in PowerShell:

```powershell
# 1. Pre-flight: confirm the credential is wired up.
npx @vscode/vsce ls-publishers   # should print: niradler

# 2. Compile.
npm run compile

# 3. Sanity-check the package contents. Stop if you see .env, .claude/**,
#    .dev-token, or anything sensitive — fix .vscodeignore first.
npx @vscode/vsce ls --tree

# 4. Publish. vsce bumps package.json, creates a git commit + tag, and uploads.
npx @vscode/vsce publish patch   # 0.1.0 -> 0.1.1
# or: publish minor / major / <explicit-version> / --pre-release

# 5. Push the bump commit and tag.
git push
git push --tags
```

After a successful publish:

- Listing appears at https://marketplace.visualstudio.com/items?itemName=niradler.vscode-internals (allow ~1 minute for the gallery to refresh).

## Generate the release notes

There is no maintained `CHANGELOG.md`. Release notes are generated on demand from git history:

```powershell
# Commits since the last tag (run BEFORE bumping, or pass an explicit range).
node scripts/changelog.mjs

# Explicit range:
node scripts/changelog.mjs v0.1.0..v0.1.1
```

Pipe the output into a GitHub Release (requires `gh` CLI). Use `--notes-file`, not `--notes`: when bullet lines start with `-`, gh parses them as shorthand flags and the create call fails.

```powershell
$notesFile = Join-Path $env:TEMP "release-notes-v0.1.1.txt"
node scripts/changelog.mjs v0.1.0..v0.1.1 | Out-File -FilePath $notesFile -Encoding utf8
gh release create v0.1.1 --title "v0.1.1" --notes-file $notesFile
Remove-Item $notesFile -Force
```

Anything surprising during the release (issues hit, follow-ups deferred) goes into [release-notes.md](release-notes.md) under a version heading — that file is for context the commit log can't capture, not for re-listing commits.

## Sanity checks before publish

Always run before publishing:

```powershell
# What will go into the package
npx @vscode/vsce ls --tree

# Confirm nothing sensitive is included.
# Expected EXCLUDED: .env, .env.*, .claude/**, .vscode/**, .github/**, src/**,
# scripts/**, skills/**, docs/**, CHANGELOG.md, .dev-token, *.map, **/*.ts.
```

If something sensitive appears, stop and add it to `.vscodeignore`.

## Manual upload fallback

If `vsce publish` fails (e.g. bad PAT), upload the `.vsix` manually:

1. Build with `npx @vscode/vsce package`.
2. Go to https://marketplace.visualstudio.com/manage/publishers/niradler.
3. Drag the `.vsix` onto the page or click **New Extension → Visual Studio Code**.

## Pre-release channel

For non-final builds, publish to the pre-release channel:

```powershell
npx @vscode/vsce publish --pre-release
```

Users only see pre-release builds if they explicitly opt in via the Extensions view.
