import { encode } from '@msgpack/msgpack';
import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS } from '../constants';
import { hexToBytes, sha256Hex } from '../crypto';
import { exportBackupState, importBackupState } from '../backup';
import { effectiveRedirectDepthLimit, effectiveRegexTimeoutMs, normalizeUiScale } from '../hardening';
import { executeRegexJobRequest } from '../regex/executeRegexJob';
import type { ActionPack, RegexTransformRequest } from '../types';
import { getDefaultState } from '../storage';
import { normalizeStoredState } from '../validation';
import { validateCompiledActionPackV2 } from './actionPackValidator';
import { BUNDLED_ACTION_PACK_EXAMPLES, createBundledExampleActionPacks, createBundledExampleWorkspaces } from './bundledExamples';
import { compileWorkspace } from './compiler';
import { createSandboxGraphRuntime } from './sandboxRuntime';
import { ACTION_PACK_SCHEMA_VERSION, LEGACY_ACTION_PACK_SCHEMA_VERSION, type CompiledActionPackV2, type GraphValue } from './types';
import { executeCompiledActionPackV2, type GraphRuntime } from './vm';
import { createEdge, createDefaultWorkspace, createWorkspaceNode, workspaceFromLegacyPack } from './workspace';
import {
  exportCompiledActionPackV2Binary,
  exportWorkspaceBinary,
  ACTION_PACK_MAGIC,
  importAnyArtifact,
  importCompiledActionPackV2Binary,
  importWorkspaceBinary,
} from './vault';

const runtime: GraphRuntime = {
  regex: {
    async test(input, pattern) {
      return executeRegexJobRequest({ kind: 'test', input, pattern }).matched;
    },
    async transform(request: Omit<RegexTransformRequest, 'kind'>) {
      const response = executeRegexJobRequest({ kind: 'transform', ...request });
      return {
        matched: response.matched,
        result: response.result ?? request.input,
      };
    },
  },
  readClipboard: async () => 'clipboard-token',
  readSource: async (source) => (source === 'clipboard' ? { type: 'string', value: 'clipboard-token' } : undefined),
};

const projectRoot = fileURLToPath(new URL('../../../', import.meta.url));

function createLegacyPack(): ActionPack {
  return {
    id: 'legacy-pack',
    name: 'Legacy Pack',
    version: 1,
    enabled: true,
    metadata: {
      created_at: 1,
      author: 'Test',
      description: 'Legacy',
    },
    trigger: {
      type: 'ALWAYS',
      scope_regex: '',
      hotkey: 'Ctrl+Shift+U',
    },
    activities: [
      {
        id: 'activity-1',
        order: 1,
        action: 'REMOVE',
        pattern: 'utm_[^&]+&?',
        match_mode: 'STANDARD',
        nth_occurrence: 1,
        payload: '',
        payload_vars: false,
      },
    ],
  };
}

function createBasicCompiledPack() {
  const workspace = createDefaultWorkspace();
  const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
  const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
  const regex = createWorkspaceNode('RegExpression', { x: 260, y: 120 }, {
    pattern: 'utm_[^&]+&?',
    action: 'REMOVE',
    matchMode: 'STANDARD',
  });
  const compiled = compileWorkspace({
    ...workspace,
    nodes: [...workspace.nodes, regex],
    edges: [
      createEdge(dataIn.id, 'url', regex.id, 'input'),
      createEdge(regex.id, 'result', dataOut.id, 'url'),
    ],
  });

  if (!compiled.ok || !compiled.pack) {
    throw new Error('Test fixture did not compile');
  }

  return compiled.pack;
}

async function encodeActionPackCandidate(candidate: unknown): Promise<Uint8Array> {
  const magicBytes = new TextEncoder().encode(ACTION_PACK_MAGIC);
  const payload = encode(omitUndefinedFields(candidate));
  const checksumBytes = hexToBytes(await sha256Hex(payload));
  const output = new Uint8Array(magicBytes.length + 1 + checksumBytes.length + payload.length);
  output.set(magicBytes, 0);
  output[magicBytes.length] = ACTION_PACK_SCHEMA_VERSION;
  output.set(checksumBytes, magicBytes.length + 1);
  output.set(payload, magicBytes.length + 1 + checksumBytes.length);
  return output;
}

function omitUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitUndefinedFields);
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefinedFields(entry)]),
  );
}

