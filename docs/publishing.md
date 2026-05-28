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

3. **Store the PAT locally**. This repo's `.env` is gitignored — put it there:

   ```env
   VSCE_PAT=<paste-token-here>
   ```

## Publish (per release)

From the repo root in PowerShell:

```powershell
# Load PAT into the current shell from .env
$env:VSCE_PAT = (Get-Content .env | Select-String '^VSCE_PAT=').ToString().Split('=',2)[1].Trim()

# Verify
[bool]$env:VSCE_PAT   # → True

# Compile + bundle pre-flight (vsce will also do this via vscode:prepublish)
npm run compile

# Package — produces vscode-internals-<version>.vsix in the repo root.
npx @vscode/vsce package

# Publish — uploads the current package.json version. vsce reads $env:VSCE_PAT automatically.
npx @vscode/vsce publish
```

After a successful publish:

- Listing appears at https://marketplace.visualstudio.com/items?itemName=niradler.vscode-internals (allow ~1 minute for the gallery to refresh).
- Tag and push the release:

  ```powershell
  git tag v0.1.0
  git push origin v0.1.0
  ```

## Bumping versions

`vsce publish` accepts a SemVer keyword and bumps `package.json` for you:

```powershell
npx @vscode/vsce publish patch   # 0.1.0 -> 0.1.1
npx @vscode/vsce publish minor   # 0.1.0 -> 0.2.0
npx @vscode/vsce publish major   # 0.1.0 -> 1.0.0
npx @vscode/vsce publish 0.1.3   # explicit
```

It also creates a git commit/tag via `npm version` when run inside a git repo.

## Sanity checks before publish

Always run before publishing:

```powershell
# What will go into the package
npx @vscode/vsce ls --tree

# Verify .env is NOT in the package output (vsce already errors out, but double-check)
```

If you see anything sensitive (`*.env`, `.dev-token`, credentials, etc.), stop and add it to `.vscodeignore`.

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
