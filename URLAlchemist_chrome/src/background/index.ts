import { CONTEXT_MENU_RUN_ID, MAX_REDIRECT_DEPTH } from '../shared/constants';
import { packMatchesScope, simulateActionPack, triggerMatches } from '../shared/engine/engine';
import { loadStoredState } from '../shared/storage';
import type { ActionPack, EngineIssue, TriggerType } from '../shared/types';
import { createOffscreenRegexExecutor, readClipboardFromOffscreen } from './offscreenBridge';

const redirectTrail = new Map<string, { url: string; depth: number; expiresAt: number }>();
const runtime = {
  regex: createOffscreenRegexExecutor(),
  readClipboard: readClipboardFromOffscreen,
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

async function ensureContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  await chrome.contextMenus.create({
    id: CONTEXT_MENU_RUN_ID,
    title: 'Run URL Alchemist packs',
    contexts: ['page', 'link'],
  });
}

async function applyPacksToTab(tabId: number, inputUrl: string, trigger: TriggerType): Promise<void> {
  const state = await loadStoredState();
  if (!state.settings.globalEnabled) {
    return;
  }

  let currentUrl = inputUrl;
  let urlChanged = false;

  for (const pack of state.packs) {
    if (!triggerMatches(pack, trigger)) {
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

  if (urlChanged && currentUrl !== inputUrl) {
    await chrome.tabs.update(tabId, {
      url: currentUrl,
    });
  }
}

async function runActiveTabPacks(trigger: TriggerType): Promise<void> {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  if (tab?.id === undefined || !tab.url) {
    return;
  }

  await applyPacksToTab(tab.id, tab.url, trigger);
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

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'run-hotkey-packs') {
    return;
  }

  void runActiveTabPacks('HOTKEY');
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
