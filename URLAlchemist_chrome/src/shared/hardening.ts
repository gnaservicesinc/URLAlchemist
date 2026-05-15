import { DEFAULT_SETTINGS, DEFAULT_VM_INSTRUCTION_LIMIT, MAX_REDIRECT_DEPTH, REGEX_TIMEOUT_MS } from './constants';
import type { GlobalSettings } from './types';

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

export function normalizeUiScale(value: unknown): number {
  return clampInteger(value, DEFAULT_SETTINGS.uiScale, 10, 600);
}

export function normalizeHardeningMaxInstructions(value: unknown): number {
  return clampInteger(value, DEFAULT_SETTINGS.hardeningMaxInstructions, 1, DEFAULT_VM_INSTRUCTION_LIMIT);
}

export function normalizeHardeningMaxRecursion(value: unknown): number {
  return clampInteger(value, DEFAULT_SETTINGS.hardeningMaxRecursion, 1, 10);
}

export function normalizeHardeningRegexTimeoutMs(value: unknown): number {
  return clampInteger(value, DEFAULT_SETTINGS.hardeningRegexTimeoutMs, 10, REGEX_TIMEOUT_MS);
}

export function effectiveVmInstructionLimit(settings: GlobalSettings, packStepBudget: number): number {
  return Math.min(
    packStepBudget,
    normalizeHardeningMaxInstructions(settings.hardeningMaxInstructions),
    DEFAULT_VM_INSTRUCTION_LIMIT,
  );
}

export function effectiveRedirectDepthLimit(settings: GlobalSettings): number {
  return Math.min(
    MAX_REDIRECT_DEPTH,
    normalizeHardeningMaxRecursion(settings.hardeningMaxRecursion),
  );
}

export function effectiveRegexTimeoutMs(settings: GlobalSettings): number {
  return Math.min(REGEX_TIMEOUT_MS, normalizeHardeningRegexTimeoutMs(settings.hardeningRegexTimeoutMs));
}
