#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACT_DIR="$PROJECT_ROOT/URLAlchemist_Firefox_artifacts"
PACKAGE_NAME="URLAlchemist_Firefox_source.zip"
STAGING_DIR="$ARTIFACT_DIR/source-package"
SOURCE_DIR="$STAGING_DIR/URLAlchemist_Firefox"

cd "$SCRIPT_DIR"

VERSION="$(node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid package version: $VERSION" >&2
  exit 2
fi

if [[ -z "${URL_ALCHEMIST_BUILD_TIME:-}" && "${SOURCE_DATE_EPOCH:-}" =~ ^[0-9]+$ ]]; then
  URL_ALCHEMIST_BUILD_TIME="$(node -e 'process.stdout.write(new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString())')"
fi
URL_ALCHEMIST_BUILD_TIME="${URL_ALCHEMIST_BUILD_TIME:-2026-06-07T00:00:00.000Z}"
SOURCE_TARBALL_NAME="URLAlchemist_Firefox_${VERSION}_source.tar.gz"

rm -rf "$STAGING_DIR"
mkdir -p "$SOURCE_DIR" "$ARTIFACT_DIR"

rsync -a \
  --exclude 'node_modules' \
  --exclude 'dist' \
  --exclude 'dist.zip' \
  --exclude '.tmp' \
  --exclude '.vite' \
  --exclude '.DS_Store' \
  --exclude 'public/bundled-actionpacks' \
  --exclude 'RELEASE_BUILD_TIME.txt' \
  --exclude "$PACKAGE_NAME" \
  ./ "$SOURCE_DIR/"

if [[ -f "$PROJECT_ROOT/LICENSE" ]]; then
  cp "$PROJECT_ROOT/LICENSE" "$SOURCE_DIR/LICENSE"
fi
printf '%s\n' "$URL_ALCHEMIST_BUILD_TIME" > "$SOURCE_DIR/RELEASE_BUILD_TIME.txt"

cd "$STAGING_DIR"
rm -f "$ARTIFACT_DIR/$PACKAGE_NAME" "$ARTIFACT_DIR/$SOURCE_TARBALL_NAME"
COPYFILE_DISABLE=1 zip -X -qr "$ARTIFACT_DIR/$PACKAGE_NAME" URLAlchemist_Firefox
COPYFILE_DISABLE=1 tar -czf "$ARTIFACT_DIR/$SOURCE_TARBALL_NAME" URLAlchemist_Firefox

cd "$PROJECT_ROOT"
rm -rf "$STAGING_DIR"

echo "Created $ARTIFACT_DIR/$PACKAGE_NAME"
echo "Created $ARTIFACT_DIR/$SOURCE_TARBALL_NAME"
