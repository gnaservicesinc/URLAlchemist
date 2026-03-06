# Firefox Reviewer Notes

## Build command

From the `URLAlchemist_Firefox` directory:

```bash
bash ./reviewer-build.sh
```

This runs:

```bash
npm ci
npm run build
```

## Third-party libraries bundled into the extension

The project installs dependencies through npm with the included `package-lock.json`.

Direct runtime dependencies used by the shipped Firefox extension:

- `react` 19.2.4
  - Source: https://github.com/facebook/react/tree/main/packages/react
- `react-dom` 19.2.4
  - Source: https://github.com/facebook/react/tree/main/packages/react-dom
- `@msgpack/msgpack` 3.1.3
  - Source: https://github.com/msgpack/msgpack-javascript
- `safe-regex` 2.1.1
  - Source: https://github.com/davisjam/safe-regex

Transitive open-source dependencies are resolved by npm from `package-lock.json` during `npm ci`.

## web-ext lint note

`npx web-ext lint -s dist` currently reports 2 `UNSAFE_VAR_ASSIGNMENT` warnings in the generated minified React options bundle.

- These warnings are in generated `dist/assets/options-*.js` output.
- The project source under `src/` and `public/` does not use `innerHTML` or `dangerouslySetInnerHTML`.
- The warnings come from bundled third-party framework code in the production artifact, not from custom extension source.
