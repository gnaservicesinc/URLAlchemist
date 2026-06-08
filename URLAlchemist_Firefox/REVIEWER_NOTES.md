# Firefox Reviewer Notes

## Build command

From the `URLAlchemist_Firefox` directory:

```bash
bash ./reviewer-build.sh
```

This runs:

```bash
npm ci
npm run generate:bundled
npm run build
```

`reviewer-build.sh` sets `URL_ALCHEMIST_BUILD_TIME=2026-06-07T00:00:00.000Z` unless the environment already provides a value. This keeps the generated bundle reproducible for source review comparison.

## Source upload package

From the `URLAlchemist_Firefox` directory:

```bash
bash ./reviewer-source-package.sh
```

The script creates `../URLAlchemist_Firefox_artifacts/URLAlchemist_Firefox_source.zip`. The archive includes readable source, `package-lock.json`, these reviewer notes, and the build scripts. It excludes `dist/`, `node_modules/`, build caches, macOS metadata, and generated bundled-example binaries under `public/bundled-actionpacks/`.

The source-package script uses `rsync` and `zip`. On Ubuntu, install them with `sudo apt-get install zip rsync`. The helper was verified locally with Info-ZIP 3.0 and openrsync protocol 29 / rsync 2.6.9-compatible behavior; these tools only create the AMO source archive and are not part of the extension build output.

After extracting the source package, run:

```bash
cd URLAlchemist_Firefox
bash ./reviewer-build.sh
```

The generated extension output is written to `dist/`.

## Build environment

Verified locally with:

- macOS 26.4 on ARM64
- Node.js v25.6.1
- npm 11.10.0

## Third-party libraries bundled into the extension

The project installs dependencies through npm with the included `package-lock.json`.

Direct runtime dependencies used by the shipped Firefox extension:

- `react` 19.2.4
  - Source: https://github.com/facebook/react/tree/main/packages/react
- `react-dom` 19.2.4
  - Source: https://github.com/facebook/react/tree/main/packages/react-dom
- `@msgpack/msgpack` 3.1.3
  - Source: https://github.com/msgpack/msgpack-javascript
- `@xyflow/react` 12.10.2
  - Source: https://github.com/xyflow/xyflow
- `safe-regex` 2.1.1
  - Source: https://github.com/davisjam/safe-regex

Transitive open-source dependencies are resolved by npm from `package-lock.json` during `npm ci`.

## web-ext lint note

`npx web-ext lint -s dist` currently reports 2 `UNSAFE_VAR_ASSIGNMENT` warnings in the generated minified React options bundle.

- These warnings are in generated `dist/assets/options-*.js` output.
- The project source under `src/` and `public/` does not use `innerHTML` or `dangerouslySetInnerHTML`.
- The warnings come from bundled third-party framework code in the production artifact, not from custom extension source.

## Firefox runtime note

This Firefox MV3 build uses a background script/page rather than a Chrome service worker plus offscreen document. Regex worker jobs, clipboard reads/writes, alarms, content-script hotkeys, and page-overlay messages are handled directly from the Firefox background/content runtime.

## Security model summary

- Action Packs are binary files decoded and validated by the extension before installation.
- Imported Action Packs open in a staging review flow and are not saved automatically.
- Version 2.5 uses workspace/action-pack schema 8. Legacy V1 `.urlpack` import/conversion remains available, and older V2 schemas are migrated before validation.
- Version-file update metadata/export support was removed; old version-file metadata is stripped during migration and export.
- Large local media resources are stored in IndexedDB by SHA-256 and referenced from workspaces/installed Action Packs. They are excluded from browser sync and bundled into exported artifacts only.
- Installed Action Packs keep local-only install metadata for trust status, logging, locks, review overrides, install time, and Content Blocker statistics. That metadata is stripped from exported `.actionpack` files.
- New Action Pack installs default logging off unless the user changes the setting; migrated existing packs retain logging on.
- Content Blocker workspaces compile into local Action Packs plus local install metadata. Locked Content Blocker packs cannot be disabled, deleted, exported, overwritten by rebuild/import, or removed by backup restore/reset until unlocked.
- Level 1 locks use challenge text, repeated confirmation, and a delay. Level 2 locks use salted PBKDF2 through WebCrypto. Level 3 has no in-app unlock path. Extension removal or browser profile tampering remains outside what an extension can prevent.
- The AI Connectors Ollama connector is disabled by default, allows only loopback HTTP endpoints, previews strict JSON recipes, and never adds runtime AI instructions.
- The extension does not use `eval`, `new Function`, imported scripts, or downloaded code to execute Action Pack logic.

## Useful review entry points

- `public/manifest.json` declares the Firefox MV3 extension permissions and entry points.
- `src/background/index.ts` owns navigation, hotkey, context-menu, interval, overlay-event, clipboard, Content Blocker, and content-message routing.
- `src/content/index.ts` owns page overlays, hotkey capture, page reads, page mutation, and display UI.
- `src/shared/v2/actionPackValidator.ts` validates imported compiled Action Packs.
- `src/shared/v2/compiler.ts` compiles workspaces into Action Packs.
- `src/shared/v2/resources.ts` owns local resource IndexedDB storage and SHA-256 resource references.
- `src/shared/v2/locks.ts` owns local lock challenge and PBKDF2 password verification helpers.
- `src/shared/v2/ollama.ts` owns local-only Ollama endpoint validation and recipe validation.
- `src/shared/v2/vm.ts` executes compiled instructions.
- `src/options/components/StagingModal.tsx` implements the Action Pack staging review gate.
