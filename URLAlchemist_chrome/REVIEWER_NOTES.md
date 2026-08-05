# Chrome Reviewer Notes

## Build command

From the `URLAlchemist_chrome` directory:

```bash
bash ./reviewer-build.sh
```

This runs:

```bash
npm ci
npm run generate:bundled
npm run build
```

The built Chrome MV3 extension is written to `dist/`.

The release source archive includes `RELEASE_BUILD_TIME.txt`. `reviewer-build.sh`
uses that value unless `URL_ALCHEMIST_BUILD_TIME` is set explicitly, so the
visible build metadata and generated bundle match the submitted release build.

## Source upload package

From the `URLAlchemist_chrome` directory:

```bash
bash ./reviewer-source-package.sh
```

The script creates `../URLAlchemist_chrome_artifacts/URLAlchemist_Chrome_source.zip`
and a versioned `URLAlchemist_Chrome_VERSION_source.tar.gz` in the same artifact
directory. Both archives include readable source, the root license, and the
release build-time record. They exclude generated build output, installed
dependencies, bundled-example binaries, local cache folders, and temporary
files. The reviewer can extract either source package, run
`bash ./reviewer-build.sh`, and compare the resulting `dist/` output with the
submitted extension package.

## Third-party libraries bundled into the extension

The project installs dependencies through npm with the included `package-lock.json`.

Direct runtime dependencies used by the shipped Chrome extension:

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

## Security model summary

- Action Packs are binary files decoded and validated by the extension before installation.
- Imported Action Packs open in a staging review flow and are not saved automatically.
- Version 2.7.2 uses workspace/action-pack schema 9. Legacy V1 `.urlpack` import/conversion remains available, and older V2 schemas are migrated before validation.
- Custom Block installation now requires a specific library category. Workspace Name/Version are the single block identity, each input/output ID, label, type, and tooltip must match its boundary node, and existing caller nodes refresh installed metadata without guessing how renamed ports should reconnect.
- Version-file update metadata/export support was removed; old version-file metadata is stripped during migration and export.
- Large local media resources are stored in IndexedDB by SHA-256 and referenced from workspaces/installed Action Packs. They are excluded from browser sync and bundled into exported artifacts only.
- Installed Action Packs keep local-only install metadata for trust status, logging, locks, review overrides, install time, and Content Blocker statistics. That metadata is stripped from exported `.actionpack` files.
- New Action Pack installs default logging off unless the user changes the setting; migrated existing packs retain logging on.
- Content Blocker workspaces compile into local Action Packs plus local install metadata. Locked Content Blocker packs cannot be disabled, deleted, exported, overwritten by rebuild/import, or removed by backup restore/reset until unlocked.
- Level 1 locks use challenge text, repeated confirmation, and a delay. Level 2 locks use salted PBKDF2 through WebCrypto. Level 3 has no in-app unlock path. Extension removal or browser profile tampering remains outside what an extension can prevent.
- The AI Connectors Ollama connector is disabled by default, allows only loopback HTTP endpoints, previews strict JSON recipes, and never adds runtime AI instructions.
- The extension does not use `eval`, `new Function`, imported scripts, or downloaded code to execute Action Pack logic.
- Clipboard access is optional and requested only when a pack needs clipboard read or write behavior.
- Remote data and asset blocks require HTTPS and reject credentials, local hosts, private IP ranges, and reserved network hosts.
- `file://` navigation is blocked by default unless the user enables the local-file setting.
- Keyboard and mouse event workflows are routed only through visible URL Alchemist-owned overlays.

## Useful review entry points

- `public/manifest.json` declares the Chrome MV3 extension permissions and entry points.
- `src/background/index.ts` owns navigation, hotkey, context-menu, interval, overlay-event, clipboard, and content-message routing.
- `src/content/index.ts` owns page overlays, hotkey capture, page reads, page mutation, and display UI.
- `src/shared/v2/actionPackValidator.ts` validates imported compiled Action Packs.
- `src/shared/v2/compiler.ts` compiles workspaces into Action Packs.
- `src/shared/v2/resources.ts` owns local resource IndexedDB storage and SHA-256 resource references.
- `src/shared/v2/locks.ts` owns local lock challenge and PBKDF2 password verification helpers.
- `src/shared/v2/ollama.ts` owns local-only Ollama endpoint validation and recipe validation.
- `src/shared/v2/vm.ts` executes compiled instructions.
- `src/shared/v2/remoteUrl.ts` validates remote HTTPS boundaries.
- `src/options/components/StagingModal.tsx` implements the Action Pack staging review gate.
