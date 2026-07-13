#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BUILD_TIME_FILE="$SCRIPT_DIR/RELEASE_BUILD_TIME.txt"
if [[ -z "${URL_ALCHEMIST_BUILD_TIME:-}" && -f "$BUILD_TIME_FILE" ]]; then
  URL_ALCHEMIST_BUILD_TIME="$(tr -d '\r\n' < "$BUILD_TIME_FILE")"
fi
if [[ -z "${URL_ALCHEMIST_BUILD_TIME:-}" && "${SOURCE_DATE_EPOCH:-}" =~ ^[0-9]+$ ]]; then
  URL_ALCHEMIST_BUILD_TIME="$(node -e 'process.stdout.write(new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString())')"
fi
export URL_ALCHEMIST_BUILD_TIME="${URL_ALCHEMIST_BUILD_TIME:-2026-06-07T00:00:00.000Z}"

echo "Using URL_ALCHEMIST_BUILD_TIME=$URL_ALCHEMIST_BUILD_TIME"
npm ci
npm run generate:bundled
npm run build
