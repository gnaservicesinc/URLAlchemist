#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  cat <<'USAGE'
Usage:
  ./change_version.sh MAJOR MINOR PATCH
  ./change_version.sh

When called without arguments, the script prompts for the three version
components. It updates both extension targets to MAJOR.MINOR.PATCH, refreshes
the bundled-example compatibility version constants, then rebuilds everything.

Example:
  ./change_version.sh 2 0 5
USAGE
}

read_component() {
  local label="$1"
  local value=""
  read -r -p "$label: " value
  printf '%s' "$value"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if (( $# != 0 && $# != 3 )); then
  usage >&2
  exit 2
fi

major="${1:-$(read_component "Major version")}"
minor="${2:-$(read_component "Minor version")}"
patch="${3:-$(read_component "Patch version")}"

for component in "$major" "$minor" "$patch"; do
  if [[ ! "$component" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "Invalid version component: $component" >&2
    echo "Use non-negative integer components, for example: 2 0 5" >&2
    exit 2
  fi
done

new_version="$major.$minor.$patch"

echo "Updating URL Alchemist version fields to $new_version"

URL_ALCHEMIST_ROOT="$ROOT_DIR" URL_ALCHEMIST_NEW_VERSION="$new_version" node --input-type=module <<'NODE'
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.env.URL_ALCHEMIST_ROOT;
const version = process.env.URL_ALCHEMIST_NEW_VERSION;

if (!root || !version) {
  throw new Error('Missing URL_ALCHEMIST_ROOT or URL_ALCHEMIST_NEW_VERSION.');
}

const jsonFiles = [
  'URLAlchemist_chrome/package.json',
  'URLAlchemist_chrome/package-lock.json',
  'URLAlchemist_chrome/public/manifest.json',
  'URLAlchemist_Firefox/package.json',
  'URLAlchemist_Firefox/package-lock.json',
  'URLAlchemist_Firefox/public/manifest.json',
];

async function updateJsonVersion(relativePath) {
  const filePath = join(root, relativePath);
  const contents = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(contents);

  parsed.version = version;
  if (parsed.packages?.['']) {
    parsed.packages[''].version = version;
  }

  await writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
  console.log(`updated ${relativePath}`);
}

async function updateBundledExampleVersions(relativePath) {
  const filePath = join(root, relativePath);
  const contents = await readFile(filePath, 'utf8');
  const replacements = [
    [/export const BUNDLED_EXAMPLE_CHROME_VERSION = '[^']+';/, `export const BUNDLED_EXAMPLE_CHROME_VERSION = '${version}';`],
    [/export const BUNDLED_EXAMPLE_FIREFOX_VERSION = '[^']+';/, `export const BUNDLED_EXAMPLE_FIREFOX_VERSION = '${version}';`],
  ];

  let updated = contents;
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(updated)) {
      throw new Error(`Missing expected version constant in ${relativePath}: ${pattern}`);
    }
    updated = updated.replace(pattern, replacement);
  }

  await writeFile(filePath, updated);
  console.log(`updated ${relativePath}`);
}

for (const relativePath of jsonFiles) {
  await updateJsonVersion(relativePath);
}

await updateBundledExampleVersions('URLAlchemist_chrome/src/shared/v2/bundledExamples.ts');
await updateBundledExampleVersions('URLAlchemist_Firefox/src/shared/v2/bundledExamples.ts');
NODE

"$ROOT_DIR/build_all.sh"
