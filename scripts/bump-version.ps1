<#
.SYNOPSIS
    Bump the GameTracker version everywhere in one shot.

.DESCRIPTION
    Updates the version string in every source-of-truth file so the installer,
    the auto-updater, and the version shown inside the app all agree:

        package.json                          "version"
        package-lock.json                     root "version" + packages."".version
        src-tauri/tauri.conf.json             "version"   (embedded at compile time -> package_info)
        src-tauri/Cargo.toml                  [package] version
        src-tauri/Cargo.lock                  gametracker package entry
        companion/src-tauri/tauri.conf.json   "version"   (the Android APK version + apk-latest.json)
        companion/src-tauri/Cargo.toml        [package] version
        companion/src-tauri/Cargo.lock        gametracker-companion package entry

    The NSIS installer template uses {{version}} placeholders that Tauri fills
    from tauri.conf.json, and the version label in the app reads package_info()
    (driven by Cargo.toml / tauri.conf.json), so those need no manual edit.

    The Android companion is a SEPARATE Tauri app: its version comes from
    companion/src-tauri/tauri.conf.json, which is ALSO what the release workflow
    reads to write apk-latest.json (the manifest the phone's in-app updater polls).
    If the companion isn't bumped, both the installed APK and the manifest keep the
    old version, so the phone always reports "you're on the latest version" and
    auto-update never fires. Hence these must move together with the desktop.

    The frontend version strings (title bar "vX.Y.Z", Settings "Tracker X.Y.Z")
    read package.json at build time via Vite's `__APP_VERSION__` define
    (src/lib/version.ts), so bumping package.json here updates them too.

.PARAMETER Version
    The new semver version, e.g. 3.0.4  (a leading "v" is accepted and stripped).
    If omitted, the current version is printed and nothing is changed.

.PARAMETER Tag
    After bumping, create a git commit + annotated tag "v<version>" so pushing it
    triggers the release workflow (.github/workflows/release.yml).

.PARAMETER Push
    Implies -Tag, and also pushes the commit and tag to origin (kicks off CI).

.EXAMPLE
    powershell -File scripts/bump-version.ps1 3.0.4
    powershell -File scripts/bump-version.ps1 3.0.4 -Tag
    powershell -File scripts/bump-version.ps1 3.0.4 -Push
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Version,
    [switch]$Tag,
    [switch]$Push
)

$ErrorActionPreference = "Stop"

# Repo root = parent of this script's folder.
$root = Split-Path -Parent $PSScriptRoot
function P([string]$rel) { Join-Path $root $rel }

$pkgJson  = P "package.json"
$pkgLock  = P "package-lock.json"
$confJson = P "src-tauri/tauri.conf.json"
$cargo    = P "src-tauri/Cargo.toml"
$cargoLk  = P "src-tauri/Cargo.lock"
# Android companion (separate Tauri app). Historically these drifted behind the
# desktop because the bump only touched the files above, which silently broke the
# phone's in-app updater — so they're bumped here too, matched independently of the
# desktop's current version (they may not agree with it).
$cCompConf  = P "companion/src-tauri/tauri.conf.json"
$cCompCargo = P "companion/src-tauri/Cargo.toml"
$cCompLock  = P "companion/src-tauri/Cargo.lock"

# Read/write files as UTF-8 (no BOM) explicitly. Windows PowerShell 5.1's
# Get-Content -Raw mis-decodes non-ASCII bytes (e.g. the em-dash in Cargo.toml's
# description) using the legacy ANSI codepage, which corrupts the file on save.
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
function Read-Text([string]$path)  { [System.IO.File]::ReadAllText($path) }
function Write-Text([string]$path, [string]$text) { [System.IO.File]::WriteAllText($path, $text, $utf8NoBom) }

# --- Read the current version from package.json (the canonical source) ---------
$pkgRaw = Read-Text $pkgJson
if ($pkgRaw -notmatch '"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+[^"]*)"') {
    throw "Could not find a version field in $pkgJson"
}
$current = $Matches[1]

if (-not $Version) {
    Write-Host "Current version: $current" -ForegroundColor Cyan
    Write-Host "Pass a new version to bump, e.g.:  powershell -File scripts/bump-version.ps1 $($current -replace '\d+$', ([int]($current -split '\.')[-1] + 1))"
    return
}

# Normalize / validate the requested version.
$new = $Version.TrimStart('v', 'V').Trim()
if ($new -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$') {
    throw "'$Version' is not a valid semver version (expected e.g. 3.0.4)."
}
if ($new -eq $current) {
    throw "Version is already $new -- nothing to do."
}

Write-Host "Bumping $current  ->  $new" -ForegroundColor Green

# --- Targeted, format-preserving replacements ---------------------------------
# We replace the exact old version string in each known location rather than
# round-tripping JSON/TOML, so formatting and comments are left untouched.
$esc = [regex]::Escape($current)

function Edit-File([string]$path, [string]$pattern, [string]$replacement, [string]$label) {
    $raw = Read-Text $path
    $updated = [regex]::Replace($raw, $pattern, $replacement, 1)
    if ($updated -eq $raw) {
        throw "Did not find the version to replace in $path ($label). File left unchanged."
    }
    Write-Text $path $updated
    Write-Host "  updated $(Resolve-Path $path -Relative)" -ForegroundColor DarkGray
}

