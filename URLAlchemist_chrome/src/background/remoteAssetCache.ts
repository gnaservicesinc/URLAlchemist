import { base64FromBytes, readLimitedResponseBytes } from '../shared/v2/remoteBytes';
import { validateRemoteUrl } from '../shared/v2/remoteUrl';
import type { AssetRef } from '../shared/v2/types';
import type { AssetRequest } from '../shared/v2/vm';

export function createRemoteAssetResolver() {
  const cache = new Map<string, AssetRef>();
  const pending = new Map<string, Promise<AssetRef>>();
  const maxEntries = 12;
  const maxEncodedBytes = 32 * 1024 * 1024;
  let encodedBytes = 0;

  return async (request: AssetRequest): Promise<AssetRef> => {
    const url = validateRemoteUrl(request.url);
    const cacheKey = `${request.kind}:${request.maxBytes}:${url}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cached);
      return cached;
    }
    // Different timeout policies must not inherit one another's deadline.
    const pendingKey = `${request.timeoutMs}:${cacheKey}`;
    const existing = pending.get(pendingKey);
    if (existing) return existing;

    const fetchAsset = async (): Promise<AssetRef> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetch(url, { method: 'GET', redirect: 'error', signal: controller.signal });
        if (!response.ok) throw new Error(`Remote asset request failed with HTTP ${response.status}`);
        if (Number(response.headers.get('content-length') ?? '0') > request.maxBytes) {
          throw new Error('Remote asset exceeded the configured byte limit');
        }
        const bytes = await readLimitedResponseBytes(response, request.maxBytes, 'Remote asset');
        const asset: AssetRef = {
          source: 'embedded', kind: request.kind,
          mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || `${request.kind}/*`,
          name: new URL(url).pathname.split('/').filter(Boolean).pop(),
          dataBase64: base64FromBytes(bytes), compression: 'none', sizeBytes: bytes.byteLength, cacheKey,
        };
        const size = asset.dataBase64!.length;
        if (size <= maxEncodedBytes) {
          const previous = cache.get(cacheKey);
          if (previous) encodedBytes -= previous.dataBase64!.length;
          cache.delete(cacheKey);
          while (cache.size >= maxEntries || encodedBytes + size > maxEncodedBytes) {
            const oldest = cache.keys().next().value!;
            encodedBytes -= cache.get(oldest)!.dataBase64!.length;
            cache.delete(oldest);
          }
          cache.set(cacheKey, asset);
          encodedBytes += size;
        }
        return asset;
      } finally {
        clearTimeout(timeout);
      }
    };
    const promise = fetchAsset();
    pending.set(pendingKey, promise);
    try { return await promise; }
    finally { pending.delete(pendingKey); }
  };
}
