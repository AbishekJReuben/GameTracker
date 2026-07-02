<#
.SYNOPSIS
  Build (if needed) and run the GameTracker signaling server on port 8080, optionally Cloudflare tunnel.

.DESCRIPTION
  Production entry for discovery.chilloutgamestudio.com — the WebRTC rendezvous server
  that lets the phone companion connect "from anywhere." When launched by the Control
  Center (redirected stdout), parks with Wait-DiscoveryForeground so background jobs survive.

.PARAMETER LocalOnly
  Skip tunnels; serve http://127.0.0.1:8080 only.

.PARAMETER SkipBuild
  Skip cargo build (requires existing signaling/target/release/gametracker-signal.exe).

.PARAMETER UseCustomDomain
  Named Cloudflare tunnel via CLOUDFLARED_TUNNEL_TOKEN.

.PARAMETER SkipTunnel
  Do not start cloudflared (shared tunnel may already run for discovery + other sites).

.PARAMETER AppHostname
  Public hostname for logs and probes. Default: discovery.chilloutgamestudio.com

.PARAMETER Port
  Local signaling port. Default: 8080
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [switch]$LocalOnly,
  [switch]$SkipBuild,
  [switch]$UseCustomDomain,
  [switch]$SkipTunnel,
  [string]$AppHostname = 'discovery.chilloutgamestudio.com'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$SignalingDir = Join-Path $RepoRoot 'signaling'
$Exe = Join-Path $SignalingDir 'target\release\gametracker-signal.exe'
Set-Location $RepoRoot

$LogDir = Join-Path $RepoRoot '.logs'
if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$SignalLog = Join-Path $LogDir 'discovery-signal.log'
$StartLog = Join-Path $LogDir 'discovery-start.log'
$TunnelLog = Join-Path $LogDir 'cloudflared-discovery.log'
$HostMeta = Join-Path $LogDir 'discovery-host.log'

function Write-Step { param([string]$Msg) Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }

function Append-DiscoveryLog {
  param([string]$FileName, [string]$Message)
  try {
    $path = Join-Path $LogDir $FileName
    [IO.File]::AppendAllText($path, ("{0} {1}{2}" -f (Get-Date -Format o), $Message, [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  } catch {}
}

function Wait-DiscoveryForeground {
  $nonInteractive = $false
  try { if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected) { $nonInteractive = $true } } catch { $nonInteractive = $true }
  if (-not [Environment]::UserInteractive) { $nonInteractive = $true }
  if ($nonInteractive) {
    Write-Host 'Non-interactive host detected (launched by Control Center). Keeping services alive.' -ForegroundColor DarkGray
    Append-DiscoveryLog -FileName 'discovery-start.log' -Message 'Services up; parking non-interactive host so background jobs survive.'
    while ($true) { Start-Sleep -Seconds 3600 }
  } else {
    try { Read-Host | Out-Null } catch {
      Append-DiscoveryLog -FileName 'discovery-start.log' -Message 'Read-Host unavailable; parking host to keep background jobs alive.'
      while ($true) { Start-Sleep -Seconds 3600 }
    }
  }
}

function Test-TcpPort {
  param([int]$ListenPort)
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $c.ReceiveTimeout = 500
    $c.SendTimeout = 500
    $c.Connect('127.0.0.1', $ListenPort)
    $c.Close()
    return $true
  } catch { return $false }
}

function Stop-ProcessOnPort {
  param([int]$ListenPort)
  try {
    $conns = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
      if ($c.OwningProcess -gt 0) {
        $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
        if ($p -and $p.ProcessName -match 'gametracker-signal') {
          Write-Host "Stopping stale signaling process on port $ListenPort (PID $($c.OwningProcess))..." -ForegroundColor Yellow
          Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
          Start-Sleep -Seconds 2
        }
      }
    }
  } catch {}
}

function Write-HostMeta {
  param([string]$PublicUrl, [string]$LocalUrl)
  $lines = @(
    "DISCOVERY_PUBLIC_URL=$PublicUrl",
    "DISCOVERY_LOCAL_URL=$LocalUrl",
    "DISCOVERY_APP_HOST=$AppHostname",
    "DISCOVERY_PORT=$Port",
    "Updated=$(Get-Date -Format o)"
  )
  Set-Content -LiteralPath $HostMeta -Value ($lines -join [Environment]::NewLine) -Encoding UTF8
  Append-DiscoveryLog -FileName 'discovery-host.log' -Message "Public=$PublicUrl Local=$LocalUrl"
}

Write-Step "GameTracker Discovery signaling (port $Port)"
Append-DiscoveryLog -FileName 'discovery-start.log' -Message "=== Start-DiscoveryPublic Port=$Port LocalOnly=$LocalOnly SkipBuild=$SkipBuild UseCustomDomain=$UseCustomDomain SkipTunnel=$SkipTunnel ==="

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host 'ERROR: cargo (Rust) not found on PATH.' -ForegroundColor Red
  exit 1
}

