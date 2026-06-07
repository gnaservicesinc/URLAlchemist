import { decode, encode } from '@msgpack/msgpack';

import { MAX_ACTION_PACK_BINARY_BYTES } from '../constants';
import { hexToBytes, sha256Hex } from '../crypto';
import { importActionPackBinary } from '../vault';
import type { CompiledActionPackV2, ImportedV2Artifact, WorkspaceFileV2 } from './types';
import {
  ACTION_PACK_SCHEMA_VERSION,
  SUPPORTED_ACTION_PACK_SCHEMA_VERSIONS,
  SUPPORTED_WORKSPACE_SCHEMA_VERSIONS,
  WORKSPACE_SCHEMA_VERSION,
} from './types';
import { migrateCompiledActionPackV2Candidate, validateCompiledActionPackV2 } from './actionPackValidator';
import { isContentBlockerActionPack, stripLocalInstallMetadata } from './installMetadata';
import { getResource, putResourceBytes, resourceToBytes } from './resources';
import { validateWorkspaceFile } from './workspace';

export const WORKSPACE_MAGIC = 'WSPC2';
export const ACTION_PACK_MAGIC = 'ACTP2';

const encoder = new TextEncoder();
const WORKSPACE_MAGIC_BYTES = encoder.encode(WORKSPACE_MAGIC);
const ACTION_PACK_MAGIC_BYTES = encoder.encode(ACTION_PACK_MAGIC);
const HEADER_CHECKSUM_BYTES = 32;
const RESOURCE_BUNDLE_VERSION = 1;

interface ResourceBundleEntry {
  resourceId: string;
  name: string;
  mimeType: string;
  kind: string;
  bytes: Uint8Array;
}

interface ResourceBundleEnvelope {
  __urlAlchemistResourceBundle: typeof RESOURCE_BUNDLE_VERSION;
  artifact: unknown;
  resources: ResourceBundleEntry[];
}

function headerLength(magicBytes: Uint8Array): number {
  return magicBytes.length + 1 + HEADER_CHECKSUM_BYTES;
}

function omitUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitUndefinedFields);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefinedFields(entry)]),
  );
}

async function exportWithHeader(value: unknown, magicBytes: Uint8Array, schemaVersion: number): Promise<Uint8Array> {
  const payload = encode(omitUndefinedFields(value));
  const checksumHex = await sha256Hex(payload);
  const checksumBytes = hexToBytes(checksumHex);
  const output = new Uint8Array(headerLength(magicBytes) + payload.length);

  if (output.byteLength > MAX_ACTION_PACK_BINARY_BYTES) {
    throw new Error('Artifact export exceeds the 128 MB portable artifact size limit');
  }

  output.set(magicBytes, 0);
  output[magicBytes.length] = schemaVersion;
  output.set(checksumBytes, magicBytes.length + 1);
  output.set(payload, headerLength(magicBytes));

  return output;
}

async function importWithHeader(bytes: Uint8Array, magic: string): Promise<{ decoded: unknown; checksumHex: string; schemaVersion: number }> {
  const magicBytes = encoder.encode(magic);
  const length = headerLength(magicBytes);

  if (bytes.byteLength > MAX_ACTION_PACK_BINARY_BYTES) {
    throw new Error('Files larger than 128 MB are rejected');
  }

  if (bytes.length <= length) {
    throw new Error('The file is too small to be a v2 artifact');
  }

  const decodedMagic = new TextDecoder().decode(bytes.slice(0, magicBytes.length));
  if (decodedMagic !== magic) {
    throw new Error('Magic header does not match');
  }

  const schemaVersion = bytes[magicBytes.length];
  const checksumBytes = bytes.slice(magicBytes.length + 1, length);
  const payload = bytes.slice(length);
  const checksumHex = Array.from(checksumBytes, (value) => value.toString(16).padStart(2, '0')).join('');
  const actualChecksum = await sha256Hex(payload);

  if (checksumHex !== actualChecksum) {
    throw new Error('Checksum verification failed');
  }

  return {
    decoded: decode(payload),
    checksumHex,
    schemaVersion,
  };
}

export async function exportWorkspaceBinary(workspace: WorkspaceFileV2): Promise<Uint8Array> {
  return exportWithHeader(await bundleResources(workspace, collectResourceIds(workspace)), WORKSPACE_MAGIC_BYTES, WORKSPACE_SCHEMA_VERSION);
}

export async function exportCompiledActionPackV2Binary(pack: CompiledActionPackV2): Promise<Uint8Array> {
  if (isContentBlockerActionPack(pack)) {
    throw new Error('Content Blocker Action Packs are local installs. Export the workspace source and compile it locally instead.');
  }
  const payload = stripLocalInstallMetadata(pack);
  return exportWithHeader(await bundleResources(payload, collectResourceIds(payload)), ACTION_PACK_MAGIC_BYTES, ACTION_PACK_SCHEMA_VERSION);
}