# Like Edit-File, but the version being replaced is captured from the file itself
# (any semver) rather than assumed to equal the desktop's $current. This is what
# lets the companion re-sync even after it has drifted behind (e.g. companion 3.2.7
# while the desktop is 3.6.0). $pattern must capture the leading text in group 1,
# the version in group 2, and the trailing text in group 3. A file already at $new
# is left untouched (not an error) so re-runs are safe.
function Set-Version([string]$path, [string]$pattern, [string]$label) {
    if (-not (Test-Path $path)) {
        throw "Expected file not found: $path ($label)."
    }
    $raw = Read-Text $path
    $m = [regex]::Match($raw, $pattern)
    if (-not $m.Success) {
        throw "Did not find a version to replace in $path ($label). File left unchanged."
    }
    $old = $m.Groups[2].Value
    if ($old -eq $new) {
        Write-Host "  already $new in $(Resolve-Path $path -Relative) ($label)" -ForegroundColor DarkGray
        return
    }
    $updated = $raw.Remove($m.Groups[2].Index, $m.Groups[2].Length).Insert($m.Groups[2].Index, $new)
    Write-Text $path $updated
    Write-Host "  updated $(Resolve-Path $path -Relative)  ($old -> $new)" -ForegroundColor DarkGray
}

# package.json:        "version": "x.y.z"
Edit-File $pkgJson  "(`"version`"\s*:\s*`")$esc(`")" "`${1}$new`${2}" "package.json version"

# package-lock.json:   npm stores the app's own version in exactly TWO places — the root
#                      "version" and packages."".version — and they are always the first
#                      two "version" fields in the file. Every OTHER "version" belongs to
#                      a dependency and must not be touched, which is why this uses the
#                      instance Replace overload with a real count of 2 rather than
#                      Edit-File (whose trailing `1` is a RegexOptions, not a count, so it
#                      rewrites every match — fine for the files above, wrong here).
#                      npm rewrites these on `npm install`, but the lock is committed, so
#                      a bump that skips it leaves the tree inconsistent.
$lockRaw = Read-Text $pkgLock
$lockRe  = [regex]"(`"version`"\s*:\s*`")$esc(`")"
$lockNew = $lockRe.Replace($lockRaw, "`${1}$new`${2}", 2)
if ($lockNew -eq $lockRaw) {
    throw "Did not find version $current to replace in $pkgLock. File left unchanged."
}
Write-Text $pkgLock $lockNew
Write-Host "  updated $(Resolve-Path $pkgLock -Relative)" -ForegroundColor DarkGray

# tauri.conf.json:     "version": "x.y.z"
Edit-File $confJson "(`"version`"\s*:\s*`")$esc(`")" "`${1}$new`${2}" "tauri.conf.json version"

# Cargo.toml:          version = "x.y.z"  (line-anchored = the [package] version,
#                      not rust-version / dependency versions)
Edit-File $cargo    "(?m)^(version\s*=\s*`")$esc(`")" "`${1}$new`${2}" "Cargo.toml [package] version"

# Cargo.lock:          the version line directly under  name = "gametracker"
Edit-File $cargoLk  "(name = `"gametracker`"\r?\nversion = `")$esc(`")" "`${1}$new`${2}" "Cargo.lock gametracker entry"

# --- Android companion (matched independently of the desktop's $current) --------
# companion tauri.conf.json:  "version": "x.y.z"  (drives the APK version + apk-latest.json)
Set-Version $cCompConf  "(`"version`"\s*:\s*`")([0-9]+\.[0-9]+\.[0-9]+[^`"]*)(`")" "companion tauri.conf.json version"
# companion Cargo.toml:       version = "x.y.z"   (first line-anchored = the [package] version)
Set-Version $cCompCargo "(?m)^(version\s*=\s*`")([0-9]+\.[0-9]+\.[0-9]+[^`"]*)(`")" "companion Cargo.toml [package] version"
# companion Cargo.lock:       the version line directly under  name = "gametracker-companion"
Set-Version $cCompLock  "(name = `"gametracker-companion`"\r?\nversion = `")([0-9]+\.[0-9]+\.[0-9]+[^`"]*)(`")" "companion Cargo.lock entry"

Write-Host "Version bumped to $new in 8 files (desktop + Android companion)." -ForegroundColor Green

# --- Optional git tag / push --------------------------------------------------
if ($Tag -or $Push) {
    Push-Location $root
    try {
        git add $pkgJson $pkgLock $confJson $cargo $cargoLk $cCompConf $cCompCargo $cCompLock | Out-Null
        git commit -m "Bump version to $new" | Out-Null
        git tag -a "v$new" -m "Tracker v$new" | Out-Null
        Write-Host "Committed and tagged v$new." -ForegroundColor Green
        if ($Push) {
            git push origin HEAD
            git push origin "v$new"
            Write-Host "Pushed commit + tag v$new -- release workflow will build and publish." -ForegroundColor Green
        } else {
            Write-Host "Run:  git push origin HEAD; git push origin v$new   to trigger the release." -ForegroundColor Yellow
        }
    } finally {
        Pop-Location
    }
} else {
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Yellow
    Write-Host "  1. Review the changes:  git diff"
    Write-Host "  2. Commit + tag:        powershell -File scripts/bump-version.ps1 $new -Tag"
    Write-Host "     (or re-run with -Push to also push and start the release build)"
}
