import { CONTEXT_MENU_RUN_ID } from '../shared/constants';
import { packMatchesScope, simulateActionPack, triggerMatches } from '../shared/engine/engine';
import { effectiveRedirectDepthLimit, effectiveRegexTimeoutMs } from '../shared/hardening';
import { normalizeHotkeyValue } from '../shared/hotkeys';
import {
  CONTENT_DISPLAY_MESSAGE,
  CONTENT_INTERACTION_MESSAGE,
  CONTENT_MUTATE_TEXT_MESSAGE,
  CONTENT_OVERLAY_CONTROL_MESSAGE,
  CONTENT_OVERLAY_DRAW_MESSAGE,
  CONTENT_READ_SOURCE_MESSAGE,
  isHotkeyTriggerMessage,
  isOverlayAppEventMessage,
  type ContentGraphResponse,
  type RuntimeSourceContext,
} from '../shared/messages';
import { appendActionPackLogEntry, appendTraceEntry, loadStoredState, updateActionPackV2Install } from '../shared/storage';
import type { ActionPack, EngineIssue, GlobalSettings, TriggerType, WorkspaceTriggerType } from '../shared/types';
import { isActionPackLocked } from '../shared/v2/installMetadata';
import { base64FromBytes, readLimitedResponseBytes } from '../shared/v2/remoteBytes';
import { validateRemoteUrl } from '../shared/v2/remoteUrl';
import { resolveResourceAsset } from '../shared/v2/resources';
import type { AssetRef, CompiledActionPackV2, GraphEventHandler, GraphValue, OverlayRuntimeEvent, WorkspaceInputSource } from '../shared/v2/types';
import { evaluateCompiledActionPackCondition, executeCompiledActionPackV2, type AssetRequest, type DisplayRequest, type GraphRuntime, type OverlayControlRequest, type OverlayDrawRequest, type UserInteractionRequest } from '../shared/v2/vm';
import { createOffscreenRegexExecutor, readClipboardFromOffscreen, writeClipboardBinaryFromOffscreen, writeClipboardFromOffscreen } from './offscreenBridge';

const redirectTrail = new Map<string, { url: string; depth: number; expiresAt: number }>();
const fallbackTriggerHistory = new Map<string, number[]>();
const INTERVAL_ALARM_PREFIX = 'url-alchemist-interval:';
const CONDITIONAL_ALARM_PREFIX = 'url-alchemist-conditional:';
const remoteAssetCache = new Map<string, AssetRef>();
const fallbackOverlaySessions = new Map<string, { active: boolean; url: string; updatedAt: number }>();
const fallbackSharedState = new Map<string, GraphValue>();
const fallbackConditionStates = new Map<string, boolean>();
const FOCUS_GUARD_BLOCK_PAGE = 'focus-guard-block.html';
const MAX_FOCUS_GUARD_MEDIA_BYTES = 1024 * 1024;

interface FocusGuardBlockPayload {
  title: string;
  message: string;
  packName: string;
  sourceUrl: string;
  mediaDataUrl?: string;
}

function sessionStorageArea(): chrome.storage.SessionStorageArea | undefined {
  return chrome.storage?.session;
}

function overlaySessionKey(tabId: number, packId: string): string {
  return `url-alchemist-overlay-session:${tabId}:${packId}`;
}

function sharedStateKey(packId: string, key: string): string {
  return `url-alchemist-v2-shared:${packId}:${key}`;
}

function conditionStateStorageKey(pack: CompiledActionPackV2): string {
  return pack.triggerPlan.conditionStateKey ?? `url-alchemist-condition:${pack.manifest.id}`;
}

async function getOverlaySession(tabId: number, packId: string): Promise<{ active: boolean; url: string; updatedAt: number }> {
  const key = overlaySessionKey(tabId, packId);
  const sessionStorage = sessionStorageArea();
  if (!sessionStorage) {
    return fallbackOverlaySessions.get(key) ?? { active: false, url: '', updatedAt: 0 };
  }

  const stored = await sessionStorage.get(key);
  const value = stored[key];
  if (typeof value === 'object' && value !== null && 'active' in value) {
    return value as { active: boolean; url: string; updatedAt: number };
  }

  return { active: false, url: '', updatedAt: 0 };
}

