import {
  ACTION_TYPES,
  CONDITION_TARGETS,
  CONDITION_TYPES,
  MATCH_MODES,
  TRIGGER_TYPES,
} from './types';
import type { ActionPack, Activity, ActivityCondition, StoredState } from './types';
import { DEFAULT_SETTINGS } from './constants';

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
const STORED_STATE_KEYS = ['settings', 'packs'];
const SETTINGS_KEYS = ['globalEnabled', 'allowLocalFiles'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, allowedKeys: string[]): boolean {
  const keys = Object.keys(record);
  return keys.every((key) => allowedKeys.includes(key)) && allowedKeys.every((key) => key in record || !requiredByDefault(allowedKeys, key));
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

  if (!isFiniteNumber(candidate.order)) {
    return { ok: false, errors: [`${prefix}.order must be a number`] };
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

  if (candidate.nth_occurrence !== undefined && !isFiniteNumber(candidate.nth_occurrence)) {
    return { ok: false, errors: [`${prefix}.nth_occurrence must be numeric when provided`] };
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

  if (!isFiniteNumber(candidate.version)) {
    return { ok: false, errors: ['Pack version must be numeric'] };
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

  if (!isFiniteNumber(candidate.metadata.created_at)) {
    return { ok: false, errors: ['Pack metadata.created_at must be numeric'] };
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

export function validateStoredState(candidate: unknown): ValidationResult<StoredState> {
  if (!isRecord(candidate) || !hasExactKeys(candidate, STORED_STATE_KEYS)) {
    return { ok: false, errors: ['Stored state must be exact'] };
  }

  if (!isRecord(candidate.settings) || !hasExactKeys(candidate.settings, SETTINGS_KEYS)) {
    return { ok: false, errors: ['Stored settings must be exact'] };
  }

  if (
    typeof candidate.settings.globalEnabled !== 'boolean' ||
    typeof candidate.settings.allowLocalFiles !== 'boolean'
  ) {
    return { ok: false, errors: ['Stored settings values must be booleans'] };
  }

  if (!Array.isArray(candidate.packs)) {
    return { ok: false, errors: ['Stored packs must be an array'] };
  }

  const packs: ActionPack[] = [];
  const errors: string[] = [];

  candidate.packs.forEach((pack) => {
    const packResult = validateActionPack(pack);
    if (packResult.ok) {
      packs.push(packResult.value);
      return;
    }

    errors.push(...packResult.errors);
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      settings: {
        globalEnabled: candidate.settings.globalEnabled,
        allowLocalFiles: candidate.settings.allowLocalFiles,
      },
      packs,
    },
  };
}

export function normalizeStoredState(candidate: unknown): StoredState {
  const parsed = validateStoredState(candidate);
  if (parsed.ok) {
    return parsed.value;
  }

  return {
    settings: DEFAULT_SETTINGS,
    packs: [],
  };
}
