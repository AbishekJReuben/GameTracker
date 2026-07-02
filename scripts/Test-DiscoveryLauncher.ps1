<#
.SYNOPSIS
  Dependency-free tests for the GameTracker Discovery launcher + control center.

  Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-DiscoveryLauncher.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$Gui = Join-Path $scriptDir 'DiscoveryControlCenter.ps1'

$failures = [System.Collections.Generic.List[string]]::new()
$passed = 0
function Assert-True([bool]$Condition, [string]$Name, [string]$Detail = '') {
  if ($Condition) { $script:passed++; Write-Host "  OK   $Name" -ForegroundColor Green }
  else {
    $msg = if ($Detail) { "$Name - $Detail" } else { $Name }
    $script:failures.Add($msg); Write-Host "  FAIL $msg" -ForegroundColor Red
  }
}

function Get-TopBlock([string]$Text, [string]$StartContains) {
  $lines = $Text -split "`r?`n"
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -like "*$StartContains*") { $idx = $i; break } }
  if ($idx -lt 0) { return $null }
  $depth = 0
  $sb = New-Object System.Text.StringBuilder
  for ($i = $idx; $i -lt $lines.Count; $i++) {
    [void]$sb.AppendLine($lines[$i])
    $depth += ([regex]::Matches($lines[$i], '\{')).Count - ([regex]::Matches($lines[$i], '\}')).Count
    if ($i -gt $idx -and $depth -le 0) { break }
  }
  return $sb.ToString()
}

function Invoke-Runspace([string]$ScriptText, [object]$Arg) {
  $body = $ScriptText
  if ($body -match '^\s*\$script:(?:Probe|Metrics)Script\s*=\s*\{') {
    $body = ($body -replace '^\s*\$script:(?:Probe|Metrics)Script\s*=\s*\{', '').TrimEnd()
    if ($body.EndsWith('}')) { $body = $body.Substring(0, $body.Length - 1).TrimEnd() }
  }
  $rs = [runspacefactory]::CreateRunspace(); $rs.ApartmentState = 'MTA'; $rs.Open()
  $ps = [PowerShell]::Create(); $ps.Runspace = $rs
  $null = $ps.AddScript($body)
  if ($null -ne $Arg) { $null = $ps.AddArgument($Arg) }
  $out = $ps.Invoke()
  $ps.Dispose(); $rs.Dispose()
  if ($out -and $out.Count -gt 0) { return $out[$out.Count - 1] }
  return $null
}

Write-Host "`n=== Discovery launcher tests ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoRoot`n"

$scripts = @('ChilloutDashboardKit.ps1','DiscoveryControlCenter.ps1','Start-DiscoveryPublic.ps1','RunStartScript.ps1','Register-DiscoveryAutostart.ps1','Test-DiscoveryLauncher.ps1')
foreach ($name in $scripts) {
  $p = Join-Path $scriptDir $name
  if (Test-Path -LiteralPath $p) {
    $tokens = $null; $errs = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$tokens, [ref]$errs)
    Assert-True (($null -eq $errs) -or ($errs.Count -eq 0)) "parses: $name" ($(if ($errs.Count) { $errs[0].Message } else { '' }))
  } else { Assert-True $false "exists: $name" }
}

$vbs = Join-Path $scriptDir 'RunStartScriptHidden.vbs'
if (Test-Path -LiteralPath $vbs) {
  $vbsText = Get-Content -LiteralPath $vbs -Raw
  Assert-True ($vbsText -match 'RunStartScript\.ps1') 'VBS references RunStartScript.ps1'
} else { Assert-True $false 'exists: RunStartScriptHidden.vbs' }

foreach ($name in @('ChilloutDashboardKit.ps1','DiscoveryControlCenter.ps1','Start-DiscoveryPublic.ps1','RunStartScript.ps1','Register-DiscoveryAutostart.ps1')) {
  $b = [IO.File]::ReadAllBytes((Join-Path $scriptDir $name))
  Assert-True ($b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF) "UTF-8 BOM: $name"
}

