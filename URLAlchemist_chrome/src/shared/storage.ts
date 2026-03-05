import { DEFAULT_SETTINGS, STORAGE_KEY } from './constants';
import type { ActionPack, GlobalSettings, StoredState } from './types';
import { normalizeStoredState } from './validation';

export function getDefaultState(): StoredState {
  return {
    settings: DEFAULT_SETTINGS,
    packs: [],
  };
}

export async function loadStoredState(): Promise<StoredState> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const candidate = stored[STORAGE_KEY];

  if (candidate === undefined) {
    return getDefaultState();
  }

  return normalizeStoredState(candidate);
}

export async function saveStoredState(state: StoredState): Promise<void> {
  await chrome.storage.local.set({
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
  const handleChange: Parameters<typeof chrome.storage.onChanged.addListener>[0] = (changes, areaName) => {
    if (areaName !== 'local' || !changes[STORAGE_KEY]) {
      return;
    }

    listener(normalizeStoredState(changes[STORAGE_KEY].newValue));
  };

  chrome.storage.onChanged.addListener(handleChange);

  return () => {
    chrome.storage.onChanged.removeListener(handleChange);
  };
}
