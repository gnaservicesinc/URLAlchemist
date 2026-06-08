import { ALLOWED_NAVIGATION_PROTOCOLS } from '../constants';
import { effectiveVmInstructionLimit } from '../hardening';
import { capLogMessage } from '../logs';
import type { ActionPackLogSeverity, EngineIssue, GlobalSettings } from '../types';
import type { EngineRuntime } from '../engine/runtime';
import { validateRemoteUrl } from './remoteUrl';
import { readLimitedResponseBytes } from './remoteBytes';
import { extractVariableReferences, resolveVariableText } from './variables';
import type { AssetRef, CompiledActionPackV2, GraphEventHandler, GraphValue, GraphVmInstruction, GraphVmProgram, OverlayRuntimeEvent } from './types';

export interface RemoteRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  outputDataType: GraphValue['type'];
  timeoutMs: number;
  maxBytes: number;
}

export interface AssetRequest {
  url: string;
  kind: AssetRef['kind'];
  timeoutMs: number;
  maxBytes: number;
}

export interface UserInteractionRequest {
  kind: Extract<GraphVmInstruction, { op: 'USER_INTERACTION' }>['interaction'];
  message: string;
  placeholder?: string;
  defaultValue?: string;
  minValue?: number;
  maxValue?: number;
}

export interface DisplayRequest {
  type: Extract<GraphVmInstruction, { op: 'DISPLAY' }>['displayType'];
  title?: string;
  message: string;
  mode: Extract<GraphVmInstruction, { op: 'DISPLAY' }>['mode'];
  stopMode?: Extract<GraphVmInstruction, { op: 'DISPLAY' }>['stopMode'];
  timeoutMs?: number;
  asset?: AssetRef;
  captureKeyboard?: boolean;
  captureMouse?: boolean;
}

export interface OverlayControlRequest {
  action: Extract<GraphVmInstruction, { op: 'OVERLAY_CONTROL' }>['action'];
  message: string;
  width: number;
  height: number;
  cellSize: number;
  tickMs: number;
  background: string;
}

export interface OverlayDrawRequest {
  cells?: GraphValue;
  text?: GraphValue;
  width: number;
  height: number;
  cellSize: number;
  background: string;
}

export interface GraphRuntime extends EngineRuntime {
  readSource?: (source: string) => Promise<GraphValue | undefined>;
  writeDestination?: (destination: string, value: GraphValue) => Promise<void>;
  loadSessionValue?: (key: string) => Promise<GraphValue | undefined>;
  saveSessionValue?: (key: string, value: GraphValue) => Promise<void>;
  deleteSessionValue?: (key: string) => Promise<void>;
  fetchRemote?: (request: RemoteRequest) => Promise<GraphValue>;
  resolveAsset?: (request: AssetRequest) => Promise<AssetRef>;
  resolveStoredAsset?: (asset: AssetRef) => Promise<AssetRef>;
  requestUserInteraction?: (request: UserInteractionRequest) => Promise<GraphValue>;
  displayOverlay?: (request: DisplayRequest) => Promise<GraphValue>;
  overlayControl?: (request: OverlayControlRequest) => Promise<GraphValue>;
  overlayDraw?: (request: OverlayDrawRequest) => Promise<GraphValue>;
  writeLog?: (entry: { severity: ActionPackLogSeverity; message: string; nodeId: string }) => Promise<void>;
  sleep?: (durationMs: number) => Promise<void>;
  mutatePageText?: (value: GraphValue) => Promise<void>;
}

export interface GraphExecutionOptions {
  handler?: GraphEventHandler;
  event?: OverlayRuntimeEvent;
}

export interface GraphExecutionResult {
  originalUrl: string;
  finalUrl: string;
  changed: boolean;
  appliedPackIds: string[];
  issues: EngineIssue[];
  trace: GraphTraceEntry[];
  outputs: Record<string, GraphValue>;
  exitCode: number;
  aborted: boolean;
}

export interface GraphTraceEntry {
  nodeId: string;
  op: GraphVmInstruction['op'];
  message: string;
  valueType?: string;
  preview?: string;
}

interface VmState {
  values: Map<string, GraphValue>;
  globals: Map<string, GraphValue>;
  locals: Map<string, GraphValue>;
  loopSteps: number;
  issues: EngineIssue[];
  trace: GraphTraceEntry[];
  outputs: Map<string, GraphValue>;
  customInputs: Map<string, GraphValue>;
  aborted: boolean;
  exitCode: number;
}

function issue(message: string, activityId?: string): EngineIssue {
  return { message, activityId };
}

function blockedNavigationIssue(url: string, settings: GlobalSettings): string | null {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    return 'Blocked the transformed output because it is not a valid absolute URL';
  }

  if (parsedUrl.protocol === 'file:') {
    return settings.allowLocalFiles ? null : 'Local file URLs are blocked by global settings';
  }

  if (!ALLOWED_NAVIGATION_PROTOCOLS.includes(parsedUrl.protocol as (typeof ALLOWED_NAVIGATION_PROTOCOLS)[number])) {
    return `Blocked the transformed output because the "${parsedUrl.protocol}" protocol is not allowed`;
  }

  return null;
}

function previewValue(value: GraphValue): string {
  const raw = typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
  if (!raw) {
    return '';
  }

  return raw.length > 120 ? `${raw.slice(0, 117)}...` : raw;
}

function trace(state: VmState, instruction: GraphVmInstruction, message: string, value?: GraphValue): void {
  state.trace.push({
    nodeId: instruction.nodeId,
    op: instruction.op,
    message,
    valueType: value?.type,
    preview: value ? previewValue(value) : undefined,
  });
}

function createVmState(event?: OverlayRuntimeEvent): VmState {
  const mouseX = event?.kind === 'mouse' ? event.x : -1;
  const mouseY = event?.kind === 'mouse' ? event.y : -1;
  return {
    values: new Map(),
    globals: new Map([
      ['$mouse_x', { type: 'number', value: mouseX }],
      ['$mouse_y', { type: 'number', value: mouseY }],
    ]),
    locals: new Map(),
    loopSteps: 0,
    issues: [],
    trace: [],
    outputs: new Map(),
    customInputs: new Map(),
    aborted: false,
    exitCode: 0,
  };
}

function bytes(value: GraphValue): number {
  return new TextEncoder().encode(typeof value.value === 'string' ? value.value : JSON.stringify(value.value)).length;
}

function graphValueFromUnknown(value: unknown, preferredType: GraphValue['type'] = 'Any'): GraphValue {
  if (preferredType === 'asset') {
    return { type: 'asset', value: value as AssetRef };
  }

  if (typeof value === 'boolean') {
    return { type: 'bool', value: value ? 1 : 0 };
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? { type: 'number', value } : { type: 'floatingPoint', value };
  }

  if (typeof value === 'string') {
    if (preferredType === 'URL') {
      return { type: 'URL', value };
    }

    if (preferredType === 'JSON') {
      return { type: 'JSON', value };
    }

    return { type: 'string', value };
  }

  if (Array.isArray(value)) {
    return { type: 'data', value };
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return {
      type: 'dict',
      value: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          graphValueFromUnknown(entry),
        ]),
      ),
    };
  }

  return { type: preferredType, value } as GraphValue;
}

