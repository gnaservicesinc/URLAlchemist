import { sha256Hex } from './crypto';
import type { StoredState } from './types';
import { normalizeStoredState } from './validation';

const BACKUP_KIND = 'url-alchemist.backup.v1';

interface BackupEnvelope {
  kind: typeof BACKUP_KIND;
  createdAt: number;
  compression: 'gzip' | 'none';
  payloadBase64: string;
  payloadSha256: string;
  archiveSha256: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    chunks.push(result.value);
    total += result.value.byteLength;
  }

  const output = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return output;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  return output.buffer;
}

async function gzip(bytes: Uint8Array): Promise<{ compression: 'gzip' | 'none'; bytes: Uint8Array }> {
  if (!globalThis.CompressionStream) {
    return { compression: 'none', bytes };
  }

  const stream = new Blob([arrayBufferFromBytes(bytes)]).stream().pipeThrough(new CompressionStream('gzip'));
  return { compression: 'gzip', bytes: await streamToBytes(stream) };
}

async function gunzip(bytes: Uint8Array, compression: BackupEnvelope['compression']): Promise<Uint8Array> {
  if (compression === 'none') {
    return bytes;
  }

  if (!globalThis.DecompressionStream) {
    throw new Error('This browser cannot restore gzip-compressed backups.');
  }

  return streamToBytes(new Blob([arrayBufferFromBytes(bytes)]).stream().pipeThrough(new DecompressionStream('gzip')));
}

export async function exportBackupState(state: StoredState): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(state));
  const compressed = await gzip(payload);
  const payloadSha256 = await sha256Hex(payload);
  const archiveSha256 = await sha256Hex(compressed.bytes);
  const envelope: BackupEnvelope = {
    kind: BACKUP_KIND,
    createdAt: Date.now(),
    compression: compressed.compression,
    payloadBase64: bytesToBase64(compressed.bytes),
    payloadSha256,
    archiveSha256,
  };

  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export async function importBackupState(text: string): Promise<StoredState> {
  const envelope = JSON.parse(text) as BackupEnvelope;
  if (envelope.kind !== BACKUP_KIND) {
    throw new Error('This is not a URL Alchemist backup.');
  }

  const archiveBytes = base64ToBytes(envelope.payloadBase64);
  if (await sha256Hex(archiveBytes) !== envelope.archiveSha256) {
    throw new Error('Backup archive checksum verification failed.');
  }

  const payloadBytes = await gunzip(archiveBytes, envelope.compression);
  if (await sha256Hex(payloadBytes) !== envelope.payloadSha256) {
    throw new Error('Backup payload checksum verification failed.');
  }

  return normalizeStoredState(JSON.parse(new TextDecoder().decode(payloadBytes)));
}
