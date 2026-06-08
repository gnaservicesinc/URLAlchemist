#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

run() {
  echo
  echo "==> $*"
  "$@"
}

cd "/opt/URLAlchemist/Repo/URLAlchemist"
npm --prefix "/opt/URLAlchemist/Repo/URLAlchemist/URLAlchemist_chrome" run generate:bundled && npm --prefix "/opt/URLAlchemist/Repo/URLAlchemist/URLAlchemist_Firefox" run generate:bundled
run npm --prefix "/opt/URLAlchemist/Repo/URLAlchemist/URLAlchemist_chrome" run generate:bundled
run npm --prefix "/opt/URLAlchemist/Repo/URLAlchemist/URLAlchemist_Firefox" run generate:bundled
run npm --prefix "/opt/URLAlchemist/Repo/URLAlchemist/URLAlchemist_chrome" run build
run npm --prefix "/opt/URLAlchemist/Repo/URLAlchemist/URLAlchemist_Firefox" run build
/opt/URLAlchemist/Repo/URLAlchemist/URLAlchemist_chrome/reviewer-source-package.sh
echo
echo "All URL Alchemist targets rebuilt."