describe('v2 workspace compiler and VM', () => {
  it('blocks build until Data Out is connected', () => {
    const workspace = createDefaultWorkspace();
    const result = compileWorkspace(workspace);

    expect(result.ok).toBe(false);
    expect(result.validation.errors.join(' ')).toContain('Data Out');
  });

  it('compiles a basic URL regex flow and executes it', async () => {
    const result = await executeCompiledActionPackV2(
      'https://example.com/?utm_source=newsletter&keep=1',
      createBasicCompiledPack(),
      runtime,
      DEFAULT_SETTINGS,
    );

    expect(result.finalUrl).toBe('https://example.com/?keep=1');
  });

  it('compiles and executes the generic overlay input block', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const capture = createWorkspaceNode('OverlayInput', { x: 260, y: 80 }, {
      promptMessage: 'Capture test input',
      captureKeyboard: true,
      captureMouse: true,
    });
    const save = createWorkspaceNode('SaveLoad', { x: 520, y: 80 }, {
      literalValue: 'overlay-input:test-result',
    });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 780, y: 80 });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, capture, save, extendedOut],
      edges: [
        createEdge(capture.id, 'result', save.id, 'value'),
        createEdge(save.id, 'result', extendedOut.id, 'fileBlob'),
        createEdge(dataIn.id, 'url', dataOut.id, 'url'),
      ],
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.pack!.risk.reasons).toContain('Overlay input can capture keyboard or mouse while it is open.');
    expect(compiled.pack!.vm.instructions).toContainEqual(expect.objectContaining({
      op: 'DISPLAY',
      displayType: 'input-capture',
      captureKeyboard: true,
      captureMouse: true,
    }));

    const result = await executeCompiledActionPackV2(
      'https://example.com/',
      compiled.pack!,
      {
        ...runtime,
        displayOverlay: async () => ({ type: 'dict', value: { events: { type: 'data', value: [{ type: 'keydown', key: 'ArrowLeft' }] } } }),
      },
      DEFAULT_SETTINGS,
    );

    expect(result.trace.some((entry) => entry.op === 'DISPLAY' && entry.message === 'Display completed')).toBe(true);
  });

  it('marks binary clipboard asset output as requiring clipboard write permission', () => {
    const workspace = createDefaultWorkspace();
    const getImage = createWorkspaceNode('GetImage', { x: 260, y: 80 }, {
      assetDataBase64: 'iVBORw0KGgo=',
      assetKind: 'image',
      assetMimeType: 'image/png',
      assetCompression: 'none',
    });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 520, y: 80 });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, getImage, extendedOut],
      edges: [
        createEdge(getImage.id, 'result', extendedOut.id, 'clipboardBinary'),
      ],
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.pack!.requiredPermissions).toContain('clipboardWrite');
    expect(compiled.pack!.vm.instructions).toContainEqual(expect.objectContaining({
      op: 'OUTPUT',
      destination: 'clipboardBinary',
      dataType: 'asset',
      risk: 'high',
    }));
    expect(validateCompiledActionPackV2(compiled.pack!)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('routes trigger, keyboard, mouse, and tick handlers through shared state', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const onTrigger = createWorkspaceNode('OnTriggerEvent', { x: 260, y: 80 });
    const startOverlay = createWorkspaceNode('OverlayControl', { x: 520, y: 80 }, {
      overlayControlAction: 'START',
      overlayText: 'Event test',
    });
    const keyboard = createWorkspaceNode('KeyboardIn', { x: 260, y: 260 });
    const saveDirection = createWorkspaceNode('SharedState', { x: 520, y: 260 }, {
      sharedStateMode: 'SET',
      literalValue: 'test:direction',
      selectFalseValue: '',
      literalDataType: 'string',
    });
    const mouse = createWorkspaceNode('MouseIn', { x: 260, y: 440 });
    const saveMouse = createWorkspaceNode('SharedState', { x: 520, y: 440 }, {
      sharedStateMode: 'SET',
      literalValue: 'test:last-mouse',
      selectFalseValue: '{}',
      literalDataType: 'dict',
    });
    const tick = createWorkspaceNode('OverlayTickIn', { x: 260, y: 620 });
    const loadDirection = createWorkspaceNode('SharedState', { x: 520, y: 620 }, {
      sharedStateMode: 'GET',
      literalValue: 'test:direction',
      selectFalseValue: 'none',
      literalDataType: 'string',
    });
    const tickReady = createWorkspaceNode('Logical', { x: 520, y: 760 }, {
      operator: 'GTE',
      compareValue: '0',
      booleanOutput: true,
    });
    const saveTickDirection = createWorkspaceNode('SharedState', { x: 780, y: 620 }, {
      sharedStateMode: 'SET',
      literalValue: 'test:tick-direction',
      selectFalseValue: '',
      literalDataType: 'string',
    });
    const compiled = compileWorkspace({
      ...workspace,
      trigger: { ...workspace.trigger, type: 'HOTKEY', hotkey: 'Ctrl+Shift+E' },
      nodes: [...workspace.nodes, onTrigger, startOverlay, keyboard, saveDirection, mouse, saveMouse, tick, loadDirection, tickReady, saveTickDirection],
      edges: [
        createEdge(dataIn.id, 'url', dataOut.id, 'url'),
        createEdge(onTrigger.id, 'triggered', startOverlay.id, 'enabled'),
        createEdge(keyboard.id, 'keyboardKey', saveDirection.id, 'value'),
        createEdge(mouse.id, 'mouseEvent', saveMouse.id, 'value'),
        createEdge(tick.id, 'tick', tickReady.id, 'input'),
        createEdge(loadDirection.id, 'result', saveTickDirection.id, 'value'),
        createEdge(tickReady.id, 'result', saveTickDirection.id, 'enabled'),
      ],
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.pack!.schemaVersion).toBe(ACTION_PACK_SCHEMA_VERSION);
    expect(compiled.pack!.vm.eventHandlers?.trigger?.some((instruction) => instruction.op === 'OVERLAY_CONTROL')).toBe(true);
    expect(compiled.pack!.vm.eventHandlers?.keyboard?.some((instruction) => instruction.op === 'SHARED_STATE')).toBe(true);
    expect(compiled.pack!.vm.eventHandlers?.mouse?.some((instruction) => instruction.op === 'SHARED_STATE')).toBe(true);
    expect(compiled.pack!.vm.eventHandlers?.tick?.some((instruction) => instruction.op === 'SHARED_STATE')).toBe(true);

    const session = new Map<string, import('./types').GraphValue>();
    const eventRuntime: GraphRuntime = {
      ...runtime,
      loadSessionValue: async (key) => session.get(key),
      saveSessionValue: async (key, value) => {
        session.set(key, value);
      },
      deleteSessionValue: async (key) => {
        session.delete(key);
      },
      overlayControl: async () => ({ type: 'dict', value: { ok: { type: 'bool', value: 1 }, active: { type: 'bool', value: 1 } } }),
    };

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, eventRuntime, DEFAULT_SETTINGS, {
      handler: 'trigger',
      event: { kind: 'trigger', hotkey: 'Ctrl+Shift+E', url: 'https://example.com/' },
    });
    expect(session.has('test:direction')).toBe(false);

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, eventRuntime, DEFAULT_SETTINGS, {
      handler: 'keyboard',
      event: { kind: 'keyboard', eventType: 'keydown', key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    });
    expect(session.get('test:direction')).toEqual({ type: 'string', value: 'ArrowUp' });

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, eventRuntime, DEFAULT_SETTINGS, {
      handler: 'mouse',
      event: { kind: 'mouse', eventType: 'pointerdown', button: 0, buttons: 1, x: 12, y: 16 },
    });
    expect(session.get('test:last-mouse')?.type).toBe('dict');

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, eventRuntime, DEFAULT_SETTINGS, {
      handler: 'tick',
      event: { kind: 'tick', tick: 1, deltaMs: 120 },
    });
    expect(session.get('test:tick-direction')).toEqual({ type: 'string', value: 'ArrowUp' });
  });

  it('migrates v4 packs into v5 event handler programs', () => {
    const pack = createBasicCompiledPack();
    const candidate = omitUndefinedFields({
      ...pack,
      schemaVersion: LEGACY_ACTION_PACK_SCHEMA_VERSION,
      vm: {
        ...pack.vm,
        eventHandlers: undefined,
      },
    });
    const result = validateCompiledActionPackV2(candidate);

    expect(result.ok).toBe(true);
    expect(result.ok && result.pack.schemaVersion).toBe(ACTION_PACK_SCHEMA_VERSION);
    expect(result.ok && result.pack.vm.eventHandlers?.trigger).toEqual(result.ok ? result.pack.vm.instructions : []);
  });

  it('rejects malformed imported event handlers', () => {
    const pack = createBasicCompiledPack();
    const result = validateCompiledActionPackV2({
      ...pack,
      vm: {
        ...pack.vm,
        eventHandlers: {
          keyboard: [
            {
              op: 'SHARED_STATE',
              nodeId: 'bad',
              mode: 'SET',
              value: 'missing.symbol',
              fallbackKey: 'bad',
              fallbackValue: { type: 'string', value: '' },
            },
          ],
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.errors.join(' ')).toContain('missing.symbol');
  });

  it('classifies clipboard access as high risk', () => {
    const workspace = createDefaultWorkspace();
    const extendedIn = createWorkspaceNode('ExtendedDataIn', { x: 180, y: 360 });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 560, y: 360 });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, extendedIn, extendedOut],
      edges: [createEdge(extendedIn.id, 'clipboard', extendedOut.id, 'clipboard')],
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.pack!.risk.highest).toBe('high');
    expect(compiled.pack!.risk.usesHighRiskInput).toBe(true);
    expect(compiled.pack!.risk.usesHighRiskOutput).toBe(true);
  });

  it('allows strings into number slots and requires explicit conversion back to string', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const math = createWorkspaceNode('Math', { x: 260, y: 120 }, {
      mathOperation: 'ADD',
      compareValue: '-32',
    });
    const convert = createWorkspaceNode('Convert', { x: 520, y: 120 }, {
      convertMode: 'NUMBER_TO_STRING',
      convertOrd: false,
    });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 780, y: 120 });
    let writtenValue = '';
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, math, convert, extendedOut],
      edges: [
        createEdge(dataIn.id, 'selectedText', math.id, 'left'),
        createEdge(math.id, 'result', convert.id, 'input'),
        createEdge(convert.id, 'result', extendedOut.id, 'pageText'),
      ],
    });

    expect(compiled.ok).toBe(true);

    await executeCompiledActionPackV2(
      'https://example.com/',
      compiled.pack!,
      {
        ...runtime,
        readSource: async (source) => (source === 'selectedText' ? { type: 'string', value: 'abc' } : undefined),
        writeDestination: async (_destination, value) => {
          writtenValue = String(value.value);
        },
      },
      DEFAULT_SETTINGS,
    );

    expect(writtenValue).toBe('ABC\0');
  });

  it('converts a v1 pack into a buildable v2 workspace', () => {
    const workspace = workspaceFromLegacyPack(createLegacyPack());
    const compiled = compileWorkspace(workspace);

    expect(compiled.ok).toBe(true);
    expect(workspace.trigger.type).toBe('INPUT_DATA');
    expect(workspace.trigger.sourceFilters).toEqual([]);
    expect(compiled.pack!.vm.instructions.some((instruction) => instruction.op === 'REGEX_TRANSFORM')).toBe(true);
  });

  it('executes SystemData and page text mutation outputs', async () => {
    const workspace = createDefaultWorkspace();
    const system = createWorkspaceNode('SystemData', { x: 220, y: 80 }, { systemDataMode: 'ISO_DATE' });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 520, y: 80 });
    let mutated = '';
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, system, extendedOut],
      edges: [
        createEdge(system.id, 'result', extendedOut.id, 'pageText'),
      ],
    });

    expect(compiled.ok).toBe(true);
    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      writeDestination: async () => {},
      mutatePageText: async (value) => {
        mutated = String(value.value);
      },
    }, DEFAULT_SETTINGS);

    expect(mutated).toMatch(/T/);
  });

  it('returns cancellation dictionaries from interaction blocks', async () => {
    const workspace = createDefaultWorkspace();
    const prompt = createWorkspaceNode('PromptText', { x: 220, y: 80 }, { promptMessage: 'Name?' });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 520, y: 80 });
    let written: unknown;
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, prompt, extendedOut],
      edges: [
        createEdge(prompt.id, 'result', extendedOut.id, 'fileBlob'),
      ],
    });

    expect(compiled.ok).toBe(true);
    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      requestUserInteraction: async () => ({
        type: 'dict',
        value: {
          ok: { type: 'bool', value: 0 },
          cancelled: { type: 'bool', value: 1 },
          value: { type: 'Any', value: null },
          source: { type: 'string', value: 'test' },
        },
      }),
      writeDestination: async (_destination, value) => {
        written = value.value;
      },
    }, DEFAULT_SETTINGS);

    expect((written as Record<string, { value: unknown }>).cancelled.value).toBe(1);
  });

  it('returns playback details from ShowVideo and validates asset bounds', async () => {
    const workspace = createDefaultWorkspace();
    const video = createWorkspaceNode('GetVideo', { x: 220, y: 80 }, {
      assetUrl: 'https://example.com/video.mp4',
      remoteMaxBytes: 524288,
    });
    const show = createWorkspaceNode('ShowVideo', { x: 520, y: 80 });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 820, y: 80 });
    let written: unknown;
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, video, show, extendedOut],
      edges: [
        createEdge(video.id, 'result', show.id, 'asset'),
        createEdge(show.id, 'result', extendedOut.id, 'fileBlob'),
      ],
    });

    expect(compiled.ok).toBe(true);
    expect(validateCompiledActionPackV2({
      ...compiled.pack!,
      vm: {
        ...compiled.pack!.vm,
        instructions: compiled.pack!.vm.instructions.map((instruction) => instruction.op === 'GET_ASSET' ? { ...instruction, maxBytes: 9999999 } : instruction),
      },
    }).ok).toBe(false);

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      resolveAsset: async (request) => ({
        source: 'remote',
        kind: request.kind,
        mimeType: 'video/mp4',
        url: request.url,
        sizeBytes: 12,
      }),
      displayOverlay: async () => ({
        type: 'dict',
        value: {
          completed: { type: 'bool', value: 0 },
          stoppedAtSeconds: { type: 'number', value: 42 },
          durationSeconds: { type: 'number', value: 100 },
          watchedPercent: { type: 'number', value: 42 },
          reason: { type: 'string', value: 'closed' },
        },
      }),
      writeDestination: async (_destination, value) => {
        written = value.value;
      },
    }, DEFAULT_SETTINGS);

    expect((written as Record<string, { value: unknown }>).stoppedAtSeconds.value).toBe(42);
  });

  it('migrates legacy compiled ALWAYS packs into input-data trigger plans', () => {
    const pack = createBasicCompiledPack();
    const legacy = {
      ...pack,
      schemaVersion: 3,
      manifest: {
        ...pack.manifest,
        trigger: {
          type: 'ALWAYS',
          scope_regex: '^https://example\\.com',
          hotkey: 'Ctrl+Shift+U',
        },
      },
      vm: {
        ...pack.vm,
        safety: undefined,
      },
      triggerPlan: undefined,
    };
    const { triggerPlan: _triggerPlan, ...legacyWithoutPlan } = legacy;
    const legacyVm = { ...legacyWithoutPlan.vm };
    delete (legacyVm as { safety?: unknown }).safety;

    const validation = validateCompiledActionPackV2({
      ...legacyWithoutPlan,
      vm: legacyVm,
    });

    expect(validation.ok).toBe(true);
    if (validation.ok) {
      expect(validation.pack.schemaVersion).toBe(ACTION_PACK_SCHEMA_VERSION);
      expect(validation.pack.triggerPlan.type).toBe('INPUT_DATA');
      expect(validation.pack.triggerPlan.sourceFilters[0]).toEqual({ source: 'url', pattern: '^https://example\\.com' });
      expect(validation.pack.vm.safety.abortOnFailure).toBe(true);
    }
  });

  it('blocks interval triggers below the Chrome background minimum', () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const compiled = compileWorkspace({
      ...workspace,
      trigger: {
        type: 'INTERVAL',
        intervalMs: 1000,
      },
      edges: [createEdge(dataIn.id, 'url', dataOut.id, 'url')],
    });

    expect(compiled.ok).toBe(false);
    expect(compiled.validation.errors.join(' ')).toContain('Interval trigger');
  });

  it('blocks conditional triggers until the Chrome runtime supports them', () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const compiled = compileWorkspace({
      ...workspace,
      trigger: {
        type: 'CONDITIONAL',
        conditionalMode: 'RISING_EDGE',
      },
      edges: [createEdge(dataIn.id, 'url', dataOut.id, 'url')],
    });

    expect(compiled.ok).toBe(false);
    expect(compiled.validation.errors.join(' ')).toContain('Conditional triggers are not supported');
  });

  it('uses a connected Regex payload input before the text payload field', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const regex = createWorkspaceNode('RegExpression', { x: 260, y: 120 }, {
      pattern: 'abc',
      action: 'SUBSTITUTE',
      matchMode: 'STANDARD',
      payload: 'fallback',
      payloadVars: false,
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, regex],
      edges: [
        createEdge(dataIn.id, 'selectedText', regex.id, 'input'),
        createEdge(dataIn.id, 'pageTitle', regex.id, 'payload'),
        createEdge(regex.id, 'result', dataOut.id, 'url'),
      ],
    });

    expect(compiled.ok).toBe(true);
    const result = await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      readSource: async (source) => {
        if (source === 'selectedText') {
          return { type: 'string', value: 'abc' };
        }

        if (source === 'pageTitle') {
          return { type: 'string', value: 'https://example.com/from-payload' };
        }

        return undefined;
      },
    }, DEFAULT_SETTINGS);

    expect(result.finalUrl).toBe('https://example.com/from-payload');
  });

  it('executes remote GET through the transparent runtime hook', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const fetchNode = createWorkspaceNode('FetchData', { x: 260, y: 80 }, {
      remoteUrl: 'https://example.com/data.txt',
      remoteDataType: 'string',
    });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 560, y: 80 });
    let fetchedUrl = '';
    let written = '';
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, fetchNode, extendedOut],
      edges: [
        createEdge(fetchNode.id, 'result', extendedOut.id, 'pageText'),
        createEdge(dataIn.id, 'url', dataOut.id, 'url'),
      ],
    });

    expect(compiled.ok).toBe(true);
    expect(compiled.pack!.risk.highest).toBe('high');

    await executeCompiledActionPackV2('https://example.com/page', compiled.pack!, {
      ...runtime,
      fetchRemote: async (request) => {
        fetchedUrl = request.url;
        return { type: 'string', value: 'remote text' };
      },
      writeDestination: async (_destination, value) => {
        written = String(value.value);
      },
    }, DEFAULT_SETTINGS);

    expect(fetchedUrl).toBe('https://example.com/data.txt');
    expect(written).toBe('remote text');
  });

  it('preserves JSON-to-dict values when sending them as request bodies', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const fetchJson = createWorkspaceNode('FetchData', { x: 260, y: 80 }, {
      remoteUrl: 'https://example.com/input.json',
      remoteDataType: 'JSON',
    });
    const jsonToDict = createWorkspaceNode('Convert', { x: 260, y: 80 }, {
      convertMode: 'JSON_TO_DICT',
    });
    const addUrl = createWorkspaceNode('DataStructure', { x: 520, y: 80 }, {
      dictKey: 'url',
    });
    const post = createWorkspaceNode('HttpRequest', { x: 780, y: 80 }, {
      remoteMethod: 'POST',
      remoteUrl: 'https://example.com/api',
      remoteDataType: 'string',
    });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 1040, y: 80 });
    let postedBody: unknown;
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, fetchJson, jsonToDict, addUrl, post, extendedOut],
      edges: [
        createEdge(fetchJson.id, 'result', jsonToDict.id, 'input'),
        createEdge(jsonToDict.id, 'result', addUrl.id, 'dict'),
        createEdge(dataIn.id, 'url', addUrl.id, 'value'),
        createEdge(addUrl.id, 'result', post.id, 'body'),
        createEdge(post.id, 'result', extendedOut.id, 'pageText'),
        createEdge(dataIn.id, 'url', dataOut.id, 'url'),
      ],
    });

    expect(compiled.ok).toBe(true);

    await executeCompiledActionPackV2('https://example.com/page', compiled.pack!, {
      ...runtime,
      fetchRemote: async (request) => {
        if (request.method === 'GET') {
          return { type: 'JSON', value: '{"title":"Example","nested":{"ok":true}}' };
        }
        postedBody = request.body;
        return { type: 'string', value: 'ok' };
      },
      writeDestination: async () => undefined,
    }, DEFAULT_SETTINGS);

    expect(postedBody).toEqual({
      title: 'Example',
      nested: { ok: 1 },
      url: 'https://example.com/page',
    });
  });

  it('detects workspace and action pack artifacts by header instead of extension', async () => {
    const workspace = workspaceFromLegacyPack(createLegacyPack());
    const compiled = compileWorkspace(workspace);
    const workspaceArtifact = await importAnyArtifact(await exportWorkspaceBinary(workspace));
    const packArtifact = await importAnyArtifact(await exportCompiledActionPackV2Binary(compiled.pack!));

    expect(workspaceArtifact.kind).toBe('workspace');
    expect(packArtifact.kind).toBe('action-pack');
  });

  it('round-trips an exported v2 action pack through strict import validation', async () => {
    const pack = createBasicCompiledPack();
    const imported = await importCompiledActionPackV2Binary(await exportCompiledActionPackV2Binary(pack));

    expect(imported.pack.manifest.id).toBe(pack.manifest.id);
    expect(imported.pack.vm.instructions).toHaveLength(pack.vm.instructions.length);
    expect(imported.pack.checksumHex).toBe(imported.checksumHex);
  });

  it('clears runtime-only trace windows from imported binary action packs', async () => {
    const imported = await importCompiledActionPackV2Binary(
      await encodeActionPackCandidate({
        ...createBasicCompiledPack(),
        traceEnabledUntil: Date.now() + 60_000,
      }),
    );

    expect(imported.pack.traceEnabledUntil).toBeUndefined();
  });

  it('rejects malformed v2 VM instructions', async () => {
    const pack = createBasicCompiledPack();
    const malformed = {
      ...pack,
      vm: {
        ...pack.vm,
        instructions: [
          {
            op: 'LAUNCH',
            nodeId: 'malformed-node',
          },
        ],
      },
    };

    await expect(
      importCompiledActionPackV2Binary(await exportCompiledActionPackV2Binary(malformed as typeof pack)),
    ).rejects.toThrow('unknown instruction op');
  });

  it('rejects imported action packs that understate clipboard risk metadata', async () => {
    const workspace = createDefaultWorkspace();
    const extendedIn = createWorkspaceNode('ExtendedDataIn', { x: 180, y: 360 });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 560, y: 360 });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes, extendedIn, extendedOut],
      edges: [createEdge(extendedIn.id, 'clipboard', extendedOut.id, 'clipboard')],
    });

    expect(compiled.ok).toBe(true);

    const understated: CompiledActionPackV2 = {
      ...compiled.pack!,
      risk: {
        highest: 'safe',
        usesExtendedInput: false,
        usesExtendedOutput: false,
        usesHighRiskInput: false,
        usesHighRiskOutput: false,
        reasons: [],
      },
      requiredPermissions: [],
    };

    await expect(
      importCompiledActionPackV2Binary(await exportCompiledActionPackV2Binary(understated)),
    ).rejects.toThrow('understates');
  });

  it('rejects imported action packs with excessive VM budgets', async () => {
    const basePack = createBasicCompiledPack();
    const pack: CompiledActionPackV2 = {
      ...basePack,
      vm: {
        ...basePack.vm,
        stepBudget: 301,
      },
    };

    await expect(
      importCompiledActionPackV2Binary(await exportCompiledActionPackV2Binary(pack)),
    ).rejects.toThrow('stepBudget');
  });

  it('rejects imported action packs with unsafe regex instructions', async () => {
    const pack = createBasicCompiledPack();
    const unsafe = {
      ...pack,
      vm: {
        ...pack.vm,
        instructions: pack.vm.instructions.map((instruction) =>
          instruction.op === 'REGEX_TRANSFORM'
            ? {
                ...instruction,
                pattern: '(a+)+$',
              }
            : instruction,
        ),
      },
    };

    await expect(
      importCompiledActionPackV2Binary(await exportCompiledActionPackV2Binary(unsafe)),
    ).rejects.toThrow('Unsafe regular expression rejected');
  });

  it('rejects imported conditional trigger plans until the runtime supports them', async () => {
    const basePack = createBasicCompiledPack();
    const pack: CompiledActionPackV2 = {
      ...basePack,
      manifest: {
        ...basePack.manifest,
        trigger: {
          ...basePack.manifest.trigger,
          type: 'CONDITIONAL',
          conditionalMode: 'RISING_EDGE',
        },
      },
      triggerPlan: {
        ...basePack.triggerPlan,
        type: 'CONDITIONAL',
        conditionalMode: 'RISING_EDGE',
      },
    };

    await expect(
      importCompiledActionPackV2Binary(await exportCompiledActionPackV2Binary(pack)),
    ).rejects.toThrow('CONDITIONAL is not supported');
  });

  it('runs staged SaveLoad and output instructions without persistent side effects', async () => {
    let persistentSaveCount = 0;
    let persistentWriteCount = 0;
    const pack: CompiledActionPackV2 = {
      ...createBasicCompiledPack(),
      risk: {
        highest: 'extended',
        usesExtendedInput: false,
        usesExtendedOutput: true,
        usesHighRiskInput: false,
        usesHighRiskOutput: false,
        reasons: ['Session storage access is extended risk.', 'pageText is high risk.'],
      },
      triggerPlan: {
        type: 'INPUT_DATA',
        inputSources: ['url'],
        sourceFilters: [],
        safety: {
          timestampHistoryLimit: 25,
          burstLimit: 10,
          burstWindowMs: 1000,
        },
      },
      vm: {
        constants: {},
        symbolTable: {
          'input.url': 'URL',
          'save.result': 'Any',
        },
        stepBudget: 300,
        loopBudget: 500,
        valueByteLimit: 256 * 1024,
        safety: {
          abortOnFailure: true,
          regexTimeoutMs: 50,
          remoteTimeoutMs: 5000,
          remoteMaxBytes: 128 * 1024,
          rules: [],
        },
        instructions: [
          {
            op: 'SOURCE',
            nodeId: 'input',
            source: 'url',
            output: 'input.url',
            dataType: 'URL',
            risk: 'safe',
          },
          {
            op: 'SAVELOAD',
            nodeId: 'save',
            mode: 'SAVE',
            fallbackKey: 'sandbox-key',
            value: 'input.url',
            output: 'save.result',
          },
          {
            op: 'OUTPUT',
            nodeId: 'output',
            input: 'input.url',
            destination: 'pageText',
            dataType: 'string',
            risk: 'high',
          },
        ],
      },
    };

    const sandboxRuntime = createSandboxGraphRuntime({
      ...runtime,
      saveSessionValue: async () => {
        persistentSaveCount += 1;
      },
      writeDestination: async () => {
        persistentWriteCount += 1;
      },
    });

    await executeCompiledActionPackV2('https://example.com/', pack, sandboxRuntime, DEFAULT_SETTINGS);

    expect(persistentSaveCount).toBe(0);
    expect(persistentWriteCount).toBe(0);
  });

  it('runs staged imports without reading real clipboard or page sources', async () => {
    let clipboardReadCount = 0;
    let sourceReadCount = 0;
    const pack: CompiledActionPackV2 = {
      ...createBasicCompiledPack(),
      risk: {
        highest: 'high',
        usesExtendedInput: false,
        usesExtendedOutput: false,
        usesHighRiskInput: true,
        usesHighRiskOutput: false,
        reasons: ['Clipboard payload interpolation is high risk.'],
      },
      requiredPermissions: ['clipboardRead'],
      vm: {
        constants: {},
        symbolTable: {
          'input.clipboard': 'string',
          'input.url': 'URL',
          'output.url': 'URL',
        },
        stepBudget: 300,
        loopBudget: 500,
        valueByteLimit: 256 * 1024,
        safety: {
          abortOnFailure: true,
          regexTimeoutMs: 50,
          remoteTimeoutMs: 5000,
          remoteMaxBytes: 128 * 1024,
          rules: [],
        },
        instructions: [
          {
            op: 'SOURCE',
            nodeId: 'clipboard-input',
            source: 'clipboard',
            output: 'input.clipboard',
            dataType: 'string',
            risk: 'high',
          },
          {
            op: 'SOURCE',
            nodeId: 'url-input',
            source: 'url',
            output: 'input.url',
            dataType: 'URL',
            risk: 'safe',
          },
          {
            op: 'REGEX_TRANSFORM',
            nodeId: 'rewrite-url',
            input: 'input.url',
            output: 'output.url',
            pattern: '^.*$',
            action: 'SUBSTITUTE',
            matchMode: 'STANDARD',
            payload: 'https://example.com/{clipboard}',
            payloadVars: true,
          },
          {
            op: 'OUTPUT',
            nodeId: 'output',
            input: 'output.url',
            destination: 'url',
            dataType: 'URL',
            risk: 'safe',
          },
        ],
      },
    };

    const result = await executeCompiledActionPackV2(
      'https://start.example/',
      pack,
      createSandboxGraphRuntime({
        ...runtime,
        readClipboard: async () => {
          clipboardReadCount += 1;
          return 'real-clipboard';
        },
        readSource: async () => {
          sourceReadCount += 1;
          return { type: 'string', value: 'real-source' };
        },
      }),
      DEFAULT_SETTINGS,
    );

    expect(result.finalUrl).toBe('https://example.com/sandbox-clipboard');
    expect(clipboardReadCount).toBe(0);
    expect(sourceReadCount).toBe(0);
  });

  it('stops reading remote response streams after the byte limit is exceeded', async () => {
    let cancelCalled = false;
    const pack: CompiledActionPackV2 = {
      ...createBasicCompiledPack(),
      vm: {
        constants: {},
        symbolTable: {
          'remote.result': 'string',
        },
        stepBudget: 300,
        loopBudget: 500,
        valueByteLimit: 256 * 1024,
        safety: {
          abortOnFailure: true,
          regexTimeoutMs: 50,
          remoteTimeoutMs: 5000,
          remoteMaxBytes: 128 * 1024,
          rules: [],
        },
        instructions: [
          {
            op: 'FETCH_GET',
            nodeId: 'fetch',
            output: 'remote.result',
            fallbackUrl: 'https://example.com/large.txt',
            outputDataType: 'string',
            timeoutMs: 5000,
            maxBytes: 1024,
          },
          {
            op: 'OUTPUT',
            nodeId: 'output',
            input: 'remote.result',
            destination: 'pageText',
            dataType: 'string',
            risk: 'high',
          },
        ],
      },
    };

    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(1025));
            },
            cancel() {
              cancelCalled = true;
            },
          }),
          { status: 200 },
        ),
    );

    try {
      const result = await executeCompiledActionPackV2('https://example.com/', pack, runtime, DEFAULT_SETTINGS);

      expect(result.issues[0]?.message).toContain('byte limit');
      expect(cancelCalled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('compiles every bundled example and keeps the gallery grounded in runnable workflows', () => {
    const workspaces = createBundledExampleWorkspaces();
    const packs = createBundledExampleActionPacks();
    const usedActions = new Set<string>();
    const usedMatchModes = new Set<string>();

    expect(BUNDLED_ACTION_PACK_EXAMPLES.some((example) => example.slug === 'screen-time')).toBe(false);
    expect(BUNDLED_ACTION_PACK_EXAMPLES.map((example) => example.slug)).toContain('break-reminder');
    expect(workspaces.length).toBeGreaterThanOrEqual(13);
    expect(packs).toHaveLength(workspaces.length);

    workspaces.forEach((workspace) => {
      const compiled = compileWorkspace(workspace);
      expect(compiled.ok, `${workspace.metadata.name}: ${compiled.validation.errors.join('; ')}`).toBe(true);
      workspace.nodes.forEach((node) => {
        if ((node.type === 'FetchData' || node.type === 'HttpRequest') && node.settings.remoteUrl) {
          expect(node.settings.remoteUrl).not.toMatch(/example\.com\/(?:api|data)/);
        }
        if ((node.type === 'GetImage' || node.type === 'GetVideo' || node.type === 'GetAudio') && !node.settings.assetDataBase64) {
          expect(node.settings.assetUrl, `${workspace.metadata.name} remote asset`).toMatch(/^https:\/\//);
        }
        if (node.type === 'RegExpression') {
          usedActions.add(node.settings.action ?? 'SUBSTITUTE');
          usedMatchModes.add(node.settings.matchMode ?? 'STANDARD');
        }
      });
    });

    expect(Array.from(usedActions).sort()).toEqual(['APPEND', 'PREPEND', 'REMOVE', 'SUBSTITUTE']);
    expect(Array.from(usedMatchModes).sort()).toEqual(['AFTER_PATTERN', 'BEFORE_PATTERN', 'NTH_OCCURRENCE', 'STANDARD']);
  });

  it('executes every bundled example with realistic stubbed browser services', async () => {
    const session = new Map<string, GraphValue>();
    const destinationWrites: string[] = [];
    const packs = createBundledExampleActionPacks();
    const exampleRuntime: GraphRuntime = {
      ...runtime,
      readSource: async (source) => {
        if (source === 'clipboard') {
          return { type: 'string', value: 'docs & notes' };
        }
        if (source === 'selectedText') {
          return { type: 'string', value: 'c# docs & tips' };
        }
        if (source === 'pageTitle') {
          return { type: 'string', value: 'Example Page' };
        }
        if (source === 'pageText') {
          return { type: 'string', value: 'This damn page has a few crap words.' };
        }
        if (source === 'linkUrl') {
          return { type: 'URL', value: 'https://github.com/acme/project/pull/42?tab=conversation' };
        }
        return undefined;
      },
      fetchRemote: async (request) => ({
        type: request.outputDataType,
        value: request.method === 'POST'
          ? `echo:${request.url}:${JSON.stringify(request.body ?? {})}`
          : 'Example Domain remote response',
      } as GraphValue),
      requestUserInteraction: async (request) => {
        const value: GraphValue = request.kind === 'PROMPT_NUMBER'
          ? { type: 'number', value: 30 }
          : { type: 'string', value: request.defaultValue || 'Test input' };

        return {
          type: 'dict',
          value: {
            ok: { type: 'bool', value: 1 },
            cancelled: { type: 'bool', value: 0 },
            value,
            source: { type: 'string', value: 'test' },
          },
        };
      },
      displayOverlay: async (request) => ({
        type: 'dict',
        value: {
          ok: { type: 'bool', value: 1 },
          completed: { type: 'bool', value: request.type === 'video' ? 0 : 1 },
          cancelled: { type: 'bool', value: 0 },
          stoppedAtSeconds: { type: 'number', value: request.type === 'video' ? 1 : 0 },
          durationSeconds: { type: 'number', value: request.type === 'video' ? 2 : 0 },
          watchedPercent: { type: 'number', value: request.type === 'video' ? 50 : 0 },
          reason: { type: 'string', value: request.type === 'input-capture' ? 'closed' : 'test' },
        },
      }),
      overlayControl: async (request) => ({
        type: 'dict',
        value: {
          ok: { type: 'bool', value: 1 },
          active: { type: 'bool', value: request.action === 'STOP' ? 0 : 1 },
          action: { type: 'string', value: request.action },
        },
      }),
      overlayDraw: async () => ({ type: 'dict', value: { ok: { type: 'bool', value: 1 } } }),
      loadSessionValue: async (key) => session.get(key),
      saveSessionValue: async (key, value) => {
        session.set(key, value);
      },
      deleteSessionValue: async (key) => {
        session.delete(key);
      },
      writeDestination: async (destination) => {
        destinationWrites.push(destination);
      },
      mutatePageText: async () => undefined,
    };

    for (const pack of packs) {
      const inputUrl = pack.manifest.name === 'GitHub PR Files Shortcut'
        ? 'https://github.com/acme/project/pull/42?tab=conversation'
        : 'https://example.com/path?utm_source=newsletter&ref=abc&id=123&keep=1';
      const result = await executeCompiledActionPackV2(inputUrl, pack, exampleRuntime, DEFAULT_SETTINGS, {
        handler: 'trigger',
        event: { kind: 'trigger', hotkey: pack.manifest.trigger.hotkey, url: inputUrl },
      });

      expect(result.issues, pack.manifest.name).toEqual([]);
    }

    expect(session.has('break-reminder:last-run')).toBe(true);
    expect(session.has('playback-resume:last-video')).toBe(true);
    expect(destinationWrites).toContain('pageText');
    expect(destinationWrites).toContain('clipboard');
  });

  it('keeps the Snake example built from generic block and VM operation names', () => {
    const snake = createBundledExampleWorkspaces().find((workspace) => workspace.metadata.name === 'Snake Overlay Arcade');
    expect(snake).toBeTruthy();

    const compiled = compileWorkspace(snake!);
    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    expect(snake!.nodes.some((node) => /snake|arcadegame/i.test(node.type))).toBe(false);
    expect(compiled.pack!.vm.instructions.some((instruction) => /snake|arcadegame/i.test(instruction.op))).toBe(false);
    expect(compiled.pack!.vm.eventHandlers?.trigger?.length).toBeGreaterThan(0);
    expect(compiled.pack!.vm.eventHandlers?.keyboard?.length).toBeGreaterThan(0);
    expect(compiled.pack!.vm.eventHandlers?.mouse?.length).toBeGreaterThan(0);
    expect(compiled.pack!.vm.eventHandlers?.tick?.length).toBeGreaterThan(0);
  });

  it('simulates Snake gameplay through generic overlay event handlers', async () => {
    const snake = createBundledExampleWorkspaces().find((workspace) => workspace.metadata.name === 'Snake Overlay Arcade')!;
    const compiled = compileWorkspace(snake);
    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);

    const session = new Map<string, import('./types').GraphValue>();
    const overlayEvents: string[] = [];
    let overlayActive = false;
    const snakeRuntime: GraphRuntime = {
      ...runtime,
      loadSessionValue: async (key) => session.get(key),
      saveSessionValue: async (key, value) => {
        session.set(key, value);
      },
      deleteSessionValue: async (key) => {
        session.delete(key);
      },
      overlayControl: async (request) => {
        overlayEvents.push(request.action);
        if (request.action === 'START') {
          overlayActive = true;
        }
        if (request.action === 'STOP') {
          overlayActive = false;
        }
        return { type: 'dict', value: { ok: { type: 'bool', value: 1 }, active: { type: 'bool', value: overlayActive ? 1 : 0 } } };
      },
      overlayDraw: async () => ({ type: 'dict', value: { ok: { type: 'bool', value: 1 }, active: { type: 'bool', value: 1 } } }),
    };

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, snakeRuntime, DEFAULT_SETTINGS, {
      handler: 'trigger',
      event: { kind: 'trigger', hotkey: 'Ctrl+Shift+S', url: 'https://example.com/' },
    });
    expect(overlayEvents).toContain('START');
    expect(session.get('snake:direction')).toEqual({ type: 'string', value: 'ArrowRight' });

    for (let tick = 1; tick <= 6; tick += 1) {
      await executeCompiledActionPackV2('https://example.com/', compiled.pack!, snakeRuntime, DEFAULT_SETTINGS, {
        handler: 'tick',
        event: { kind: 'tick', tick, deltaMs: 135 },
      });
    }
    expect(session.get('snake:score')).toEqual({ type: 'number', value: 1 });

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, snakeRuntime, DEFAULT_SETTINGS, {
      handler: 'mouse',
      event: { kind: 'mouse', eventType: 'pointerdown', button: 0, buttons: 1, x: 16, y: 16 },
    });
    expect(session.get('snake:paused')).toEqual({ type: 'number', value: 1 });

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, snakeRuntime, DEFAULT_SETTINGS, {
      handler: 'keyboard',
      event: { kind: 'keyboard', eventType: 'keydown', key: 'Escape', code: 'Escape', keyCode: 27 },
    });
    expect(overlayEvents).toContain('STOP');
  });

  it('round-trips generated bundled workspace and action pack artifacts', async () => {
    const indexPath = resolve(projectRoot, 'public/bundled-actionpacks/index.json');
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as { examples: typeof BUNDLED_ACTION_PACK_EXAMPLES };

    expect(index.examples.map((example) => example.id)).toEqual(BUNDLED_ACTION_PACK_EXAMPLES.map((example) => example.id));

    for (const example of BUNDLED_ACTION_PACK_EXAMPLES) {
      const workspaceBytes = new Uint8Array(await readFile(resolve(projectRoot, 'public', example.workspacePath)));
      const actionPackBytes = new Uint8Array(await readFile(resolve(projectRoot, 'public', example.actionPackPath)));
      const workspace = await importWorkspaceBinary(workspaceBytes);
      const pack = await importCompiledActionPackV2Binary(actionPackBytes);

      expect(workspace.workspace.metadata.id).toBe(example.id);
      expect(workspace.workspace.metadata.compatibility?.firefox?.status).toBe('pending-v2-runtime');
      expect(pack.pack.manifest.id).toBe(example.id);
    }
  });

  it('round-trips backup blobs with checksum validation', async () => {
    const state = {
      ...getDefaultState(),
      settings: {
        ...getDefaultState().settings,
        syncEnabled: true,
      },
      actionPacksV2: [createBasicCompiledPack()],
      workspacesV2: [createDefaultWorkspace()],
    };
    const backup = await exportBackupState(state);
    const restored = await importBackupState(backup);

    expect(restored.settings.syncEnabled).toBe(true);
    expect(restored.actionPacksV2).toHaveLength(1);
    expect(restored.workspacesV2).toHaveLength(1);
  });

  it('migrates stored settings with hardening and UI scale defaults', () => {
    const restored = normalizeStoredState({
      settings: {
        globalEnabled: true,
        allowLocalFiles: false,
        advancedModeEnabled: false,
        syncEnabled: false,
        builderUuid: 'builder-id',
      },
      packs: [],
      actionPacksV2: [],
      workspacesV2: [],
      traceEntries: [],
    });

    expect(restored.settings.uiScale).toBe(100);
    expect(restored.settings.hardeningMaxInstructions).toBe(300);
    expect(restored.settings.hardeningMaxRecursion).toBe(3);
    expect(restored.settings.hardeningRegexTimeoutMs).toBe(50);
  });

  it('clamps UI scale and hardening settings to stricter effective limits', () => {
    const looseSettings = {
      ...DEFAULT_SETTINGS,
      uiScale: 1000,
      hardeningMaxRecursion: 10,
      hardeningRegexTimeoutMs: 500,
    };

    expect(normalizeUiScale(looseSettings.uiScale)).toBe(150);
    expect(normalizeUiScale(25)).toBe(75);
    expect(effectiveRedirectDepthLimit(looseSettings)).toBe(3);
    expect(effectiveRegexTimeoutMs(looseSettings)).toBe(50);
  });

  it('honors the hardened VM instruction limit at runtime', async () => {
    const pack = createBasicCompiledPack();
    const result = await executeCompiledActionPackV2(
      'https://example.com/?utm_source=test&id=1',
      pack,
      runtime,
      {
        ...DEFAULT_SETTINGS,
        hardeningMaxInstructions: 1,
      },
    );

    expect(result.changed).toBe(false);
    expect(result.issues.some((entry) => entry.message.includes('VM step budget exceeded'))).toBe(true);
  });

  it('executes bundled examples that use selected text, clipboard input, storage, and clipboard output', async () => {
    const packs = new Map(createBundledExampleActionPacks().map((pack) => [pack.manifest.name, pack]));
    const written: Record<string, string> = {};
    const saved: Record<string, unknown> = {};
    const contextRuntime: GraphRuntime = {
      ...runtime,
      readSource: async (source) => {
        if (source === 'clipboard') {
          return { type: 'string', value: 'clipboard token' };
        }

        if (source === 'selectedText') {
          return { type: 'string', value: 'abc' };
        }

        if (source === 'pageTitle') {
          return { type: 'string', value: 'Example Title' };
        }

        return undefined;
      },
      saveSessionValue: async (key, value) => {
        saved[key] = value.value;
      },
      writeDestination: async (destination, value) => {
        written[destination] = String(value.value);
      },
    };

    const selectedResult = await executeCompiledActionPackV2(
      'https://example.com/',
      packs.get('Search Selected Text')!,
      contextRuntime,
      DEFAULT_SETTINGS,
    );
    expect(selectedResult.finalUrl).toBe('https://www.google.com/search?q=abc');

    const clipboardResult = await executeCompiledActionPackV2(
      'https://example.com/',
      packs.get('Clipboard Search Launcher')!,
      contextRuntime,
      DEFAULT_SETTINGS,
    );
    expect(clipboardResult.finalUrl).toBe('https://www.google.com/search?q=clipboard+token');

    await executeCompiledActionPackV2('https://example.com/page', packs.get('Remember Current Page')!, contextRuntime, DEFAULT_SETTINGS);
    expect(saved['last-url']).toBe('https://example.com/page');

    await executeCompiledActionPackV2('https://example.com/page', packs.get('Research Note Snapshot')!, contextRuntime, DEFAULT_SETTINGS);
    expect(written.clipboard).toContain('Example Title');
    expect(written.clipboard).toContain('https://example.com/page');

    await executeCompiledActionPackV2('https://example.com/page', packs.get('Uppercase Selection Clipboard')!, contextRuntime, DEFAULT_SETTINGS);
    expect(written.clipboard).toBe('ABC');
  });
});
