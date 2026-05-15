import { ALLOWED_NAVIGATION_PROTOCOLS } from '../constants';
import type { EngineIssue, GlobalSettings } from '../types';
import type { EngineRuntime } from '../engine/runtime';
import type { CompiledActionPackV2, GraphValue, GraphVmInstruction } from './types';

export interface RemoteRequest {
  url: string;
  method: 'GET' | 'POST';
  body?: unknown;
  outputDataType: GraphValue['type'];
  timeoutMs: number;
  maxBytes: number;
}

export interface GraphRuntime extends EngineRuntime {
  readSource?: (source: string) => Promise<GraphValue | undefined>;
  writeDestination?: (destination: string, value: GraphValue) => Promise<void>;
  loadSessionValue?: (key: string) => Promise<GraphValue | undefined>;
  saveSessionValue?: (key: string, value: GraphValue) => Promise<void>;
  fetchRemote?: (request: RemoteRequest) => Promise<GraphValue>;
}

export interface GraphExecutionResult {
  originalUrl: string;
  finalUrl: string;
  changed: boolean;
  appliedPackIds: string[];
  issues: EngineIssue[];
  trace: GraphTraceEntry[];
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

function bytes(value: GraphValue): number {
  return new TextEncoder().encode(typeof value.value === 'string' ? value.value : JSON.stringify(value.value)).length;
}

function graphValueFromUnknown(value: unknown, preferredType: GraphValue['type'] = 'Any'): GraphValue {
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

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return { type: 'dict', value: value as Record<string, GraphValue> };
  }

  return { type: preferredType, value } as GraphValue;
}

function plainValue(value: GraphValue | undefined): unknown {
  if (!value) {
    return undefined;
  }

  if (value.type === 'dict' && typeof value.value === 'object' && value.value !== null) {
    return Object.fromEntries(
      Object.entries(value.value).map(([key, entry]) => [key, plainValue(entry as GraphValue)]),
    );
  }

  return value.value;
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local')) {
    return true;
  }

  if (normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return true;
  }

  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) {
    return false;
  }

  const octets = ipv4.slice(1).map((entry) => Number.parseInt(entry, 10));
  if (octets.some((entry) => entry < 0 || entry > 255)) {
    return true;
  }

  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function validateRemoteUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Remote data URL must be a valid absolute URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Remote data blocks only allow HTTPS URLs');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Remote data URLs cannot include credentials');
  }

  if (isPrivateOrLocalHost(parsed.hostname)) {
    throw new Error('Remote data blocks cannot access local or private network hosts');
  }

  return parsed.toString();
}