export async function importWorkspaceBinary(bytes: Uint8Array): Promise<{ workspace: WorkspaceFileV2; checksumHex: string; schemaVersion: number }> {
  const imported = await importWithHeader(bytes, WORKSPACE_MAGIC);
  if (!(SUPPORTED_WORKSPACE_SCHEMA_VERSIONS as readonly number[]).includes(imported.schemaVersion)) {
    throw new Error(`Unsupported workspace schema version: ${imported.schemaVersion}`);
  }

  const decoded = await hydrateResourceBundle(imported.decoded);
  const validation = validateWorkspaceFile(decoded);
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }

  return {
    workspace: validation.value,
    checksumHex: imported.checksumHex,
    schemaVersion: imported.schemaVersion,
  };
}

export async function importCompiledActionPackV2Binary(bytes: Uint8Array): Promise<{ pack: CompiledActionPackV2; checksumHex: string; schemaVersion: number }> {
  const imported = await importWithHeader(bytes, ACTION_PACK_MAGIC);
  if (!(SUPPORTED_ACTION_PACK_SCHEMA_VERSIONS as readonly number[]).includes(imported.schemaVersion)) {
    throw new Error(`Unsupported Action Pack schema version: ${imported.schemaVersion}`);
  }

  const decoded = await hydrateResourceBundle(imported.decoded);
  const validation = validateCompiledActionPackV2(migrateCompiledActionPackV2Candidate(decoded));
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }
  const pack = stripLocalInstallMetadata(validation.pack);
  if (isContentBlockerActionPack(validation.pack) || pack.manifest.metadata.workspaceType === 'content-blocker') {
    throw new Error('Compiled Content Blocker Action Packs cannot be imported. Import the workspace source and compile it locally instead.');
  }

  return {
    pack: {
      ...pack,
      checksumHex: imported.checksumHex,
    },
    checksumHex: imported.checksumHex,
    schemaVersion: imported.schemaVersion,
  };
}

function isResourceAsset(value: unknown): value is { source: 'resource'; resourceId?: string; sha256?: string } {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value as { source?: unknown }).source === 'resource');
}

function collectResourceIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (isResourceAsset(value)) {
    const id = value.resourceId ?? value.sha256;
    if (typeof id === 'string') {
      ids.add(id);
    }
    return ids;
  }

  if (Array.isArray(value)) {
    value.forEach((entry) => collectResourceIds(entry, ids));
    return ids;
  }

  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((entry) => collectResourceIds(entry, ids));
  }

  return ids;
}

async function bundleResources(artifact: unknown, resourceIds: Set<string>): Promise<unknown> {
  if (resourceIds.size === 0) {
    return artifact;
  }

  const resources: ResourceBundleEntry[] = [];
  for (const resourceId of resourceIds) {
    const resource = await getResource(resourceId);
    if (!resource) {
      continue;
    }

    resources.push({
      resourceId: resource.resourceId,
      name: resource.name,
      mimeType: resource.mimeType,
      kind: resource.kind,
      bytes: resourceToBytes(resource),
    });
  }

  return resources.length === 0
    ? artifact
    : {
        __urlAlchemistResourceBundle: RESOURCE_BUNDLE_VERSION,
        artifact,
        resources,
      } satisfies ResourceBundleEnvelope;
}

function isResourceBundleEnvelope(value: unknown): value is ResourceBundleEnvelope {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { __urlAlchemistResourceBundle?: unknown }).__urlAlchemistResourceBundle === RESOURCE_BUNDLE_VERSION &&
    Array.isArray((value as { resources?: unknown }).resources),
  );
}

async function hydrateResourceBundle(decoded: unknown): Promise<unknown> {
  if (!isResourceBundleEnvelope(decoded)) {
    return decoded;
  }

  for (const resource of decoded.resources) {
    if (
      typeof resource.resourceId !== 'string' ||
      typeof resource.name !== 'string' ||
      typeof resource.mimeType !== 'string' ||
      !(resource.bytes instanceof Uint8Array)
    ) {
      throw new Error('Portable resource bundle contains an invalid resource entry.');
    }

    const stored = await putResourceBytes(resource.bytes, {
      name: resource.name,
      mimeType: resource.mimeType,
      kind: resource.kind === 'image' || resource.kind === 'video' || resource.kind === 'audio' || resource.kind === 'unknown'
        ? resource.kind
        : 'unknown',
    });
    if (stored.resourceId !== resource.resourceId) {
      throw new Error(`Portable resource checksum mismatch for ${resource.name}.`);
    }
  }

  return decoded.artifact;
}

export async function importAnyArtifact(bytes: Uint8Array): Promise<ImportedV2Artifact> {
  try {
    const workspace = await importWorkspaceBinary(bytes);
    return { kind: 'workspace', ...workspace };
  } catch {
    // Try the next supported artifact type.
  }

  try {
    const pack = await importCompiledActionPackV2Binary(bytes);
    return { kind: 'action-pack', ...pack };
  } catch (error) {
    if (error instanceof Error && error.message.includes('Content Blocker')) {
      throw error;
    }
    // Try legacy v1 URL pack import before rejecting.
  }

  const legacy = await importActionPackBinary(bytes);
  return {
    kind: 'legacy-urlpack',
    pack: legacy.pack,
    checksumHex: legacy.checksumHex,
    schemaVersion: legacy.schemaVersion,
  };
}
