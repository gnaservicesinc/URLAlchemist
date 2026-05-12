import { DEFAULT_SETTINGS, STORAGE_KEY } from './constants';
import type { ActionPack, GlobalSettings, StoredState, StoredTraceEntry } from './types';
import { normalizeStoredState } from './validation';
import type { CompiledActionPackV2, WorkspaceFileV2 } from './v2/types';

function getChromeStorageLocal(): typeof chrome.storage.local | null {
  return globalThis.chrome?.storage?.local ?? null;
}

function getChromeStorageChanges(): typeof chrome.storage.onChanged | null {
  return globalThis.chrome?.storage?.onChanged ?? null;
}

export function getDefaultState(): StoredState {
  return {
    settings: DEFAULT_SETTINGS,
    packs: [],
    actionPacksV2: [],
    workspacesV2: [],
    traceEntries: [],
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
    return getDefaultState();
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

export async function upsertActionPackV2(pack: CompiledActionPackV2): Promise<StoredState> {
  const state = await loadStoredState();
  const index = state.actionPacksV2.findIndex((candidate) => candidate.manifest.id === pack.manifest.id);
  const actionPacksV2 = [...state.actionPacksV2];

  if (index >= 0) {
    actionPacksV2[index] = pack;
  } else {
    actionPacksV2.unshift(pack);
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
  const nextState = {
    ...state,
    actionPacksV2: state.actionPacksV2.filter((pack) => pack.manifest.id !== packId),
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

export async function appendTraceEntry(entry: StoredTraceEntry): Promise<StoredState> {
  const state = await loadStoredState();
  const nextState = {
    ...state,
    traceEntries: [entry, ...state.traceEntries].slice(0, 100),
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
