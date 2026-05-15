import { decode, encode } from '@msgpack/msgpack';

import { MAX_ACTION_PACK_BINARY_BYTES } from '../constants';
import { hexToBytes, sha256Hex } from '../crypto';
import { importActionPackBinary } from '../vault';
import type { CompiledActionPackV2, ImportedV2Artifact, WorkspaceFileV2 } from './types';
import {
  ACTION_PACK_SCHEMA_VERSION,
  LEGACY_ACTION_PACK_SCHEMA_VERSION,
  LEGACY_WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_SCHEMA_VERSION,
} from './types';
import { migrateCompiledActionPackV2Candidate, validateCompiledActionPackV2 } from './actionPackValidator';
import { validateWorkspaceFile } from './workspace';

export const WORKSPACE_MAGIC = 'WSPC2';
export const ACTION_PACK_MAGIC = 'ACTP2';

const encoder = new TextEncoder();
const WORKSPACE_MAGIC_BYTES = encoder.encode(WORKSPACE_MAGIC);
const ACTION_PACK_MAGIC_BYTES = encoder.encode(ACTION_PACK_MAGIC);
const HEADER_CHECKSUM_BYTES = 32;

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
    throw new Error('Artifact export exceeds the 1MB Action Pack size limit');
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
    throw new Error('Files larger than 1MB are rejected');
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
  return exportWithHeader(workspace, WORKSPACE_MAGIC_BYTES, WORKSPACE_SCHEMA_VERSION);
}

export async function exportCompiledActionPackV2Binary(pack: CompiledActionPackV2): Promise<Uint8Array> {
  const { checksumHex: _checksumHex, traceEnabledUntil: _traceEnabledUntil, ...payload } = pack;
  return exportWithHeader(payload, ACTION_PACK_MAGIC_BYTES, ACTION_PACK_SCHEMA_VERSION);
}

export async function importWorkspaceBinary(bytes: Uint8Array): Promise<{ workspace: WorkspaceFileV2; checksumHex: string; schemaVersion: number }> {
  const imported = await importWithHeader(bytes, WORKSPACE_MAGIC);
  if (![WORKSPACE_SCHEMA_VERSION, LEGACY_WORKSPACE_SCHEMA_VERSION].includes(imported.schemaVersion)) {
    throw new Error(`Unsupported workspace schema version: ${imported.schemaVersion}`);
  }

  const validation = validateWorkspaceFile(imported.decoded);
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
  if (![ACTION_PACK_SCHEMA_VERSION, LEGACY_ACTION_PACK_SCHEMA_VERSION].includes(imported.schemaVersion)) {
    throw new Error(`Unsupported Action Pack schema version: ${imported.schemaVersion}`);
  }

  const validation = validateCompiledActionPackV2(migrateCompiledActionPackV2Candidate(imported.decoded));
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }

  return {
    pack: {
      ...validation.pack,
      checksumHex: imported.checksumHex,
    },
    checksumHex: imported.checksumHex,
    schemaVersion: imported.schemaVersion,
  };
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
  } catch {
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
