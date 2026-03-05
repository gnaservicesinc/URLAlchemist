export const TRIGGER_TYPES = ['ALWAYS', 'HOTKEY', 'CONTEXT_MENU', 'NEVER'] as const;
export const ACTION_TYPES = ['SUBSTITUTE', 'REMOVE', 'APPEND', 'PREPEND'] as const;
export const MATCH_MODES = ['STANDARD', 'BEFORE_PATTERN', 'AFTER_PATTERN', 'NTH_OCCURRENCE'] as const;
export const CONDITION_TYPES = ['IF_CONTAINS', 'IF_REGEX_MATCH'] as const;
export const CONDITION_TARGETS = ['URL', 'PREVIOUS_OUTPUT'] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];
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
}

export interface StoredState {
  settings: GlobalSettings;
  packs: ActionPack[];
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
}

export interface RegexTransformRequest {
  kind: 'transform';
  input: string;
  pattern: string;
  matchMode: MatchMode;
  action: ActionType;
  replacement: string;
  nthOccurrence?: number;
}

export type RegexJobRequest = RegexTestRequest | RegexTransformRequest;

export interface RegexJobResponse {
  kind: RegexJobRequest['kind'];
  matched: boolean;
  result?: string;
}