function isGraphValue(value: unknown): value is GraphValue {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'type' in value &&
    'value' in value &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function dictValue(entries: Record<string, GraphValue | string | number | boolean | null | undefined>): GraphValue {
  return {
    type: 'dict',
    value: Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [
        key,
        value && typeof value === 'object' && 'type' in value
          ? value as GraphValue
          : graphValueFromUnknown(value),
      ]),
    ),
  };
}

function plainValue(value: GraphValue | undefined): unknown {
  if (!value) {
    return undefined;
  }

  if (!isGraphValue(value)) {
    return value;
  }

  if (value.type === 'dict' && typeof value.value === 'object' && value.value !== null) {
    return Object.fromEntries(
      Object.entries(value.value).map(([key, entry]) => [key, plainValue(entry as GraphValue | undefined)]),
    );
  }

  if (value.type === 'data' && Array.isArray(value.value)) {
    return value.value.map((entry) => plainValue(isGraphValue(entry) ? entry : graphValueFromUnknown(entry)));
  }

  return value.value;
}

function coerceRemoteValue(raw: unknown, outputDataType: GraphValue['type']): GraphValue {
  switch (outputDataType) {
    case 'string':
    case 'URL':
    case 'JSON':
      return { type: outputDataType, value: typeof raw === 'string' ? raw : JSON.stringify(raw) } as GraphValue;
    case 'dict':
      return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? graphValueFromUnknown(raw, 'dict')
        : { type: 'dict', value: {} };
    case 'number': {
      const numeric = Number(raw);
      return { type: 'number', value: Number.isFinite(numeric) ? Math.trunc(numeric) : 0 };
    }
    case 'floatingPoint': {
      const numeric = Number(raw);
      return { type: 'floatingPoint', value: Number.isFinite(numeric) ? numeric : 0 };
    }
    case 'bool':
      return { type: 'bool', value: raw ? 1 : 0 };
    case 'Any':
    case 'data':
    default:
      return { type: outputDataType, value: raw } as GraphValue;
  }
}

async function defaultFetchRemote(request: RemoteRequest): Promise<GraphValue> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), request.timeoutMs);
  const requestUrl = validateRemoteUrl(request.url);

  try {
    const response = await fetch(requestUrl, {
      method: request.method,
      redirect: 'error',
      signal: controller.signal,
      headers: request.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Remote request failed with HTTP ${response.status}`);
    }

    const buffer = await readLimitedResponseBytes(response, request.maxBytes, 'Remote response');
    const text = new TextDecoder().decode(buffer);
    const contentType = response.headers.get('content-type') ?? '';
    const raw = request.outputDataType === 'JSON' || request.outputDataType === 'dict' || contentType.includes('json')
      ? JSON.parse(text || 'null')
      : text;

    return coerceRemoteValue(raw, request.outputDataType);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function defaultResolveAsset(request: AssetRequest): Promise<AssetRef> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), request.timeoutMs);
  const requestUrl = validateRemoteUrl(request.url);

  try {
    const response = await fetch(requestUrl, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Remote asset request failed with HTTP ${response.status}`);
    }

    const bytes = await readLimitedResponseBytes(response, request.maxBytes, 'Remote asset');
    return {
      source: 'remote',
      kind: request.kind,
      mimeType: response.headers.get('content-type')?.split(';')[0]?.trim() || `${request.kind}/*`,
      url: requestUrl,
      sizeBytes: bytes.byteLength,
      cacheKey: requestUrl,
    };
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function systemData(mode: Extract<GraphVmInstruction, { op: 'SYSTEM_DATA' }>['mode']): GraphValue {
  const now = new Date();
  switch (mode) {
    case 'EPOCH_SECONDS':
      return { type: 'number', value: Math.floor(now.getTime() / 1000) };
    case 'ISO_DATE':
      return { type: 'string', value: now.toISOString() };
    case 'TIMEZONE_OFFSET_MINUTES':
      return { type: 'number', value: now.getTimezoneOffset() };
    case 'LOCALE_DATE':
      return { type: 'string', value: now.toLocaleDateString() };
    case 'LOCALE_TIME':
      return { type: 'string', value: now.toLocaleTimeString() };
    case 'NOW_MS':
    default:
      return { type: 'number', value: now.getTime() };
  }
}

async function defaultUserInteraction(request: UserInteractionRequest): Promise<GraphValue> {
  return dictValue({
    ok: false,
    cancelled: true,
    value: null,
    source: 'unavailable',
    error: `User interaction "${request.kind}" is unavailable in this runtime`,
  });
}

async function defaultDisplay(request: DisplayRequest): Promise<GraphValue> {
  return dictValue({
    ok: false,
    completed: false,
    cancelled: true,
    stoppedAtSeconds: 0,
    durationSeconds: 0,
    watchedPercent: 0,
    reason: 'unavailable',
    error: `Display "${request.type}" is unavailable in this runtime`,
  });
}

async function defaultOverlayControl(request: OverlayControlRequest): Promise<GraphValue> {
  return dictValue({
    ok: false,
    active: false,
    action: request.action,
    reason: 'unavailable',
    error: 'Overlay control is unavailable in this runtime',
  });
}

async function defaultOverlayDraw(): Promise<GraphValue> {
  return dictValue({
    ok: false,
    active: false,
    reason: 'unavailable',
    error: 'Overlay drawing is unavailable in this runtime',
  });
}

function truthy(value: GraphValue | undefined): boolean {
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

  if (Array.isArray(value.value)) {
    return value.value.length > 0;
  }

  return value.value !== null && value.value !== undefined;
}

function asString(value: GraphValue | undefined): string {
  if (!value) {
    return '';
  }

  if (typeof value.value === 'string') {
    return value.value;
  }

  if (typeof value.value === 'number') {
    return String(value.value);
  }

  if (Array.isArray(value.value)) {
    return value.value.join(',');
  }

  return JSON.stringify(value.value);
}

function numericValues(value: GraphValue | undefined): number[] {
  if (!value) {
    return [];
  }

  if (typeof value.value === 'number') {
    return Number.isFinite(value.value) ? [value.value] : [];
  }

  if (Array.isArray(value.value)) {
    return value.value.map((entry) => Number(entry)).filter(Number.isFinite);
  }

  if (typeof value.value === 'string') {
    return Array.from(value.value, (character) => character.charCodeAt(0));
  }

  if (value.type === 'data' && Array.isArray(value.value)) {
    return value.value.map((entry) => Number(entry)).filter(Number.isFinite);
  }

  const parsed = Number.parseFloat(asString(value));
  return Number.isFinite(parsed) ? [parsed] : [];
}

function asNumber(value: GraphValue | undefined): number {
  return numericValues(value)[0] ?? 0;
}

function getValue(state: VmState, key?: string): GraphValue | undefined {
  return key ? state.values.get(key) : undefined;
}

function setValue(state: VmState, key: string, value: GraphValue, limit: number): void {
  if (bytes(value) > limit) {
    state.issues.push(issue(`Value for ${key} exceeded the VM value size limit`));
    return;
  }

  state.values.set(key, value);
}

function setAssetValue(state: VmState, key: string, value: GraphValue, maxBytes: number): void {
  const asset = value.type === 'asset' ? value.value : null;
  const assetSize = asset?.sizeBytes ?? (
    asset?.dataBase64 ? Math.ceil((asset.dataBase64.length * 3) / 4) : 0
  );
  if (assetSize > maxBytes) {
    state.issues.push(issue(`Asset for ${key} exceeded the configured byte limit`));
    return;
  }

  state.values.set(key, value);
}

function parseVariableOrLiteral(state: VmState, raw: string): GraphValue {
  const trimmed = raw.trim();
  const parsedNumber = Number.parseFloat(trimmed);
  if (trimmed && Number.isFinite(parsedNumber) && String(parsedNumber) === trimmed) {
    return { type: Number.isInteger(parsedNumber) ? 'number' : 'floatingPoint', value: parsedNumber } as GraphValue;
  }

  if (!trimmed) {
    return { type: 'number', value: 0 };
  }

  if (trimmed.startsWith('_')) {
    const local = state.locals.get(trimmed);
    if (local) {
      return local;
    }

    const initialized: GraphValue = { type: 'number', value: 0 };
    state.locals.set(trimmed, initialized);
    return initialized;
  }

  const global = state.globals.get(trimmed);
  if (global) {
    return global;
  }

  if (!trimmed.startsWith('$')) {
    const dollarGlobal = state.globals.get(`$${trimmed}`);
    if (dollarGlobal) {
      return dollarGlobal;
    }
  }

  const initialized: GraphValue = { type: 'number', value: 0 };
  state.globals.set(trimmed, initialized);
  return initialized;
}

function resolveFallbackValue(state: VmState, fallbackValue: GraphValue, fallbackRaw?: string): GraphValue {
  const singleVariable = fallbackHasSingleVariableReference(fallbackRaw);
  if (singleVariable) {
    return lookupVariable(state, singleVariable) ?? fallbackValue;
  }

  if (fallbackValue.type === 'string' && fallbackRaw !== undefined) {
    return { type: 'string', value: resolveFallbackText(state, fallbackRaw) };
  }

  const trimmed = fallbackRaw?.trim();
  if (trimmed?.startsWith('_')) {
    return parseVariableOrLiteral(state, trimmed);
  }

  return fallbackValue;
}

function lookupVariable(state: VmState, token: string): GraphValue | undefined {
  if (token.startsWith('_')) {
    return state.locals.get(token);
  }

  return state.globals.get(token) ?? (!token.startsWith('$') ? state.globals.get(`$${token}`) : undefined);
}

function resolveNamedVariableText(state: VmState, text: string, resolveNumeric?: (index: number, token: string) => string | undefined): string {
  return resolveVariableText(text, {
    resolveNamed: (token) => asString(lookupVariable(state, token) ?? lookupVariable(state, token.slice(1))),
    resolveNumeric,
  });
}

function resolveFallbackText(state: VmState, text: string): string {
  return resolveNamedVariableText(state, text);
}

function fallbackHasSingleVariableReference(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }

  const references = extractVariableReferences(trimmed);
  return references.length === 1 && references[0].kind === 'named' && references[0].token === trimmed
    ? references[0].token
    : null;
}

