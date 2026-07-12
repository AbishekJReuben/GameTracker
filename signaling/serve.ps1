# Build (once) and run the GameTracker signaling server on port 8080.
#
# Keep this running (or install it as a scheduled task / service) so the phone can
# reach your PC "from anywhere." Pair it with a Cloudflare Tunnel pointing
# discovery.chilloutgamestudio.com -> http://localhost:8080 (see
# cloudflared-config.example.yml).
#
# Usage:  pwsh signaling/serve.ps1   [-Port 8080]

param(
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here

# Build discovery clients (companion + quest into signaling/static) if either is
# missing, so phone browsers and the Quest headset work over HTTPS.
$needsBuild = -not (Test-Path (Join-Path $here "static\quest.html")) `
    -or -not (Test-Path (Join-Path $here "static\companion.html"))
if ($needsBuild) {
    Write-Host "Building discovery clients (npm run discovery:build)..." -ForegroundColor Cyan
    Push-Location $repo
    try { npm run discovery:build } finally { Pop-Location }
}

Write-Host "Building signaling server (release)..." -ForegroundColor Cyan
cargo build --release --manifest-path "$here\Cargo.toml"

$exe = Join-Path $here "target\release\gametracker-signal.exe"
if (-not (Test-Path $exe)) { throw "Build succeeded but $exe not found." }

$env:PORT = "$Port"
Write-Host "Signaling server listening on http://localhost:$Port  (Ctrl+C to stop)" -ForegroundColor Green
& $exe
