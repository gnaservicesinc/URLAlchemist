#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROME_DIR="$ROOT_DIR/URLAlchemist_chrome"
FIREFOX_DIR="$ROOT_DIR/URLAlchemist_Firefox"
CHROME_ARTIFACT_DIR="$ROOT_DIR/URLAlchemist_chrome_artifacts"
FIREFOX_ARTIFACT_DIR="$ROOT_DIR/URLAlchemist_Firefox_artifacts"

run() {
  echo
  echo "==> $*"
  "$@"
}

fail() {
  echo "Release build failed: $*" >&2
  exit 1
}

read_json_version() {
  node -e 'const fs = require("node:fs"); const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version; if (typeof value !== "string") process.exit(2); process.stdout.write(value);' "$1"
}

resolve_build_time() {
  if [[ -n "${URL_ALCHEMIST_BUILD_TIME:-}" ]]; then
    printf '%s' "$URL_ALCHEMIST_BUILD_TIME"
  elif [[ "${SOURCE_DATE_EPOCH:-}" =~ ^[0-9]+$ ]]; then
    node -e 'process.stdout.write(new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString())'
  else
    node -e 'process.stdout.write(new Date().toISOString())'
  fi
}

package_extension() {
  local source_dir="$1"
  local output_path="$2"

  [[ -f "$source_dir/manifest.json" ]] || fail "missing $source_dir/manifest.json"
  rm -f "$output_path"
  (
    cd "$source_dir"
    shopt -s dotglob nullglob
    local -a entries=(*)
    ((${#entries[@]} > 0)) || fail "no files found in $source_dir"
    COPYFILE_DISABLE=1 zip -X -qr "$output_path" "${entries[@]}" -x '.DS_Store' '*/.DS_Store'
  )
  unzip -Z1 "$output_path" | awk '$0 == "manifest.json" { found = 1 } END { exit(found ? 0 : 1) }' \
    || fail "manifest.json is not at the root of $output_path"
  unzip -Z1 "$output_path" | awk '/(^|\/)\.DS_Store$/ { found = 1 } END { exit(found ? 1 : 0) }' \
    || fail ".DS_Store must not be included in $output_path"
}

sha256_digest() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$path" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

write_checksum_manifest() {
  local output_path="$1"
  shift

  : > "$output_path"
  for artifact in "$@"; do
    [[ -f "$artifact" ]] || fail "missing release artifact $artifact"
    printf '%s  %s\n' "$(sha256_digest "$artifact")" "$(basename "$artifact")" >> "$output_path"
  done
}

for command_name in awk node npm rsync tar unzip zip; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
  fail "sha256sum or shasum is required"
fi

CHROME_VERSION="$(read_json_version "$CHROME_DIR/package.json")"
FIREFOX_VERSION="$(read_json_version "$FIREFOX_DIR/package.json")"
CHROME_MANIFEST_VERSION="$(read_json_version "$CHROME_DIR/public/manifest.json")"
FIREFOX_MANIFEST_VERSION="$(read_json_version "$FIREFOX_DIR/public/manifest.json")"

[[ "$CHROME_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid Chrome version $CHROME_VERSION"
[[ "$CHROME_VERSION" == "$FIREFOX_VERSION" ]] || fail "Chrome $CHROME_VERSION and Firefox $FIREFOX_VERSION versions differ"
[[ "$CHROME_VERSION" == "$CHROME_MANIFEST_VERSION" ]] || fail "Chrome package and manifest versions differ"
[[ "$FIREFOX_VERSION" == "$FIREFOX_MANIFEST_VERSION" ]] || fail "Firefox package and manifest versions differ"

VERSION="$CHROME_VERSION"
export URL_ALCHEMIST_BUILD_TIME="$(resolve_build_time)"
[[ -n "$URL_ALCHEMIST_BUILD_TIME" ]] || fail "URL_ALCHEMIST_BUILD_TIME resolved to an empty value"

mkdir -p "$CHROME_ARTIFACT_DIR" "$FIREFOX_ARTIFACT_DIR"

CHROME_UPLOAD="$CHROME_ARTIFACT_DIR/URLAlchemist_Chrome_${VERSION}.zip"
CHROME_SOURCE_ZIP="$CHROME_ARTIFACT_DIR/URLAlchemist_Chrome_source.zip"
CHROME_SOURCE_TARBALL="$CHROME_ARTIFACT_DIR/URLAlchemist_Chrome_${VERSION}_source.tar.gz"
CHROME_CHECKSUMS="$CHROME_ARTIFACT_DIR/SHA256SUMS"
FIREFOX_UPLOAD="$FIREFOX_ARTIFACT_DIR/URLAlchemist_Firefox_${VERSION}.xpi"
FIREFOX_SOURCE_ZIP="$FIREFOX_ARTIFACT_DIR/URLAlchemist_Firefox_source.zip"
FIREFOX_SOURCE_TARBALL="$FIREFOX_ARTIFACT_DIR/URLAlchemist_Firefox_${VERSION}_source.tar.gz"
FIREFOX_CHECKSUMS="$FIREFOX_ARTIFACT_DIR/SHA256SUMS"

cd "$ROOT_DIR"
echo "Release version: $VERSION"
echo "Shared build time: $URL_ALCHEMIST_BUILD_TIME"

run npm --prefix "$CHROME_DIR" run generate:bundled
run npm --prefix "$FIREFOX_DIR" run generate:bundled
run npm --prefix "$CHROME_DIR" run build
run npm --prefix "$FIREFOX_DIR" run build
run package_extension "$CHROME_DIR/dist" "$CHROME_UPLOAD"
run package_extension "$FIREFOX_DIR/dist" "$FIREFOX_UPLOAD"
run bash "$CHROME_DIR/reviewer-source-package.sh"
run bash "$FIREFOX_DIR/reviewer-source-package.sh"

write_checksum_manifest "$CHROME_CHECKSUMS" "$CHROME_UPLOAD" "$CHROME_SOURCE_ZIP" "$CHROME_SOURCE_TARBALL"
write_checksum_manifest "$FIREFOX_CHECKSUMS" "$FIREFOX_UPLOAD" "$FIREFOX_SOURCE_ZIP" "$FIREFOX_SOURCE_TARBALL"

echo
echo "Release artifacts ready."
echo "Build metadata: URL_ALCHEMIST_BUILD_TIME=$URL_ALCHEMIST_BUILD_TIME"
echo "Chrome upload: $CHROME_UPLOAD"
echo "Chrome reviewer source ZIP: $CHROME_SOURCE_ZIP"
echo "Chrome source tarball: $CHROME_SOURCE_TARBALL"
echo "Chrome checksums: $CHROME_CHECKSUMS"
echo "Firefox upload: $FIREFOX_UPLOAD"
echo "Firefox reviewer source ZIP: $FIREFOX_SOURCE_ZIP"
echo "Firefox source tarball: $FIREFOX_SOURCE_TARBALL"
echo "Firefox checksums: $FIREFOX_CHECKSUMS"
echo
echo "Chrome SHA-256:"
while IFS= read -r checksum_line; do
  echo "  $checksum_line"
done < "$CHROME_CHECKSUMS"
echo "Firefox SHA-256:"
while IFS= read -r checksum_line; do
  echo "  $checksum_line"
done < "$FIREFOX_CHECKSUMS"
