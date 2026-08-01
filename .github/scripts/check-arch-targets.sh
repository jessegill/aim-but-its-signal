#!/usr/bin/env bash
#
# The product targets Apple Silicon only, minimum macOS 15. A universal or x64 packaging
# target is therefore a bug: it doubles build time and ships a slice nobody runs.
#
# Packaging config lives in package.json / electron-builder.* which this workflow does not
# own, so this reports a GitHub annotation rather than failing the job.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT" || exit 1

warn() {
  echo "::warning file=$1::$2"
  echo "WARN  $1: $2"
}

FOUND=0

for config in package.json electron-builder.yml electron-builder.yaml electron-builder.json \
              electron-builder.config.js electron-builder.config.cjs electron-builder.config.ts; do
  [ -f "$config" ] || continue

  if grep -Eiq '(^|[^a-z])universal([^a-z]|$)' "$config"; then
    warn "$config" "declares a 'universal' build target; the product is arm64-only (macOS 15+, Apple Silicon)"
    FOUND=1
  fi
  if grep -Eiq '"?x64"?' "$config"; then
    warn "$config" "references an x64 arch; the product is arm64-only (macOS 15+, Apple Silicon)"
    FOUND=1
  fi
  if grep -Eiq '(win|windows|linux|appimage|deb|nsis)' "$config" \
     && grep -Eiq 'electron-builder|"build"[[:space:]]*:' "$config"; then
    warn "$config" "references a non-macOS packaging target; this app is macOS-only"
    FOUND=1
  fi
done

if [ "$FOUND" -eq 0 ]; then
  echo "ok  no universal / x64 / non-macOS packaging targets found"
fi

# Advisory only — never fail the build on a file this workflow does not own.
exit 0