async function saveOverlaySession(tabId: number, packId: string, active: boolean, url: string): Promise<void> {
  const key = overlaySessionKey(tabId, packId);
  const value = { active, url, updatedAt: Date.now() };
  const sessionStorage = sessionStorageArea();
  if (!sessionStorage) {
    fallbackOverlaySessions.set(key, value);
    return;
  }

  await sessionStorage.set({ [key]: value });
}

async function loadSharedGraphValue(packId: string, key: string): Promise<GraphValue | undefined> {
  const storageKey = sharedStateKey(packId, key);
  const sessionStorage = sessionStorageArea();
  if (!sessionStorage) {
    return fallbackSharedState.get(storageKey);
  }

  const stored = await sessionStorage.get(storageKey);
  return stored[storageKey] as GraphValue | undefined;
}

async function saveSharedGraphValue(packId: string, key: string, value: GraphValue): Promise<void> {
  const storageKey = sharedStateKey(packId, key);
  const sessionStorage = sessionStorageArea();
  if (!sessionStorage) {
    fallbackSharedState.set(storageKey, value);
    return;
  }

  await sessionStorage.set({ [storageKey]: value });
}

async function deleteSharedGraphValue(packId: string, key: string): Promise<void> {
  const storageKey = sharedStateKey(packId, key);
  const sessionStorage = sessionStorageArea();
  if (!sessionStorage) {
    fallbackSharedState.delete(storageKey);
    return;
  }

  await sessionStorage.remove(storageKey);
}

async function loadConditionState(pack: CompiledActionPackV2): Promise<boolean> {
  const key = conditionStateStorageKey(pack);
  const sessionStorage = sessionStorageArea();
  if (!sessionStorage) {
    return fallbackConditionStates.get(key) ?? false;
  }

  const stored = await sessionStorage.get(key);
  return stored[key] === true;
}