function applySubstitutionTemplate(template: string, inputs: Array<GraphValue | undefined>, state: VmState): string {
  return resolveNamedVariableText(state, template, (index) => asString(inputs[index - 1]));
}

function eventDict(event: OverlayRuntimeEvent | undefined, inputUrl: string): GraphValue {
  if (!event) {
    return dictValue({ kind: 'none', url: inputUrl });
  }

  return graphValueFromUnknown({ ...event, url: 'url' in event && event.url ? event.url : inputUrl }, 'dict');
}

function defaultSourceValue(source: string, inputUrl: string, event?: OverlayRuntimeEvent): GraphValue {
  switch (source) {
    case 'url':
    case 'linkUrl':
      return { type: 'URL', value: inputUrl };
    case 'triggered':
      return { type: 'bool', value: event?.kind === 'trigger' ? 1 : 0 };
    case 'event':
      return eventDict(event, inputUrl);
    case 'keyboardKey':
      return { type: 'string', value: event?.kind === 'keyboard' ? event.key : '' };
    case 'keyboardCode':
      return { type: 'string', value: event?.kind === 'keyboard' ? event.code : '' };
    case 'keyboardCodePoint':
      return { type: 'number', value: event?.kind === 'keyboard' && event.key.length > 0 ? event.key.charCodeAt(0) : 0 };
    case 'keyboardEvent':
      return eventDict(event?.kind === 'keyboard' ? event : undefined, inputUrl);
    case 'mouseEvent':
      return eventDict(event?.kind === 'mouse' ? event : undefined, inputUrl);
    case 'mouseKind':
      return { type: 'string', value: event?.kind === 'mouse' ? event.eventType : '' };
    case 'mouseButton':
      return { type: 'number', value: event?.kind === 'mouse' ? event.button : 0 };
    case 'mouseX':
      return { type: 'number', value: event?.kind === 'mouse' ? event.x : -1 };
    case 'mouseY':
      return { type: 'number', value: event?.kind === 'mouse' ? event.y : -1 };
    case 'tick':
      return { type: 'number', value: event?.kind === 'tick' ? event.tick : 0 };
    case 'deltaMs':
      return { type: 'number', value: event?.kind === 'tick' ? event.deltaMs : 0 };
    case 'tickEvent':
      return eventDict(event?.kind === 'tick' ? event : undefined, inputUrl);
    case 'pageMetadata':
    case 'mediaData':
    case 'jsMetadata':
      return { type: 'dict', value: {} };
    case 'secondsOnPage':
      return { type: 'number', value: 0 };
    case 'pageLinks':
    case 'consoleOutput':
      return { type: 'data', value: [] };
    default:
      return { type: 'string', value: '' };
  }
}

function numericPayload(value: GraphValue | undefined): number | number[] {
  const numbers = numericValues(value);
  if (numbers.length === 0) {
    return 0;
  }

  return numbers.length === 1 ? numbers[0] : numbers;
}

function applyNumericOperation(
  left: number | number[],
  right: number | number[],
  operation: Extract<GraphVmInstruction, { op: 'MATH' }>['operation'],
): number | number[] {
  const calculate = (leftValue: number, rightValue: number): number =>
    operation === 'SUBTRACT'
      ? leftValue - rightValue
      : operation === 'MULTIPLY'
        ? leftValue * rightValue
        : operation === 'DIVIDE'
          ? rightValue === 0
            ? 0
            : leftValue / rightValue
          : operation === 'MODULO'
            ? rightValue === 0
              ? 0
              : leftValue % rightValue
            : leftValue + rightValue;

  if (Array.isArray(left) || Array.isArray(right)) {
    const leftValues = Array.isArray(left) ? left : [left];
    const rightValues = Array.isArray(right) ? right : [right];
    const count = Math.max(leftValues.length, rightValues.length);
    return Array.from({ length: count }, (_, index) => calculate(leftValues[index] ?? 0, rightValues[index] ?? rightValues[0] ?? 0));
  }

  return calculate(left, right);
}

/**
 * cleanupStringCodes intentionally whitelists printable ASCII (32-126) and
 * selected extended-Latin characters (128-255). It silently drops control
 * characters, emoji, and most Unicode code points. This is a deliberate
 * safety boundary for NUMBER_TO_STRING and DATA_TO_STRING conversions; if you
 * need broader Unicode support, extend this whitelist or add a new convert mode.
 */
function cleanupStringCodes(values: number[]): number[] {
  return values
    .map((value) => Math.trunc(value))
    .filter(
      (value) =>
        (value >= 32 && value <= 126) ||
        (value >= 128 && value <= 140) ||
        value === 142 ||
        (value >= 145 && value <= 255),
    );
}

