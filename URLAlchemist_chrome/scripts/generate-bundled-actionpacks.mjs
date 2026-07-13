import { readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const temporaryOutput = resolve('.tmp/generate-bundled-actionpacks.mjs');
const packageJson = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve('public/manifest.json'), 'utf8'));

if (typeof packageJson.version !== 'string' || packageJson.version !== manifest.version) {
  throw new Error(`Package and manifest versions must match before generating bundled artifacts (${packageJson.version} !== ${manifest.version}).`);
}

await build({
  bundle: true,
  define: {
    __URL_ALCHEMIST_BUILD_TIME__: JSON.stringify(process.env.URL_ALCHEMIST_BUILD_TIME ?? 'development'),
    __URL_ALCHEMIST_VERSION__: JSON.stringify(packageJson.version),
  },
  entryPoints: ['scripts/write-bundled-actionpacks.ts'],
  format: 'esm',
  logLevel: 'silent',
  outfile: temporaryOutput,
  platform: 'node',
});

await import(pathToFileURL(temporaryOutput).href);
await rm(dirname(temporaryOutput), { recursive: true, force: true });