async function saveConditionState(pack: CompiledActionPackV2, matched: boolean): Promise<void> {
  const key = conditionStateStorageKey(pack);
  const sessionStorage = sessionStorageArea();
  if (!sessionStorage) {
    fallbackConditionStates.set(key, matched);
    return;
  }

  await sessionStorage.set({ [key]: matched });
}
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
  const cacheKey = `${request.kind}:${request.maxBytes}:${request.url}`;
  const cached = remoteAssetCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const validatedUrl = validateRemoteUrl(request.url);
    const response = await fetch(validatedUrl, {
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

    const bytes = await readLimitedResponseBytes(response, request.maxBytes, 'Remote asset');
    const asset: AssetRef = {
      source: 'embedded',
      kind: request.kind,
      mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || `${request.kind}/*`,
      name: new URL(request.url).pathname.split('/').filter(Boolean).pop(),
      dataBase64: base64FromBytes(bytes),
      compression: 'none',
      sizeBytes: bytes.byteLength,
      cacheKey,
    };
    if (remoteAssetCache.size > 12) {
      remoteAssetCache.clear();
    }
    remoteAssetCache.set(cacheKey, asset);
    return asset;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function getBinaryClipboardPayload(value: GraphValue): { mimeType: string; dataBase64: string } {
  const payload = value.value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Binary clipboard output requires an asset payload');
  }

  const record = payload as Record<string, unknown>;
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType.trim() : '';
  const dataBase64 = typeof record.dataBase64 === 'string' ? record.dataBase64.trim() : '';
  if (!mimeType || !dataBase64) {
    throw new Error('Binary clipboard output requires an asset with mimeType and dataBase64');
  }

  return { mimeType, dataBase64 };
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

function graphDictEntry(value: GraphValue, key: string): GraphValue | undefined {
  return value.type === 'dict' ? value.value[key] : undefined;
}

function graphBoolValue(value: GraphValue | undefined): boolean {
  if (!value) {
    return false;
  }

  if (value.type === 'bool') {
    return value.value === 1;
  }

  if (typeof value.value === 'number') {
    return value.value !== 0;
  }

  if (typeof value.value === 'string') {
    return value.value.trim() !== '' && value.value !== '0' && value.value.toLowerCase() !== 'false';
  }

  return Boolean(value.value);
}

async function controlOverlay(tabId: number | undefined, packId: string | undefined, url: string | undefined, request: OverlayControlRequest): Promise<GraphValue> {
  if (tabId === undefined || tabId < 0 || !packId) {
    throw new Error('No active tab or pack is available for overlay control');
  }

  if (request.action === 'STATUS') {
    const session = await getOverlaySession(tabId, packId);
    return {
      type: 'dict',
      value: {
        ok: { type: 'bool', value: 1 },
        active: { type: 'bool', value: session.active ? 1 : 0 },
        action: { type: 'string', value: 'STATUS' },
      },
    };
  }

  const response = await sendContentGraphMessage(tabId, {
    type: CONTENT_OVERLAY_CONTROL_MESSAGE,
    requestId: crypto.randomUUID(),
    packId,
    request,
  });
  const active = graphBoolValue(graphDictEntry(response, 'active'));
  await saveOverlaySession(tabId, packId, active, url ?? '');
  return response;
}

async function drawOverlay(tabId: number | undefined, packId: string | undefined, request: OverlayDrawRequest): Promise<GraphValue> {
  if (tabId === undefined || tabId < 0 || !packId) {
    throw new Error('No active tab or pack is available for overlay drawing');
  }

  return sendContentGraphMessage(tabId, {
    type: CONTENT_OVERLAY_DRAW_MESSAGE,
    requestId: crypto.randomUUID(),
    packId,
    request,
  });
}

function createRunRuntime(context: RuntimeSourceContext = {}, settings?: GlobalSettings, packId?: string, inputUrl?: string, packName = '', loggingEnabled = true): GraphRuntime {
  return {
    ...baseRuntime,
    regex: createOffscreenRegexExecutor(settings ? effectiveRegexTimeoutMs(settings) : undefined),
    loadSessionValue: async (key) => packId ? loadSharedGraphValue(packId, key) : baseRuntime.loadSessionValue?.(key),
    saveSessionValue: async (key, value) => {
      if (packId) {
        await saveSharedGraphValue(packId, key, value);
        return;
      }

      await baseRuntime.saveSessionValue?.(key, value);
    },
    deleteSessionValue: async (key) => {
      if (packId) {
        await deleteSharedGraphValue(packId, key);
      }
    },
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
      } else if (destination === 'clipboardBinary') {
        const { mimeType, dataBase64 } = getBinaryClipboardPayload(value);
        await writeClipboardBinaryFromOffscreen(mimeType, dataBase64);
      }
    },
    resolveAsset: resolveRemoteAsset,
    resolveStoredAsset: resolveResourceAsset,
    requestUserInteraction: async (request: UserInteractionRequest) => sendContentGraphMessage(context.tabId, {
      type: CONTENT_INTERACTION_MESSAGE,
      requestId: crypto.randomUUID(),
      request,
    }),
    displayOverlay: async (request: DisplayRequest) => displayWithFallback(context.tabId, request),
    overlayControl: async (request: OverlayControlRequest) => controlOverlay(context.tabId, packId, inputUrl, request),
    overlayDraw: async (request: OverlayDrawRequest) => drawOverlay(context.tabId, packId, request),
    writeLog: async (entry) => {
      if (!packId || !loggingEnabled) {
        return;
      }

      await appendActionPackLogEntry({
        id: crypto.randomUUID(),
        packId,
        packName,
        timestamp: Date.now(),
        kind: 'message',
        severity: entry.severity,
        message: entry.message,
        nodeId: entry.nodeId,
      });
    },
    sleep: (durationMs) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, durationMs)),
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
    console.warn(`[URL Alchemist] Burst guard skipped ${pack.manifest.name}`);
    return false;
  }

  await saveTriggerHistory(pack.manifest.id, [...history, now].slice(-safety.timestampHistoryLimit));
  return true;
}

