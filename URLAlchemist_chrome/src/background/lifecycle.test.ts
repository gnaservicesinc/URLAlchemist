import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../shared/storage', () => ({
  loadStoredState: async () => ({ settings: { globalEnabled: true }, actionPacksV2: [] }),
  appendActionPackLogEntry: vi.fn(), appendTraceEntry: vi.fn(), updateActionPackV2Install: vi.fn(),
}));

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('wires startup, tab close, pack removal and allowance expiry into background storage cleanup', async () => {
  const listener = () => ({ addListener: vi.fn() });
  const onRemoved = listener();
  const onChanged = listener();
  const onAlarm = listener();
  const pack = { manifest: { id: 'pack' }, triggerPlan: {} };
  const other = { manifest: { id: 'other' }, triggerPlan: {} };
  const values: Record<string, unknown> = {
    'url-alchemist-overlay-session:1:pack': { active: true },
    'url-alchemist-overlay-session:2:pack': { active: true },
    'url-alchemist-overlay-session:99:pack': { active: true },
    'url-alchemist-v2-shared:pack:key': { type: 'string', value: 'persist' },
    'url-alchemist-v2-shared:removed:key': true,
    'url-alchemist-v2-shared:other:key': true,
    'url-alchemist-trigger-log:pack': [1],
    'url-alchemist-content-blocker:payload': { tabId: 1, packId: 'pack' },
    unrelated: 'keep',
  };
  let packs = [pack, other];
  vi.stubGlobal('chrome', {
    storage: { onChanged,
      local: { get: async () => ({ 'url-alchemist-state': { actionPacksV2: packs } }) },
      session: {
        get: async (key: string | null) => key === null ? { ...values } : { [key]: values[key] },
        set: async (items: Record<string, unknown>) => { Object.assign(values, items); },
        remove: async (keys: string[]) => { keys.forEach((key) => delete values[key]); },
      },
    },
    tabs: { onRemoved, get: async (tabId: number) => {
      if (tabId === 99) throw new Error('No such tab');
      return { id: tabId };
    } },
    alarms: { onAlarm, create: vi.fn(), getAll: async () => [] },
    runtime: { onInstalled: listener(), onStartup: listener(), onMessage: listener() },
    action: { onClicked: listener() },
    webNavigation: { onBeforeNavigate: listener(), onCommitted: listener() },
    contextMenus: { onClicked: listener() },
  });
  await import('./index');
  await vi.waitFor(() => {
    expect(values['url-alchemist-overlay-session:99:pack']).toBeUndefined();
    expect(values['url-alchemist-v2-shared:removed:key']).toBeUndefined();
  });
  onRemoved.addListener.mock.calls[0][0](1);
  await vi.waitFor(() => {
    expect(values['url-alchemist-overlay-session:1:pack']).toBeUndefined();
    expect(values['url-alchemist-content-blocker:payload']).toBeUndefined();
  });
  expect(values['url-alchemist-overlay-session:2:pack']).toBeDefined();
  expect(values['url-alchemist-v2-shared:pack:key']).toBeDefined();

  packs = [other];
  onChanged.addListener.mock.calls[0][0]({ 'url-alchemist-state': {
    oldValue: { actionPacksV2: [pack, other] }, newValue: { actionPacksV2: [other] },
  } }, 'local');
  await vi.waitFor(() => expect(values['url-alchemist-trigger-log:pack']).toBeUndefined());
  expect(values['url-alchemist-overlay-session:2:pack']).toBeUndefined();
  expect(values['url-alchemist-v2-shared:pack:key']).toBeUndefined();
  expect(values['url-alchemist-v2-shared:other:key']).toBe(true);

  const key = 'url-alchemist-content-blocker-allow:2:other:https://example.com';
  values[key] = { expiresAt: Date.now() - 1 };
  for (const [callback] of onAlarm.addListener.mock.calls) callback({ name: 'url-alchemist-session-cleanup' });
  await vi.waitFor(() => expect(values[key]).toBeUndefined());
  expect(values.unrelated).toBe('keep');
});