$guiText = Get-Content -Raw -LiteralPath $Gui
Assert-True ($guiText -match 'ChilloutDashboardKit\.ps1') 'GUI dot-sources ChilloutDashboardKit'
Assert-True ($guiText -match 'Get-CgResourceXaml') 'GUI uses Get-CgResourceXaml'
Assert-True ($guiText -match 'DiscoveryLogQueue') 'GUI uses DiscoveryLogQueue'
Assert-True ($guiText -match 'function Wait-DiscoveryForeground' -or (Get-Content (Join-Path $scriptDir 'Start-DiscoveryPublic.ps1') -Raw) -match 'Wait-DiscoveryForeground') 'Wait-DiscoveryForeground exists'
Assert-True ($guiText -match '\$script:Ctl') 'GUI uses $script:Ctl'
Assert-True ($guiText -match 'Start-ProbeAsync') 'GUI has child runspace probe'
Assert-True ($guiText -match 'Start-MetricsAsync') 'GUI has child runspace metrics'

$startText = Get-Content -LiteralPath (Join-Path $scriptDir 'Start-DiscoveryPublic.ps1') -Raw
Assert-True ($startText -match 'function Wait-DiscoveryForeground') 'Start-DiscoveryPublic defines Wait-DiscoveryForeground'
Assert-True ($startText -match 'IsOutputRedirected') 'Wait-DiscoveryForeground checks IsOutputRedirected'
Assert-True ($startText -match 'gametracker-signal') 'Start script references gametracker-signal'

$probeBlock = Get-TopBlock $guiText '$script:ProbeScript'
if ($probeBlock) {
  $arg = @{
    RunnerActive=$false; RunnerExited=$false; RunnerPid=0; RunnerExitCode=0
    LocalOnly=$true; SkipTunnel=$true; Port=8080; AppHost='discovery.chilloutgamestudio.com'; RepoRoot=$RepoRoot
  }
  $r = Invoke-Runspace $probeBlock $arg
  Assert-True ($r -is [hashtable]) 'probe returns hashtable'
  if ($r -is [hashtable]) {
    Assert-True ($r.ContainsKey('runner')) 'probe has runner'
    Assert-True ($r.ContainsKey('signal')) 'probe has signal'
    Assert-True ($r.ContainsKey('traffic')) 'probe has traffic'
    if ($r.ContainsKey('traffic')) {
      Assert-True ($r.traffic.ContainsKey('LocalMs')) 'traffic.LocalMs'
      Assert-True ($r.traffic.ContainsKey('SuccessPct')) 'traffic.SuccessPct'
    }
  }
} else { Assert-True $false 'extract ProbeScript' }

$metricsBlock = Get-TopBlock $guiText '$script:MetricsScript'
if ($metricsBlock) {
  $m = Invoke-Runspace $metricsBlock $null
  Assert-True ($m -is [hashtable]) 'metrics returns hashtable'
  if ($m -is [hashtable]) {
    Assert-True ($m.ContainsKey('SigCpu')) 'metrics.SigCpu'
    Assert-True ($m.ContainsKey('CloudflaredCount')) 'metrics.CloudflaredCount'
  }
} else { Assert-True $false 'extract MetricsScript' }

Assert-True (Test-Path (Join-Path $RepoRoot 'package.json')) 'package.json at repo root'

$reg = Join-Path $scriptDir 'Register-DiscoveryAutostart.ps1'
if (Test-Path $reg) {
  $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $reg -Status 2>&1 | Out-String
  Assert-True ($LASTEXITCODE -eq 0) 'Register-DiscoveryAutostart -Status runs'
}

Write-Host "`nPassed: $passed" -ForegroundColor Cyan
if ($failures.Count -gt 0) {
  Write-Host "Failed: $($failures.Count)" -ForegroundColor Red
  foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
  exit 1
}
Write-Host 'All discovery launcher tests passed.' -ForegroundColor Green
exit 0
