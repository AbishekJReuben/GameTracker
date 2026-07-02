<#
.SYNOPSIS
  Task Scheduler entry point: launch the GameTracker Discovery Control Center GUI at logon.

.PARAMETER Force
  Launch even if Control Center is already running.

.PARAMETER NoHideConsole
  Leave launcher console visible (debugging).
#>
[CmdletBinding()]
param(
  [switch] $Force,
  [switch] $NoHideConsole
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
  if ($MyInvocation.MyCommand.Path) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
}
if ([string]::IsNullOrWhiteSpace($scriptDir)) { $scriptDir = (Get-Location).Path }
$RepoRoot = (Resolve-Path (Join-Path $scriptDir '..') -ErrorAction SilentlyContinue).Path
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $scriptDir }

$GuiScript = Join-Path $RepoRoot 'scripts\DiscoveryControlCenter.ps1'
$LogDir    = Join-Path $RepoRoot '.logs'
$UiLog     = Join-Path $LogDir 'task-scheduler-ui.log'

try { Set-Location -LiteralPath $RepoRoot } catch {}
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction SilentlyContinue } catch {}

function Write-LauncherLog {
  param([string] $Message, [string] $Level = 'INFO')
  try {
    if (-not (Test-Path -LiteralPath $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    if ((Test-Path -LiteralPath $UiLog) -and ((Get-Item -LiteralPath $UiLog).Length -gt 512KB)) {
      Move-Item -LiteralPath $UiLog -Destination "$UiLog.1" -Force -ErrorAction SilentlyContinue
    }
    [System.IO.File]::AppendAllText($UiLog, ("{0} {1,-5} {2}{3}" -f (Get-Date -Format o), $Level, $Message, [Environment]::NewLine), [System.Text.Encoding]::UTF8)
  } catch {}
}

if (-not $NoHideConsole) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DiscoveryLauncherConsole {
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
'@ -ErrorAction SilentlyContinue
    $console = [DiscoveryLauncherConsole]::GetConsoleWindow()
    if ($console -ne [IntPtr]::Zero) { [DiscoveryLauncherConsole]::ShowWindow($console, 0) | Out-Null }
  } catch {}
}

Write-LauncherLog "Launcher start. RepoRoot=$RepoRoot Interactive=$([Environment]::UserInteractive) Force=$Force"

if (-not (Test-Path -LiteralPath $GuiScript)) {
  Write-LauncherLog "GUI script missing: $GuiScript" 'ERROR'
  if ([Environment]::UserInteractive) {
    try {
      Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
      [System.Windows.Forms.MessageBox]::Show("Discovery GUI script not found:`n$GuiScript", 'Discovery Launcher', 'OK', 'Error') | Out-Null
    } catch {}
  }
  exit 1
}

if (-not [Environment]::UserInteractive) {
  Write-LauncherLog "Non-interactive session - GUI cannot show. Use Task Scheduler 'Run only when user is logged on' + At log on." 'WARN'
  exit 0
}

if (-not $Force) {
  try {
    $existing = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*DiscoveryControlCenter.ps1*' -and $_.ProcessId -ne $PID })
    if ($existing.Count -gt 0) {
      Write-LauncherLog "Control Center already running (PID $($existing[0].ProcessId)); not launching another. Use -Force to override." 'WARN'
      exit 0
    }
  } catch {
    Write-LauncherLog "Single-instance check failed (continuing): $_" 'WARN'
  }
}

$psExe = 'powershell.exe'
try { $cmd = Get-Command powershell.exe -ErrorAction SilentlyContinue; if ($cmd) { $psExe = $cmd.Source } } catch {}

try {
  $proc = Start-Process -FilePath $psExe -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Sta', '-WindowStyle', 'Hidden',
    '-File', "`"$GuiScript`""
  ) -WorkingDirectory $RepoRoot -WindowStyle Hidden -PassThru
  Write-LauncherLog "Launched Control Center (PID $($proc.Id)) via $psExe"
  exit 0
} catch {
  Write-LauncherLog "Failed to launch Control Center: $_" 'ERROR'
  exit 1
}
