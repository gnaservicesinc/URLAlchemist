import { createActivity, createPack } from '../shared/factories';
import { getHotkeyValidationError } from '../shared/hotkeys';
import { ensureActivityOrder, escapeRegexLiteral, sortActivities } from '../shared/helpers';
import type { ActionPack, Activity } from '../shared/types';
import {
  buildRegexFromBuilder,
  createDefaultRegexBuilder,
  seedRegexBuilderFromLiteral,
  validateEditorRegexPattern,
  type RegexBuilderConfig,
  type RegexSourceMode,
} from './regexBuilder';

export type PatternHelperMode = 'REGEX' | 'CONTAINS' | 'STARTS_WITH';

export interface ActivityDraft extends Activity {
  helperMode: PatternHelperMode;
  helperInput: string;
  regexBuilder: RegexBuilderConfig;
  regexSourceMode: RegexSourceMode;
}

export interface PackDraft extends Omit<ActionPack, 'activities'> {
  activities: ActivityDraft[];
}

function looksLiteralPattern(value: string): boolean {
  const stripped = value.replace(/\\./g, '');
  return !/[.*+?^${}()|[\]]/.test(stripped);
}

function unescapeLiteralPattern(value: string): string {
  return value.replace(/\\([.*+?^${}()|[\]\\])/g, '$1');
}

function inferPatternHelper(pattern: string): Pick<ActivityDraft, 'helperMode' | 'helperInput'> {
  if (pattern.startsWith('^') && looksLiteralPattern(pattern.slice(1))) {
    return {
      helperMode: 'STARTS_WITH',
      helperInput: unescapeLiteralPattern(pattern.slice(1)),
    };
  }

  if (looksLiteralPattern(pattern)) {
    return {
      helperMode: 'CONTAINS',
      helperInput: unescapeLiteralPattern(pattern),
    };
  }

  return {
    helperMode: 'REGEX',
    helperInput: pattern,
  };
}

function buildPatternFromHelper(helperMode: PatternHelperMode, helperInput: string): string {
  if (helperMode === 'REGEX') {
    return helperInput;
  }

  if (helperMode === 'STARTS_WITH') {
    return `^${escapeRegexLiteral(helperInput)}`;
  }

  return escapeRegexLiteral(helperInput);
}

export function toActivityDraft(activity: Activity): ActivityDraft {
  const helper = inferPatternHelper(activity.pattern);
  const regexBuilder =
    helper.helperMode === 'REGEX'
      ? createDefaultRegexBuilder()
      : seedRegexBuilderFromLiteral(helper.helperMode, helper.helperInput);

  return {
    ...activity,
    nth_occurrence: activity.nth_occurrence ?? 1,
    regexBuilder,
    regexSourceMode: helper.helperMode === 'REGEX' ? 'MANUAL' : 'VISUAL',
    ...helper,
  };
}

export function createActivityDraft(order: number): ActivityDraft {
  return toActivityDraft(createActivity(order));
}

export function toPackDraft(pack: ActionPack): PackDraft {
  return {
    ...pack,
    activities: sortActivities(pack.activities).map(toActivityDraft),
  };
}

export function createPackDraft(): PackDraft {
  return toPackDraft(createPack());
}

export function updateActivityDraft(
  activity: ActivityDraft,
  updates: Partial<ActivityDraft>,
): ActivityDraft {
  const next: ActivityDraft = {
    ...activity,
    ...updates,
  };

  if (updates.helperMode && updates.helperMode !== activity.helperMode && updates.helperMode === 'REGEX') {
    next.regexSourceMode = 'VISUAL';

    if (activity.helperMode === 'STARTS_WITH' || activity.helperMode === 'CONTAINS') {
      next.regexBuilder = seedRegexBuilderFromLiteral(activity.helperMode, activity.helperInput);
    } else if (activity.helperInput.trim()) {
      next.regexSourceMode = 'MANUAL';
      next.helperInput = activity.helperInput;
    }
  }

  if (updates.regexSourceMode === 'MANUAL' && activity.regexSourceMode !== 'MANUAL') {
    next.helperInput = next.pattern;
  }

  return {
    ...next,
    pattern:
      next.helperMode === 'REGEX'
        ? next.regexSourceMode === 'VISUAL'
          ? buildRegexFromBuilder(next.regexBuilder)
          : next.helperInput
        : buildPatternFromHelper(next.helperMode, next.helperInput),
  };
}

export function fromPackDraft(draft: PackDraft): ActionPack {
  return {
    ...draft,
    activities: ensureActivityOrder(
      draft.activities.map(({ helperInput, helperMode, regexBuilder, regexSourceMode, ...activity }) => ({
        ...activity,
        nth_occurrence:
          activity.match_mode === 'NTH_OCCURRENCE' ? Math.max(1, Math.trunc(activity.nth_occurrence ?? 1)) : 1,
      })),
    ),
  };
}

export function reorderDraftActivities(
  activities: ActivityDraft[],
  draggedId: string,
  targetId: string,
): ActivityDraft[] {
  const next = [...activities];
  const fromIndex = next.findIndex((activity) => activity.id === draggedId);
  const toIndex = next.findIndex((activity) => activity.id === targetId);

  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
    return activities;
  }

  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);

  return next.map((activity, index) => ({
    ...activity,
    order: index + 1,
  }));
}

export function getActivityPatternValidationError(activity: ActivityDraft): string | null {
  return validateEditorRegexPattern(activity.pattern);
}

export function validatePackDraftInputs(draft: PackDraft, installedPacks: ActionPack[] = []): string[] {
  const errors: string[] = [];

  if (!draft.name.trim()) {
    errors.push('Pack name is required.');
  }

  if (draft.trigger.scope_regex?.trim()) {
    const scopeError = validateEditorRegexPattern(draft.trigger.scope_regex);
    if (scopeError) {
      errors.push(`Scope regex: ${scopeError}`);
    }
  }

  if (draft.trigger.type === 'HOTKEY') {
    const hotkeyError = getHotkeyValidationError(
      draft.trigger.hotkey,
      installedPacks
        .filter((pack) => pack.id !== draft.id && pack.trigger.type === 'HOTKEY')
        .map((pack) => pack.trigger.hotkey ?? ''),
    );

    if (hotkeyError) {
      errors.push(`Hotkey: ${hotkeyError}`);
    }
  }

  draft.activities.forEach((activity) => {
    const patternError = getActivityPatternValidationError(activity);
    if (patternError) {
      errors.push(`Activity ${activity.order}: ${patternError}`);
    }

    if (activity.condition?.type === 'IF_REGEX_MATCH') {
      const conditionError = validateEditorRegexPattern(activity.condition.value);
      if (conditionError) {
        errors.push(`Activity ${activity.order} condition: ${conditionError}`);
      }
    }
  });

  return errors;
}
