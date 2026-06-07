import { DEFAULT_SETTINGS, STORAGE_KEY } from './constants';
import { capLogMessage, rotateActionPackLogEntries } from './logs';
import type { ActionPack, GlobalSettings, StoredActionPackLogEntry, StoredState, StoredTraceEntry } from './types';
import { normalizeStoredState } from './validation';
import { isActionPackLocked, withInstallMetadata } from './v2/installMetadata';
import { validateWorkspaceFile } from './v2/workspace';
import type { CompiledActionPackV2, WorkspaceFileV2, WorkspaceViewport } from './v2/types';

function getChromeStorageLocal(): typeof chrome.storage.local | null {
  return globalThis.chrome?.storage?.local ?? null;
}

function getChromeStorageSync(): typeof chrome.storage.sync | null {
  return globalThis.chrome?.storage?.sync ?? null;
}

function getChromeStorageChanges(): typeof chrome.storage.onChanged | null {
  return globalThis.chrome?.storage?.onChanged ?? null;
}

function getChromeStorageSession(): typeof chrome.storage.session | null {
  return globalThis.chrome?.storage?.session ?? null;
}

const SYNC_STORAGE_KEY = 'url-alchemist-sync-state';
const OPEN_WORKSPACE_DRAFT_KEY = 'url-alchemist-open-workspace';
// Chrome sync QUOTA_BYTES_PER_ITEM is 8192 bytes per key.
// We store the entire snapshot under ONE key, so the total must fit inside that limit.
const SYNC_MAX_ITEM_BYTES = 8 * 1024;
// Leave ~400 bytes of headroom for Chrome's internal JSON wrapping/serialization overhead.
const SYNC_MAX_TOTAL_BYTES = SYNC_MAX_ITEM_BYTES - 400;

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function createSyncSnapshot(state: StoredState): StoredState {
  const settings = {
    ...state.settings,
    syncEnabled: true,
  };
  const actionPacksV2 = state.actionPacksV2
    .filter((pack) => !pack.install?.lockState?.locked)
    .filter((pack) => jsonBytes(pack) <= SYNC_MAX_ITEM_BYTES);
  const workspacesV2 = state.workspacesV2.filter((workspace) => jsonBytes(workspace) <= SYNC_MAX_ITEM_BYTES);
  let snapshot: StoredState = {
    settings,
    packs: [],
    actionPacksV2,
    workspacesV2,
    traceEntries: [],
    actionPackLogs: [],
  };

  while (jsonBytes(snapshot) > SYNC_MAX_TOTAL_BYTES && snapshot.workspacesV2.length > 0) {
    snapshot = {
      ...snapshot,
      workspacesV2: snapshot.workspacesV2.slice(0, -1),
    };
  }

  while (jsonBytes(snapshot) > SYNC_MAX_TOTAL_BYTES && snapshot.actionPacksV2.length > 0) {
    snapshot = {
      ...snapshot,
      actionPacksV2: snapshot.actionPacksV2.slice(0, -1),
    };
  }

  return jsonBytes(snapshot) <= SYNC_MAX_TOTAL_BYTES ? snapshot : {
    settings,
    packs: [],
    actionPacksV2: [],
    workspacesV2: [],
    traceEntries: [],
    actionPackLogs: [],
  };
}

