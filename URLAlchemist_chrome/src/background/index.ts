import { CONTEXT_MENU_RUN_ID } from '../shared/constants';
import { packMatchesScope, simulateActionPack, triggerMatches } from '../shared/engine/engine';
import { effectiveRedirectDepthLimit, effectiveRegexTimeoutMs } from '../shared/hardening';
import { normalizeHotkeyValue } from '../shared/hotkeys';
import {
  CONTENT_DISPLAY_MESSAGE,
  CONTENT_INTERACTION_MESSAGE,
  CONTENT_MUTATE_TEXT_MESSAGE,
  CONTENT_READ_SOURCE_MESSAGE,
  isHotkeyTriggerMessage,
  type ContentGraphResponse,
  type RuntimeSourceContext,
} from '../shared/messages';
import { appendTraceEntry, loadStoredState } from '../shared/storage';
import type { ActionPack, EngineIssue, GlobalSettings, TriggerType, WorkspaceTriggerType } from '../shared/types';
import type { AssetRef, CompiledActionPackV2, GraphValue, WorkspaceInputSource } from '../shared/v2/types';
import { executeCompiledActionPackV2, type AssetRequest, type DisplayRequest, type GraphRuntime, type UserInteractionRequest } from '../shared/v2/vm';
import { createOffscreenRegexExecutor, readClipboardFromOffscreen, writeClipboardFromOffscreen } from './offscreenBridge';

const redirectTrail = new Map<string, { url: string; depth: number; expiresAt: number }>();
const fallbackTriggerHistory = new Map<string, number[]>();
const INTERVAL_ALARM_PREFIX = 'url-alchemist-interval:';
const remoteAssetCache = new Map<string, AssetRef>();
const baseRuntime: GraphRuntime = {
  regex: createOffscreenRegexExecutor(),
  readClipboard: readClipboardFromOffscreen,
  loadSessionValue: async (key) => {
    const stored = await chrome.storage.local.get(`url-alchemist-session:${key}`);
    return stored[`url-alchemist-session:${key}`] as Awaited<ReturnType<NonNullable<GraphRuntime['loadSessionValue']>>>;
  },
  saveSessionValue: async (key, value) => {
    await chrome.storage.local.set({ [`url-alchemist-session:${key}`]: value });
  },
};

async function sendContentGraphMessage(tabId: number | undefined, message: object): Promise<GraphValue> {
  if (tabId === undefined || tabId < 0) {
    throw new Error('No active tab is available for page interaction');
  }

  const response = await chrome.tabs.sendMessage(tabId, message) as ContentGraphResponse | undefined;
  if (!response) {
    throw new Error('The page did not respond to the interaction request');
  }

  if (!response.ok) {
    throw new Error(response.error);
  }

  return response.data;
}

