import type { GlobalSettings } from './types';

export const STORAGE_KEY = 'url-alchemist-state';
export const VAULT_MAGIC = 'URLA1';
export const VAULT_SCHEMA_VERSION = 1;
export const MAX_REDIRECT_DEPTH = 3;
export const REGEX_TIMEOUT_MS = 50;
export const GLOBAL_SCOPE_PATTERNS = new Set(['', '.*', '^.*$', '(?:.*)']);
export const CONTEXT_MENU_RUN_ID = 'url-alchemist-run-context';

export const DEFAULT_SETTINGS: GlobalSettings = {
  globalEnabled: true,
  allowLocalFiles: false,
};