function focusGuardBlockPageUrl(): string {
  return chrome.runtime.getURL(FOCUS_GUARD_BLOCK_PAGE);
}

function isFocusGuardBlockPage(url: string): boolean {
  return url.startsWith(focusGuardBlockPageUrl());
}

function globLikeMatches(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedValue = value.toLowerCase();
  if (!normalizedPattern) {
    return false;
  }
  if (!normalizedPattern.includes('*')) {
    return normalizedValue.includes(normalizedPattern);
  }

  let cursor = 0;
  for (const part of normalizedPattern.split('*').filter(Boolean)) {
    const found = normalizedValue.indexOf(part, cursor);
    if (found < 0) {
      return false;
    }
    cursor = found + part.length;
  }
  return true;
}

function focusGuardPatternMatches(pattern: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    return globLikeMatches(pattern, url) || globLikeMatches(pattern, parsed.hostname);
  } catch {
    return globLikeMatches(pattern, url);
  }
}

function focusGuardMatches(pack: CompiledActionPackV2, url: string): boolean {
  const config = pack.install?.focusGuard;
  if (!config || !/^https?:\/\//i.test(url) || isFocusGuardBlockPage(url)) {
    return false;
  }
  if (config.allowPatterns.some((pattern) => focusGuardPatternMatches(pattern, url))) {
    return false;
  }
  return config.blockedPatterns.some((pattern) => focusGuardPatternMatches(pattern, url));
}

async function createFocusGuardBlockUrl(pack: CompiledActionPackV2, sourceUrl: string): Promise<string> {
  const config = pack.install?.focusGuard;
  const payload: FocusGuardBlockPayload = {
    title: config?.pageTitle || 'Focus Guard',
    message: config?.pageMessage || 'This page is blocked by URL Alchemist.',
    packName: pack.manifest.name,
    sourceUrl,
  };
  const resourceId = config?.resourceIds?.[0];
  if (resourceId) {
    try {
      const asset = await resolveResourceAsset({
        source: 'resource',
        kind: 'image',
        mimeType: 'image/*',
        resourceId,
        sha256: resourceId,
      });
      if (asset.dataBase64 && (asset.sizeBytes ?? 0) <= MAX_FOCUS_GUARD_MEDIA_BYTES) {
        payload.mediaDataUrl = `data:${asset.mimeType};base64,${asset.dataBase64}`;
      }
    } catch (error) {
      console.warn('[URL Alchemist] Focus Guard media resource was unavailable', error);
    }
  }

  const id = `url-alchemist-focus-guard:${crypto.randomUUID()}`;
  if (chrome.storage?.session) {
    await chrome.storage.session.set({ [id]: payload });
    return `${focusGuardBlockPageUrl()}?id=${encodeURIComponent(id)}`;
  }

  const params = new URLSearchParams({
    title: payload.title,
    message: payload.message,
    packName: payload.packName,
    sourceUrl: payload.sourceUrl,
  });
  return `${focusGuardBlockPageUrl()}?${params.toString()}`;
}

async function applyFocusGuardPacks(state: Awaited<ReturnType<typeof loadStoredState>>, tabId: number, inputUrl: string): Promise<boolean> {
  for (const pack of state.actionPacksV2) {
    if (!pack.install?.focusGuard || (!pack.manifest.enabled && !isActionPackLocked(pack))) {
      continue;
    }
    if (!focusGuardMatches(pack, inputUrl)) {
      continue;
    }

    const focusGuard = {
      ...pack.install.focusGuard,
      blockCount: (pack.install.focusGuard.blockCount ?? 0) + 1,
      lastBlockedAt: Date.now(),
    };
    await updateActionPackV2Install(pack.manifest.id, { focusGuard });
    await chrome.tabs.update(tabId, { url: await createFocusGuardBlockUrl(pack, inputUrl) });
    return true;
  }

  return false;
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
    console.warn(`[URL Alchemist] ${pack.manifest.name}: ${issue.message}`, issue.activityId ?? '');
  });
}

