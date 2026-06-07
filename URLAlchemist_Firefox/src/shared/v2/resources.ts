import { sha256Hex } from '../crypto';
import type { AssetKind, AssetRef } from './types';

const DB_NAME = 'url-alchemist-resources';
const DB_VERSION = 1;
const STORE_NAME = 'resources';
const MAX_RESOURCE_BYTES = 50 * 1024 * 1024;

export interface StoredResource {
  resourceId: string;
  sha256: string;
  kind: AssetKind;
  mimeType: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
  updatedAt: number;
  bytes: ArrayBuffer;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('This browser does not support local resource storage.'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'resourceId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open resource storage.'));
  });
}

function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((db) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = run(tx.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Resource storage request failed.'));
      tx.oncomplete = () => db.close();
      tx.onerror = () => {
        db.close();
        reject(tx.error ?? new Error('Resource storage transaction failed.'));
      };
    }),
  );
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const output = new Uint8Array(bytes.byteLength);
  output.set(bytes);
  return output.buffer;
}

export function inferAssetKind(mimeType: string): AssetKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'unknown';
}

export async function putResourceBytes(
  bytes: Uint8Array,
  metadata: { name: string; mimeType: string; kind?: AssetKind },
): Promise<AssetRef> {
  if (bytes.byteLength > MAX_RESOURCE_BYTES) {
    throw new Error('Resources larger than 50 MB are not supported in this release.');
  }

  const sha256 = await sha256Hex(bytes);
  const now = Date.now();
  const existing = await getResource(sha256);
  const resource: StoredResource = existing ?? {
    resourceId: sha256,
    sha256,
    kind: metadata.kind ?? inferAssetKind(metadata.mimeType),
    mimeType: metadata.mimeType || 'application/octet-stream',
    name: metadata.name || 'resource',
    sizeBytes: bytes.byteLength,
    createdAt: now,
    updatedAt: now,
    bytes: copyBuffer(bytes),
  };

  if (!existing) {
    await transaction('readwrite', (store) => store.put(resource));
  }

  return resourceToAssetRef(resource);
}

export async function getResource(resourceId: string | undefined): Promise<StoredResource | undefined> {
  if (!resourceId) return undefined;
  return transaction<StoredResource | undefined>('readonly', (store) => store.get(resourceId));
}

export async function listResources(): Promise<StoredResource[]> {
  return transaction<StoredResource[]>('readonly', (store) => store.getAll());
}

export async function deleteResource(resourceId: string): Promise<void> {
  await transaction('readwrite', (store) => store.delete(resourceId));
}

export function resourceToBytes(resource: StoredResource): Uint8Array {
  return new Uint8Array(resource.bytes);
}

export function resourceToAssetRef(resource: StoredResource): AssetRef {
  return {
    source: 'resource',
    kind: resource.kind,
    mimeType: resource.mimeType,
    resourceId: resource.resourceId,
    sha256: resource.sha256,
    name: resource.name,
    sizeBytes: resource.sizeBytes,
    compression: 'none',
  };
}

export async function resolveResourceAsset(asset: AssetRef): Promise<AssetRef> {
  const resource = await getResource(asset.resourceId ?? asset.sha256);
  if (!resource) {
    return {
      ...asset,
      source: 'embedded',
      dataBase64: '',
      mimeType: asset.mimeType || 'text/plain',
      name: asset.name || 'missing-resource',
    };
  }

  const bytes = resourceToBytes(resource);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }

  return {
    ...resourceToAssetRef(resource),
    source: 'embedded',
    dataBase64: btoa(binary),
  };
}