function coerceRemoteValue(raw: unknown, outputDataType: GraphValue['type']): GraphValue {
  switch (outputDataType) {
    case 'string':
    case 'URL':
    case 'JSON':
      return { type: outputDataType, value: typeof raw === 'string' ? raw : JSON.stringify(raw) } as GraphValue;
    case 'dict':
      return { type: 'dict', value: typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw as Record<string, GraphValue> : {} };
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

  try {
    const response = await fetch(request.url, {
      method: request.method,
      redirect: 'error',
      signal: controller.signal,
      headers: request.method === 'POST' ? { 'content-type': 'application/json' } : undefined,
      body: request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Remote request failed with HTTP ${response.status}`);
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > request.maxBytes) {
      throw new Error('Remote response exceeded the configured byte limit');
    }

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

  const initialized: GraphValue = { type: 'number', value: 0 };
  state.globals.set(trimmed, initialized);
  return initialized;
}

function defaultSourceValue(source: string, inputUrl: string): GraphValue {
  switch (source) {
    case 'url':
    case 'linkUrl':
      return { type: 'URL', value: inputUrl };
    case 'pageMetadata':
    case 'mediaData':
    case 'jsMetadata':
      return { type: 'dict', value: {} };
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

async function executeInstruction(
  instruction: GraphVmInstruction,
  state: VmState,
  runtime: GraphRuntime,
  pack: CompiledActionPackV2,
  inputUrl: string,
): Promise<void> {
  switch (instruction.op) {
    case 'SOURCE': {
      const external = await runtime.readSource?.(instruction.source);
      const value = external ?? defaultSourceValue(instruction.source, inputUrl);
      setValue(state, instruction.output, value, pack.vm.valueByteLimit);
      trace(state, instruction, `Read ${instruction.source}`, value);
      break;
    }
    case 'REGEX_TRANSFORM': {
      const source = getValue(state, instruction.input);
      const input = asString(source);
      const rawPayload = instruction.payloadInput ? asString(getValue(state, instruction.payloadInput)) : instruction.payload;
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
      setValue(state, instruction.output, value, pack.vm.valueByteLimit);
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
      setValue(state, instruction.output, value, pack.vm.valueByteLimit);
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
      setValue(state, instruction.output, value, pack.vm.valueByteLimit);
      trace(state, instruction, `${instruction.method} remote data`, value);
      break;
    }
    case 'COMPARE': {
      const left = asNumber(getValue(state, instruction.input));
      const right = asNumber(parseVariableOrLiteral(state, instruction.compareValue));
      const matched =
        instruction.operator === 'LT'
          ? left < right
          : instruction.operator === 'LTE'
            ? left <= right
            : instruction.operator === 'GT'
              ? left > right
              : instruction.operator === 'GTE'
                ? left >= right
                : left === right;
      const value: GraphValue = instruction.booleanOutput
        ? { type: 'bool', value: matched ? 1 : 0 }
        : { type: 'number', value: matched ? left : 0 };
      setValue(state, instruction.output, value, pack.vm.valueByteLimit);
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
      setValue(state, instruction.output, value, pack.vm.valueByteLimit);
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
          value = { type: 'dict', value: JSON.parse(asString(source) || '{}') };
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

      setValue(state, instruction.output, value, pack.vm.valueByteLimit);
      trace(state, instruction, 'Converted value', value);
      break;
    }
    case 'DECLARE': {
      const rawValue = instruction.value ? getValue(state, instruction.value) : parseVariableOrLiteral(state, instruction.fallbackValue);
      if (instruction.name.startsWith('_')) {
        state.locals.set(instruction.name, rawValue ?? { type: 'number', value: 0 });
      } else {
        state.globals.set(instruction.name, rawValue ?? { type: 'number', value: 0 });
      }
      trace(state, instruction, `Declared ${instruction.name}`, rawValue);
      break;
    }
    case 'SAVELOAD': {
      const key = instruction.key ? asString(getValue(state, instruction.key)) : instruction.fallbackKey;
      if (!key) {
        state.issues.push(issue('SaveLoad block skipped because key is empty', instruction.nodeId));
        break;
      }

      if (instruction.mode === 'SAVE') {
        const value = getValue(state, instruction.value) ?? { type: 'Any', value: null };
        await runtime.saveSessionValue?.(key, value);
        if (instruction.output) {
          setValue(state, instruction.output, { type: 'bool', value: 1 }, pack.vm.valueByteLimit);
        }
        trace(state, instruction, `Saved ${key}`, value);
        break;
      }

      const loaded = await runtime.loadSessionValue?.(key);
      const value = instruction.mode === 'EXISTS' ? { type: 'bool', value: loaded ? 1 : 0 } : loaded ?? { type: 'Any', value: null };
      if (instruction.output) {
        setValue(state, instruction.output, value as GraphValue, pack.vm.valueByteLimit);
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
      setValue(state, instruction.output, next, pack.vm.valueByteLimit);
      trace(state, instruction, `Updated dict key ${key}`, next);
      break;
    }
    case 'LOOP': {
      const count = Math.max(1, Math.min(instruction.loopLimit, Math.trunc(asNumber(getValue(state, instruction.count)) || instruction.loopLimit)));
      state.loopSteps += count;
      if (state.loopSteps > pack.vm.loopBudget) {
        state.issues.push(issue('Loop budget exceeded; pack execution was aborted', instruction.nodeId));
        return;
      }

      const value = getValue(state, instruction.input) ?? { type: 'Any', value: null };
      setValue(state, instruction.output, value, pack.vm.valueByteLimit);
      trace(state, instruction, `Looped ${count} time${count === 1 ? '' : 's'}`, value);
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
): Promise<GraphExecutionResult> {
  const state: VmState = {
    values: new Map(),
    globals: new Map(),
    locals: new Map(),
    loopSteps: 0,
    issues: [],
    trace: [],
    outputs: new Map(),
  };

  if (inputUrl.startsWith('file://') && !settings.allowLocalFiles) {
    return {
      originalUrl: inputUrl,
      finalUrl: inputUrl,
      changed: false,
      appliedPackIds: [],
      issues: [issue('Local file URLs are blocked by global settings')],
      trace: [],
    };
  }

  try {
    for (const [index, instruction] of pack.vm.instructions.entries()) {
      if (index >= pack.vm.stepBudget) {
        state.issues.push(issue('VM step budget exceeded; pack execution was aborted'));
        break;
      }

      const issueCount = state.issues.length;
      await executeInstruction(instruction, state, runtime, pack, inputUrl);
      if (state.issues.length > issueCount && pack.vm.safety.abortOnFailure) {
        break;
      }
    }
  } catch (error) {
    state.issues.push(issue(error instanceof Error ? error.message : 'The compiled graph failed during execution'));
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
  };
}