async function saveSyncState(state: StoredState): Promise<void> {
  const chromeStorage = getChromeStorageSync();
  if (!chromeStorage) {
    return;
  }

  if (!state.settings.syncEnabled) {
    await chromeStorage.remove(SYNC_STORAGE_KEY);
    return;
  }

  const snapshot = createSyncSnapshot(state);
  try {
    await chromeStorage.set({
      [SYNC_STORAGE_KEY]: snapshot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // QuotaExceeded and kQuotaBytesPerItem are the two common Chromium error strings.
    if (message.includes('quota') || message.includes('Quota')) {
      console.warn(
        '[URL Alchemist] Sync snapshot exceeded the per-item quota and was skipped. '
        + 'Local storage is unaffected. Disable Google Sync or reduce pack/workspace count.',
        `Snapshot size: ${jsonBytes(snapshot)} bytes`,
      );
      return;
    }
    throw error;
  }
}

async function loadSyncState(): Promise<StoredState | null> {
  const chromeStorage = getChromeStorageSync();
  if (!chromeStorage) {
    return null;
  }

  const stored = await chromeStorage.get(SYNC_STORAGE_KEY);
  const candidate = stored[SYNC_STORAGE_KEY];
  return candidate === undefined ? null : normalizeStoredState(candidate);
}

export function getDefaultState(): StoredState {
  return {
    settings: DEFAULT_SETTINGS,
    packs: [],
    actionPacksV2: [],
    workspacesV2: [],
    traceEntries: [],
    actionPackLogs: [],
  };
}

export async function loadStoredState(): Promise<StoredState> {
  const chromeStorage = getChromeStorageLocal();
  if (!chromeStorage) {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    return stored ? normalizeStoredState(JSON.parse(stored)) : getDefaultState();
  }

  const stored = await chromeStorage.get(STORAGE_KEY);
  const candidate = stored[STORAGE_KEY];

  if (candidate === undefined) {
    return await loadSyncState() ?? getDefaultState();
  }

  return normalizeStoredState(candidate);
}

export async function saveStoredState(state: StoredState): Promise<void> {
  const chromeStorage = getChromeStorageLocal();
  if (!chromeStorage) {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
    globalThis.dispatchEvent(new Event('url-alchemist-storage'));
    return;
  }

  await chromeStorage.set({
    [STORAGE_KEY]: state,
  });
  await saveSyncState(state);
}

export async function updateSettings(settings: Partial<GlobalSettings>): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState: StoredState = {
    ...state,
    settings: {
      ...state.settings,
      ...settings,
    },
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function loadOpenWorkspaceDraft(): Promise<WorkspaceFileV2 | null> {
  const chromeStorage = getChromeStorageLocal();
  const candidate = chromeStorage
    ? (await chromeStorage.get(OPEN_WORKSPACE_DRAFT_KEY))[OPEN_WORKSPACE_DRAFT_KEY]
    : globalThis.localStorage?.getItem(OPEN_WORKSPACE_DRAFT_KEY);
  let raw: unknown;
  try {
    raw = typeof candidate === 'string' ? JSON.parse(candidate) : candidate;
  } catch {
    return null;
  }
  if (raw === undefined || raw === null) {
    return null;
  }

  const validation = validateWorkspaceFile(raw);
  return validation.ok ? validation.value : null;
}

export async function saveOpenWorkspaceDraft(workspace: WorkspaceFileV2): Promise<void> {
  const chromeStorage = getChromeStorageLocal();
  if (!chromeStorage) {
    globalThis.localStorage?.setItem(OPEN_WORKSPACE_DRAFT_KEY, JSON.stringify(workspace));
    return;
  }

  await chromeStorage.set({ [OPEN_WORKSPACE_DRAFT_KEY]: workspace });
}

export async function clearOpenWorkspaceDraft(): Promise<void> {
  const chromeStorage = getChromeStorageLocal();
  if (!chromeStorage) {
    globalThis.localStorage?.removeItem(OPEN_WORKSPACE_DRAFT_KEY);
    return;
  }

  await chromeStorage.remove(OPEN_WORKSPACE_DRAFT_KEY);
}

export async function upsertPack(pack: ActionPack): Promise<StoredState> {
  const state = await loadStoredState();
  const index = state.packs.findIndex((candidate) => candidate.id === pack.id);
  const packs = [...state.packs];

  if (index >= 0) {
    packs[index] = pack;
  } else {
    packs.unshift(pack);
  }

  const nextState = {
    ...state,
    packs,
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function upsertActionPackV2(pack: CompiledActionPackV2, options: { allowLockedOverwrite?: boolean } = {}): Promise<StoredState> {
  const state = await loadStoredState();
  const index = state.actionPacksV2.findIndex((candidate) => candidate.manifest.id === pack.manifest.id);
  const actionPacksV2 = [...state.actionPacksV2];
  const existing = index >= 0 ? actionPacksV2[index] : undefined;
  if (existing && isActionPackLocked(existing) && !options.allowLockedOverwrite) {
    throw new Error('Locked Action Packs cannot be overwritten. Unlock the Action Pack before rebuilding or importing over it.');
  }

  const nextPack = pack.install
    ? pack
    : withInstallMetadata(pack, state.settings, {
        source: existing?.install?.source ?? 'user-created',
        trustStatus: existing?.install?.trustStatus,
        loggingEnabled: existing?.install?.loggingEnabled,
        lockState: existing?.install?.lockState,
        focusGuard: existing?.install?.focusGuard,
        contentBlocker: existing?.install?.contentBlocker,
      });

  if (index >= 0) {
    actionPacksV2[index] = nextPack;
  } else {
    actionPacksV2.unshift(nextPack);
  }

  const nextState = {
    ...state,
    actionPacksV2,
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function deleteActionPackV2(packId: string): Promise<StoredState> {
  const state = await loadStoredState();
  const pack = state.actionPacksV2.find((candidate) => candidate.manifest.id === packId);
  if (pack?.install?.lockState?.locked) {
    throw new Error('Locked Action Packs must be unlocked before they can be deleted.');
  }
  const nextState = {
    ...state,
    actionPacksV2: state.actionPacksV2.filter((pack) => pack.manifest.id !== packId),
    actionPackLogs: state.actionPackLogs.filter((entry) => entry.packId !== packId),
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function upsertWorkspaceV2(workspace: WorkspaceFileV2): Promise<StoredState> {
  const state = await loadStoredState();
  const index = state.workspacesV2.findIndex((candidate) => candidate.metadata.id === workspace.metadata.id);
  const workspacesV2 = [...state.workspacesV2];

  if (index >= 0) {
    workspacesV2[index] = workspace;
  } else {
    workspacesV2.unshift(workspace);
  }

  const nextState = {
    ...state,
    workspacesV2,
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function deleteWorkspaceV2(workspaceId: string): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState = {
    ...state,
    workspacesV2: state.workspacesV2.filter((ws) => ws.metadata.id !== workspaceId),
  };
  await saveStoredState(nextState);
  return nextState;
}

export async function updateWorkspaceV2Viewport(workspaceId: string, viewport: WorkspaceViewport): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState = {
    ...state,
    workspacesV2: state.workspacesV2.map((workspace) =>
      workspace.metadata.id === workspaceId
        ? {
            ...workspace,
            viewport,
          }
        : workspace,
    ),
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function updateActionPackV2Trace(packId: string, traceEnabledUntil: number): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState = {
    ...state,
    actionPacksV2: state.actionPacksV2.map((pack) =>
      pack.manifest.id === packId
        ? {
            ...pack,
            traceEnabledUntil,
          }
        : pack,
    ),
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function updateActionPackV2Install(
  packId: string,
  install: Partial<NonNullable<CompiledActionPackV2['install']>>,
): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState = {
    ...state,
    actionPacksV2: state.actionPacksV2.map((pack) =>
      pack.manifest.id === packId
        ? {
            ...pack,
            install: {
              ...pack.install,
              source: install.source ?? pack.install?.source ?? 'imported',
              trustStatus: install.trustStatus ?? pack.install?.trustStatus ?? 'review',
              loggingEnabled: install.loggingEnabled ?? pack.install?.loggingEnabled ?? state.settings.defaultActionPackLoggingEnabled,
              installedAt: install.installedAt ?? pack.install?.installedAt ?? Date.now(),
              artifactChecksumHex: install.artifactChecksumHex ?? pack.install?.artifactChecksumHex ?? pack.checksumHex,
              bundledHashVerified: install.bundledHashVerified ?? pack.install?.bundledHashVerified,
              userReview: install.userReview ?? pack.install?.userReview,
              lockState: install.lockState ?? pack.install?.lockState,
              focusGuard: install.focusGuard ?? pack.install?.focusGuard,
              contentBlocker: install.contentBlocker ?? pack.install?.contentBlocker,
            },
          }
        : pack,
    ),
  };

  await saveStoredState(nextState);
  return nextState;
}

const MAX_TRACE_URL_LENGTH = 2048;

function capTraceEntry(entry: StoredTraceEntry): StoredTraceEntry {
  return {
    ...entry,
    inputUrl: entry.inputUrl.length > MAX_TRACE_URL_LENGTH
      ? `${entry.inputUrl.slice(0, MAX_TRACE_URL_LENGTH)}...`
      : entry.inputUrl,
    outputUrl: entry.outputUrl.length > MAX_TRACE_URL_LENGTH
      ? `${entry.outputUrl.slice(0, MAX_TRACE_URL_LENGTH)}...`
      : entry.outputUrl,
  };
}

export async function appendTraceEntry(entry: StoredTraceEntry): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState = {
    ...state,
    traceEntries: [capTraceEntry(entry), ...state.traceEntries].slice(0, 100),
  };

  await saveStoredState(nextState);
  return nextState;
}

const MAX_ACTION_PACK_LOG_ENTRIES_TOTAL = 1_500;
const MAX_LOG_URL_LENGTH = 2048;

function capLogUrl(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }

  return value.length > MAX_LOG_URL_LENGTH ? `${value.slice(0, MAX_LOG_URL_LENGTH)}...` : value;
}

function capActionPackLogEntry(entry: StoredActionPackLogEntry): StoredActionPackLogEntry {
  return {
    ...entry,
    message: capLogMessage(entry.message),
    inputUrl: capLogUrl(entry.inputUrl),
    outputUrl: capLogUrl(entry.outputUrl),
  };
}

function capActionPackLogs(entries: StoredActionPackLogEntry[], packId: string): StoredActionPackLogEntry[] {
  return rotateActionPackLogEntries(entries, packId).slice(0, MAX_ACTION_PACK_LOG_ENTRIES_TOTAL);
}

export async function appendActionPackLogEntry(entry: StoredActionPackLogEntry): Promise<StoredState> {
  const state = await loadStoredState();
  const nextLogs = capActionPackLogs([capActionPackLogEntry(entry), ...state.actionPackLogs], entry.packId);
  const nextState = {
    ...state,
    actionPackLogs: nextLogs,
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function clearActionPackLog(packId: string): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState = {
    ...state,
    actionPackLogs: state.actionPackLogs.filter((entry) => entry.packId !== packId),
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function deletePack(packId: string): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState = {
    ...state,
    packs: state.packs.filter((pack) => pack.id !== packId),
  };

  await saveStoredState(nextState);
  return nextState;
}

export async function resetExtensionStorage(): Promise<void> {
  const state = await loadStoredState();
  if (state.actionPacksV2.some((pack) => pack.install?.lockState?.locked)) {
    throw new Error('Locked Action Packs must be unlocked before resetting URL Alchemist.');
  }

  const local = getChromeStorageLocal();
  const sync = getChromeStorageSync();
  const session = getChromeStorageSession();

  if (local) {
    await local.clear();
  } else {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
    globalThis.localStorage?.removeItem(OPEN_WORKSPACE_DRAFT_KEY);
  }

  await sync?.clear();
  await session?.clear();
}

export function subscribeStoredState(listener: (state: StoredState) => void): () => void {
  const chromeChanges = getChromeStorageChanges();
  if (!chromeChanges) {
    const handleLocalChange = () => {
      void loadStoredState().then(listener);
    };
    globalThis.addEventListener('url-alchemist-storage', handleLocalChange);
    return () => {
      globalThis.removeEventListener('url-alchemist-storage', handleLocalChange);
    };
  }

  const handleChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) {
      return;
    }

    listener(normalizeStoredState(changes[STORAGE_KEY].newValue));
  };

  chromeChanges.addListener(handleChange);

  return () => {
    chromeChanges.removeListener(handleChange);
  };
}
