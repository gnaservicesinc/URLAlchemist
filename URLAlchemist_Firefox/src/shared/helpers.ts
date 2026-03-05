import { GLOBAL_SCOPE_PATTERNS } from './constants';
import { formatHotkeyLabel } from './hotkeys';
import type { ActionPack, Activity } from './types';

export function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function sortActivities(activities: Activity[]): Activity[] {
  return [...activities].sort((left, right) => left.order - right.order);
}

export function packUsesClipboard(pack: ActionPack): boolean {
  return pack.activities.some((activity) => {
    const combined = `${activity.payload} ${activity.condition?.value ?? ''}`;
    return combined.includes('{clipboard}');
  });
}

export function isGlobalScope(scopeRegex?: string): boolean {
  return GLOBAL_SCOPE_PATTERNS.has((scopeRegex ?? '').trim());
}

export function describeMatchMode(activity: Activity): string {
  switch (activity.match_mode) {
    case 'BEFORE_PATTERN':
      return 'Everything before the match';
    case 'AFTER_PATTERN':
      return 'Everything after the match';
    case 'NTH_OCCURRENCE':
      return 'The numbered occurrence in the URL';
    default:
      return 'Every standard match';
  }
}

export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

export function normalizeHotkeyLabel(hotkey?: string): string {
  return formatHotkeyLabel(hotkey);
}

export function ensureActivityOrder(activities: Activity[]): Activity[] {
  return activities.map((activity, index) => ({
    ...activity,
    order: index + 1,
  }));
}
