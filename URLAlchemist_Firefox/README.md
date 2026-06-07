# URL Alchemist for Firefox Source Build Instructions

This directory contains the human-readable source code for the Firefox Manifest V3 build of URL Alchemist. The packaged extension is generated from these sources.

## Build tools used

This add-on uses build tooling that requires a source code submission to AMO:

- TypeScript for typed source files in `src/`
- Vite 7 for the production build
- Rollup (through Vite) to bundle multiple source files into the final extension files
- `@vitejs/plugin-react` to transform React TSX/JSX
- `@tailwindcss/vite` to process the options page CSS
- `@xyflow/react` for the visual workspace editor
- Vite production minification for generated files in `dist/`

This add-on does not use:

- webpack
- HTML template engines
- CSS template engines
- obfuscators
- remote build services

## Source package contents

Include these files and folders in the AMO source submission package:

- `src/`
- `public/`
- `scripts/`
- `options.html`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vite.config.ts`
- `README.md`
- `REVIEWER_NOTES.md`
- `reviewer-build.sh`
- `reviewer-source-package.sh`
- `LICENSE`

The source submission package intentionally excludes `public/bundled-actionpacks/`. Those binary workspace and Action Pack artifacts are generated from `src/shared/v2/bundledExamples.ts` by `npm run generate:bundled`, which is called by `reviewer-build.sh` before the extension is built.

Do not treat these as source files:

- `dist/` is generated build output
- `node_modules/` contains third-party dependencies installed by `npm ci`
- `.tmp/` and `.vite/` are generated build caches

## Creating the AMO source submission zip

Run this command from this directory:

```bash
bash ./reviewer-source-package.sh
```

The script creates:

```text
../URLAlchemist_Firefox_artifacts/URLAlchemist_Firefox_source.zip
```

The source zip includes readable source, configuration, lockfile, reviewer notes, and build scripts. It excludes generated build output, installed dependencies, bundled-example binary output, local cache folders, and macOS metadata files.

The source-package script uses `rsync` and `zip`. On Ubuntu, install them with:

```bash
sudo apt-get update
sudo apt-get install zip rsync
```

The source-package helper was verified locally with Info-ZIP 3.0 and openrsync protocol 29 / rsync 2.6.9-compatible behavior. These tools only create the AMO source archive; the extension build output itself is produced by Node.js and npm.

## Build environment

Exact environment used to verify this build:

- macOS 26.4
- ARM64 CPU
- Node.js v25.6.1
- npm 11.10.0
- bash or another POSIX-compatible shell

Mozilla's documented default reviewer environment is Ubuntu 24.04.4 LTS on ARM64 with Node.js 24.14.0 and npm 11.9.0. This project uses standard local npm installs and does not require any proprietary tools or web-based build services.

## Required tools

1. Install Node.js, which includes npm: https://nodejs.org/
2. Verify the installed versions:

```bash
node -v
npm -v
```

## Build instructions

Run this command from this directory:

```bash
bash ./reviewer-build.sh
```

The script performs these steps:

```bash
export URL_ALCHEMIST_BUILD_TIME="${URL_ALCHEMIST_BUILD_TIME:-2026-06-07T00:00:00.000Z}"
npm ci
npm run generate:bundled
npm run build
```

The fixed `URL_ALCHEMIST_BUILD_TIME` value makes the production bundle reproducible for reviewer comparison. To intentionally produce a build with a different visible About-page build timestamp, set `URL_ALCHEMIST_BUILD_TIME` before running the script.

## Build output

The generated extension files are written to `dist/`, including:

- `dist/manifest.json`
- `dist/background.js`
- `dist/content.js`
- `dist/options.html`
- `dist/help/*`
- `dist/bundled-actionpacks/*`
- `dist/assets/*`

## Optional verification

These commands are not required to create the extension package, but they are useful for verification:

```bash
npm test
npm run generate:bundled
npx web-ext lint -s dist
```

## Notes for reviewers

- `package-lock.json` is included so dependency resolution is pinned.
- The authoritative project source is in `src/`, `public/`, and the top-level config files listed above.
- Firefox uses an MV3 background script/page for regex, clipboard, interval, and overlay runtime services; it does not use Chrome offscreen documents.
- Version 2.5 uses schema 7 workspace/action-pack artifacts, removes version-file export/update metadata, preserves V1 `.urlpack` conversion, stores large resources in IndexedDB by SHA-256, and strips local-only install metadata from exported `.actionpack` files.
- Focus Guard content-blocker packs are normal compiled Action Packs with local lock metadata. Locks are enforced inside the extension but cannot prevent add-on removal or browser profile tampering.
- The Local Ollama Builder accepts only loopback HTTP endpoints and produces previewed JSON workspace recipes; Action Packs do not contain runtime AI instructions.
- `dist/` is generated output and should be recreated from source.
