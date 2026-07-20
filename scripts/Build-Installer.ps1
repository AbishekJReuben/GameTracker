<#
.SYNOPSIS
    Build the desktop GameTracker NSIS installer (Windows x64).

.DESCRIPTION
    Wraps `tauri build`, which compiles the Rust backend + bundles the web frontend
    into the signed NSIS setup executable under
    src-tauri\target\release\bundle\nsis\.

    The app config has `createUpdaterArtifacts: true`, so a build normally needs the
    updater signing key AND its password. The key (~\.tauri\gametracker_updater.key) is
    an rsign **encrypted** private key — the password is a CI-only secret
    (TAURI_SIGNING_PRIVATE_KEY_PASSWORD, see .github/workflows/release.yml), never
    stored on disk. Signing is therefore only attempted when the password is ALREADY
    present in the environment (e.g. exported before running this script); otherwise
    it builds WITHOUT updater artifacts and warns. This is deliberate: passing a wrong/
    blank password makes tauri-cli fall back to an interactive decrypt prompt, which
    hangs forever in a non-interactive/background shell (there's no stdin to answer
    it) — so guessing a password is worse than skipping signing.

.PARAMETER SkipWebBuild
    Assume dist\ was already built (by Build-All.ps1) and skip tauri's
    beforeBuildCommand. Both native builds share ..\dist, so the orchestrator builds
    it once and passes this to avoid a concurrent-write race.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\Build-Installer.ps1
#>
[CmdletBinding()]
param([switch]$SkipWebBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host "== NSIS installer build ==" -ForegroundColor Cyan

# --- updater signing key (createUpdaterArtifacts = true) ---
# Only sign when a password is ALREADY in the environment (the key on disk is
# encrypted; the password is a CI-only secret, never stored locally). Do NOT
# default it to '' — an empty/wrong password makes tauri-cli fall back to an
# interactive "decrypt prompt", which hangs forever here (no stdin to answer it).
$signing = $false
if ($env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
        $keyFile = Join-Path $env:USERPROFILE '.tauri\gametracker_updater.key'
        if (Test-Path $keyFile) {
            $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw $keyFile).Trim()
        }
    }
    if ($env:TAURI_SIGNING_PRIVATE_KEY) {
        $signing = $true
        Write-Host "Signing with TAURI_SIGNING_PRIVATE_KEY (password from environment)."
    }
}
if (-not $signing) {
    Write-Warning "TAURI_SIGNING_PRIVATE_KEY_PASSWORD not set (it's a CI-only secret, not stored locally) - building the installer WITHOUT updater artifacts. Set that env var yourself first if you need a signed .sig."
}

# --- assemble a --config override (only when we actually need one) ---
$tauriConfPath = Join-Path $root 'src-tauri\tauri.conf.json'
$tauriConf = Get-Content $tauriConfPath -Raw | ConvertFrom-Json

$override = @{}
if ($tauriConf.productName) { $override['productName'] = $tauriConf.productName }
if ($tauriConf.version)     { $override['version']     = $tauriConf.version }
if ($SkipWebBuild)  { $override['build']  = @{ beforeBuildCommand = '' } }        # dist already built
if (-not $signing)  { $override['bundle'] = @{ createUpdaterArtifacts = $false } } # no key -> no .sig

$cfgArgs = @()
$tmpCfg = $null
if ($override.Count -gt 0) {
    $tmpCfg = Join-Path ([System.IO.Path]::GetTempPath()) ("gt-tauri-override-{0}.json" -f ([guid]::NewGuid().ToString('N')))
    ($override | ConvertTo-Json -Depth 6) | Out-File -FilePath $tmpCfg -Encoding utf8
    $cfgArgs = @('--config', $tmpCfg)
}

if (-not $SkipWebBuild) { Write-Host "Frontend bundle: handled by tauri beforeBuildCommand (npm run build)." }

try {
    Write-Host "Running: npx tauri build $($cfgArgs -join ' ')"
    npx tauri build @cfgArgs
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }
} finally {
    if ($tmpCfg -and (Test-Path $tmpCfg)) { Remove-Item $tmpCfg -Force -ErrorAction SilentlyContinue }
}

# --- report the artifact ---
$nsisDir = Join-Path $root 'src-tauri\target\release\bundle\nsis'
$exe = Get-ChildItem $nsisDir -Filter '*-setup.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { throw "Build finished but no *-setup.exe found under $nsisDir" }

$sw.Stop()
Write-Host ("== Installer done in {0:n0}s ==" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
Write-Host ("Installer: {0}  ({1:n1} MB)" -f $exe.FullName, ($exe.Length / 1MB)) -ForegroundColor Green
