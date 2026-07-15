import {
  ACTION_TYPES,
  CONDITION_TARGETS,
  CONDITION_TYPES,
  MATCH_MODES,
  TRIGGER_TYPES,
} from './types';
import type { ActionPack, ActionPackLogSeverity, Activity, ActivityCondition, StoredState } from './types';
import { DEFAULT_SETTINGS } from './constants';
import {
  normalizeHardeningMaxInstructions,
  normalizeHardeningMaxRecursion,
  normalizeHardeningRegexTimeoutMs,
  normalizeUiScale,
} from './hardening';
import type { CompiledCustomBlockV2 } from './v2/types';
import { ACTION_PACK_SCHEMA_VERSION, SUPPORTED_ACTION_PACK_SCHEMA_VERSIONS } from './v2/types';
import type { CompiledActionPackV2 } from './v2/types';
import { validateCompiledActionPackV2 } from './v2/actionPackValidator';
import { normalizeAiWorkspaceInstructions } from './v2/aiInstructions';
import { migratedStoredInstallMetadata } from './v2/installMetadata';
import { validateWorkspaceFile } from './v2/workspace';

interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

interface ValidationFailure {
  ok: false;
  errors: string[];
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

const ACTIVITY_KEYS = [
  'id',
  'order',
  'condition',
  'action',
  'pattern',
  'match_mode',
  'nth_occurrence',
  'payload',
  'payload_vars',
];
const PACK_KEYS = ['id', 'name', 'version', 'enabled', 'metadata', 'trigger', 'activities'];
const METADATA_KEYS = ['author', 'description', 'created_at'];
const TRIGGER_KEYS = ['type', 'hotkey', 'scope_regex'];
const CONDITION_KEYS = ['type', 'value', 'target'];
const STORED_STATE_KEYS = ['settings', 'packs', 'actionPacksV2', 'customBlocksV2', 'workspacesV2', 'traceEntries', 'actionPackLogs'];
const ACTION_PACK_LOG_KINDS = ['run', 'message'] as const;
const ACTION_PACK_LOG_SEVERITIES = ['debug', 'info', 'warn', 'error'] as const;
const SETTINGS_KEYS = [
  'globalEnabled',
  'allowLocalFiles',
  'advancedModeEnabled',
  'syncEnabled',
  'defaultActionPackLoggingEnabled',
  'ollamaEnabled',
  'ollamaEndpoint',
  'ollamaModel',
  'ollamaTimeoutMs',
  'aiWorkspaceInstructions',
  'uiScale',
  'hardeningMaxInstructions',
  'hardeningMaxRecursion',
  'hardeningRegexTimeoutMs',
  'undoHistoryLimit',
  'builderUuid',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasExactKeys(record: Record<string, unknown>, allowedKeys: string[]): boolean {
  const keys = Object.keys(record);
  return keys.every((key) => allowedKeys.includes(key)) && allowedKeys.every((key) => hasOwn(record, key) || !requiredByDefault(allowedKeys, key));
}

function requiredByDefault(allowedKeys: string[], key: string): boolean {
  if (allowedKeys === ACTIVITY_KEYS) {
    return key !== 'condition' && key !== 'nth_occurrence';
  }

  if (allowedKeys === METADATA_KEYS || allowedKeys === TRIGGER_KEYS || allowedKeys === CONDITION_KEYS) {
    return key !== 'author' && key !== 'description' && key !== 'hotkey' && key !== 'scope_regex';
  }

  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isLogKind(value: unknown): value is StoredState['actionPackLogs'][number]['kind'] {
  return typeof value === 'string' && (ACTION_PACK_LOG_KINDS as readonly string[]).includes(value);
}

function isLogSeverity(value: unknown): value is ActionPackLogSeverity {
  return typeof value === 'string' && (ACTION_PACK_LOG_SEVERITIES as readonly string[]).includes(value);
}

function validateCondition(candidate: unknown, prefix: string): ValidationResult<ActivityCondition> {
  if (!isRecord(candidate) || !hasExactKeys(candidate, CONDITION_KEYS)) {
    return { ok: false, errors: [`${prefix} must be an exact condition object`] };
  }

  if (!CONDITION_TYPES.includes(candidate.type as ActivityCondition['type'])) {
    return { ok: false, errors: [`${prefix}.type is invalid`] };
  }

  if (!isNonEmptyString(candidate.value)) {
    return { ok: false, errors: [`${prefix}.value must be a non-empty string`] };
  }

  if (!CONDITION_TARGETS.includes(candidate.target as ActivityCondition['target'])) {
    return { ok: false, errors: [`${prefix}.target is invalid`] };
  }

  return {
    ok: true,
    value: {
      type: candidate.type as ActivityCondition['type'],
      value: candidate.value,
      target: candidate.target as ActivityCondition['target'],
    },
  };
}

function validateActivity(candidate: unknown, index: number): ValidationResult<Activity> {
  const prefix = `activities[${index}]`;

  if (!isRecord(candidate) || !hasExactKeys(candidate, ACTIVITY_KEYS)) {
    return { ok: false, errors: [`${prefix} must be an exact activity object`] };
  }

  if (!isNonEmptyString(candidate.id)) {
    return { ok: false, errors: [`${prefix}.id must be a string`] };
  }

  if (!isPositiveInteger(candidate.order)) {
    return { ok: false, errors: [`${prefix}.order must be a positive integer`] };
  }

  if (!ACTION_TYPES.includes(candidate.action as Activity['action'])) {
    return { ok: false, errors: [`${prefix}.action is invalid`] };
  }

  if (typeof candidate.pattern !== 'string') {
    return { ok: false, errors: [`${prefix}.pattern must be a string`] };
  }

  if (!MATCH_MODES.includes(candidate.match_mode as Activity['match_mode'])) {
    return { ok: false, errors: [`${prefix}.match_mode is invalid`] };
  }

  if (typeof candidate.payload !== 'string') {
    return { ok: false, errors: [`${prefix}.payload must be a string`] };
  }

  if (candidate.nth_occurrence !== undefined && !isPositiveInteger(candidate.nth_occurrence)) {
    return { ok: false, errors: [`${prefix}.nth_occurrence must be a positive integer when provided`] };
  }

  if (typeof candidate.payload_vars !== 'boolean') {
    return { ok: false, errors: [`${prefix}.payload_vars must be a boolean`] };
  }

  if (candidate.condition !== undefined) {
    const conditionResult = validateCondition(candidate.condition, `${prefix}.condition`);
    if (!conditionResult.ok) {
      return conditionResult;
    }
  }

  return {
    ok: true,
    value: {
      id: candidate.id,
      order: candidate.order,
      condition: candidate.condition as ActivityCondition | undefined,
      action: candidate.action as Activity['action'],
      pattern: candidate.pattern,
      match_mode: candidate.match_mode as Activity['match_mode'],
      nth_occurrence: candidate.nth_occurrence as number | undefined,
      payload: candidate.payload,
      payload_vars: candidate.payload_vars,
    },
  };
}

export function validateActionPack(candidate: unknown): ValidationResult<ActionPack> {
  if (!isRecord(candidate) || !hasExactKeys(candidate, PACK_KEYS)) {
    return { ok: false, errors: ['Pack must be an exact ActionPack object'] };
  }

  if (!isNonEmptyString(candidate.id)) {
    return { ok: false, errors: ['Pack id must be a string'] };
  }

  if (!isNonEmptyString(candidate.name)) {
    return { ok: false, errors: ['Pack name must be a non-empty string'] };
  }

  if (!isPositiveInteger(candidate.version)) {
    return { ok: false, errors: ['Pack version must be a positive integer'] };
  }

  if (typeof candidate.enabled !== 'boolean') {
    return { ok: false, errors: ['Pack enabled must be boolean'] };
  }

  if (!isRecord(candidate.metadata) || !hasExactKeys(candidate.metadata, METADATA_KEYS)) {
    return { ok: false, errors: ['Pack metadata must be exact'] };
  }

  if (!isOptionalString(candidate.metadata.author) || !isOptionalString(candidate.metadata.description)) {
    return { ok: false, errors: ['Pack metadata text fields must be strings'] };
  }

  if (!isNonNegativeInteger(candidate.metadata.created_at)) {
    return { ok: false, errors: ['Pack metadata.created_at must be a non-negative integer'] };
  }

  if (!isRecord(candidate.trigger) || !hasExactKeys(candidate.trigger, TRIGGER_KEYS)) {
    return { ok: false, errors: ['Pack trigger must be exact'] };
  }

  if (!TRIGGER_TYPES.includes(candidate.trigger.type as ActionPack['trigger']['type'])) {
    return { ok: false, errors: ['Pack trigger.type is invalid'] };
  }

  if (!isOptionalString(candidate.trigger.hotkey) || !isOptionalString(candidate.trigger.scope_regex)) {
    return { ok: false, errors: ['Pack trigger optional fields must be strings'] };
  }

  if (!Array.isArray(candidate.activities)) {
    return { ok: false, errors: ['Pack activities must be an array'] };
  }

  const activities: Activity[] = [];
  const errors: string[] = [];

  candidate.activities.forEach((activity, index) => {
    const activityResult = validateActivity(activity, index);
    if (activityResult.ok) {
      activities.push(activityResult.value);
      return;
    }

    errors.push(...activityResult.errors);
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      id: candidate.id,
      name: candidate.name,
      version: candidate.version,
      enabled: candidate.enabled,
      metadata: {
        author: candidate.metadata.author as string | undefined,
        description: candidate.metadata.description as string | undefined,
        created_at: candidate.metadata.created_at,
      },
      trigger: {
        type: candidate.trigger.type as ActionPack['trigger']['type'],
        hotkey: candidate.trigger.hotkey as string | undefined,
        scope_regex: candidate.trigger.scope_regex as string | undefined,
      },
      activities,
    },
  };
}

export interface ValidatedStoredState {
  state: StoredState;
  warnings: string[];
}

export function validateStoredState(candidate: unknown): ValidationResult<ValidatedStoredState> {
  if (!isRecord(candidate)) {
    return { ok: false, errors: ['Stored state must be an object'] };
  }

  if (!isRecord(candidate.settings) || !Object.keys(candidate.settings).every((key) => SETTINGS_KEYS.includes(key))) {
    return { ok: false, errors: ['Stored settings must be exact'] };
  }

  if (
    typeof candidate.settings.globalEnabled !== 'boolean' ||
    typeof candidate.settings.allowLocalFiles !== 'boolean' ||
    typeof candidate.settings.advancedModeEnabled !== 'boolean' ||
    (candidate.settings.syncEnabled !== undefined && typeof candidate.settings.syncEnabled !== 'boolean') ||
    (candidate.settings.defaultActionPackLoggingEnabled !== undefined && typeof candidate.settings.defaultActionPackLoggingEnabled !== 'boolean') ||
    (candidate.settings.ollamaEnabled !== undefined && typeof candidate.settings.ollamaEnabled !== 'boolean')
  ) {
    return { ok: false, errors: ['Stored settings values must be booleans'] };
  }

  if (
    (candidate.settings.ollamaEndpoint !== undefined && typeof candidate.settings.ollamaEndpoint !== 'string') ||
    (candidate.settings.ollamaModel !== undefined && typeof candidate.settings.ollamaModel !== 'string') ||
    (candidate.settings.aiWorkspaceInstructions !== undefined && typeof candidate.settings.aiWorkspaceInstructions !== 'string')
  ) {
    return { ok: false, errors: ['Stored AI connector settings must be strings'] };
  }

  if (candidate.settings.builderUuid !== undefined && typeof candidate.settings.builderUuid !== 'string') {
    return { ok: false, errors: ['Stored builder UUID must be a string'] };
  }

  if (
    (candidate.settings.uiScale !== undefined && !isFiniteNumber(candidate.settings.uiScale)) ||
    (candidate.settings.hardeningMaxInstructions !== undefined && !isFiniteNumber(candidate.settings.hardeningMaxInstructions)) ||
    (candidate.settings.hardeningMaxRecursion !== undefined && !isFiniteNumber(candidate.settings.hardeningMaxRecursion)) ||
    (candidate.settings.hardeningRegexTimeoutMs !== undefined && !isFiniteNumber(candidate.settings.hardeningRegexTimeoutMs)) ||
    (candidate.settings.ollamaTimeoutMs !== undefined && !isFiniteNumber(candidate.settings.ollamaTimeoutMs)) ||
    (candidate.settings.undoHistoryLimit !== undefined && !isFiniteNumber(candidate.settings.undoHistoryLimit))
  ) {
    return { ok: false, errors: ['Stored numeric settings must be finite numbers'] };
  }

  if (candidate.packs !== undefined && !Array.isArray(candidate.packs)) {
    return { ok: false, errors: ['Stored packs must be an array'] };
  }

  const packs: ActionPack[] = [];
  const actionPacksV2: CompiledActionPackV2[] = [];
  const customBlocksV2: CompiledCustomBlockV2[] = [];
  const workspacesV2: StoredState['workspacesV2'] = [];
  const traceEntries: StoredState['traceEntries'] = [];
  const actionPackLogs: StoredState['actionPackLogs'] = [];
  const warnings: string[] = [];
  let droppedLegacyPacks = 0;

  const candidatePacks = Array.isArray(candidate.packs) ? candidate.packs : [];
  candidatePacks.forEach((pack: unknown, index: number) => {
    const packResult = validateActionPack(pack);
    if (packResult.ok) {
      packs.push(packResult.value);
      return;
    }

    droppedLegacyPacks += 1;
    warnings.push(`Dropped legacy pack at index ${index}: ${packResult.errors.join('; ')}`);
  });

  if (droppedLegacyPacks > 0) {
    warnings.push(`Recovered ${packs.length} of ${candidatePacks.length} legacy packs (${droppedLegacyPacks} dropped).`);
  }

  if (candidate.actionPacksV2 !== undefined && !Array.isArray(candidate.actionPacksV2)) {
    warnings.push('Stored Action Packs were not an array; resetting to empty.');
  }

  const candidateActionPacksV2 = Array.isArray(candidate.actionPacksV2) ? candidate.actionPacksV2 : [];
  candidateActionPacksV2.forEach((pack: unknown, index: number) => {
    if (
      isRecord(pack) &&
      pack.kind === 'action-pack.v2' &&
      (SUPPORTED_ACTION_PACK_SCHEMA_VERSIONS as readonly number[]).includes(pack.schemaVersion as number) &&
      isRecord(pack.manifest) &&
      isRecord(pack.vm) &&
      Array.isArray(pack.vm.instructions)
    ) {
      const validation = validateCompiledActionPackV2(pack);
      if (validation.ok) {
        actionPacksV2.push(migratedStoredInstallMetadata(validation.pack));
      } else {
        warnings.push(`Dropped Action Pack at index ${index}: ${validation.errors.join('; ')}`);
      }
    } else {
      warnings.push(`Dropped Action Pack at index ${index}: missing required fields or wrong kind/schemaVersion.`);
    }
  });

  if (candidate.customBlocksV2 !== undefined && !Array.isArray(candidate.customBlocksV2)) {
    warnings.push('Stored Custom Blocks were not an array; resetting to empty.');
  }

  const candidateCustomBlocksV2 = Array.isArray(candidate.customBlocksV2) ? candidate.customBlocksV2 : [];
  candidateCustomBlocksV2.forEach((block: unknown, index: number) => {
    if (
      isRecord(block) &&
      block.kind === 'custom-block.v2' &&
      typeof block.blockId === 'string' &&
      typeof block.label === 'string' &&
      Number.isInteger(block.version) &&
      isRecord(block.vm) &&
      Array.isArray(block.vm.instructions)
    ) {
      customBlocksV2.push({
        ...(block as unknown as CompiledCustomBlockV2),
        schemaVersion: ACTION_PACK_SCHEMA_VERSION,
      });
    } else {
      warnings.push(`Dropped Custom Block at index ${index}: missing required fields.`);
    }
  });

  if (candidate.workspacesV2 !== undefined && !Array.isArray(candidate.workspacesV2)) {
    warnings.push('Stored workspaces were not an array; resetting to empty.');
  }

  const candidateWorkspacesV2 = Array.isArray(candidate.workspacesV2) ? candidate.workspacesV2 : [];
  candidateWorkspacesV2.forEach((workspace: unknown, index: number) => {
    const validation = validateWorkspaceFile(workspace);
    if (validation.ok) {
      workspacesV2.push(validation.value);
    } else {
      warnings.push(`Dropped workspace at index ${index}: ${validation.errors.join('; ')}`);
    }
  });

  const candidateTraceEntries = Array.isArray(candidate.traceEntries) ? candidate.traceEntries : [];
  if (candidateTraceEntries.length > 0) {
    candidateTraceEntries.forEach((entry) => {
      if (isRecord(entry) && typeof entry.id === 'string' && typeof entry.packId === 'string') {
        traceEntries.push(entry as unknown as StoredState['traceEntries'][number]);
      }
    });
  }

  const candidateActionPackLogs = Array.isArray(candidate.actionPackLogs) ? candidate.actionPackLogs : [];
  if (candidateActionPackLogs.length > 0) {
    candidateActionPackLogs.forEach((entry) => {
      if (
        isRecord(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.packId === 'string' &&
        typeof entry.packName === 'string' &&
        isNonNegativeInteger(entry.timestamp) &&
        isLogKind(entry.kind) &&
        isLogSeverity(entry.severity) &&
        typeof entry.message === 'string'
      ) {
        actionPackLogs.push({
          id: entry.id,
          packId: entry.packId,
          packName: entry.packName,
          timestamp: entry.timestamp,
          kind: entry.kind,
          severity: entry.severity,
          message: entry.message,
          nodeId: typeof entry.nodeId === 'string' ? entry.nodeId : undefined,
          handler: typeof entry.handler === 'string' ? entry.handler : undefined,
          inputUrl: typeof entry.inputUrl === 'string' ? entry.inputUrl : undefined,
          outputUrl: typeof entry.outputUrl === 'string' ? entry.outputUrl : undefined,
          changed: typeof entry.changed === 'boolean' ? entry.changed : undefined,
          exitCode: isNonNegativeInteger(entry.exitCode) ? entry.exitCode : undefined,
          issueCount: isNonNegativeInteger(entry.issueCount) ? entry.issueCount : undefined,
        });
      }
    });
  }

  const state: StoredState = {
    settings: {
      globalEnabled: candidate.settings.globalEnabled,
      allowLocalFiles: candidate.settings.allowLocalFiles,
      advancedModeEnabled: candidate.settings.advancedModeEnabled,
      syncEnabled: candidate.settings.syncEnabled ?? DEFAULT_SETTINGS.syncEnabled,
      defaultActionPackLoggingEnabled: candidate.settings.defaultActionPackLoggingEnabled ?? DEFAULT_SETTINGS.defaultActionPackLoggingEnabled,
      ollamaEnabled: candidate.settings.ollamaEnabled ?? DEFAULT_SETTINGS.ollamaEnabled,
      ollamaEndpoint: candidate.settings.ollamaEndpoint || DEFAULT_SETTINGS.ollamaEndpoint,
      ollamaModel: candidate.settings.ollamaModel || DEFAULT_SETTINGS.ollamaModel,
      ollamaTimeoutMs: Math.max(1_000, Math.min(120_000, Math.trunc(candidate.settings.ollamaTimeoutMs ?? DEFAULT_SETTINGS.ollamaTimeoutMs))),
      aiWorkspaceInstructions: typeof candidate.settings.aiWorkspaceInstructions === 'string'
        ? normalizeAiWorkspaceInstructions(candidate.settings.aiWorkspaceInstructions)
        : DEFAULT_SETTINGS.aiWorkspaceInstructions,
      uiScale: normalizeUiScale(candidate.settings.uiScale),
      hardeningMaxInstructions: normalizeHardeningMaxInstructions(candidate.settings.hardeningMaxInstructions),
      hardeningMaxRecursion: normalizeHardeningMaxRecursion(candidate.settings.hardeningMaxRecursion),
      hardeningRegexTimeoutMs: normalizeHardeningRegexTimeoutMs(candidate.settings.hardeningRegexTimeoutMs),
      undoHistoryLimit: Math.max(0, Math.min(10_000, Math.trunc(candidate.settings.undoHistoryLimit ?? DEFAULT_SETTINGS.undoHistoryLimit))),
      builderUuid: candidate.settings.builderUuid || crypto.randomUUID(),
    },
    packs,
    actionPacksV2,
    customBlocksV2,
    workspacesV2,
    traceEntries,
    actionPackLogs,
  };

  return {
    ok: true,
    value: { state, warnings },
  };
}

export function normalizeStoredState(candidate: unknown): StoredState {
  const parsed = validateStoredState(candidate);
  if (parsed.ok) {
    if (parsed.value.warnings.length > 0) {
      console.warn('[URL Alchemist] State normalization warnings:', parsed.value.warnings);
    }
    return parsed.value.state;
  }

  console.warn('[URL Alchemist] Stored state was corrupted and reset to defaults:', parsed.errors);
  return {
    settings: DEFAULT_SETTINGS,
    packs: [],
    actionPacksV2: [],
    customBlocksV2: [],
    workspacesV2: [],
    traceEntries: [],
    actionPackLogs: [],
  };
}
