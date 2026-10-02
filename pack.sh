#!/usr/bin/env bash
#
# Builds the Chrome Web Store upload zip with an explicit file list, so dev
# files (tests/, markdown, .git, tooling) can never ride along.
#
# Usage: ./pack.sh [--allow-dirty]
#
# Output: dist/pdf-dark-mode-<manifest-version>.zip (+ .sha256 alongside)
#
set -euo pipefail

ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) echo "usage: $0 [--allow-dirty]" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")"

for tool in zip unzip python3 shasum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "pack: required tool missing: $tool" >&2
    exit 1
  fi
done

# The zip must match a commit, unless explicitly overridden.
if [ "$ALLOW_DIRTY" -eq 0 ] && [ -n "$(git status --porcelain --untracked-files=no 2>/dev/null || true)" ]; then
  echo "pack: tracked tree is dirty — commit first or re-run with --allow-dirty" >&2
  git status --porcelain --untracked-files=no >&2
  exit 1
fi

VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
if [ -z "$VERSION" ]; then
  echo "pack: could not read version from manifest.json" >&2
  exit 1
fi

# Best-effort test gate using this environment's nvm Node (system node is broken).
NVM_NODE="$HOME/.nvm/versions/node/v22.21.0/bin/node"
if [ -x "$NVM_NODE" ]; then
  echo "pack: running test suite..."
  "$NVM_NODE" tests/run.js
else
  echo "pack: warning: nvm node not found, skipping test gate" >&2
fi

mkdir -p dist
OUT="dist/pdf-dark-mode-${VERSION}.zip"
rm -f "$OUT" "$OUT.sha256"

zip -r -X "$OUT" \
  manifest.json \
  LICENSE \
  worker.js \
  scripts \
  popup \
  instruction \
  images \
  vendor \
  viewer \
  -x 'vendor/README.md' '*.DS_Store' '__MACOSX/*' \
  >/dev/null

# Validate the payload: every runtime entry point must be present exactly once.
for required in \
  "manifest.json" \
  "worker.js" \
  "scripts/core.js" \
  "scripts/invert.js" \
  "popup/popup.html" \
  "instruction/index.html" \
  "viewer/viewer.html" \
  "vendor/pdfjs/pdf.min.mjs" \
  "vendor/pdfjs/pdf.worker.min.mjs" \
  "images/PDM 128x128.png" \
; do
  count="$(unzip -l "$OUT" | grep -c " $required\$" || true)"
  if [ "$count" -ne 1 ]; then
    echo "pack: validation failed: '$required' appears $count times (expected 1)" >&2
    exit 1
  fi
done

# Nothing dev-only may ride along.
if unzip -l "$OUT" | grep -Eq ' tests/| \.git/| README\.md$|IMPLEMENTATION_PLAN| AGENTS\.md$| \.DS_Store$|__MACOSX'; then
  echo "pack: validation failed: dev-only files present in zip:" >&2
  unzip -l "$OUT" | grep -E ' tests/| \.git/| README\.md$|IMPLEMENTATION_PLAN| AGENTS\.md$| \.DS_Store$|__MACOSX' >&2
  exit 1
fi

shasum -a 256 "$OUT" | tee "$OUT.sha256"
echo "pack: wrote $OUT ($(du -h "$OUT" | cut -f1))"
