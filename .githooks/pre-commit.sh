#!/bin/sh
# Unix/macOS entry (copied to `.githooks/pre-commit` by install-git-hooks.mjs).
# Auto-rebuild the web companion bundle (signaling/static) whenever a commit
# touches shared source. Escape hatch: GT_SKIP_WEB_BUILD=1
set -e

if [ "$GT_SKIP_WEB_BUILD" = "1" ]; then
  echo "[pre-commit] GT_SKIP_WEB_BUILD=1 — skipping web bundle rebuild."
  exit 0
fi

changed=$(git diff --cached --name-only --diff-filter=ACMR)

relevant=$(printf '%s\n' "$changed" \
  | grep -E '^(src/|companion\.html|quest\.html|index\.html|package\.json|package-lock\.json|vite\.quest\.config\.ts|tailwind\.|postcss\.)' \
  | grep -v '^signaling/static/' \
  || true)

if [ -z "$relevant" ]; then
  exit 0
fi

echo "[pre-commit] shared source changed — rebuilding web bundle (signaling/static)…"
npm run discovery:build
git add signaling/static
echo "[pre-commit] signaling/static rebuilt and staged. (GT_SKIP_WEB_BUILD=1 to skip)"
