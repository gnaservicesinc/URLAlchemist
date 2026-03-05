import { decode, encode } from '@msgpack/msgpack';

import { VAULT_MAGIC, VAULT_SCHEMA_VERSION } from './constants';
import { hexToBytes, sha256Hex } from './crypto';
import type { ActionPack, ImportEnvelope } from './types';
import { validateActionPack } from './validation';

const encoder = new TextEncoder();
const MAGIC_BYTES = encoder.encode(VAULT_MAGIC);
const HEADER_LENGTH = MAGIC_BYTES.length + 1 + 32;

export async function exportActionPackBinary(pack: ActionPack): Promise<Uint8Array> {
  const payload = encode(pack);
  const checksumHex = await sha256Hex(payload);
  const checksumBytes = hexToBytes(checksumHex);
  const output = new Uint8Array(HEADER_LENGTH + payload.length);

  output.set(MAGIC_BYTES, 0);
  output[MAGIC_BYTES.length] = VAULT_SCHEMA_VERSION;
  output.set(checksumBytes, MAGIC_BYTES.length + 1);
  output.set(payload, HEADER_LENGTH);

  return output;
}

export async function importActionPackBinary(bytes: Uint8Array): Promise<ImportEnvelope> {
  if (bytes.length <= HEADER_LENGTH) {
    throw new Error('The file is too small to be a URL Alchemist pack');
  }

  const magic = new TextDecoder().decode(bytes.slice(0, MAGIC_BYTES.length));
  if (magic !== VAULT_MAGIC) {
    throw new Error('The file header is not a valid URL Alchemist pack');
  }

  const schemaVersion = bytes[MAGIC_BYTES.length];
  if (schemaVersion !== VAULT_SCHEMA_VERSION) {
    throw new Error(`Unsupported pack schema version: ${schemaVersion}`);
  }

  const checksumBytes = bytes.slice(MAGIC_BYTES.length + 1, HEADER_LENGTH);
  const payload = bytes.slice(HEADER_LENGTH);
  const checksumHex = Array.from(checksumBytes, (value) => value.toString(16).padStart(2, '0')).join('');
  const actualChecksum = await sha256Hex(payload);

  if (checksumHex !== actualChecksum) {
    throw new Error('Checksum verification failed for the imported pack');
  }

  let decoded: unknown;

  try {
    decoded = decode(payload);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Unable to decode the pack payload');
  }

  const validation = validateActionPack(decoded);
  if (!validation.ok) {
    throw new Error(validation.errors.join('; '));
  }

  return {
    pack: validation.value,
    checksumHex,
    schemaVersion,
  };
}