function numberValuesToString(values: number[], ord: boolean): string {
  const codes = ord
    ? values.flatMap((value) => Array.from(String(Math.trunc(value)), (character) => character.charCodeAt(0)))
    : values;

  return `${String.fromCharCode(...cleanupStringCodes(codes))}\0`;
}

function graphList(value: GraphValue | undefined): unknown[] {
  if (!value) {
    return [];
  }

  if (value.type === 'data' && Array.isArray(value.value)) {
    return value.value;
  }

  if (Array.isArray(value.value)) {
    return value.value;
  }

  return [];
}

function graphDictEntries(value: GraphValue | undefined): Record<string, GraphValue> {
  if (value?.type !== 'dict' || typeof value.value !== 'object' || value.value === null || Array.isArray(value.value)) {
    return {};
  }

  return value.value;
}

function applyTextTransform(input: string, mode: Extract<GraphVmInstruction, { op: 'TEXT_TRANSFORM' }>['mode']): string {
  switch (mode) {
    case 'COLLAPSE_WHITESPACE':
      return input.replace(/\s+/g, ' ').trim();
    case 'NORMALIZE_LINE_ENDINGS':
      return input.replace(/\r\n?/g, '\n');
    case 'STRIP_CONTROL_CHARS':
      return input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    case 'UPPERCASE':
      return input.toUpperCase();
    case 'LOWERCASE':
      return input.toLowerCase();
    case 'TITLE_CASE':
      return input.toLowerCase().replace(/\b[\p{L}\p{N}]/gu, (character) => character.toUpperCase());
    case 'URL_ENCODE':
      return encodeURIComponent(input);
    case 'URL_DECODE':
      try {
        return decodeURIComponent(input);
      } catch {
        return input;
      }
    case 'TRIM':
    default:
      return input.trim();
  }
}

function splitText(input: string, mode: Extract<GraphVmInstruction, { op: 'TEXT_SPLIT_JOIN' }>['mode'], separator: string): string[] {
  switch (mode) {
    case 'SPLIT_WHITESPACE':
      return input.trim() ? input.trim().split(/\s+/g) : [];
    case 'SPLIT_COMMA':
      return input.split(',').map((entry) => entry.trim()).filter(Boolean);
    case 'SPLIT_CUSTOM':
      return separator ? input.split(separator) : [input];
    case 'SPLIT_LINES':
    default:
      return input.replace(/\r\n?/g, '\n').split('\n');
  }
}

function joinText(value: GraphValue | undefined, mode: Extract<GraphVmInstruction, { op: 'TEXT_SPLIT_JOIN' }>['mode'], separator: string): string {
  const list = graphList(value).map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry));
  const glue = mode === 'JOIN_LINES'
    ? '\n'
    : mode === 'JOIN_SPACE'
      ? ' '
      : mode === 'JOIN_COMMA'
        ? ', '
        : separator;
  return list.join(glue);
}

function urlPartsValue(url: URL): GraphValue {
  return dictValue({
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    host: url.host,
    hostname: url.hostname,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    params: {
      type: 'dict',
      value: Object.fromEntries(Array.from(url.searchParams.entries()).map(([key, value]) => [key, { type: 'string', value }])),
    },
  });
}

function urlFromParts(value: GraphValue | undefined): URL {
  if (typeof value?.value === 'string') {
    return new URL(value.value);
  }

  const dict = graphDictEntries(value);
  const href = dict.href ? asString(dict.href) : '';
  if (href) {
    return new URL(href);
  }

  const origin = dict.origin ? asString(dict.origin) : 'https://example.com';
  const pathname = dict.pathname ? asString(dict.pathname) : '/';
  const url = new URL(pathname, origin);
  const params = graphDictEntries(dict.params);
  Object.entries(params).forEach(([key, entry]) => {
    url.searchParams.set(key, asString(entry));
  });
  if (dict.hash) {
    url.hash = asString(dict.hash);
  }
  return url;
}

function sortUrlSearchParams(url: URL): void {
  const entries = Array.from(url.searchParams.entries()).sort(([left], [right]) => left.localeCompare(right));
  url.search = '';
  entries.forEach(([key, value]) => url.searchParams.append(key, value));
}

function parseParamList(raw: string): string[] {
  return raw.split(/[,\s]+/g).map((entry) => entry.trim()).filter(Boolean);
}