$needBuild = (-not $SkipBuild) -or (-not (Test-Path -LiteralPath $Exe))
if ($needBuild) {
  Write-Step 'Building signaling server (cargo release)'
  Append-DiscoveryLog -FileName 'discovery-start.log' -Message 'cargo build --release'
  $buildOut = cmd /c "cargo build --release --manifest-path `"$SignalingDir\Cargo.toml`" 2>&1"
  if ($buildOut) { Add-Content -LiteralPath $SignalLog -Value ($buildOut -join [Environment]::NewLine) }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: cargo build failed (exit $LASTEXITCODE)." -ForegroundColor Red
    exit $LASTEXITCODE
  }
  if (-not (Test-Path -LiteralPath $Exe)) {
    Write-Host "ERROR: Build succeeded but $Exe not found." -ForegroundColor Red
    exit 1
  }
} else {
  Write-Step 'Skipping build (-SkipBuild, binary present)'
}

Stop-ProcessOnPort -ListenPort $Port
Get-Job -Name 'DiscoverySignal', 'DiscoveryTunnel' -ErrorAction SilentlyContinue | Remove-Job -Force -ErrorAction SilentlyContinue

Write-Step 'Starting signaling server (background job)'
$null = Start-Job -Name 'DiscoverySignal' -ScriptBlock {
  param($Binary, $ListenPort, $Log)
  $env:PORT = "$ListenPort"
  & $Binary 2>&1 | ForEach-Object {
    Add-Content -LiteralPath $Log -Value $_
    Write-Output $_
  }
} -ArgumentList $Exe, $Port, $SignalLog

$ready = $false
for ($i = 0; $i -lt 60; $i++) {
  if (Test-TcpPort -ListenPort $Port) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) {
  Write-Host "Signaling server did not open port $Port in time. Check $SignalLog or Receive-Job -Name DiscoverySignal -Keep" -ForegroundColor Red
  Append-DiscoveryLog -FileName 'discovery-start.log' -Message "ERROR: port $Port not ready within 60s"
} else {
  Write-Host "Signaling listening on http://127.0.0.1:$Port/health" -ForegroundColor Green
  Append-DiscoveryLog -FileName 'discovery-start.log' -Message "Port $Port ready"
}

$localUrl = "http://127.0.0.1:$Port/"

if ($LocalOnly) {
  Write-HostMeta -PublicUrl $localUrl -LocalUrl $localUrl
  Write-Step 'Local-only mode'
  Write-Host "Open: $localUrl" -ForegroundColor Green
  Wait-DiscoveryForeground
  exit 0
}

if ($UseCustomDomain -and -not $SkipTunnel) {
  $tunnelToken = [Environment]::GetEnvironmentVariable('CLOUDFLARED_TUNNEL_TOKEN', 'User')
  if (-not $tunnelToken) { $tunnelToken = [Environment]::GetEnvironmentVariable('CLOUDFLARED_TUNNEL_TOKEN', 'Machine') }
  if (-not $tunnelToken) {
    Write-Host 'Missing CLOUDFLARED_TUNNEL_TOKEN. Set it or use -SkipTunnel if a shared cloudflared already serves discovery.*' -ForegroundColor Yellow
    Append-DiscoveryLog -FileName 'discovery-start.log' -Message 'WARN: no CLOUDFLARED_TUNNEL_TOKEN'
  } else {
    $existing = @(Get-Process -Name 'cloudflared' -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
      Write-Step 'Cloudflare tunnel already running'
      Append-DiscoveryLog -FileName 'discovery-start.log' -Message "cloudflared already running ($($existing.Count) process(es))"
    } else {
      Write-Step 'Starting named Cloudflare tunnel'
      $null = Start-Job -Name 'DiscoveryTunnel' -ScriptBlock {
        param($R, $Tok, $L)
        $m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
        $u = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($m -and $u) { $env:Path = "$m;$u" } elseif ($m) { $env:Path = $m } elseif ($u) { $env:Path = $u }
        Set-Location $R
        & npx --yes cloudflared tunnel --no-autoupdate run --token $Tok 2>&1 | Tee-Object -FilePath $L -Append
      } -ArgumentList $RepoRoot, $tunnelToken, $TunnelLog
      Append-DiscoveryLog -FileName 'discovery-start.log' -Message 'Started DiscoveryTunnel job'
    }
  }
} elseif ($SkipTunnel) {
  Write-Host "Skip tunnel: assuming shared cloudflared serves $AppHostname -> :$Port" -ForegroundColor DarkGray
  Append-DiscoveryLog -FileName 'discovery-start.log' -Message 'SkipTunnel: shared tunnel expected'
}

$publicUrl = "https://$AppHostname/"
Write-HostMeta -PublicUrl $publicUrl -LocalUrl $localUrl
Write-Host ''
Write-Host '============================================================' -ForegroundColor White
Write-Host ' GAMETRACKER DISCOVERY (SIGNALING)' -ForegroundColor Green
Write-Host "   $publicUrl" -ForegroundColor Green
Write-Host "   $localUrl" -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor White
Write-Host "Logs: $SignalLog" -ForegroundColor DarkGray
Write-Host 'Jobs: Get-Job | Receive-Job -Name DiscoverySignal,DiscoveryTunnel -Keep' -ForegroundColor DarkGray
Write-Host ''

Wait-DiscoveryForeground
