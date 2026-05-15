import type { CompiledActionPackV2, WorkspaceFileV2 } from './v2/types';

export const WORKSPACE_TRIGGER_TYPES = ['INPUT_DATA', 'HOTKEY', 'CONTEXT_MENU', 'INTERVAL', 'CONDITIONAL', 'NEVER'] as const;
export const LEGACY_TRIGGER_TYPES = ['ALWAYS'] as const;
export const TRIGGER_TYPES = [...LEGACY_TRIGGER_TYPES, ...WORKSPACE_TRIGGER_TYPES] as const;
export const ACTION_TYPES = ['SUBSTITUTE', 'REMOVE', 'APPEND', 'PREPEND'] as const;
export const MATCH_MODES = ['STANDARD', 'BEFORE_PATTERN', 'AFTER_PATTERN', 'NTH_OCCURRENCE'] as const;
export const CONDITION_TYPES = ['IF_CONTAINS', 'IF_REGEX_MATCH'] as const;
export const CONDITION_TARGETS = ['URL', 'PREVIOUS_OUTPUT'] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];
export type WorkspaceTriggerType = (typeof WORKSPACE_TRIGGER_TYPES)[number];
export type LegacyTriggerType = (typeof LEGACY_TRIGGER_TYPES)[number];
export type ActionType = (typeof ACTION_TYPES)[number];
export type MatchMode = (typeof MATCH_MODES)[number];
export type ConditionType = (typeof CONDITION_TYPES)[number];
export type ConditionTarget = (typeof CONDITION_TARGETS)[number];

export interface ActivityCondition {
  type: ConditionType;
  value: string;
  target: ConditionTarget;
}

export interface Activity {
  id: string;
  order: number;
  condition?: ActivityCondition;
  action: ActionType;
  pattern: string;
  match_mode: MatchMode;
  nth_occurrence?: number;
  payload: string;
  payload_vars: boolean;
}

export interface ActionPack {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  metadata: {
    author?: string;
    description?: string;
    created_at: number;
  };
  trigger: {
    type: TriggerType;
    hotkey?: string;
    scope_regex?: string;
  };
  activities: Activity[];
}

export interface GlobalSettings {
  globalEnabled: boolean;
  allowLocalFiles: boolean;
  advancedModeEnabled: boolean;
  syncEnabled: boolean;
  uiScale: number;
  hardeningMaxInstructions: number;
  hardeningMaxRecursion: number;
  hardeningRegexTimeoutMs: number;
  builderUuid: string;
}

export interface StoredTraceEntry {
  id: string;
  packId: string;
  packName: string;
  timestamp: number;
  inputUrl: string;
  outputUrl: string;
  changed: boolean;
  entries: Array<{
    nodeId: string;
    op: string;
    message: string;
    valueType?: string;
    preview?: string;
  }>;
  issues: EngineIssue[];
}

export interface StoredState {
  settings: GlobalSettings;
  packs: ActionPack[];
  actionPacksV2: CompiledActionPackV2[];
  workspacesV2: WorkspaceFileV2[];
  traceEntries: StoredTraceEntry[];
}

export interface EngineIssue {
  activityId?: string;
  message: string;
}

export interface EngineExecutionResult {
  originalUrl: string;
  finalUrl: string;
  changed: boolean;
  appliedPackIds: string[];
  issues: EngineIssue[];
}

export interface ImportEnvelope {
  pack: ActionPack;
  checksumHex: string;
  schemaVersion: number;
}

export interface VaultHeader {
  magic: string;
  schemaVersion: number;
  checksumHex: string;
}

export interface RegexTestRequest {
  kind: 'test';
  input: string;
  pattern: string;
  timeoutMs?: number;
}

export interface RegexTransformRequest {
  kind: 'transform';
  input: string;
  pattern: string;
  matchMode: MatchMode;
  action: ActionType;
  replacement: string;
  nthOccurrence?: number;
  timeoutMs?: number;
}

export type RegexJobRequest = RegexTestRequest | RegexTransformRequest;

export interface RegexJobResponse {
  kind: RegexJobRequest['kind'];
  matched: boolean;
  result?: string;
}
