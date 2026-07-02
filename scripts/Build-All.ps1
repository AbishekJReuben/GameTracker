<#
.SYNOPSIS
    Build the NSIS installer and the Android APK, one after another (sequential).

.DESCRIPTION
    Builds the shared web bundle once (npm run build), then runs Build-Installer.ps1
    and Build-Apk.ps1 in sequence, each with -SkipWebBuild so the bundle isn't rebuilt.
    Each step runs even if the previous one failed; a summary is printed at the end and
    the script exits non-zero if any step failed.

    Sequential avoids the shared-dist race and the cargo/gradle contention you get from
    running both native builds at once.

.PARAMETER ApkFirst
    Build the APK before the installer (default: installer first).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\Build-All.ps1
#>
[CmdletBinding()]
param([switch]$ApkFirst)

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$scripts = Join-Path $root 'scripts'
$total = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host "== [1/3] Building shared web bundle once (npm run build) ==" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "web build failed (exit $LASTEXITCODE) - aborting before the native builds." }

$steps = @(
    @{ Name = 'NSIS'; Path = (Join-Path $scripts 'Build-Installer.ps1') },
    @{ Name = 'APK';  Path = (Join-Path $scripts 'Build-Apk.ps1') }
)
if ($ApkFirst) { [array]::Reverse($steps) }

$results = [ordered]@{}
$i = 2
foreach ($step in $steps) {
    Write-Host ("== [{0}/3] Building {1} ==" -f $i, $step.Name) -ForegroundColor Cyan
    try {
        & $step.Path -SkipWebBuild          # child throws on failure (guards on its own LASTEXITCODE)
        $results[$step.Name] = 'OK'
    } catch {
        $results[$step.Name] = "FAILED: $($_.Exception.Message)"
        Write-Warning ("{0} build failed: {1}" -f $step.Name, $_.Exception.Message)
    }
    Set-Location $root                       # child scripts Set-Location; restore between steps
    $i++
}

$total.Stop()
Write-Host ""
Write-Host ("== Sequential build finished in {0:n0}s ==" -f $total.Elapsed.TotalSeconds) -ForegroundColor Cyan
$failed = @()
foreach ($k in $results.Keys) {
    $ok = $results[$k] -eq 'OK'
    Write-Host ("  {0,-5} : {1}" -f $k, $results[$k]) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
    if (-not $ok) { $failed += $k }
}
if ($failed.Count -gt 0) { throw ("Build(s) failed: {0}. See the output above." -f ($failed -join ', ')) }
Write-Host "All artifacts built successfully." -ForegroundColor Green
