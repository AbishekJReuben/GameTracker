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

function Get-NewestWriteTime([string[]]$paths) {
    $newest = [datetime]::MinValue
    foreach ($p in $paths) {
        if (-not (Test-Path $p)) { continue }
        $item = Get-Item $p
        if ($item.PSIsContainer) {
            $child = Get-ChildItem -Path $p -Recurse -File -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending |
                Select-Object -First 1
            if ($child -and $child.LastWriteTime -gt $newest) { $newest = $child.LastWriteTime }
        } elseif ($item.LastWriteTime -gt $newest) {
            $newest = $item.LastWriteTime
        }
    }
    return $newest
}

# Build discovery clients (companion + quest + public Share into signaling/static) when missing
# OR when source is newer than the published static HTML — otherwise browsers /
# Quest keep running a stale bundle while the APK has the latest Control/cloud.
$staticCompanion = Join-Path $here "static\companion.html"
$staticQuest = Join-Path $here "static\quest.html"
$staticShare = Join-Path $here "static\share.html"
$needsBuild = -not (Test-Path $staticCompanion) -or -not (Test-Path $staticQuest) -or -not (Test-Path $staticShare)
if (-not $needsBuild) {
    $staticAge = Get-NewestWriteTime @($staticCompanion, $staticQuest, $staticShare)
    $srcAge = Get-NewestWriteTime @(
        (Join-Path $repo "src\companion"),
        (Join-Path $repo "src\quest"),
        (Join-Path $repo "src\share"),
        (Join-Path $repo "src\lib"),
        (Join-Path $repo "companion.html"),
        (Join-Path $repo "quest.html"),
        (Join-Path $repo "share.html"),
        (Join-Path $repo "vite.quest.config.ts"),
        (Join-Path $repo "package.json")
    )
    if ($srcAge -gt $staticAge) { $needsBuild = $true }
}
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
