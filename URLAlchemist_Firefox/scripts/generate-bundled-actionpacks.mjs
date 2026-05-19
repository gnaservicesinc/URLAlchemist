import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const temporaryOutput = resolve('.tmp/generate-bundled-actionpacks.mjs');

await build({
  bundle: true,
  entryPoints: ['scripts/write-bundled-actionpacks.ts'],
  format: 'esm',
  logLevel: 'silent',
  outfile: temporaryOutput,
  platform: 'node',
});

await import(pathToFileURL(temporaryOutput).href);
await rm(dirname(temporaryOutput), { recursive: true, force: true });

