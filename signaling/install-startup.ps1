# Install (or remove) a Windows Scheduled Task that starts the GameTracker
# signaling server automatically at every logon, so the phone can always reach
# your PC "from anywhere" (paired with the Cloudflare Tunnel to
# discovery.chilloutgamestudio.com — see cloudflared-config.example.yml).
#
# It runs the prebuilt release binary hidden, and restarts it on failure. The
# binary is built first if it's missing (so the task never has to build at logon).
#
# Usage:
#   pwsh signaling/install-startup.ps1              # install / update the task
#   pwsh signaling/install-startup.ps1 -Port 8080   # custom port
#   pwsh signaling/install-startup.ps1 -Uninstall   # remove the task
#
# If Register-ScheduledTask reports access denied, run this from an elevated shell.

param(
    [int]$Port = 8080,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$taskName = "GameTracker Signaling"

if ($Uninstall) {
    try {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
        Write-Host "Removed scheduled task '$taskName'." -ForegroundColor Green
    } catch {
        Write-Host "No scheduled task '$taskName' to remove." -ForegroundColor Yellow
    }
    return
}

$exe = Join-Path $here "target\release\gametracker-signal.exe"
if (-not (Test-Path $exe)) {
    Write-Host "Signaling binary not found — building release once..." -ForegroundColor Cyan
    cargo build --release --manifest-path "$here\Cargo.toml"
    if (-not (Test-Path $exe)) { throw "Build succeeded but $exe not found." }
}

# Launch the console app through a hidden PowerShell so no window flashes at logon.
$command = "`$env:PORT=$Port; & '$exe'"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"$command`""

$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "Installed scheduled task '$taskName' (starts at logon on port $Port)." -ForegroundColor Green
Write-Host "Starting it now..." -ForegroundColor Cyan
Start-ScheduledTask -TaskName $taskName
Write-Host "Done. Verify with:  Get-ScheduledTask -TaskName '$taskName'" -ForegroundColor Green