function plainObject(value: unknown): Record<string, unknown> {
  if (isGraphValue(value)) {
    return plainObject(plainValue(value));
  }

  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function pointPart(value: unknown, key: 'x' | 'y'): number {
  const entry = plainObject(value)[key];
  if (isGraphValue(entry)) {
    return asNumber(entry);
  }
  const numeric = Number(entry);
  return Number.isFinite(numeric) ? numeric : 0;
}

function samePoint(left: unknown, right: unknown): boolean {
  return pointPart(left, 'x') === pointPart(right, 'x') && pointPart(left, 'y') === pointPart(right, 'y');
}

function enabledValue(state: VmState, key?: string): boolean {
  return key === undefined ? true : truthy(getValue(state, key));
}

function eventInstructions(pack: CompiledActionPackV2, handler: GraphEventHandler): GraphVmInstruction[] {
  const handlerInstructions = pack.vm.eventHandlers?.[handler];
  if (handlerInstructions) {
    return handlerInstructions;
  }

  return handler === 'trigger' ? pack.vm.instructions : [];
}

async function executeInstructionList(
  instructions: GraphVmInstruction[],
  program: GraphVmProgram,
  state: VmState,
  runtime: GraphRuntime,
  pack: CompiledActionPackV2,
  settings: GlobalSettings,
  inputUrl: string,
  event: OverlayRuntimeEvent | undefined,
): Promise<void> {
  const stepBudget = effectiveVmInstructionLimit(settings, program.stepBudget);
  for (const [index, instruction] of instructions.entries()) {
    if (instruction.guard) {
      const expected = instruction.guardExpected === 1;
      if (truthy(getValue(state, instruction.guard)) !== expected) {
        continue;
      }
    }

    if (index >= stepBudget) {
      state.issues.push(issue('VM step budget exceeded; pack execution was aborted'));
      break;
    }

    const issueCount = state.issues.length;
    await executeInstruction(instruction, state, runtime, pack, program, settings, inputUrl, event);
    if (state.aborted || (state.issues.length > issueCount && program.safety.abortOnFailure)) {
      break;
    }
  }
}

async function executeInstruction(
  instruction: GraphVmInstruction,
  state: VmState,
  runtime: GraphRuntime,
  pack: CompiledActionPackV2,
  program: GraphVmProgram,
  settings: GlobalSettings,
  inputUrl: string,
  event: OverlayRuntimeEvent | undefined,
): Promise<void> {
  switch (instruction.op) {
    case 'SOURCE': {
      const external = await runtime.readSource?.(instruction.source);
      const value = external ?? defaultSourceValue(instruction.source, inputUrl, event);
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, `Read ${instruction.source}`, value);
      break;
    }
    case 'CONSTANT': {
      setValue(state, instruction.output, instruction.value, program.valueByteLimit);
      trace(state, instruction, 'Loaded constant', instruction.value);
      break;
    }
    case 'REGEX_TRANSFORM': {
      const source = getValue(state, instruction.input);
      const input = asString(source);
      const rawPayload = instruction.payloadInput
        ? asString(getValue(state, instruction.payloadInput))
        : resolveNamedVariableText(state, instruction.payload, (_index, token) => token);
      let payload = instruction.payloadVars
        ? rawPayload.replaceAll('{date}', new Date().toISOString())
        : rawPayload.replace(/\$/g, '$$$$');
      if (instruction.payloadVars && payload.includes('{clipboard}')) {
        payload = payload.replaceAll('{clipboard}', (await runtime.readClipboard()).replace(/\$/g, '$$$$'));
      }
      const transformed = await runtime.regex.transform({
        input,
        pattern: instruction.pattern,
        matchMode: instruction.matchMode,
        action: instruction.action,
        replacement: payload,
        nthOccurrence: instruction.nthOccurrence,
      });
      const value = graphValueFromUnknown(transformed.result, source?.type === 'URL' ? 'URL' : 'string');
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, transformed.matched ? 'Regex matched' : 'Regex did not match', value);
      break;
    }
    case 'FETCH_GET': {
      const requestUrl = validateRemoteUrl(instruction.url ? asString(getValue(state, instruction.url)) : instruction.fallbackUrl);
      const fetcher = runtime.fetchRemote ?? defaultFetchRemote;
      const value = await fetcher({
        url: requestUrl,
        method: 'GET',
        outputDataType: instruction.outputDataType,
        timeoutMs: instruction.timeoutMs,
        maxBytes: instruction.maxBytes,
      });
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Fetched remote data', value);
      break;
    }
    case 'HTTP_REQUEST': {
      const requestUrl = validateRemoteUrl(instruction.url ? asString(getValue(state, instruction.url)) : instruction.fallbackUrl);
      const fetcher = runtime.fetchRemote ?? defaultFetchRemote;
      const value = await fetcher({
        url: requestUrl,
        method: instruction.method,
        body: plainValue(getValue(state, instruction.body)),
        outputDataType: instruction.outputDataType,
        timeoutMs: instruction.timeoutMs,
        maxBytes: instruction.maxBytes,
      });
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, `${instruction.method} remote data`, value);
      break;
    }
    case 'SYSTEM_DATA': {
      const value = systemData(instruction.mode);
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, `Read ${instruction.mode}`, value);
      break;
    }
    case 'USER_INTERACTION': {
      const message = instruction.messageInput
        ? asString(getValue(state, instruction.messageInput))
        : resolveFallbackText(state, instruction.message || 'URL Alchemist needs input');
      const value = await (runtime.requestUserInteraction ?? defaultUserInteraction)({
        kind: instruction.interaction,
        message,
        placeholder: instruction.placeholder,
        defaultValue: instruction.defaultValue,
        minValue: instruction.minValue,
        maxValue: instruction.maxValue,
      });
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'User interaction completed', value);
      break;
    }
    case 'GET_ASSET': {
      const requestUrl = instruction.url ? asString(getValue(state, instruction.url)) : instruction.fallbackUrl;
      const value: GraphValue = instruction.embedded
        ? {
            type: 'asset',
            value: instruction.embedded.source === 'resource'
              ? await (runtime.resolveStoredAsset?.(instruction.embedded) ?? Promise.resolve(instruction.embedded))
              : instruction.embedded,
          }
        : {
            type: 'asset',
            value: await (runtime.resolveAsset ?? defaultResolveAsset)({
              url: validateRemoteUrl(requestUrl),
              kind: instruction.kind,
              timeoutMs: instruction.timeoutMs,
              maxBytes: instruction.maxBytes,
            }),
          };
      setAssetValue(state, instruction.output, value, instruction.maxBytes);
      trace(state, instruction, instruction.embedded ? 'Loaded embedded asset' : 'Resolved remote asset', value);
      break;
    }
    case 'DISPLAY': {
      const title = instruction.titleInput ? asString(getValue(state, instruction.titleInput)) : instruction.title ? resolveFallbackText(state, instruction.title) : undefined;
      const message = instruction.input ? asString(getValue(state, instruction.input)) : resolveFallbackText(state, instruction.message);
      const assetValue = instruction.asset ? getValue(state, instruction.asset) : undefined;
      const value = await (runtime.displayOverlay ?? defaultDisplay)({
        type: instruction.displayType,
        title,
        message,
        mode: instruction.mode,
        stopMode: instruction.stopMode,
        timeoutMs: instruction.timeoutMs,
        asset: assetValue?.type === 'asset' ? assetValue.value : undefined,
        captureKeyboard: instruction.captureKeyboard,
        captureMouse: instruction.captureMouse,
      });
      if (instruction.output) {
        setValue(state, instruction.output, value, program.valueByteLimit);
      }
      trace(state, instruction, 'Display completed', value);
      break;
    }
    case 'COMPARE': {
      const source = getValue(state, instruction.input);
      const compareRaw = instruction.compareValue.trim();
      const parsedRight = Number.parseFloat(compareRaw);
      const compareAsNumber =
        compareRaw.startsWith('$') ||
        compareRaw.startsWith('_') ||
        (compareRaw !== '' && Number.isFinite(parsedRight) && String(parsedRight) === compareRaw);
      const matched = compareAsNumber
        ? (() => {
            const left = asNumber(source);
            const right = asNumber(parseVariableOrLiteral(state, compareRaw));
            return instruction.operator === 'LT'
              ? left < right
              : instruction.operator === 'LTE'
                ? left <= right
                : instruction.operator === 'NEQ'
                  ? left !== right
                  : instruction.operator === 'GT'
                    ? left > right
                    : instruction.operator === 'GTE'
                      ? left >= right
                      : left === right;
          })()
        : (() => {
            const left = asString(source);
            const right = compareRaw.startsWith('$') || compareRaw.startsWith('_')
              ? asString(parseVariableOrLiteral(state, compareRaw))
              : compareRaw;
            return instruction.operator === 'LT'
              ? left < right
              : instruction.operator === 'LTE'
                ? left <= right
                : instruction.operator === 'NEQ'
                  ? left !== right
                  : instruction.operator === 'GT'
                    ? left > right
                    : instruction.operator === 'GTE'
                      ? left >= right
                      : left === right;
          })();
      const value: GraphValue = instruction.booleanOutput
        ? { type: 'bool', value: matched ? 1 : 0 }
        : { type: 'number', value: matched ? asNumber(source) : 0 };
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Compared value', value);
      break;
    }
    case 'MATH': {
      const left = instruction.left ? numericPayload(getValue(state, instruction.left)) : numericPayload(parseVariableOrLiteral(state, instruction.fallbackLeft));
      const right = instruction.right ? numericPayload(getValue(state, instruction.right)) : numericPayload(parseVariableOrLiteral(state, instruction.fallbackRight));
      const result = applyNumericOperation(left, right, instruction.operation);
      const value: GraphValue = Array.isArray(result)
        ? { type: 'number', value: result }
        : { type: Number.isInteger(result) ? 'number' : 'floatingPoint', value: result };
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Calculated value', value);
      break;
    }
    case 'CONVERT': {
      const source = getValue(state, instruction.input);
      let value: GraphValue;

      switch (instruction.mode) {
        case 'FLOAT_TO_NUMBER': {
          const input = asNumber(source);
          const rounded =
            instruction.rounding === 'FLOOR' ? Math.floor(input) : instruction.rounding === 'CEIL' ? Math.ceil(input) : Math.round(input);
          value = { type: 'number', value: rounded };
          break;
        }
        case 'DICT_TO_JSON':
          value = { type: 'JSON', value: JSON.stringify(source?.value ?? {}) };
          break;
        case 'JSON_TO_DICT':
          value = graphValueFromUnknown(JSON.parse(asString(source) || '{}'), 'dict');
          break;
        case 'NUMBER_TO_STRING':
          value = { type: 'string', value: numberValuesToString(numericValues(source), instruction.ord ?? true) };
          break;
        case 'DATA_TO_STRING':
          {
            const values = numericValues(source);
            const allNumericAscii = values.length > 0 && values.every((entry) => entry >= 46 && entry <= 57);
            value = { type: 'string', value: numberValuesToString(values, !allNumericAscii) };
          }
          break;
        case 'STRING_TO_URL':
        default:
          value = { type: 'URL', value: new URL(asString(source)).toString() };
          break;
      }

      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Converted value', value);
      break;
    }
    case 'DECLARE': {
      const rawValue = instruction.value ? getValue(state, instruction.value) : instruction.fallbackValue;
      if (instruction.name.startsWith('_')) {
        state.locals.set(instruction.name, rawValue ?? { type: 'number', value: 0 });
      } else {
        state.globals.set(instruction.name, rawValue ?? { type: 'number', value: 0 });
        if (!instruction.name.startsWith('$')) {
          state.globals.set(`$${instruction.name}`, rawValue ?? { type: 'number', value: 0 });
        }
      }
      trace(state, instruction, `Declared ${instruction.name}`, rawValue);
      break;
    }
    case 'SAVELOAD': {
      const key = instruction.key ? asString(getValue(state, instruction.key)) : resolveFallbackText(state, instruction.fallbackKey);
      if (!key) {
        state.issues.push(issue('SaveLoad block skipped because key is empty', instruction.nodeId));
        break;
      }

      if (instruction.mode === 'SAVE') {
        const value = getValue(state, instruction.value) ?? { type: 'Any', value: null };
        await runtime.saveSessionValue?.(key, value);
        if (instruction.output) {
          setValue(state, instruction.output, { type: 'bool', value: 1 }, program.valueByteLimit);
        }
        trace(state, instruction, `Saved ${key}`, value);
        break;
      }

      const loaded = await runtime.loadSessionValue?.(key);
      const value = instruction.mode === 'EXISTS' ? { type: 'bool', value: loaded ? 1 : 0 } : loaded ?? { type: 'Any', value: null };
      if (instruction.output) {
        setValue(state, instruction.output, value as GraphValue, program.valueByteLimit);
      }
      trace(state, instruction, `Loaded ${key}`, value as GraphValue);
      break;
    }
    case 'DICT_SET': {
      const existing = getValue(state, instruction.dict);
      const fallbackDict = instruction.fallbackDictName ? state.globals.get(instruction.fallbackDictName) : undefined;
      const dictValue = existing?.type === 'dict' ? existing.value : fallbackDict?.type === 'dict' ? fallbackDict.value : {};
      const key = asString(instruction.key ? getValue(state, instruction.key) : graphValueFromUnknown(instruction.fallbackKey));
      const value = getValue(state, instruction.value) ?? { type: 'Any', value: null };
      const next: GraphValue = { type: 'dict', value: { ...dictValue, [key]: value } };
      if (instruction.fallbackDictName) {
        state.globals.set(instruction.fallbackDictName, next);
      }
      setValue(state, instruction.output, next, program.valueByteLimit);
      trace(state, instruction, `Updated dict key ${key}`, next);
      break;
    }
    case 'LOOP': {
      const count = Math.max(1, Math.min(instruction.loopLimit, Math.trunc(asNumber(getValue(state, instruction.count)) || instruction.loopLimit)));
      state.loopSteps += count;
      if (state.loopSteps > program.loopBudget) {
        state.issues.push(issue('Loop budget exceeded; pack execution was aborted', instruction.nodeId));
        return;
      }

      const value = getValue(state, instruction.input) ?? { type: 'Any', value: null };
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, `Looped ${count} time${count === 1 ? '' : 's'}`, value);
      break;
    }
    case 'SLEEP': {
      if (!enabledValue(state, instruction.enabled)) {
        if (instruction.output) {
          setValue(state, instruction.output, { type: 'bool', value: 0 }, program.valueByteLimit);
        }
        trace(state, instruction, 'Sleep skipped');
        break;
      }

      const durationMs = Math.max(0, Math.min(60_000, Math.trunc(instruction.duration ? asNumber(getValue(state, instruction.duration)) : instruction.fallbackMs)));
      await (runtime.sleep ?? ((ms) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms))))(durationMs);
      if (instruction.output) {
        setValue(state, instruction.output, { type: 'bool', value: 1 }, program.valueByteLimit);
      }
      trace(state, instruction, `Slept ${durationMs}ms`);
      break;
    }
    case 'SHARED_STATE': {
      const key = instruction.key ? asString(getValue(state, instruction.key)) : resolveFallbackText(state, instruction.fallbackKey);
      if (!key) {
        state.issues.push(issue('Shared State skipped because key is empty', instruction.nodeId));
        break;
      }
      const fallbackValue = resolveFallbackValue(state, instruction.fallbackValue, instruction.fallbackRaw);

      if (!enabledValue(state, instruction.enabled)) {
        if (instruction.output) {
          setValue(state, instruction.output, instruction.mode === 'EXISTS' ? { type: 'bool', value: 0 } : fallbackValue, program.valueByteLimit);
        }
        trace(state, instruction, `Shared State ${instruction.mode.toLowerCase()} skipped`);
        break;
      }

      if (instruction.mode === 'SET') {
        const value = getValue(state, instruction.value) ?? fallbackValue;
        await runtime.saveSessionValue?.(key, value);
        if (instruction.output) {
          setValue(state, instruction.output, value, program.valueByteLimit);
        }
        trace(state, instruction, `Saved shared state ${key}`, value);
        break;
      }

      if (instruction.mode === 'DELETE') {
        await runtime.deleteSessionValue?.(key);
        if (!runtime.deleteSessionValue) {
          await runtime.saveSessionValue?.(key, { type: 'Any', value: null });
        }
        if (instruction.output) {
          setValue(state, instruction.output, { type: 'bool', value: 1 }, program.valueByteLimit);
        }
        trace(state, instruction, `Deleted shared state ${key}`);
        break;
      }

      const loaded = await runtime.loadSessionValue?.(key);
      const value = instruction.mode === 'EXISTS'
        ? { type: 'bool', value: loaded ? 1 : 0 } as GraphValue
        : loaded ?? fallbackValue;
      if (instruction.output) {
        setValue(state, instruction.output, value, program.valueByteLimit);
      }
      trace(state, instruction, `Loaded shared state ${key}`, value);
      break;
    }
    case 'DICT_GET': {
      const source = getValue(state, instruction.dict);
      const dict = source?.type === 'dict' ? source.value : {};
      const key = instruction.key ? asString(getValue(state, instruction.key)) : instruction.fallbackKey;
      const value = key && Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : instruction.fallbackValue;
      setValue(state, instruction.output, value ?? instruction.fallbackValue, program.valueByteLimit);
      trace(state, instruction, `Read dict key ${key}`, value ?? instruction.fallbackValue);
      break;
    }
    case 'LIST_OP': {
      const list = graphList(getValue(state, instruction.list) ?? instruction.fallbackList);
      const item = getValue(state, instruction.item) ?? instruction.fallbackItem;
      const index = Math.trunc(asNumber(getValue(state, instruction.index)));
      let value: GraphValue;

      switch (instruction.operation) {
        case 'PREPEND':
          value = { type: 'data', value: [plainValue(item), ...list] };
          break;
        case 'DROP_LAST':
          value = { type: 'data', value: list.slice(0, -1) };
          break;
        case 'GET':
          value = graphValueFromUnknown(list[Math.max(0, Math.min(list.length - 1, index))]);
          break;
        case 'LENGTH':
          value = { type: 'number', value: list.length };
          break;
        case 'CONTAINS_POINT':
          value = { type: 'bool', value: list.some((entry) => samePoint(entry, plainValue(item))) ? 1 : 0 };
          break;
        case 'APPEND':
        default:
          value = { type: 'data', value: [...list, plainValue(item)] };
          break;
      }

      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, `List ${instruction.operation.toLowerCase()}`, value);
      break;
    }
    case 'SELECT': {
      const selected = truthy(getValue(state, instruction.condition))
        ? getValue(state, instruction.trueValue) ?? instruction.fallbackTrue
        : getValue(state, instruction.falseValue) ?? instruction.fallbackFalse;
      setValue(state, instruction.output, selected, program.valueByteLimit);
      trace(state, instruction, 'Selected value', selected);
      break;
    }
    case 'BRANCH': {
      const selected = truthy(getValue(state, instruction.condition));
      const value = getValue(state, instruction.input) ?? instruction.fallbackInput;
      setValue(state, selected ? instruction.trueOutput : instruction.falseOutput, value, program.valueByteLimit);
      trace(state, instruction, selected ? 'Selected true branch' : 'Selected false branch', value);
      break;
    }
    case 'CUSTOM_INPUT': {
      const value = state.customInputs.get(instruction.inputId) ?? instruction.fallback;
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, `Read custom input ${instruction.inputId}`, value);
      break;
    }
    case 'CUSTOM_OUTPUT': {
      const value = getValue(state, instruction.value) ?? instruction.fallback;
      state.outputs.set(instruction.outputId, value);
      trace(state, instruction, `Wrote custom output ${instruction.outputId}`, value);
      break;
    }
    case 'CUSTOM_BLOCK': {
      const subState = createVmState(event);
      instruction.outputIds.forEach((outputId) => {
        subState.outputs.delete(outputId);
      });
      Object.entries(instruction.inputDefaults).forEach(([inputId, value]) => {
        subState.customInputs.set(inputId, value);
      });
      Object.entries(instruction.inputSymbols).forEach(([inputId, symbolId]) => {
        const value = getValue(state, symbolId);
        if (value) {
          subState.customInputs.set(inputId, value);
        }
      });
      const nestedInstructions = instruction.program.eventHandlers?.trigger ?? instruction.program.instructions;
      await executeInstructionList(nestedInstructions, instruction.program, subState, runtime, pack, settings, inputUrl, event);
      state.issues.push(...subState.issues);
      state.trace.push(...subState.trace);
      instruction.outputIds.forEach((outputId) => {
        const value = subState.outputs.get(outputId);
        const symbolId = instruction.outputSymbols[outputId];
        if (value && symbolId) {
          setValue(state, symbolId, value, program.valueByteLimit);
        }
      });
      if (subState.aborted) {
        state.aborted = true;
        state.exitCode = subState.exitCode;
      }
      trace(state, instruction, `Ran custom block ${instruction.blockId}`);
      break;
    }
    case 'RANDOM_INT': {
      const min = Math.trunc(instruction.min ? asNumber(getValue(state, instruction.min)) : instruction.fallbackMin);
      const max = Math.trunc(instruction.max ? asNumber(getValue(state, instruction.max)) : instruction.fallbackMax);
      const low = Math.min(min, max);
      const high = Math.max(min, max);
      const value: GraphValue = { type: 'number', value: low + Math.floor(Math.random() * (high - low + 1)) };
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Generated random integer', value);
      break;
    }
    case 'SUBSTITUTE': {
      const inputValues = instruction.values.map((entry) => getValue(state, entry));
      const value: GraphValue = { type: 'string', value: applySubstitutionTemplate(instruction.template, inputValues, state) };
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Applied substitution', value);
      break;
    }
    case 'TEXT_TRANSFORM': {
      const value: GraphValue = { type: 'string', value: applyTextTransform(asString(getValue(state, instruction.input)), instruction.mode) };
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Transformed text', value);
      break;
    }
    case 'TEXT_SPLIT_JOIN': {
      const joining = instruction.mode.startsWith('JOIN_');
      const value: GraphValue = joining
        ? { type: 'string', value: joinText(getValue(state, instruction.input), instruction.mode, instruction.separator) }
        : { type: 'data', value: splitText(asString(getValue(state, instruction.input)), instruction.mode, instruction.separator) };
      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, joining ? 'Joined text' : 'Split text', value);
      break;
    }
    case 'URL_QUERY': {
      const source = getValue(state, instruction.input);
      const key = instruction.key ? asString(getValue(state, instruction.key)) : resolveFallbackText(state, instruction.fallbackKey);
      const rawValue = instruction.value ? asString(getValue(state, instruction.value)) : resolveFallbackText(state, instruction.fallbackValue);
      const url = urlFromParts(source);
      let value: GraphValue;

      switch (instruction.mode) {
        case 'PARSE':
          value = urlPartsValue(url);
          break;
        case 'GET_PARAM':
          value = { type: 'string', value: key ? url.searchParams.get(key) ?? '' : '' };
          break;
        case 'SET_PARAM':
          if (key) {
            url.searchParams.set(key, rawValue);
          }
          value = { type: 'URL', value: url.toString() };
          break;
        case 'DELETE_PARAM':
          if (key) {
            url.searchParams.delete(key);
          }
          value = { type: 'URL', value: url.toString() };
          break;
        case 'KEEP_PARAMS': {
          const keep = new Set(parseParamList(resolveFallbackText(state, instruction.fallbackParams || key)));
          Array.from(url.searchParams.keys()).forEach((param) => {
            if (!keep.has(param)) {
              url.searchParams.delete(param);
            }
          });
          value = { type: 'URL', value: url.toString() };
          break;
        }
        case 'SORT_PARAMS':
          sortUrlSearchParams(url);
          value = { type: 'URL', value: url.toString() };
          break;
        case 'REBUILD':
        default:
          value = { type: 'URL', value: url.toString() };
          break;
      }

      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Updated URL query', value);
      break;
    }
    case 'DICT_OP': {
      const dict = graphDictEntries(getValue(state, instruction.dict));
      const other = graphDictEntries(getValue(state, instruction.other));
      const key = instruction.key ? asString(getValue(state, instruction.key)) : resolveFallbackText(state, instruction.fallbackKey);
      let value: GraphValue;

      switch (instruction.mode) {
        case 'MERGE':
          value = { type: 'dict', value: { ...dict, ...other } };
          break;
        case 'DELETE_KEY': {
          const next = { ...dict };
          delete next[key];
          value = { type: 'dict', value: next };
          break;
        }
        case 'HAS_KEY':
          value = { type: 'bool', value: Object.prototype.hasOwnProperty.call(dict, key) ? 1 : 0 };
          break;
        case 'VALUES':
          value = { type: 'data', value: Object.values(dict).map((entry) => plainValue(entry)) };
          break;
        case 'KEYS':
        default:
          value = { type: 'data', value: Object.keys(dict) };
          break;
      }

      setValue(state, instruction.output, value, program.valueByteLimit);
      trace(state, instruction, 'Updated dictionary', value);
      break;
    }
    case 'CONDITION_OUT': {
      const value: GraphValue = { type: 'bool', value: truthy(getValue(state, instruction.condition)) ? 1 : 0 };
      setValue(state, instruction.output, value, program.valueByteLimit);
      state.outputs.set('condition', value);
      trace(state, instruction, 'Evaluated condition', value);
      break;
    }
    case 'DECISION_OUT': {
      const numeric = numericValues(getValue(state, instruction.decision))[0] ?? 0;
      const decision = Math.max(0, Math.min(2, Math.trunc(numeric)));
      const value: GraphValue = { type: 'number', value: decision };
      setValue(state, instruction.output, value, program.valueByteLimit);
      state.outputs.set('contentBlockerDecision', value);
      trace(state, instruction, 'Evaluated content blocker decision', value);
      break;
    }
    case 'LOG': {
      const message = capLogMessage(instruction.message ? asString(getValue(state, instruction.message)) : resolveFallbackText(state, instruction.fallbackMessage));
      await runtime.writeLog?.({
        severity: instruction.severity,
        message,
        nodeId: instruction.nodeId,
      });
      if (instruction.output) {
        setValue(state, instruction.output, { type: 'bool', value: 1 }, program.valueByteLimit);
      }
      trace(state, instruction, `Logged ${instruction.severity}`, { type: 'string', value: message });
      break;
    }
    case 'ABORT': {
      const shouldAbort = instruction.condition === undefined || truthy(getValue(state, instruction.condition));
      if (instruction.output) {
        setValue(state, instruction.output, { type: 'bool', value: shouldAbort ? 1 : 0 }, program.valueByteLimit);
      }
      if (!shouldAbort) {
        trace(state, instruction, 'Abort skipped');
        break;
      }

      state.aborted = true;
      state.exitCode = 130;
      trace(state, instruction, resolveFallbackText(state, instruction.message || 'Action Pack aborted'));
      break;
    }
    case 'OVERLAY_CONTROL': {
      if (!enabledValue(state, instruction.enabled)) {
        if (instruction.output) {
          setValue(state, instruction.output, dictValue({ ok: true, skipped: true, active: false }), program.valueByteLimit);
        }
        trace(state, instruction, 'Overlay control skipped');
        break;
      }

      const message = instruction.messageInput ? asString(getValue(state, instruction.messageInput)) : resolveFallbackText(state, instruction.message);
      const value = await (runtime.overlayControl ?? defaultOverlayControl)({
        action: instruction.action,
        message,
        width: instruction.width,
        height: instruction.height,
        cellSize: instruction.cellSize,
        tickMs: instruction.tickMs,
        background: instruction.background,
      });
      if (instruction.output) {
        setValue(state, instruction.output, value, program.valueByteLimit);
      }
      trace(state, instruction, `Overlay ${instruction.action.toLowerCase()}`, value);
      break;
    }
    case 'OVERLAY_DRAW': {
      if (!enabledValue(state, instruction.enabled)) {
        if (instruction.output) {
          setValue(state, instruction.output, dictValue({ ok: true, skipped: true }), program.valueByteLimit);
        }
        trace(state, instruction, 'Overlay draw skipped');
        break;
      }

      const text = instruction.text ? getValue(state, instruction.text) : graphValueFromUnknown('');
      const value = await (runtime.overlayDraw ?? defaultOverlayDraw)({
        cells: getValue(state, instruction.cells),
        text,
        width: instruction.width,
        height: instruction.height,
        cellSize: instruction.cellSize,
        background: instruction.background,
      });
      if (instruction.output) {
        setValue(state, instruction.output, value, program.valueByteLimit);
      }
      trace(state, instruction, 'Overlay draw completed', value);
      break;
    }
    case 'OUTPUT': {
      const value = getValue(state, instruction.input);
      if (!value) {
        state.issues.push(issue(`Output ${instruction.destination} had no value`, instruction.nodeId));
        break;
      }

      state.outputs.set(instruction.destination, value);
      if (instruction.destination !== 'url') {
        await runtime.writeDestination?.(instruction.destination, value);
        if (instruction.destination === 'pageText') {
          await runtime.mutatePageText?.(value);
        }
      }
      trace(state, instruction, `Wrote ${instruction.destination}`, value);
      break;
    }
    default:
      break;
  }
}

