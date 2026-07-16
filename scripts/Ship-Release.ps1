<#
.SYNOPSIS
  Ship a GameTracker version to the personal GitHub remote (starts CI).

.DESCRIPTION
  One-shot release helper used by ReleaseControlCenter.ps1:

    1. bump-version.ps1 <ver>     — rewrite version in desktop + companion files
    2. sync package-lock.json
    3. git add -A + commit        — ALL working-tree changes (not just version files)
    4. annotated tag v<ver>
    5. git push <Remote> HEAD + tag   — kicks .github/workflows/release.yml

  Default remote is **personal** (AbishekJReuben/GameTracker), NOT origin
  (ChilloutGameStudio). CI secrets and Releases live on personal.

.PARAMETER Version
  Semver, e.g. 3.9.7 (leading v stripped).

.PARAMETER Remote
  Git remote name. Default: personal.

.PARAMETER DryRun
  Print steps without changing files / git.

.PARAMETER VersionFilesOnly
  Legacy: stage only the version bump files (package.json, tauri configs, Cargo
  locks). Default is to ship the entire working tree so feature work isn't left
  uncommitted when you cut a release.

.EXAMPLE
  powershell -File scripts/Ship-Release.ps1 3.9.7
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Version,
  [string] $Remote = 'personal',
  [switch] $DryRun,
  [switch] $SkipBump,
  [switch] $VersionFilesOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$ver = $Version.TrimStart('v', 'V').Trim()
if ($ver -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$') {
  throw "'$Version' is not valid semver (expected e.g. 3.9.7)."
}
$tag = "v$ver"

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

# --- sanity ------------------------------------------------------------------
$remotes = git remote
if ($remotes -notcontains $Remote) {
  throw "Git remote '$Remote' not found. Known: $($remotes -join ', '). Add with: git remote add personal https://github.com/AbishekJReuben/GameTracker.git"
}

$existingTag = git tag -l $tag
if ($existingTag) {
  throw "Tag $tag already exists locally. Delete it first if you intend to re-cut: git tag -d $tag"
}

# --- 1. bump -----------------------------------------------------------------
if (-not $SkipBump) {
  Write-Step "Bump version files to $ver"
  if ($DryRun) {
    Write-Host "[dry-run] powershell -File scripts/bump-version.ps1 $ver"
  } else {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'bump-version.ps1') $ver
    if ($LASTEXITCODE -ne 0) { throw "bump-version.ps1 failed ($LASTEXITCODE)" }

    Write-Step "Sync package-lock.json"
    npm install --package-lock-only --ignore-scripts | Out-Host
  }
} else {
  Write-Step "Skip bump (files already at $ver)"
}

# --- 2. stage ----------------------------------------------------------------
$versionFiles = @(
  'package.json'
  'package-lock.json'
  'src-tauri/tauri.conf.json'
  'src-tauri/Cargo.toml'
  'src-tauri/Cargo.lock'
  'companion/src-tauri/tauri.conf.json'
  'companion/src-tauri/Cargo.toml'
  'companion/src-tauri/Cargo.lock'
)

if ($VersionFilesOnly) {
  Write-Step "Stage version files only"
  if ($DryRun) {
    Write-Host "[dry-run] git add $($versionFiles -join ' ')"
  } else {
    git add -- $versionFiles
  }
} else {
  Write-Step "Stage all working-tree changes"
  if ($DryRun) {
    Write-Host "[dry-run] git add -A"
  } else {
    # Entire tree: feature work + version bump ship together. Pre-commit may
    # also rebuild/stage signaling/static when src/ is included.
    git add -A
  }
}

if (-not $DryRun) {
  $staged = git diff --cached --name-only
  if (-not $staged) {
    throw "Nothing staged. Working tree clean and version files already at $ver?"
  }
  Write-Host ($staged | Out-String)
}

# --- 3. commit ---------------------------------------------------------------
Write-Step "Commit"
$msg = "Release $ver"
if ($DryRun) {
  Write-Host "[dry-run] git commit -m `"$msg`""
} else {
  # Ensure Windows uses the .cmd hook (not a leftover shebang script via WSL).
  & node (Join-Path $PSScriptRoot 'install-git-hooks.mjs')
  git commit -m $msg
  if ($LASTEXITCODE -ne 0) { throw "git commit failed ($LASTEXITCODE)" }
}

# --- 4. tag ------------------------------------------------------------------
Write-Step "Create annotated tag $tag"
if ($DryRun) {
  Write-Host "[dry-run] git tag -a $tag -m `"Tracker $tag`""
} else {
  git tag -a $tag -m "Tracker $tag"
  if ($LASTEXITCODE -ne 0) { throw "git tag failed ($LASTEXITCODE)" }
}

# --- 5. push -----------------------------------------------------------------
Write-Step "Push commit + tag to '$Remote' (starts CI)"
if ($DryRun) {
  Write-Host "[dry-run] git push $Remote HEAD"
  Write-Host "[dry-run] git push $Remote $tag"
} else {
  git push $Remote HEAD
  if ($LASTEXITCODE -ne 0) { throw "git push $Remote HEAD failed ($LASTEXITCODE)" }
  git push $Remote $tag
  if ($LASTEXITCODE -ne 0) { throw "git push $Remote $tag failed ($LASTEXITCODE)" }
}

Write-Host ""
Write-Host "Shipped $tag to $Remote." -ForegroundColor Green
Write-Host "CI order: create-release → android (APK) → desktop (NSIS)." -ForegroundColor DarkGray
Write-Host "Watch: https://github.com/AbishekJReuben/GameTracker/actions" -ForegroundColor DarkGray