async function resolveRemoteAsset(request: AssetRequest): Promise<AssetRef> {
  const cached = remoteAssetCache.get(request.url);
  if (cached) {
    return cached;
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Remote asset request failed with HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > request.maxBytes) {
      throw new Error('Remote asset exceeded the configured byte limit');
    }

    const asset: AssetRef = {
      source: 'remote',
      kind: request.kind,
      mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || `${request.kind}/*`,
      url: request.url,
      sizeBytes: contentLength || undefined,
      cacheKey: request.url,
    };
    if (remoteAssetCache.size > 50) {
      remoteAssetCache.clear();
    }
    remoteAssetCache.set(request.url, asset);
    return asset;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function displayWithFallback(tabId: number | undefined, request: DisplayRequest): Promise<GraphValue> {
  try {
    return await sendContentGraphMessage(tabId, {
      type: CONTENT_DISPLAY_MESSAGE,
      requestId: crypto.randomUUID(),
      request,
    });
  } catch (error) {
    const fallbackUrl = request.asset?.url;
    if (fallbackUrl && (request.mode === 'NEW_TAB' || request.mode === 'REPLACE_PAGE')) {
      if (request.mode === 'REPLACE_PAGE' && tabId !== undefined) {
        await chrome.tabs.update(tabId, { url: fallbackUrl });
      } else {
        await chrome.tabs.create({ url: fallbackUrl });
      }
      return {
        type: 'dict',
        value: {
          ok: { type: 'bool', value: 1 },
          completed: { type: 'bool', value: 0 },
          cancelled: { type: 'bool', value: 0 },
          stoppedAtSeconds: { type: 'number', value: 0 },
          durationSeconds: { type: 'number', value: 0 },
          watchedPercent: { type: 'number', value: 0 },
          reason: { type: 'string', value: 'fallback-page' },
        },
      };
    }

    throw error;
  }
}

function createRunRuntime(context: RuntimeSourceContext = {}, settings?: GlobalSettings): GraphRuntime {
  return {
    ...baseRuntime,
    regex: createOffscreenRegexExecutor(settings ? effectiveRegexTimeoutMs(settings) : undefined),
    readSource: async (source) => {
      if (source === 'clipboard') {
        return { type: 'string', value: await readClipboardFromOffscreen() };
      }

      if (source === 'selectedText') {
        return { type: 'string', value: context.selectedText ?? '' };
      }

      if (source === 'linkUrl') {
        return context.linkUrl ? { type: 'URL', value: context.linkUrl } : undefined;
      }

      if (source === 'pageTitle') {
        return { type: 'string', value: context.pageTitle ?? '' };
      }

      if (['pageText', 'rawHtml', 'pageLinks', 'pageMetadata'].includes(source)) {
        return sendContentGraphMessage(context.tabId, {
          type: CONTENT_READ_SOURCE_MESSAGE,
          requestId: crypto.randomUUID(),
          source,
        });
      }

      return undefined;
    },
    writeDestination: async (destination, value) => {
      if (destination === 'clipboard') {
        await writeClipboardFromOffscreen(typeof value.value === 'string' ? value.value : JSON.stringify(value.value));
      }
    },
    resolveAsset: resolveRemoteAsset,
    requestUserInteraction: async (request: UserInteractionRequest) => sendContentGraphMessage(context.tabId, {
      type: CONTENT_INTERACTION_MESSAGE,
      requestId: crypto.randomUUID(),
      request,
    }),
    displayOverlay: async (request: DisplayRequest) => displayWithFallback(context.tabId, request),
    mutatePageText: async (value) => {
      await sendContentGraphMessage(context.tabId, {
        type: CONTENT_MUTATE_TEXT_MESSAGE,
        requestId: crypto.randomUUID(),
        value,
      });
    },
  };
}

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
  // Evict expired entries on every write to prevent unbounded growth
  const now = Date.now();
  for (const [key, entry] of redirectTrail) {
    if (entry.expiresAt < now) {
      redirectTrail.delete(key);
    }
  }

  redirectTrail.set(getTrailKey(tabId, packId), {
    url,
    depth,
    expiresAt: now + 15_000,
  });
}

function clearRedirectTrail(tabId: number, packId: string): void {
  redirectTrail.delete(getTrailKey(tabId, packId));
}

function triggerHistoryKey(packId: string): string {
  return `url-alchemist-trigger-log:${packId}`;
}

async function loadTriggerHistory(packId: string): Promise<number[]> {
  const key = triggerHistoryKey(packId);
  const sessionStorage = chrome.storage?.session;
  if (!sessionStorage) {
    return fallbackTriggerHistory.get(key) ?? [];
  }

  const stored = await sessionStorage.get(key);
  const value = stored[key];
  return Array.isArray(value) ? value.filter((entry): entry is number => typeof entry === 'number') : [];
}

async function saveTriggerHistory(packId: string, timestamps: number[]): Promise<void> {
  const key = triggerHistoryKey(packId);
  const sessionStorage = chrome.storage?.session;
  if (!sessionStorage) {
    fallbackTriggerHistory.set(key, timestamps);
    return;
  }

  await sessionStorage.set({ [key]: timestamps });
}

