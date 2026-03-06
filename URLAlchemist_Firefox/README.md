# URL Alchemist for Firefox Source Build Instructions

This directory contains the human-readable source code for the Firefox Manifest V3 build of URL Alchemist. The packaged extension is generated from these sources.

## Build tools used

This add-on uses build tooling that requires a source code submission to AMO:

- TypeScript for typed source files in `src/`
- Vite 7 for the production build
- Rollup (through Vite) to bundle multiple source files into the final extension files
- `@vitejs/plugin-react` to transform React TSX/JSX
- `@tailwindcss/vite` to process the options page CSS
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
- `options.html`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- `vite.config.ts`
- `README.md`
- `reviewer-build.sh`

Do not treat these as source files:

- `dist/` is generated build output
- `node_modules/` contains third-party dependencies installed by `npm ci`

## Build environment

Exact environment used to verify this build:

- macOS 26.4
- ARM64 CPU
- Node.js v25.6.1
- npm 11.10.0
- bash or another POSIX-compatible shell

Mozilla's documented default reviewer environment is Ubuntu 24.04 LTS on ARM64 with Node 22 LTS and npm 10. This project uses standard local npm installs and does not require any proprietary tools.

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
npm ci
npm run build
```

## Build output

The generated extension files are written to `dist/`, including:

- `dist/manifest.json`
- `dist/background.js`
- `dist/content.js`
- `dist/options.html`
- `dist/assets/*`

## Optional verification

These commands are not required to create the extension package, but they are useful for verification:

```bash
npm test
npx web-ext lint -s dist
```

## Notes for reviewers

- `package-lock.json` is included so dependency resolution is pinned.
- The authoritative project source is in `src/`, `public/`, and the top-level config files listed above.
- `dist/` is generated output and should be recreated from source.
