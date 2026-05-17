#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACT_DIR="$PROJECT_ROOT/URLAlchemist_chrome_artifacts"
PACKAGE_NAME="URLAlchemist_Chrome_source.zip"
STAGING_DIR="$ARTIFACT_DIR/source-package"

cd "$SCRIPT_DIR"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR" "$ARTIFACT_DIR"

rsync -a \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude '.tmp' \
  --exclude '.vite' \
  --exclude '.DS_Store' \
  --exclude "$PACKAGE_NAME" \
  ./ "$STAGING_DIR/URLAlchemist_chrome/"

cd "$STAGING_DIR"
rm -f "$ARTIFACT_DIR/$PACKAGE_NAME"
zip -qr "$ARTIFACT_DIR/$PACKAGE_NAME" URLAlchemist_chrome

cd "$PROJECT_ROOT"
rm -rf "$STAGING_DIR"

echo "Created $ARTIFACT_DIR/$PACKAGE_NAME"
