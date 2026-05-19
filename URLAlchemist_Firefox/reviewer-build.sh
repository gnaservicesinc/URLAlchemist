#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export URL_ALCHEMIST_BUILD_TIME="${URL_ALCHEMIST_BUILD_TIME:-2026-05-19T00:00:00.000Z}"

npm ci
npm run generate:bundled
npm run build
