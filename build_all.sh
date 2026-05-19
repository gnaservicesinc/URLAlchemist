#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run() {
  echo
  echo "==> $*"
  "$@"
}

run npm --prefix "$ROOT_DIR/URLAlchemist_chrome" run generate:bundled
run npm --prefix "$ROOT_DIR/URLAlchemist_Firefox" run generate:bundled
run npm --prefix "$ROOT_DIR/URLAlchemist_chrome" run build
run npm --prefix "$ROOT_DIR/URLAlchemist_Firefox" run build

echo
echo "All URL Alchemist targets rebuilt."