async function recordTriggerOrSkip(pack: CompiledActionPackV2): Promise<boolean> {
  const now = Date.now();
  const history = await loadTriggerHistory(pack.manifest.id);
  const safety = pack.triggerPlan.safety;
  const recent = history.filter((timestamp) => now - timestamp <= safety.burstWindowMs);
  if (recent.length >= safety.burstLimit) {
    console.warn(`[URL Alchemist V2] Burst guard skipped ${pack.manifest.name}`);
    return false;
  }

  await saveTriggerHistory(pack.manifest.id, [...history, now].slice(-safety.timestampHistoryLimit));
  return true;
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

function v2TriggerMatches(
  pack: CompiledActionPackV2,
  trigger: WorkspaceTriggerType,
  triggeredHotkey?: string,
  inputSources: WorkspaceInputSource[] = ['url'],
): boolean {
  if (!pack.manifest.enabled || pack.triggerPlan.type !== trigger) {
    return false;
  }

  if (trigger === 'INPUT_DATA') {
    return pack.triggerPlan.inputSources.some((source) => inputSources.includes(source));
  }

  if (trigger !== 'HOTKEY') {
    return true;
  }

  return normalizeHotkeyValue(pack.manifest.trigger.hotkey) === normalizeHotkeyValue(triggeredHotkey);
}

async function v2ScopeMatches(pack: CompiledActionPackV2, url: string, runtime: GraphRuntime): Promise<boolean> {
  const urlFilters = pack.triggerPlan.sourceFilters.filter((filter) => filter.source === 'url' && filter.pattern.trim());
  if (urlFilters.length === 0) {
    return true;
  }

  for (const filter of urlFilters) {
    if (!(await runtime.regex.test(url, filter.pattern))) {
      return false;
    }
  }

  return true;
}

async function ensureContextMenu(): Promise<void> {
  await chrome.contextMenus.removeAll();
  await chrome.contextMenus.create({
    id: CONTEXT_MENU_RUN_ID,
    title: 'Run URL Alchemist packs',
    contexts: ['page', 'link'],
  });
}

async function syncIntervalAlarms(): Promise<void> {
  if (!chrome.alarms) {
    return;
  }

  const state = await loadStoredState();
  const existing = await chrome.alarms.getAll();
  await Promise.all(
    existing
      .filter((alarm) => alarm.name.startsWith(INTERVAL_ALARM_PREFIX))
      .map((alarm) => chrome.alarms.clear(alarm.name)),
  );

  if (!state.settings.globalEnabled) {
    return;
  }

  await Promise.all(
    state.actionPacksV2
      .filter((pack) => pack.manifest.enabled && pack.triggerPlan.type === 'INTERVAL')
      .map((pack) =>
        chrome.alarms.create(`${INTERVAL_ALARM_PREFIX}${pack.manifest.id}`, {
          periodInMinutes: Math.max(0.5, (pack.triggerPlan.intervalMs ?? 60_000) / 60_000),
        }),
      ),
  );
}

async function runIntervalPack(packId: string): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined || !tab.url) {
    return;
  }

  await applyPacksToTab(tab.id, tab.url, 'INTERVAL', undefined, {
    tabId: tab.id,
    pageTitle: tab.title,
  }, ['url'], packId);
}

async function applyPacksToTab(
  tabId: number,
  inputUrl: string,
  trigger: WorkspaceTriggerType,
  triggeredHotkey?: string,
  context: RuntimeSourceContext = {},
  inputSources: WorkspaceInputSource[] = ['url'],
  onlyPackId?: string,
): Promise<void> {
  const state = await loadStoredState();
  if (!state.settings.globalEnabled) {
    return;
  }

  const runtime = createRunRuntime({ ...context, tabId }, state.settings);
  const redirectDepthLimit = effectiveRedirectDepthLimit(state.settings);
  let currentUrl = inputUrl;
  let urlChanged = false;

  const legacyTrigger: TriggerType = trigger === 'INPUT_DATA' ? 'ALWAYS' : trigger as TriggerType;
  for (const pack of state.packs) {
    if (!triggerMatches(pack, legacyTrigger, triggeredHotkey)) {
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
    if (redirectDepth >= redirectDepthLimit) {
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
    if (onlyPackId && pack.manifest.id !== onlyPackId) {
      continue;
    }

    if (!v2TriggerMatches(pack, trigger, triggeredHotkey, inputSources)) {
      continue;
    }

    try {
      const matchesScope = await v2ScopeMatches(pack, currentUrl, runtime);
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

    if (!(await recordTriggerOrSkip(pack))) {
      continue;
    }

    const redirectDepth = getRedirectDepth(tabId, pack.manifest.id, currentUrl);
    if (redirectDepth >= redirectDepthLimit) {
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
  void syncIntervalAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  void ensureContextMenu();
  void syncIntervalAlarms();
});

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) {
    return;
  }

  void applyPacksToTab(details.tabId, details.url, 'INPUT_DATA', undefined, { tabId: details.tabId }, ['url']);
});

chrome.alarms?.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(INTERVAL_ALARM_PREFIX)) {
    return;
  }

  void runIntervalPack(alarm.name.slice(INTERVAL_ALARM_PREFIX.length));
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes['url-alchemist-state']) {
    void syncIntervalAlarms();
  }
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

  void applyPacksToTab(tabId, url, 'HOTKEY', hotkey, {
    tabId,
    pageTitle: message.pageTitle ?? sender.tab?.title,
    selectedText: message.selectedText,
  })
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

  void applyPacksToTab(tab.id, targetUrl, 'CONTEXT_MENU', undefined, {
    tabId: tab.id,
    linkUrl: info.linkUrl,
    pageTitle: tab.title,
    selectedText: info.selectionText,
  });
});
