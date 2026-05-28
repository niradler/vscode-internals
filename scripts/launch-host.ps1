# Launch a fresh VSCode Extension Development Host for niradler.vscode-internals,
# wait for the dev handshake file to appear, then run the E2E suite against it.
#
# Usage:
#   pwsh -File scripts/launch-host.ps1            # launch + e2e once, then leave host open
#   pwsh -File scripts/launch-host.ps1 -CloseAfter # close host after e2e (CI use)
#
# Notes:
#   - Requires the `code` CLI on PATH.
#   - The dev handshake file is written by extension.ts when
#     context.extensionMode === Development.

param(
  [switch]$CloseAfter,
  [int]$WaitSeconds = 45
)

$ErrorActionPreference = 'Stop'
$ext = Resolve-Path "$PSScriptRoot\.."
$handshake = Join-Path $env:TEMP 'niradler.vscode-internals.dev.json'

if (Test-Path $handshake) {
  Write-Host "Removing stale handshake $handshake"
  Remove-Item $handshake -Force
}

Write-Host "Compiling extension..."
Push-Location $ext
try {
  npm run compile | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Compile failed" }
} finally { Pop-Location }

Write-Host "Launching Extension Development Host (folder: $ext)..."
$codeExe = (Get-Command code).Source
# `--extensionDevelopmentPath` loads the extension from source.
# `--new-window` ensures we don't piggyback on an existing window.
# We also pass the extension folder as the workspace so workspace endpoints have something to chew on.
$proc = Start-Process -FilePath $codeExe `
  -ArgumentList @('--new-window', '--extensionDevelopmentPath', $ext, $ext) `
  -PassThru

Write-Host "PID of `code` launcher: $($proc.Id) (the real Electron host will be a child)"
Write-Host "Waiting up to $WaitSeconds s for handshake at $handshake ..."
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while (-not (Test-Path $handshake) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Path $handshake)) {
  throw "Handshake never appeared at $handshake within $WaitSeconds seconds. The dev host may have failed to activate."
}

$payload = Get-Content $handshake -Raw | ConvertFrom-Json
Write-Host "Handshake received: url=$($payload.url) (host PID $($payload.pid))"

Push-Location $ext
try {
  Write-Host ""
  Write-Host "Running E2E suite..."
  node scripts/e2e.mjs
  $e2eExit = $LASTEXITCODE
} finally { Pop-Location }

if ($CloseAfter) {
  Write-Host ""
  Write-Host "Closing dev host (PID $($payload.pid))..."
  try { Stop-Process -Id $payload.pid -Force -ErrorAction Stop } catch { Write-Host "(host already gone)" }
}

exit $e2eExit
