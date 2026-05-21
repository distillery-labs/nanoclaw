#!/bin/bash
# Rebuilds the agent container image only when container/ source has changed
# since the last successful build. Git tree hash of container/ is stored in
# .container-build-hash at the project root; rebuild is skipped on match.
# Falls back to unconditional rebuild if git is unavailable or not a repo.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HASH_FILE="$PROJECT_ROOT/.container-build-hash"

CURRENT_HASH="$(git -C "$PROJECT_ROOT" rev-parse HEAD:container 2>/dev/null || echo "unknown")"

if [ "$CURRENT_HASH" != "unknown" ] && [ -f "$HASH_FILE" ] && [ "$(cat "$HASH_FILE")" = "$CURRENT_HASH" ]; then
  echo "[maybe-rebuild] Container image up to date ($CURRENT_HASH), skipping rebuild."
  exit 0
fi

PREV_HASH="$(cat "$HASH_FILE" 2>/dev/null || echo "none")"
echo "[maybe-rebuild] Container source changed ($PREV_HASH → $CURRENT_HASH), rebuilding..."

"$SCRIPT_DIR/build.sh"

if [ "$CURRENT_HASH" != "unknown" ]; then
  echo "$CURRENT_HASH" > "$HASH_FILE"
fi

echo "[maybe-rebuild] Rebuild complete."
