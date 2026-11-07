import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRemoteAssetResolver } from './remoteAssetCache';
import type { AssetRequest } from '../shared/v2/vm';

const request = (name: string): AssetRequest => ({ kind: 'image', url: `https://example.com/${name}`, maxBytes: 1024, timeoutMs: 1000 });
afterEach(() => vi.unstubAllGlobals());

describe('remote asset cache', () => {
  it('evicts only the least recently used entry at capacity', async () => {
    const fetcher = vi.fn(async () => new Response('data'));
    vi.stubGlobal('fetch', fetcher);
    const resolve = createRemoteAssetResolver();
    for (let i = 0; i < 12; i++) await resolve(request(String(i)));
    await resolve(request('0')); // refresh oldest
    await resolve(request('12'));
    await resolve(request('0'));
    await resolve(request('2'));
    expect(fetcher).toHaveBeenCalledTimes(13);
    await resolve(request('1'));
    expect(fetcher).toHaveBeenCalledTimes(14);
  });

  it('shares identical in-flight fetches but keeps different timeout policies separate', async () => {
    const fetcher = vi.fn(async () => new Response('data'));
    vi.stubGlobal('fetch', fetcher);
    const resolve = createRemoteAssetResolver();
    const results = await Promise.all([resolve(request('a')), resolve(request('a')),
      resolve({ ...request('a'), timeoutMs: 500 })]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(results[0]).toBe(results[1]);
  });

  it('accepts concurrent loads beyond the cache capacity without full cache clears', async () => {
    const fetcher = vi.fn(async () => new Response('data'));
    vi.stubGlobal('fetch', fetcher);
    const resolve = createRemoteAssetResolver();
    await Promise.all(Array.from({ length: 20 }, (_, index) => resolve(request(String(index)))));
    for (let index = 8; index < 20; index++) await resolve(request(String(index)));
    expect(fetcher).toHaveBeenCalledTimes(20);
  });

  it('retries failed fetches and validates byte limits and hosts before caching', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(new Response('too long'));
    vi.stubGlobal('fetch', fetcher);
    const resolve = createRemoteAssetResolver();
    await expect(resolve(request('a'))).rejects.toThrow('network');
    await expect(resolve({ ...request('a'), maxBytes: 2 })).rejects.toThrow('byte limit');
    await expect(resolve({ ...request('a'), url: 'https://2130706433/' })).rejects.toThrow('cannot access');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
