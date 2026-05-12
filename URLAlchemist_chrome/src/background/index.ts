import { CONTEXT_MENU_RUN_ID, MAX_REDIRECT_DEPTH } from '../shared/constants';
import { packMatchesScope, simulateActionPack, triggerMatches } from '../shared/engine/engine';
import { normalizeHotkeyValue } from '../shared/hotkeys';
import { isHotkeyTriggerMessage } from '../shared/messages';
import { appendTraceEntry, loadStoredState } from '../shared/storage';
import type { ActionPack, EngineIssue, TriggerType } from '../shared/types';
import type { CompiledActionPackV2 } from '../shared/v2/types';
import { executeCompiledActionPackV2, type GraphRuntime } from '../shared/v2/vm';
import { createOffscreenRegexExecutor, readClipboardFromOffscreen } from './offscreenBridge';

const redirectTrail = new Map<string, { url: string; depth: number; expiresAt: number }>();
const runtime: GraphRuntime = {
  regex: createOffscreenRegexExecutor(),
  readClipboard: readClipboardFromOffscreen,
  readSource: async (source) => {
    if (source === 'clipboard') {
      return { type: 'string', value: await readClipboardFromOffscreen() };
    }

    return undefined;
  },
  loadSessionValue: async (key) => {
    const stored = await chrome.storage.local.get(`url-alchemist-session:${key}`);
    return stored[`url-alchemist-session:${key}`] as Awaited<ReturnType<NonNullable<GraphRuntime['loadSessionValue']>>>;
  },
  saveSessionValue: async (key, value) => {
    await chrome.storage.local.set({ [`url-alchemist-session:${key}`]: value });
  },
};

function getTrailKey(tabId: number, packId: string): string {
  return `${tabId}:${packId}`;
}

function getRedirectDepth(tabId: number, packId: string, url: string): number {
  const key = getTrailKey(tabId, packId);
  const trail = redirectTrail.get(key);

  if (!trail) {
    return 0;
  }

  if (trail.expiresAt < Date.now()) {
    redirectTrail.delete(key);
    return 0;
  }

  return trail.url === url ? trail.depth : 0;
}

function updateRedirectTrail(tabId: number, packId: string, url: string, depth: number): void {
  redirectTrail.set(getTrailKey(tabId, packId), {
    url,
    depth,
    expiresAt: Date.now() + 15_000,
  });
}

function clearRedirectTrail(tabId: number, packId: string): void {
  redirectTrail.delete(getTrailKey(tabId, packId));
}

function logIssues(pack: ActionPack, issues: EngineIssue[]): void {
  if (issues.length === 0) {
    return;
  }

  issues.forEach((issue) => {
    console.warn(`[URL Alchemist] ${pack.name}: ${issue.message}`, issue.activityId ?? '');
  });
}

function logV2Issues(pack: CompiledActionPackV2, issues: EngineIssue[]): void {
  if (issues.length === 0) {
    return;
  }

  issues.forEach((issue) => {
    console.warn(`[URL Alchemist V2] ${pack.manifest.name}: ${issue.message}`, issue.activityId ?? '');
  });
}

function v2TriggerMatches(pack: CompiledActionPackV2, trigger: TriggerType, triggeredHotkey?: string): boolean {
  if (!pack.manifest.enabled || pack.manifest.trigger.type !== trigger) {
    return false;
  }

  if (trigger !== 'HOTKEY') {
    return true;
  }

  return normalizeHotkeyValue(pack.manifest.trigger.hotkey) === normalizeHotkeyValue(triggeredHotkey);
}

async function v2ScopeMatches(pack: CompiledActionPackV2, url: string): Promise<boolean> {
  const scopeRegex = pack.manifest.trigger.scope_regex?.trim();
  if (!scopeRegex) {
    return true;
  }

  return await runtime.regex.test(url, scopeRegex);
}

async function ensureContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  await chrome.contextMenus.create({
    id: CONTEXT_MENU_RUN_ID,
    title: 'Run URL Alchemist packs',
    contexts: ['page', 'link'],
  });
}

