import type { EngineRuntime } from './runtime';
import type { ActionPack, EngineExecutionResult, EngineIssue, GlobalSettings, TriggerType } from '../types';
import { packUsesClipboard, sortActivities } from '../helpers';

function escapeReplacementLiteral(value: string): string {
  return value.replace(/\$/g, '$$$$');
}

function createIssue(message: string, activityId?: string): EngineIssue {
  return { message, activityId };
}

async function buildReplacementTemplate(
  pack: ActionPack,
  activity: ActionPack['activities'][number],
  runtime: EngineRuntime,
): Promise<string> {
  if (activity.action === 'REMOVE') {
    return '';
  }

  if (!activity.payload_vars) {
    return escapeReplacementLiteral(activity.payload);
  }

  let payload = activity.payload;
  const now = runtime.now ? runtime.now() : new Date();
  payload = payload.replaceAll('{date}', escapeReplacementLiteral(now.toISOString()));

  if (payload.includes('{clipboard}')) {
    if (!packUsesClipboard(pack)) {
      return payload;
    }

    const clipboard = await runtime.readClipboard();
    payload = payload.replaceAll('{clipboard}', escapeReplacementLiteral(clipboard));
  }

  return payload;
}

async function evaluateCondition(
  inputUrl: string,
  currentUrl: string,
  pack: ActionPack,
  runtime: EngineRuntime,
  activity: ActionPack['activities'][number],
): Promise<boolean> {
  if (!activity.condition) {
    return true;
  }

  const source = activity.condition.target === 'URL' ? inputUrl : currentUrl;

  if (activity.condition.type === 'IF_CONTAINS') {
    return source.includes(activity.condition.value);
  }

  return await runtime.regex.test(source, activity.condition.value);
}

export function triggerMatches(pack: ActionPack, trigger: TriggerType): boolean {
  return pack.enabled && pack.trigger.type === trigger;
}

export async function packMatchesScope(
  pack: ActionPack,
  url: string,
  runtime: EngineRuntime,
): Promise<boolean> {
  const scopeRegex = pack.trigger.scope_regex?.trim();
  if (!scopeRegex) {
    return true;
  }

  return await runtime.regex.test(url, scopeRegex);
}

export async function simulateActionPack(
  inputUrl: string,
  pack: ActionPack,
  runtime: EngineRuntime,
  settings: GlobalSettings,
): Promise<EngineExecutionResult> {
  const issues: EngineIssue[] = [];

  if (inputUrl.startsWith('file://') && !settings.allowLocalFiles) {
    return {
      originalUrl: inputUrl,
      finalUrl: inputUrl,
      changed: false,
      appliedPackIds: [],
      issues: [createIssue('Local file URLs are blocked by global settings')],
    };
  }

  let currentUrl = inputUrl;

  for (const activity of sortActivities(pack.activities)) {
    if (!activity.pattern.trim()) {
      issues.push(createIssue('Skipped an activity because its pattern is empty', activity.id));
      continue;
    }

    try {
      const conditionPassed = await evaluateCondition(inputUrl, currentUrl, pack, runtime, activity);
      if (!conditionPassed) {
        continue;
      }

      const replacement = await buildReplacementTemplate(pack, activity, runtime);
      const transformed = await runtime.regex.transform({
        input: currentUrl,
        pattern: activity.pattern,
        matchMode: activity.match_mode,
        action: activity.action,
        replacement,
        nthOccurrence: activity.nth_occurrence,
      });

      if (transformed.matched) {
        currentUrl = transformed.result;
      }
    } catch (error) {
      issues.push(
        createIssue(
          error instanceof Error ? error.message : 'The activity failed during execution',
          activity.id,
        ),
      );
      break;
    }
  }

  return {
    originalUrl: inputUrl,
    finalUrl: currentUrl,
    changed: currentUrl !== inputUrl,
    appliedPackIds: currentUrl !== inputUrl ? [pack.id] : [],
    issues,
  };
}

export async function executeActionPackSet(
  inputUrl: string,
  packs: ActionPack[],
  runtime: EngineRuntime,
  settings: GlobalSettings,
  trigger: TriggerType,
): Promise<EngineExecutionResult> {
  let currentUrl = inputUrl;
  const issues: EngineIssue[] = [];
  const appliedPackIds: string[] = [];

  for (const pack of packs) {
    if (!triggerMatches(pack, trigger)) {
      continue;
    }

    try {
      const matchesScope = await packMatchesScope(pack, currentUrl, runtime);
      if (!matchesScope) {
        continue;
      }
    } catch (error) {
      issues.push({
        message: error instanceof Error ? error.message : 'The scope regex failed',
      });
      continue;
    }

    const result = await simulateActionPack(currentUrl, pack, runtime, settings);
    currentUrl = result.finalUrl;
    issues.push(...result.issues);
    appliedPackIds.push(...result.appliedPackIds);
  }

  return {
    originalUrl: inputUrl,
    finalUrl: currentUrl,
    changed: currentUrl !== inputUrl,
    appliedPackIds,
    issues,
  };
}
