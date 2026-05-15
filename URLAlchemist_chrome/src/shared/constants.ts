import type { GlobalSettings } from './types';

export const STORAGE_KEY = 'url-alchemist-state';
export const VAULT_MAGIC = 'URLA1';
export const VAULT_SCHEMA_VERSION = 1;
export const MAX_ACTION_PACK_BINARY_BYTES = 1024 * 1024;
export const MAX_REDIRECT_DEPTH = 3;
export const REGEX_TIMEOUT_MS = 50;
export const DEFAULT_VM_INSTRUCTION_LIMIT = 300;
export const UI_SCALE_MIN = 75;
export const UI_SCALE_MAX = 150;
export const UI_SCALE_STEP = 5;
export const GLOBAL_SCOPE_PATTERNS = new Set(['', '.*', '^.*$', '(?:.*)']);
export const CONTEXT_MENU_RUN_ID = 'url-alchemist-run-context';
export const ALLOWED_NAVIGATION_PROTOCOLS = ['http:', 'https:'] as const;

export const DEFAULT_SETTINGS: GlobalSettings = {
  globalEnabled: true,
  allowLocalFiles: false,
  advancedModeEnabled: false,
  syncEnabled: false,
  uiScale: 100,
  hardeningMaxInstructions: DEFAULT_VM_INSTRUCTION_LIMIT,
  hardeningMaxRecursion: MAX_REDIRECT_DEPTH,
  hardeningRegexTimeoutMs: REGEX_TIMEOUT_MS,
  builderUuid: crypto.randomUUID(),
};
