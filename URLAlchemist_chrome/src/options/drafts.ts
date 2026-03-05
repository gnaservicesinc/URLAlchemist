import { createActivity, createPack } from '../shared/factories';
import { ensureActivityOrder, escapeRegexLiteral, sortActivities } from '../shared/helpers';
import type { ActionPack, Activity } from '../shared/types';

export type PatternHelperMode = 'REGEX' | 'CONTAINS' | 'STARTS_WITH';

export interface ActivityDraft extends Activity {
  helperMode: PatternHelperMode;
  helperInput: string;
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

  return {
    ...activity,
    nth_occurrence: activity.nth_occurrence ?? 1,
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
  const next = {
    ...activity,
    ...updates,
  };

  const helperMode = updates.helperMode ?? next.helperMode;
  const helperInput = updates.helperInput ?? next.helperInput;

  return {
    ...next,
    helperMode,
    helperInput,
    pattern: buildPatternFromHelper(helperMode, helperInput),
  };
}

export function fromPackDraft(draft: PackDraft): ActionPack {
  return {
    ...draft,
    activities: ensureActivityOrder(
      draft.activities.map(({ helperInput, helperMode, ...activity }) => ({
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