async function applyPacksToTab(
  tabId: number,
  inputUrl: string,
  trigger: TriggerType,
  triggeredHotkey?: string,
): Promise<void> {
  const state = await loadStoredState();
  if (!state.settings.globalEnabled) {
    return;
  }

  let currentUrl = inputUrl;
  let urlChanged = false;

  for (const pack of state.packs) {
    if (!triggerMatches(pack, trigger, triggeredHotkey)) {
      continue;
    }

    try {
      const matchesScope = await packMatchesScope(pack, currentUrl, runtime);
      if (!matchesScope) {
        continue;
      }
    } catch (error) {
      console.warn(
        `[URL Alchemist] Scope regex failed for ${pack.name}`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }

    const redirectDepth = getRedirectDepth(tabId, pack.id, currentUrl);
    if (redirectDepth >= MAX_REDIRECT_DEPTH) {
      console.warn(`[URL Alchemist] Loop protection skipped ${pack.name} on ${currentUrl}`);
      continue;
    }

    const result = await simulateActionPack(currentUrl, pack, runtime, state.settings);
    logIssues(pack, result.issues);

    if (!result.changed) {
      clearRedirectTrail(tabId, pack.id);
      continue;
    }

    currentUrl = result.finalUrl;
    urlChanged = true;
    updateRedirectTrail(tabId, pack.id, currentUrl, redirectDepth + 1);
  }

  for (const pack of state.actionPacksV2) {
    if (!v2TriggerMatches(pack, trigger, triggeredHotkey)) {
      continue;
    }

    try {
      const matchesScope = await v2ScopeMatches(pack, currentUrl);
      if (!matchesScope) {
        continue;
      }
    } catch (error) {
      console.warn(
        `[URL Alchemist V2] Scope regex failed for ${pack.manifest.name}`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }

    const redirectDepth = getRedirectDepth(tabId, pack.manifest.id, currentUrl);
    if (redirectDepth >= MAX_REDIRECT_DEPTH) {
      console.warn(`[URL Alchemist V2] Loop protection skipped ${pack.manifest.name} on ${currentUrl}`);
      continue;
    }

    const result = await executeCompiledActionPackV2(currentUrl, pack, runtime, state.settings);
    logV2Issues(pack, result.issues);

    if (pack.traceEnabledUntil && pack.traceEnabledUntil > Date.now()) {
      await appendTraceEntry({
        id: crypto.randomUUID(),
        packId: pack.manifest.id,
        packName: pack.manifest.name,
        timestamp: Date.now(),
        inputUrl: currentUrl,
        outputUrl: result.finalUrl,
        changed: result.changed,
        entries: result.trace,
        issues: result.issues,
      });
    }

    if (!result.changed) {
      clearRedirectTrail(tabId, pack.manifest.id);
      continue;
    }

    currentUrl = result.finalUrl;
    urlChanged = true;
    updateRedirectTrail(tabId, pack.manifest.id, currentUrl, redirectDepth + 1);
  }

  if (urlChanged && currentUrl !== inputUrl) {
    await chrome.tabs.update(tabId, {
      url: currentUrl,
    });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureContextMenu();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenu();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) {
    return;
  }

  void applyPacksToTab(details.tabId, details.url, 'ALWAYS');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isHotkeyTriggerMessage(message)) {
    return;
  }

  const tabId = sender.tab?.id;
  const hotkey = normalizeHotkeyValue(message.hotkey);
  const url = sender.tab?.url || message.url;

  if (tabId === undefined || !hotkey || !url) {
    sendResponse({ handled: false });
    return;
  }

  void applyPacksToTab(tabId, url, 'HOTKEY', hotkey)
    .then(() => {
      sendResponse({ handled: true });
    })
    .catch((error) => {
      console.warn('[URL Alchemist] Hotkey execution failed', error instanceof Error ? error.message : error);
      sendResponse({ handled: false });
    });

  return true;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_RUN_ID) {
    return;
  }

  if (tab?.id === undefined) {
    return;
  }

  const targetUrl = info.linkUrl ?? tab.url;
  if (!targetUrl) {
    return;
  }

  void applyPacksToTab(tab.id, targetUrl, 'CONTEXT_MENU');
});
