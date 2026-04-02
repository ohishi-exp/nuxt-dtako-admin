#!/bin/bash
# rust-alc-api の ts-rs TypeScript 型定義を CI artifact から取得し、
# app/types/generated/ にファイル単位で展開する
#
# Usage:
#   ./scripts/sync-ts-bindings.sh              # latest main
#   ./scripts/sync-ts-bindings.sh <sha>        # specific SHA
#
# Prerequisites: gh CLI, access to rust-alc-api repo

set -euo pipefail

REPO="yhonda-ohishi-alc/rust-alc-api"
DEST="$(cd "$(dirname "$0")/../app/types/generated" && pwd)"
SHA="${1:-}"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [ -z "$SHA" ]; then
  SHA=$(gh run list -R "$REPO" --branch main --status success --json headSha --jq '.[0].headSha' 2>/dev/null)
  if [ -z "$SHA" ]; then
    echo "ERROR: Could not find successful run on main" >&2
    exit 1
  fi
fi

ARTIFACT_NAME="ts-bindings-${SHA}"
echo "Downloading: $ARTIFACT_NAME"

RUN_ID=$(gh api "repos/$REPO/actions/artifacts?name=$ARTIFACT_NAME" --jq '.artifacts[0].workflow_run.id' 2>/dev/null)
if [ -z "$RUN_ID" ] || [ "$RUN_ID" = "null" ]; then
  echo "ERROR: Artifact '$ARTIFACT_NAME' not found" >&2
  exit 1
fi

gh run download "$RUN_ID" -R "$REPO" -n "$ARTIFACT_NAME" -D "$TMPDIR/bindings"

# Clean existing generated files (keep directory)
find "$DEST" -name "*.ts" -delete 2>/dev/null || true
rm -rf "$DEST/serde_json" 2>/dev/null || true

# Copy per-file .ts files preserving subdirectory structure
find "$TMPDIR/bindings" -name "*.ts" | while IFS= read -r f; do
  relpath="${f#$TMPDIR/bindings/}"
  # Flatten crate paths: crates/alc-core/bindings/Foo.ts -> Foo.ts
  filename=$(basename "$relpath")
  dirpart=$(dirname "$relpath")

  # Handle serde_json subdirectory
  if echo "$dirpart" | grep -q "serde_json"; then
    mkdir -p "$DEST/serde_json"
    cp "$f" "$DEST/serde_json/$filename"
  else
    cp "$f" "$DEST/$filename"
  fi
done

# Regenerate barrel index.ts
{
  find "$DEST" -maxdepth 1 -name "*.ts" ! -name "index.ts" -printf '%f\n' | sort | while IFS= read -r f; do
    name="${f%.ts}"
    echo "export type { $name } from \"./$name\";"
  done
} > "$DEST/index.ts"

COUNT=$(find "$DEST" -name "*.ts" ! -name "index.ts" | wc -l)
echo "Synced $COUNT type files to $DEST (SHA: ${SHA:0:12})"
