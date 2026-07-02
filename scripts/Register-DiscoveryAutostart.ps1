<#
.SYNOPSIS
  Register / remove / inspect the GameTracker Discovery Control Center logon scheduled task.

.PARAMETER Unregister
  Remove the scheduled task.

.PARAMETER Status
  Print task definition and exit.

.PARAMETER RunNow
  Start the task immediately after registering.

.PARAMETER TaskName
  Override task name. Default: GameTracker Discovery
#>
[CmdletBinding(DefaultParameterSetName = 'Register')]
param(
  [Parameter(ParameterSetName = 'Unregister')] [switch] $Unregister,
  [Parameter(ParameterSetName = 'Status')]     [switch] $Status,
  [Parameter(ParameterSetName = 'Register')]   [switch] $RunNow,
  [string] $TaskName = 'GameTracker Discovery'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) { $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$RepoRoot = (Resolve-Path (Join-Path $scriptDir '..')).Path
$Vbs = Join-Path $RepoRoot 'scripts\RunStartScriptHidden.vbs'

if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
  Write-Host 'The ScheduledTasks module is not available on this system.' -ForegroundColor Red
  exit 1
}

function Show-Status {
  param([string]$Name)
  $t = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if (-not $t) { Write-Host "Task '$Name' is not registered." -ForegroundColor Yellow; return }
  $info = Get-ScheduledTaskInfo -TaskName $Name -ErrorAction SilentlyContinue
  Write-Host "Task:        $Name" -ForegroundColor Cyan
  Write-Host "State:       $($t.State)"
  Write-Host "Action:      $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
  Write-Host "WorkingDir:  $($t.Actions[0].WorkingDirectory)"
  Write-Host "Triggers:    $(($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', ')"
  if ($info) {
    Write-Host "Last run:    $($info.LastRunTime)  (result 0x$('{0:X}' -f $info.LastTaskResult))"
    Write-Host "Next run:    $($info.NextRunTime)"
  }
}

if ($Status) {
  Show-Status -Name $TaskName
  exit 0
}

if ($Unregister) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'." -ForegroundColor Green
  } else {
    Write-Host "Task '$TaskName' was not registered." -ForegroundColor Yellow
  }
  exit 0
}

if (-not (Test-Path -LiteralPath $Vbs)) {
  Write-Host "Launcher not found: $Vbs" -ForegroundColor Red
  exit 1
}

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path -LiteralPath $wscript)) { $wscript = 'wscript.exe' }

$action  = New-ScheduledTaskAction -Execute $wscript -Argument ('"{0}"' -f $Vbs) -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Launch the GameTracker Discovery signaling dashboard at logon (rendezvous server on :8080).' | Out-Null

Write-Host "Registered scheduled task '$TaskName' (At log on, $env:USERDOMAIN\$env:USERNAME)." -ForegroundColor Green
Write-Host "Action: $wscript `"$Vbs`"" -ForegroundColor DarkGray
Show-Status -Name $TaskName

if ($RunNow) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host "Started '$TaskName' now." -ForegroundColor Green
}
