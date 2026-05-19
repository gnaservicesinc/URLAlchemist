#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACT_DIR="$PROJECT_ROOT/URLAlchemist_Firefox_artifacts"
PACKAGE_NAME="URLAlchemist_Firefox_source.zip"
STAGING_DIR="$ARTIFACT_DIR/source-package"
SOURCE_DIR="$STAGING_DIR/URLAlchemist_Firefox"

cd "$SCRIPT_DIR"

rm -rf "$STAGING_DIR"
mkdir -p "$SOURCE_DIR" "$ARTIFACT_DIR"

rsync -a \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.tmp' \
  --exclude '.vite' \
  --exclude '.DS_Store' \
  --exclude 'public/bundled-actionpacks' \
  --exclude "$PACKAGE_NAME" \
  ./ "$SOURCE_DIR/"

if [[ -f "$PROJECT_ROOT/LICENSE" ]]; then
  cp "$PROJECT_ROOT/LICENSE" "$SOURCE_DIR/LICENSE"
fi

cd "$STAGING_DIR"
rm -f "$ARTIFACT_DIR/$PACKAGE_NAME"
COPYFILE_DISABLE=1 zip -X -qr "$ARTIFACT_DIR/$PACKAGE_NAME" URLAlchemist_Firefox

cd "$PROJECT_ROOT"
rm -rf "$STAGING_DIR"

echo "Created $ARTIFACT_DIR/$PACKAGE_NAME"
