# Auto-rebuild the web companion bundle (signaling/static) whenever a commit
# touches shared source. PowerShell entry — used on Windows so GitHub Desktop /
# Git for Windows never route the hook through a broken WSL bash stub
# (`execvpe(/bin/bash) failed: No such file or directory`).
#
# Wired via `git config core.hooksPath .githooks` (package.json `prepare` →
# scripts/install-git-hooks.mjs). Escape hatch: $env:GT_SKIP_WEB_BUILD = '1'

$ErrorActionPreference = 'Stop'

if ($env:GT_SKIP_WEB_BUILD -eq '1') {
  Write-Host '[pre-commit] GT_SKIP_WEB_BUILD=1 — skipping web bundle rebuild.'
  exit 0
}

$changed = @(git diff --cached --name-only --diff-filter=ACMR)
if (-not $changed -or $changed.Count -eq 0) { exit 0 }

$relevant = $changed | Where-Object {
  $_ -match '^(src/|companion\.html|quest\.html|index\.html|package\.json|package-lock\.json|vite\.quest\.config\.ts|tailwind\.|postcss\.)' -and
  $_ -notmatch '^signaling/static/'
}

if (-not $relevant -or $relevant.Count -eq 0) { exit 0 }

Write-Host '[pre-commit] shared source changed — rebuilding web bundle (signaling/static)…'
npm run discovery:build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git add signaling/static
Write-Host '[pre-commit] signaling/static rebuilt and staged. (GT_SKIP_WEB_BUILD=1 to skip)'
exit 0
