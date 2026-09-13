import { describe, expect, it } from 'vitest';
import { RuntimeSessions, isExpiredAllowance, isPackSessionKey, isTabSessionKey } from './runtimeSessions';

for (const native of [false, true]) describe(native ? 'native session storage' : 'fallback session storage', () => {
  function setup(limit?: number) {
    const values: Record<string, unknown> = {};
    const tabs = new Set([1, 10]);
    const packs = new Set(['pack', 'other']);
    const store = new RuntimeSessions(() => native ? {
      get: async (key) => key === null ? { ...values } : { [key]: values[key] },
      set: async (items) => { Object.assign(values, items); },
      remove: async (keys) => { keys.forEach((key) => delete values[key]); },
    } : undefined, async (scope) => packs.has(scope.packId) && (scope.tabId === undefined || tabs.has(scope.tabId)), limit);
    return { store, tabs, packs };
  }

  it('cleans closed tabs without touching live tabs or shared state, rejecting late writes', async () => {
    const { store, tabs } = setup();
    for (const tabId of [1, 10]) {
      await store.set(`url-alchemist-overlay-session:${tabId}:pack`, { active: true }, { packId: 'pack', tabId });
      await store.set(`url-alchemist-content-blocker-allow:${tabId}:pack:https://a`, { expiresAt: 99 }, { packId: 'pack', tabId });
    }
    await store.set('url-alchemist-v2-shared:pack:key', 'kept', { packId: 'pack' });
    tabs.delete(1);
    const cleanup = store.removeWhere((key) => isTabSessionKey(key, 1));
    const late = store.set('url-alchemist-overlay-session:1:pack', true, { packId: 'pack', tabId: 1 });
    await Promise.all([cleanup, late]);
    expect(await store.get('url-alchemist-overlay-session:1:pack')).toBeUndefined();
    expect(await store.get('url-alchemist-content-blocker-allow:1:pack:https://a')).toBeUndefined();
    expect(await store.get('url-alchemist-overlay-session:10:pack')).toEqual({ active: true });
    expect(await store.get('url-alchemist-v2-shared:pack:key')).toBe('kept');
  });

  it('removes all state owned by an uninstalled pack and keeps other packs', async () => {
    const { store, packs } = setup();
    const keys = ['url-alchemist-v2-shared:pack:key', 'url-alchemist-trigger-log:pack',
      'url-alchemist-condition:pack', 'url-alchemist-overlay-session:1:pack',
      'url-alchemist-content-blocker-allow:1:pack:https://example.com/', 'custom-condition'];
    await Promise.all(keys.map((key) => store.set(key, true, { packId: 'pack' })));
    await store.set('url-alchemist-v2-shared:other:key', 'kept', { packId: 'other' });
    packs.delete('pack');
    await store.removeWhere((key) => isPackSessionKey(key, 'pack', 'custom-condition'));
    await store.set(keys[0], 'late', { packId: 'pack' });
    for (const key of keys) expect(await store.get(key)).toBeUndefined();
    expect(await store.get('url-alchemist-v2-shared:other:key')).toBe('kept');
  });

  it('expires both browser allowance formats and preserves active grants', async () => {
    const { store } = setup();
    const prefix = 'url-alchemist-content-blocker-allow:1:pack:';
    await store.set(prefix + 'expired', { expiresAt: 9 }, { packId: 'pack', tabId: 1 });
    await store.set(prefix + 'old-firefox', 10, { packId: 'pack', tabId: 1 });
    await store.set(prefix + 'active', { expiresAt: 11 }, { packId: 'pack', tabId: 1 });
    await store.removeWhere((key, value) => isExpiredAllowance(key, value, 10));
    expect(await store.get(prefix + 'expired')).toBeUndefined();
    expect(await store.get(prefix + 'old-firefox')).toBeUndefined();
    expect(await store.get(prefix + 'active')).toEqual({ expiresAt: 11 });
  });

  it('stores snapshots without sharing mutable graph references', async () => {
    const { store } = setup();
    const value = { values: [1] };
    const saved = store.set('value', value, { packId: 'pack' });
    value.values.push(2);
    await saved;
    const read = await store.get<typeof value>('value');
    read!.values.push(3);
    expect(await store.get('value')).toEqual({ values: [1] });
  });

  if (!native) it('fails visibly at the fallback byte limit and recovers after cleanup', async () => {
    const { store } = setup(50);
    await store.set('one', 'x'.repeat(25), { packId: 'pack' });
    await expect(store.set('two', 'x'.repeat(25), { packId: 'pack' })).rejects.toThrow('limit exceeded');
    expect(await store.get('one')).toBe('x'.repeat(25));
    await store.removeWhere(() => true);
    await store.set('two', 'x'.repeat(25), { packId: 'pack' });
    expect(await store.get('two')).toBe('x'.repeat(25));
  });
});