export async function executeCompiledActionPackV2(
  inputUrl: string,
  pack: CompiledActionPackV2,
  runtime: GraphRuntime,
  settings: GlobalSettings,
  options: GraphExecutionOptions = {},
): Promise<GraphExecutionResult> {
  const event = options.event;
  const state = createVmState(event);

  if (/^file:/i.test(inputUrl) && !settings.allowLocalFiles) {
    return {
      originalUrl: inputUrl,
      finalUrl: inputUrl,
      changed: false,
      appliedPackIds: [],
      issues: [issue('Local file URLs are blocked by global settings')],
      trace: [],
      outputs: {},
      exitCode: 1,
      aborted: false,
    };
  }

  try {
    const instructions = eventInstructions(pack, options.handler ?? 'trigger');
    await executeInstructionList(instructions, pack.vm, state, runtime, pack, settings, inputUrl, event);
  } catch (error) {
    state.issues.push(issue(error instanceof Error ? error.message : 'The compiled graph failed during execution'));
    state.exitCode = 1;
  }

  if (state.exitCode === 0 && state.issues.length > 0) {
    state.exitCode = 1;
  }

  const outputUrl = state.outputs.get('url');
  let finalUrl = outputUrl ? asString(outputUrl) : inputUrl;

  if (finalUrl !== inputUrl) {
    const blocked = blockedNavigationIssue(finalUrl, settings);
    if (blocked) {
      state.issues.push(issue(blocked));
      finalUrl = inputUrl;
    }
  }

  return {
    originalUrl: inputUrl,
    finalUrl,
    changed: finalUrl !== inputUrl,
    appliedPackIds: finalUrl !== inputUrl ? [pack.manifest.id] : [],
    issues: state.issues,
    trace: state.trace,
    outputs: Object.fromEntries(state.outputs),
    exitCode: state.exitCode,
    aborted: state.aborted,
  };
}

export async function evaluateCompiledActionPackCondition(
  inputUrl: string,
  pack: CompiledActionPackV2,
  runtime: GraphRuntime,
  settings: GlobalSettings,
): Promise<{ matched: boolean; issues: EngineIssue[]; trace: GraphTraceEntry[] }> {
  const conditionVm = pack.triggerPlan.conditionVm;
  const conditionOutput = pack.triggerPlan.conditionOutput;
  if (!conditionVm || !conditionOutput) {
    return {
      matched: pack.triggerPlan.type !== 'CONDITIONAL',
      issues: pack.triggerPlan.type === 'CONDITIONAL' ? [issue('Conditional Run is missing its compiled condition program')] : [],
      trace: [],
    };
  }

  const state = createVmState({ kind: 'trigger', url: inputUrl });
  try {
    await executeInstructionList(conditionVm.instructions, conditionVm, state, runtime, pack, settings, inputUrl, { kind: 'trigger', url: inputUrl });
  } catch (error) {
    state.issues.push(issue(error instanceof Error ? error.message : 'Conditional Run check failed'));
  }

  return {
    matched: truthy(state.outputs.get('condition') ?? state.values.get(conditionOutput)),
    issues: state.issues,
    trace: state.trace,
  };
}
