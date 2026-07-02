<#
.SYNOPSIS
    Build + sign the GameTracker Remote Android companion APK.

.DESCRIPTION
    Runs `tauri android build` in companion\ (the web bundle is the shared ..\..\dist)
    and signs the unsigned universal release APK with the stock Android debug keystore
    (fine for sideloading), writing companion\GameTrackerRemote.apk — the path the repo
    already tracks.

    Auto-detects the Android SDK/NDK when ANDROID_HOME / NDK_HOME aren't in the
    environment (common in a fresh shell), so the build is self-contained.

.PARAMETER SkipWebBuild
    Assume dist\ was already built (by Build-All.ps1) and don't run `npm run build`.
    `tauri android build` has no beforeBuildCommand, so with this set the APK build
    never touches dist\ — letting it run in parallel with the installer safely.

.PARAMETER OutName
    Output APK file name under companion\ (default GameTrackerRemote.apk).

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\Build-Apk.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipWebBuild,
    [string]$OutName = 'GameTrackerRemote.apk'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Write-Host "== Android companion APK build ==" -ForegroundColor Cyan

# --- locate the Android toolchain (a fresh shell may not export these) ---
if (-not $env:ANDROID_HOME) {
    $cand = @($env:ANDROID_SDK_ROOT, (Join-Path $env:LOCALAPPDATA 'Android\Sdk')) |
        Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $cand) { throw "Android SDK not found. Set ANDROID_HOME (e.g. %LOCALAPPDATA%\Android\Sdk)." }
    $env:ANDROID_HOME = $cand
}
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
if (-not $env:NDK_HOME) {
    $ndkRoot = Join-Path $env:ANDROID_HOME 'ndk'
    $ndk = Get-ChildItem $ndkRoot -Directory -ErrorAction SilentlyContinue |
        Sort-Object { [version]($_.Name) } -ErrorAction SilentlyContinue | Select-Object -Last 1
    if (-not $ndk) { throw "Android NDK not found under $ndkRoot. Install it via Android Studio SDK Manager." }
    $env:NDK_HOME = $ndk.FullName
}
# Gradle needs a valid JDK 17+. An inherited JAVA_HOME can point at a broken/partial
# JDK (e.g. a Unity editor's OpenJDK folder with no bin\java.exe), which makes
# gradlew abort with "JAVA_HOME is set to an invalid directory" — so validate it and
# fall back to a detected JDK (Android Studio's bundled JBR is ideal).
function Test-Jdk($p) { return ($p -and (Test-Path (Join-Path $p 'bin\java.exe'))) }
if (-not (Test-Jdk $env:JAVA_HOME)) {
    $jdks = @(
        (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Android Studio\jbr')
    )
    $jdks += (Get-ChildItem 'C:\Program Files\Eclipse Adoptium' -Directory -EA SilentlyContinue | ForEach-Object FullName)
    $jdks += (Get-ChildItem (Join-Path $env:ProgramFiles 'Microsoft') -Directory -Filter 'jdk-*' -EA SilentlyContinue | ForEach-Object FullName)
    $jdks += (Get-ChildItem (Join-Path $env:ProgramFiles 'Java') -Directory -EA SilentlyContinue | ForEach-Object FullName)
    $jdks += (Get-ChildItem (Join-Path $env:ProgramFiles 'Unity\Hub\Editor') -Directory -EA SilentlyContinue |
                ForEach-Object { Join-Path $_.FullName 'Editor\Data\PlaybackEngines\AndroidPlayer\OpenJDK' })
    $found = $jdks | Where-Object { Test-Jdk $_ } | Select-Object -First 1
    if (-not $found) { throw "No valid JDK (17+) found. Install Android Studio (bundled JBR) or set JAVA_HOME to a JDK with bin\java.exe." }
    if ($env:JAVA_HOME) { Write-Warning "Inherited JAVA_HOME is invalid ('$($env:JAVA_HOME)')." }
    $env:JAVA_HOME = $found
}
$env:PATH = (Join-Path $env:JAVA_HOME 'bin') + ';' + $env:PATH   # ensure gradle/apksigner find java
Write-Host "ANDROID_HOME = $($env:ANDROID_HOME)"
Write-Host "NDK_HOME     = $($env:NDK_HOME)"
Write-Host "JAVA_HOME    = $($env:JAVA_HOME)"

# --- shared web bundle (skip when the orchestrator already built dist\) ---
if (-not $SkipWebBuild) {
    Write-Host "Building web bundle (npm run build)..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "web build failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "Skipping web bundle (dist\ already built)."
}

# --- apply Android project customizations (permission/FileProvider/cleartext) ---
# Idempotent; the same script CI runs so local + CI builds match. Requires
# gen/android to exist (run `npm run companion:init` once).
if (Test-Path (Join-Path $root 'companion\src-tauri\gen\android')) {
    Write-Host "Patching Android project (scripts\patch-android.mjs)..."
    node (Join-Path $root 'scripts\patch-android.mjs')
    if ($LASTEXITCODE -ne 0) { throw "patch-android.mjs failed (exit $LASTEXITCODE)" }
}

# --- native Android build ---
Push-Location (Join-Path $root 'companion')
try {
    Write-Host "Running: npx tauri android build"
    npx tauri android build
    if ($LASTEXITCODE -ne 0) { throw "tauri android build failed (exit $LASTEXITCODE)" }
} finally { Pop-Location }

# --- sign the unsigned release APK with the debug keystore ---
$unsigned = Join-Path $root 'companion\src-tauri\gen\android\app\build\outputs\apk\universal\release\app-universal-release-unsigned.apk'
if (-not (Test-Path $unsigned)) { throw "Unsigned APK not found (did the Gradle build produce a 'universal' variant?): $unsigned" }

$bt = Get-ChildItem (Join-Path $env:ANDROID_HOME 'build-tools') -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'apksigner.bat') } |
    Sort-Object { [version]($_.Name) } | Select-Object -Last 1
if (-not $bt) { throw "No usable build-tools (with apksigner) under $($env:ANDROID_HOME)\build-tools." }
$zipalign  = Join-Path $bt.FullName 'zipalign.exe'
$apksigner = Join-Path $bt.FullName 'apksigner.bat'
$keystore  = Join-Path $env:USERPROFILE '.android\debug.keystore'
if (-not (Test-Path $keystore)) {
    throw "Debug keystore not found at $keystore. Create one with: keytool -genkey -v -keystore $keystore -storepass android -alias androiddebugkey -keypass android -keyalg RSA -keysize 2048 -validity 10000 -dname `"CN=Android Debug`""
}
Write-Host "Signing with build-tools $($bt.Name) + debug keystore."

$aligned = Join-Path ([System.IO.Path]::GetTempPath()) ("gt-aligned-{0}.apk" -f ([guid]::NewGuid().ToString('N')))
$out = Join-Path $root "companion\$OutName"
try {
    & $zipalign -f -p 4 $unsigned $aligned
    if ($LASTEXITCODE -ne 0) { throw "zipalign failed (exit $LASTEXITCODE)" }
    & $apksigner sign --ks $keystore --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android --out $out $aligned
    if ($LASTEXITCODE -ne 0) { throw "apksigner failed (exit $LASTEXITCODE)" }
} finally {
    Remove-Item $aligned -Force -ErrorAction SilentlyContinue
}

$apk = Get-Item $out
$sw.Stop()
Write-Host ("== APK done in {0:n0}s ==" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
Write-Host ("APK: {0}  ({1:n1} MB)" -f $apk.FullName, ($apk.Length / 1MB)) -ForegroundColor Green
