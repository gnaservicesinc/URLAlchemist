import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  BUNDLED_ACTION_PACK_EXAMPLES,
  BUNDLED_EXAMPLE_BUILD_TIME_UTC,
  BUNDLED_EXAMPLE_BUILDER_UUID,
  createBundledExampleActionPacks,
  createBundledExampleWorkspaces,
} from '../src/shared/v2/bundledExamples';
import { exportCompiledActionPackV2Binary, exportWorkspaceBinary } from '../src/shared/v2/vault';

const outputRoot = resolve('public/bundled-actionpacks');

async function writeBytes(path: string, bytes: Uint8Array): Promise<void> {
  const target = resolve('public', path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const workspaces = createBundledExampleWorkspaces();
const packs = createBundledExampleActionPacks();
const workspaceById = new Map(workspaces.map((workspace) => [workspace.metadata.id, workspace]));
const packById = new Map(packs.map((pack) => [pack.manifest.id, pack]));

await mkdir(outputRoot, { recursive: true });

for (const example of BUNDLED_ACTION_PACK_EXAMPLES) {
  const workspace = workspaceById.get(example.id);
  const pack = packById.get(example.id);

  if (!workspace || !pack) {
    throw new Error(`Missing generated artifact for ${example.name}`);
  }

  await writeBytes(example.workspacePath, await exportWorkspaceBinary(workspace));
  await writeBytes(example.actionPackPath, await exportCompiledActionPackV2Binary(pack));
}

const artifactsByExample = await Promise.all(BUNDLED_ACTION_PACK_EXAMPLES.map(async (example) => {
  const workspace = workspaceById.get(example.id);
  const pack = packById.get(example.id);
  if (!workspace || !pack) {
    throw new Error(`Missing generated artifact for ${example.name}`);
  }
  const workspaceBytes = await exportWorkspaceBinary(workspace);
  const actionPackBytes = await exportCompiledActionPackV2Binary(pack);
  const collection = ['URL cleanup', 'Search', 'Storage'].includes(example.category) ? 'bundled' : 'examples';
  return {
    ...example,
    collection,
    artifactHashes: {
      workspaceSha256: sha256Hex(workspaceBytes),
      actionPackSha256: sha256Hex(actionPackBytes),
    },
  };
}));

await writeFile(
  resolve(outputRoot, 'index.json'),
  `${JSON.stringify(
    {
      kind: 'url-alchemist.bundled-actionpacks.v1',
      generatedAtUtc: BUNDLED_EXAMPLE_BUILD_TIME_UTC,
      builderUuid: BUNDLED_EXAMPLE_BUILDER_UUID,
      examples: artifactsByExample,
    },
    null,
    2,
  )}\n`,
);