async function appendV2RunLog(
  pack: CompiledActionPackV2,
  result: Awaited<ReturnType<typeof executeCompiledActionPackV2>>,
  handler: GraphEventHandler | WorkspaceTriggerType,
  inputUrl: string,
): Promise<void> {
  if (pack.install?.loggingEnabled === false) {
    return;
  }

  await appendActionPackLogEntry({
    id: crypto.randomUUID(),
    packId: pack.manifest.id,
    packName: pack.manifest.name,
    timestamp: Date.now(),
    kind: 'run',
    severity: result.exitCode === 0 ? 'info' : result.aborted ? 'warn' : 'error',
    message: result.aborted
      ? 'Action Pack aborted by workflow.'
      : result.issues.length > 0
        ? result.issues.map((entry) => entry.message).join('; ')
        : 'Action Pack completed.',
    handler,
    inputUrl,
    outputUrl: result.finalUrl,
    changed: result.changed,
    exitCode: result.exitCode,
    issueCount: result.issues.length,
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
      .filter((alarm) => alarm.name.startsWith(INTERVAL_ALARM_PREFIX) || alarm.name.startsWith(CONDITIONAL_ALARM_PREFIX))
      .map((alarm) => chrome.alarms.clear(alarm.name)),
  );

  if (!state.settings.globalEnabled) {
    return;
  }

  await Promise.all(
    state.actionPacksV2
      .filter((pack) => pack.manifest.enabled && (pack.triggerPlan.type === 'INTERVAL' || pack.triggerPlan.type === 'CONDITIONAL'))
      .map((pack) => {
        const prefix = pack.triggerPlan.type === 'CONDITIONAL' ? CONDITIONAL_ALARM_PREFIX : INTERVAL_ALARM_PREFIX;
        return chrome.alarms.create(`${prefix}${pack.manifest.id}`, {
          periodInMinutes: Math.max(0.5, (pack.triggerPlan.intervalMs ?? 60_000) / 60_000),
        });
      }),
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

async function runConditionalPack(packId: string): Promise<void> {
  const state = await loadStoredState();
  if (!state.settings.globalEnabled) {
    return;
  }

  const pack = state.actionPacksV2.find((candidate) => candidate.manifest.id === packId);
  if (!pack || !pack.manifest.enabled || pack.triggerPlan.type !== 'CONDITIONAL') {
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (tab?.id === undefined || !tab.url) {
    return;
  }

  const runtime = createRunRuntime({ tabId: tab.id, pageTitle: tab.title }, state.settings, pack.manifest.id, tab.url, pack.manifest.name);
  const condition = await evaluateCompiledActionPackCondition(tab.url, pack, runtime, state.settings);
  if (condition.issues.length > 0) {
    logV2Issues(pack, condition.issues);
  }

  const wasMatched = await loadConditionState(pack);
  await saveConditionState(pack, condition.matched);
  const shouldRun = condition.matched && (pack.triggerPlan.conditionalMode === 'WHILE_TRUE' || !wasMatched);
  if (!shouldRun) {
    return;
  }

  await applyPacksToTab(tab.id, tab.url, 'CONDITIONAL', undefined, {
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

  if (!onlyPackId && trigger === 'INPUT_DATA' && inputSources.includes('url')) {
    const blocked = await applyFocusGuardPacks(state, tabId, inputUrl);
    if (blocked) {
      return;
    }
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
    const packRuntime = createRunRuntime({ ...context, tabId }, state.settings, pack.manifest.id, currentUrl, pack.manifest.name, pack.install?.loggingEnabled !== false);
    if (onlyPackId && pack.manifest.id !== onlyPackId) {
      continue;
    }

    if (!v2TriggerMatches(pack, trigger, triggeredHotkey, inputSources)) {
      continue;
    }

    try {
      const matchesScope = await v2ScopeMatches(pack, currentUrl, packRuntime);
      if (!matchesScope) {
        continue;
      }
    } catch (error) {
      console.warn(
        `[URL Alchemist] Scope regex failed for ${pack.manifest.name}`,
        error instanceof Error ? error.message : error,
      );
      continue;
    }

    if (!(await recordTriggerOrSkip(pack))) {
      continue;
    }

    const redirectDepth = getRedirectDepth(tabId, pack.manifest.id, currentUrl);
    if (redirectDepth >= redirectDepthLimit) {
      console.warn(`[URL Alchemist] Loop protection skipped ${pack.manifest.name} on ${currentUrl}`);
      continue;
    }

    const result = await executeCompiledActionPackV2(currentUrl, pack, packRuntime, state.settings, {
      handler: 'trigger',
      event: {
        kind: 'trigger',
        hotkey: triggeredHotkey,
        url: currentUrl,
      },
    });
    logV2Issues(pack, result.issues);
    await appendV2RunLog(pack, result, trigger, currentUrl);

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

function handlerForOverlayEvent(event: OverlayRuntimeEvent): GraphEventHandler | null {
  switch (event.kind) {
    case 'keyboard':
      return 'keyboard';
    case 'mouse':
      return 'mouse';
    case 'tick':
      return 'tick';
    case 'trigger':
      return 'trigger';
    case 'close':
    default:
      return null;
  }
}

async function runOverlayEvent(tabId: number, url: string, packId: string, event: OverlayRuntimeEvent, context: RuntimeSourceContext = {}): Promise<void> {
  if (event.kind === 'close') {
    await saveOverlaySession(tabId, packId, false, url);
    return;
  }

  const session = await getOverlaySession(tabId, packId);
  if (!session.active) {
    return;
  }

  const handler = handlerForOverlayEvent(event);
  if (!handler) {
    return;
  }

  const state = await loadStoredState();
  if (!state.settings.globalEnabled) {
    return;
  }

  const pack = state.actionPacksV2.find((candidate) => candidate.manifest.id === packId);
  if (!pack || !pack.manifest.enabled) {
    return;
  }

  const runtime = createRunRuntime({ ...context, tabId }, state.settings, pack.manifest.id, url, pack.manifest.name, pack.install?.loggingEnabled !== false);
  const result = await executeCompiledActionPackV2(url, pack, runtime, state.settings, { handler, event });
  logV2Issues(pack, result.issues);
  await appendV2RunLog(pack, result, handler, url);

  if (pack.traceEnabledUntil && pack.traceEnabledUntil > Date.now()) {
    await appendTraceEntry({
      id: crypto.randomUUID(),
      packId: pack.manifest.id,
      packName: pack.manifest.name,
      timestamp: Date.now(),
      inputUrl: url,
      outputUrl: result.finalUrl,
      changed: result.changed,
      entries: result.trace,
      issues: result.issues,
    });
  }

  if (result.changed && result.finalUrl !== url) {
    await chrome.tabs.update(tabId, { url: result.finalUrl });
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
  if (alarm.name.startsWith(INTERVAL_ALARM_PREFIX)) {
    void runIntervalPack(alarm.name.slice(INTERVAL_ALARM_PREFIX.length));
  } else if (alarm.name.startsWith(CONDITIONAL_ALARM_PREFIX)) {
    void runConditionalPack(alarm.name.slice(CONDITIONAL_ALARM_PREFIX.length));
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes['url-alchemist-state']) {
    void syncIntervalAlarms();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isOverlayAppEventMessage(message)) {
    const tabId = sender.tab?.id;
    const url = sender.tab?.url;
    if (tabId === undefined || !url) {
      sendResponse({ handled: false });
      return;
    }

    void runOverlayEvent(tabId, url, message.packId, message.event, {
      tabId,
      pageTitle: message.pageTitle ?? sender.tab?.title,
      selectedText: message.selectedText,
      linkUrl: message.linkUrl,
    })
      .then(() => {
        sendResponse({ handled: true });
      })
      .catch((error) => {
        console.warn('[URL Alchemist] Overlay event failed', error instanceof Error ? error.message : error);
        sendResponse({ handled: false });
      });

    return true;
  }

  if (!isHotkeyTriggerMessage(message)) {
    return;
  }

  const tabId = sender.tab?.id;
  const hotkey = normalizeHotkeyValue(message.hotkey);
  const url = sender.tab?.url;

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
