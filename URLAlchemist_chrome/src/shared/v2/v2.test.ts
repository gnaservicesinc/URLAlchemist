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
import { HOTKEY_TRIGGER_MESSAGE, isHotkeyTriggerMessage, isOverlayAppEventMessage, OVERLAY_APP_EVENT_MESSAGE } from '../messages';
import { createSyncSnapshot, getDefaultState } from '../storage';
import { normalizeStoredState } from '../validation';
import { validateCompiledActionPackV2 } from './actionPackValidator';
import { AI_WORKSPACE_INSTRUCTIONS_MAX_CHARS, DEFAULT_AI_WORKSPACE_INSTRUCTIONS, normalizeAiWorkspaceInstructions } from './aiInstructions';
import { BUNDLED_ACTION_PACK_EXAMPLES, createBundledExampleActionPacks, createBundledExampleWorkspaces } from './bundledExamples';
import { compileWorkspace } from './compiler';
import { explainRiskReason } from './explain';
import { stripLocalInstallMetadata } from './installMetadata';
import { formatRunType } from './labels';
import { createChallengeLockState, createPasswordLockState, verifyPasswordLock } from './locks';
import { listOllamaModels, validateOllamaEndpoint } from './ollama';
import { createSandboxGraphRuntime } from './sandboxRuntime';
import { ACTION_PACK_SCHEMA_VERSION, LEGACY_ACTION_PACK_SCHEMA_VERSION, type CompiledActionPackV2, type GraphValue } from './types';
import { extractVariableReferences, resolveVariableText } from './variables';
import { evaluateCompiledActionPackCondition, executeCompiledActionPackV2, type GraphRuntime } from './vm';
import { createDefaultContentBlockerWorkspace, createEdge, createDefaultWorkspace, createWorkspaceNode, validateWorkspaceFile, workspaceFromLegacyPack } from './workspace';
import { createWorkspaceBlockClipboard, pasteWorkspaceBlockClipboard } from './workspaceClipboard';
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

async function encodeActionPackForImportTest(pack: CompiledActionPackV2): Promise<Uint8Array> {
  const payload = encode(omitUndefinedForTest(pack));
  const checksumHex = await sha256Hex(payload);
  const magicBytes = new TextEncoder().encode(ACTION_PACK_MAGIC);
  const checksumBytes = hexToBytes(checksumHex);
  const output = new Uint8Array(magicBytes.length + 1 + checksumBytes.length + payload.length);
  output.set(magicBytes, 0);
  output[magicBytes.length] = ACTION_PACK_SCHEMA_VERSION;
  output.set(checksumBytes, magicBytes.length + 1);
  output.set(payload, magicBytes.length + 1 + checksumBytes.length);
  return output;
}

function omitUndefinedForTest(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(omitUndefinedForTest);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, omitUndefinedForTest(entry)]),
  );
}

function createConditionalWorkspace(conditionValue = '1') {
  const workspace = createDefaultWorkspace();
  const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
  const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
  const constant = createWorkspaceNode('Constant', { x: 260, y: 20 }, {
    literalDataType: 'bool',
    literalValue: conditionValue,
  });
  const conditionOut = createWorkspaceNode('ConditionOut', { x: 560, y: 20 });

  return {
    ...workspace,
    trigger: {
      type: 'CONDITIONAL' as const,
      conditionalMode: 'RISING_EDGE' as const,
      intervalMs: 30_000,
      inputSources: ['url' as const],
      conditionWorkspaceId: workspace.metadata.id,
    },
    nodes: [...workspace.nodes, constant, conditionOut],
    edges: [
      createEdge(dataIn.id, 'url', dataOut.id, 'url'),
      createEdge(constant.id, 'value', conditionOut.id, 'condition'),
    ],
  };
}

async function runWorkspaceForClipboard(
  workspace: ReturnType<typeof createDefaultWorkspace>,
  sourceValues: Partial<Record<string, GraphValue>> = {},
  inputUrl = 'https://example.com/?b=2&a=1&utm=1&id=7',
) {
  const compiled = compileWorkspace(workspace, { conditionWorkspaces: [workspace] });
  expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
  let clipboard = '';
  const result = await executeCompiledActionPackV2(inputUrl, compiled.pack!, {
    ...runtime,
    readSource: async (source) => sourceValues[source] ?? runtime.readSource?.(source),
    writeDestination: async (destination, value) => {
      if (destination === 'clipboard') {
        clipboard = typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
      }
    },
  }, DEFAULT_SETTINGS);
  expect(result.issues, result.issues.map((issue) => issue.message).join('; ')).toEqual([]);
  return { clipboard, result, pack: compiled.pack! };
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
  it('preserves unknown risk reasons without identity normalization', () => {
    expect(explainRiskReason('Custom scanner reason.')).toBe('Custom scanner reason.');
    expect(explainRiskReason('Custom scanner reason')).toBe('Custom scanner reason');
  });

  it('rejects dangerous imported workspace source shapes before migration', () => {
    const workspace = createDefaultWorkspace();
    const imported = {
      ...workspace,
      nodes: [
        {
          ...workspace.nodes[0],
          settings: Object.fromEntries([['__proto__', { polluted: true }]]),
        },
        ...workspace.nodes.slice(1),
      ],
    };

    const result = validateWorkspaceFile(imported);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Dangerous workspace source was accepted');
    }
    expect(result.errors.join(' ')).toContain('Workspace node 1 is invalid');
  });

  it('rejects unsafe trigger source filters in imported workspaces', () => {
    const workspace = createDefaultWorkspace();
    const result = validateWorkspaceFile({
      ...workspace,
      trigger: {
        ...workspace.trigger,
        sourceFilters: [{ source: 'url', pattern: '(a+)+$' }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Unsafe workspace source filter was accepted');
    }
    expect(result.errors.join(' ')).toContain('unsafe regex pattern');
  });

  it('strips unknown workspace source fields during import migration', () => {
    const workspace = createDefaultWorkspace();
    const result = validateWorkspaceFile({
      ...workspace,
      unexpectedRoot: { nested: true },
      metadata: {
        ...workspace.metadata,
        unexpectedMetadata: 'remove me',
      },
      trigger: {
        ...workspace.trigger,
        unexpectedTrigger: 'remove me',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join('; '));
    }
    expect((result.value as unknown as Record<string, unknown>).unexpectedRoot).toBeUndefined();
    expect((result.value.metadata as unknown as Record<string, unknown>).unexpectedMetadata).toBeUndefined();
    expect((result.value.trigger as unknown as Record<string, unknown>).unexpectedTrigger).toBeUndefined();
  });

  it('migrates schema 6 workspace metadata by stripping removed version-file fields', () => {
    const workspace = createDefaultWorkspace();
    const result = validateWorkspaceFile({
      ...workspace,
      schemaVersion: 6,
      metadata: {
        ...workspace.metadata,
        versionFileUrl: 'https://example.com/pack.version',
        versionFileSignatureUrl: 'https://example.com/pack.version.asc',
        downloadUrl: 'https://example.com/pack.actionpack',
        publicKeyLocateValue: 'author@example.com',
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join('; '));
    }
    const metadata = result.value.metadata as unknown as Record<string, unknown>;
    expect(metadata.versionFileUrl).toBeUndefined();
    expect(metadata.versionFileSignatureUrl).toBeUndefined();
    expect(metadata.downloadUrl).toBeUndefined();
    expect(metadata.publicKeyLocateValue).toBeUndefined();
  });

  it('migrates schema 6 Action Pack metadata by stripping removed version-file fields', () => {
    const pack = createBasicCompiledPack();
    const result = validateCompiledActionPackV2({
      ...pack,
      schemaVersion: 6,
      manifest: {
        ...pack.manifest,
        metadata: {
          ...pack.manifest.metadata,
          versionFileUrl: 'https://example.com/pack.version',
          versionFileSignatureUrl: 'https://example.com/pack.version.asc',
          downloadUrl: 'https://example.com/pack.actionpack',
          publicKeyLocateValue: 'author@example.com',
        },
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join('; '));
    }
    const metadata = result.pack.manifest.metadata as unknown as Record<string, unknown>;
    expect(metadata.versionFileUrl).toBeUndefined();
    expect(metadata.versionFileSignatureUrl).toBeUndefined();
    expect(metadata.downloadUrl).toBeUndefined();
    expect(metadata.publicKeyLocateValue).toBeUndefined();
  });

  it('keeps local install metadata out of exported Action Packs', async () => {
    const pack = createBasicCompiledPack();
    const withLocalMetadata: CompiledActionPackV2 = {
      ...pack,
      checksumHex: 'local-checksum',
      traceEnabledUntil: Date.now() + 60_000,
      install: {
        source: 'imported',
        trustStatus: 'trusted',
        loggingEnabled: false,
        installedAt: Date.now(),
        artifactChecksumHex: 'artifact-checksum',
        lockState: createChallengeLockState(pack.manifest.name, 1),
      },
    };

    expect(stripLocalInstallMetadata(withLocalMetadata).install).toBeUndefined();
    const imported = await importCompiledActionPackV2Binary(await exportCompiledActionPackV2Binary(withLocalMetadata));
    expect(imported.pack.install).toBeUndefined();
    expect(imported.pack.traceEnabledUntil).toBeUndefined();
  });

  it('compiles Content Blocker workspaces as local installs and rejects compiled import/export', async () => {
    const workspace = createDefaultContentBlockerWorkspace();
    const result = compileWorkspace(workspace);

    expect(result.ok).toBe(true);
    expect(result.pack?.manifest.metadata.workspaceType).toBe('content-blocker');
    expect(result.pack?.install?.contentBlocker?.pageLoad.surfaceId).toBe('page-load');
    expect(result.pack?.install?.contentBlocker?.recurring).toBeUndefined();
    expect(result.pack?.install?.contentBlocker?.challengeTasks.length).toBeGreaterThan(0);

    await expect(exportCompiledActionPackV2Binary(result.pack!)).rejects.toThrow('Content Blocker Action Packs are local installs');
    await expect(importCompiledActionPackV2Binary(await encodeActionPackForImportTest(result.pack!))).rejects.toThrow('Compiled Content Blocker Action Packs cannot be imported');
    await expect(importAnyArtifact(await encodeActionPackForImportTest(result.pack!))).rejects.toThrow('Compiled Content Blocker Action Packs cannot be imported');
  });

  it('creates a default Content Blocker that checks the current URL against a URL list', async () => {
    const workspace = createDefaultContentBlockerWorkspace();
    const pageLoad = workspace.surfaces!.find((surface) => surface.id === 'page-load')!;
    const list = pageLoad.nodes.find((node) => node.type === 'Constant' && node.settings.literalDataType === 'list')!;
    const result = compileWorkspace({
      ...workspace,
      surfaces: workspace.surfaces!.map((surface) => surface.id === 'page-load'
        ? {
            ...surface,
            nodes: surface.nodes.map((node) => node.id === list.id ? {
              ...node,
              settings: {
                ...node.settings,
                literalValue: 'https://blocked.example/path\nnot a url',
                literalListType: 'URL',
              },
            } : node),
          }
        : surface),
    });

    expect(result.ok, result.validation.errors.join('; ')).toBe(true);
    const pageLoadProgram = result.pack!.install!.contentBlocker!.pageLoad;
    const decisionPack: CompiledActionPackV2 = { ...result.pack!, vm: pageLoadProgram.vm };
    const blocked = await executeCompiledActionPackV2('https://blocked.example/path', decisionPack, runtime, DEFAULT_SETTINGS);
    const allowed = await executeCompiledActionPackV2('https://allowed.example/path', decisionPack, runtime, DEFAULT_SETTINGS);

    expect(blocked.outputs.contentBlockerDecision).toEqual({ type: 'number', value: 2 });
    expect(allowed.outputs.contentBlockerDecision).toEqual({ type: 'number', value: 0 });

    const challengeResult = compileWorkspace({
      ...workspace,
      surfaces: workspace.surfaces!.map((surface) => surface.id === 'page-load'
        ? {
            ...surface,
            nodes: surface.nodes.map((node) => node.type === 'CheckListForUrl' ? {
              ...node,
              settings: {
                ...node.settings,
                contentBlockerMatchDecision: 1 as const,
              },
            } : node).map((node) => node.id === list.id ? {
              ...node,
              settings: {
                ...node.settings,
                literalValue: 'https://blocked.example/path',
                literalListType: 'URL',
              },
            } : node),
          }
        : surface),
    });
    expect(challengeResult.ok, challengeResult.validation.errors.join('; ')).toBe(true);
    const challengePack: CompiledActionPackV2 = { ...challengeResult.pack!, vm: challengeResult.pack!.install!.contentBlocker!.pageLoad.vm };
    const challenged = await executeCompiledActionPackV2('https://blocked.example/path', challengePack, runtime, DEFAULT_SETTINGS);
    expect(challenged.outputs.contentBlockerDecision).toEqual({ type: 'number', value: 1 });
  });

  it('compares values intelligently with a dynamic Logic compare input', async () => {
    const workspace = createDefaultWorkspace();
    const left = createWorkspaceNode('Constant', { x: 240, y: 80 }, {
      literalDataType: 'string',
      literalValue: 'example',
    });
    const right = createWorkspaceNode('Constant', { x: 240, y: 240 }, {
      literalDataType: 'string',
      literalValue: 'example',
    });
    const logic = createWorkspaceNode('Logical', { x: 520, y: 120 }, {
      operator: 'EQ',
    });
    const output = createWorkspaceNode('ConditionOut', { x: 820, y: 120 });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [workspace.nodes[0], left, right, logic, output],
      edges: [
        createEdge(left.id, 'value', logic.id, 'input'),
        createEdge(right.id, 'value', logic.id, 'compare'),
        createEdge(logic.id, 'result', output.id, 'condition'),
      ],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    const result = await executeCompiledActionPackV2('https://example.com/', compiled.pack!, runtime, DEFAULT_SETTINGS);
    expect(result.outputs.condition).toEqual({ type: 'bool', value: 1 });
  });

  it('runs Logical Flow from its paired Logic block without a visible condition edge', async () => {
    const workspace = createDefaultWorkspace();
    const source = createWorkspaceNode('Constant', { x: 240, y: 120 }, {
      literalDataType: 'number',
      literalValue: '1',
    });
    const logic = createWorkspaceNode('Logical', { x: 520, y: 80 }, {
      compareValue: '1',
      logicalFlowGroupId: 'flow-test',
      logicalFlowRole: 'condition',
    });
    const flow = createWorkspaceNode('LogicalFlow', { x: 520, y: 320 }, {
      logicalFlowGroupId: 'flow-test',
      logicalFlowRole: 'control',
    });
    const output = createWorkspaceNode('ConditionOut', { x: 860, y: 260 });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [workspace.nodes[0], source, logic, flow, output],
      edges: [
        createEdge(source.id, 'value', logic.id, 'input'),
        createEdge(source.id, 'value', flow.id, 'input'),
        createEdge(flow.id, 'trueValue', output.id, 'condition'),
      ],
      logicalFlows: [{
        id: 'flow-test',
        conditionNodeId: logic.id,
        controlNodeId: flow.id,
        depth: 1,
        locked: false,
      }],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    const result = await executeCompiledActionPackV2('https://example.com/', compiled.pack!, runtime, DEFAULT_SETTINGS);
    expect(result.outputs.condition).toEqual({ type: 'bool', value: 1 });
  });

  it('converts numeric values to bool using the positive-number rule', async () => {
    const workspace = createDefaultWorkspace();
    const positive = createWorkspaceNode('Constant', { x: 240, y: 80 }, {
      literalDataType: 'number',
      literalValue: '3',
    });
    const negative = createWorkspaceNode('Constant', { x: 240, y: 240 }, {
      literalDataType: 'number',
      literalValue: '-1',
    });
    const convert = createWorkspaceNode('Convert', { x: 520, y: 80 }, {
      convertMode: 'NUMBER_TO_BOOL',
    });
    const positiveOut = createWorkspaceNode('ConditionOut', { x: 820, y: 80 }, { label: 'Positive Out' });
    const negativeOut = createWorkspaceNode('ConditionOut', { x: 820, y: 240 }, { label: 'Negative Out' });
    const converted = compileWorkspace({
      ...workspace,
      nodes: [workspace.nodes[0], positive, convert, positiveOut],
      edges: [
        createEdge(positive.id, 'value', convert.id, 'input'),
        createEdge(convert.id, 'result', positiveOut.id, 'condition'),
      ],
    });
    const direct = compileWorkspace({
      ...workspace,
      nodes: [workspace.nodes[0], negative, negativeOut],
      edges: [
        createEdge(negative.id, 'value', negativeOut.id, 'condition'),
      ],
    });

    expect(converted.ok, converted.validation.errors.join('; ')).toBe(true);
    expect(direct.ok, direct.validation.errors.join('; ')).toBe(true);
    const convertedResult = await executeCompiledActionPackV2('https://example.com/', converted.pack!, runtime, DEFAULT_SETTINGS);
    const directResult = await executeCompiledActionPackV2('https://example.com/', direct.pack!, runtime, DEFAULT_SETTINGS);
    expect(convertedResult.outputs.condition).toEqual({ type: 'bool', value: 1 });
    expect(directResult.outputs.condition).toEqual({ type: 'bool', value: 0 });
  });

  it('compares list values item-by-item and can append strings to lists', async () => {
    const workspace = createDefaultWorkspace();
    const baseList = createWorkspaceNode('Constant', { x: 240, y: 80 }, {
      literalDataType: 'list',
      literalValue: 'one\ntwo',
    });
    const item = createWorkspaceNode('Constant', { x: 240, y: 240 }, {
      literalDataType: 'list',
      literalValue: 'three\nfour',
    });
    const append = createWorkspaceNode('AddStringToList', { x: 520, y: 120 });
    const length = createWorkspaceNode('ListOperation', { x: 760, y: 120 }, {
      listOperation: 'LENGTH',
    });
    const equals = createWorkspaceNode('Logical', { x: 1000, y: 120 }, {
      compareValue: '4',
      operator: 'EQ',
    });
    const output = createWorkspaceNode('ConditionOut', { x: 1260, y: 120 });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [workspace.nodes[0], baseList, item, append, length, equals, output],
      edges: [
        createEdge(baseList.id, 'value', append.id, 'list'),
        createEdge(item.id, 'value', append.id, 'item'),
        createEdge(append.id, 'result', length.id, 'list'),
        createEdge(length.id, 'result', equals.id, 'input'),
        createEdge(equals.id, 'result', output.id, 'condition'),
      ],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    const result = await executeCompiledActionPackV2('https://example.com/', compiled.pack!, runtime, DEFAULT_SETTINGS);
    expect(result.outputs.condition).toEqual({ type: 'bool', value: 1 });
  });

  it('enforces Decision Out on Content Blocker decision surfaces', () => {
    const workspace = createDefaultContentBlockerWorkspace();
    const pageLoad = workspace.surfaces!.find((surface) => surface.id === 'page-load')!;
    const decisionOut = pageLoad.nodes.find((node) => node.type === 'DecisionOut')!;
    const result = compileWorkspace({
      ...workspace,
      surfaces: workspace.surfaces!.map((surface) => surface.id === 'page-load'
        ? {
            ...surface,
            edges: surface.edges.filter((edge) => edge.target !== decisionOut.id),
          }
        : surface),
    });

    expect(result.ok).toBe(false);
    expect(result.validation.errors.join('\n')).toContain('Page Load Decision requires exactly one connected Decision Out block.');
  });

  it('migrates legacy content-blocker profile workspaces into typed Content Blockers', () => {
    const legacy = {
      ...createDefaultWorkspace(),
      schemaVersion: 7,
      workspaceType: undefined,
      metadata: {
        ...createDefaultWorkspace().metadata,
        profile: 'content-blocker',
      },
    };

    const result = validateWorkspaceFile(legacy);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.errors.join('; '));
    }
    expect(result.value.workspaceType).toBe('content-blocker');
    expect(result.value.surfaces?.map((surface) => surface.id)).toEqual(['page-load', 'recurring', 'challenge']);
  });

  it('verifies password locks and rejects non-local Ollama endpoints', async () => {
    const lock = await createPasswordLockState('correct horse battery staple');
    expect(await verifyPasswordLock(lock, 'correct horse battery staple')).toBe(true);
    expect(await verifyPasswordLock(lock, 'wrong password')).toBe(false);
    expect(validateOllamaEndpoint('http://127.0.0.1:11434/api/generate')).toBe('http://127.0.0.1:11434');
    expect(() => validateOllamaEndpoint('https://127.0.0.1:11434')).toThrow('Ollama endpoint must be local');
    expect(() => validateOllamaEndpoint('http://192.168.0.10:11434')).toThrow('Ollama endpoint must be local');
  });

  it('lists installed Ollama models from the local tags endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        models: [
          { name: 'phi4-mini:latest', model: 'phi4-mini:latest', modified_at: '2026-06-01T00:00:00Z', size: 1234, digest: 'abc' },
          { model: 'mistral:latest' },
        ],
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const models = await listOllamaModels({
      ollamaEndpoint: 'http://127.0.0.1:11434',
      ollamaTimeoutMs: 5_000,
    });

    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:11434/api/tags', expect.objectContaining({ method: 'GET', redirect: 'error' }));
    expect(models.map((model) => model.name)).toEqual(['phi4-mini:latest', 'mistral:latest']);
    vi.unstubAllGlobals();
  });

  it('handles empty and failed Ollama model lists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [] }), { status: 200 })));
    await expect(listOllamaModels({
      ollamaEndpoint: 'http://localhost:11434',
      ollamaTimeoutMs: 5_000,
    })).resolves.toEqual([]);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
    await expect(listOllamaModels({
      ollamaEndpoint: 'http://localhost:11434',
      ollamaTimeoutMs: 5_000,
    })).rejects.toThrow('Ollama model list failed with HTTP 500');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', {
      status: 200,
      headers: { 'content-length': '2000000' },
    })));
    await expect(listOllamaModels({
      ollamaEndpoint: 'http://localhost:11434',
      ollamaTimeoutMs: 5_000,
    })).rejects.toThrow('model list that is too large');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      models: Array.from({ length: 513 }, (_, index) => ({ name: `model-${index}` })),
    }), { status: 200 })));
    await expect(listOllamaModels({
      ollamaEndpoint: 'http://localhost:11434',
      ollamaTimeoutMs: 5_000,
    })).rejects.toThrow('more than 512 model entries');
    vi.unstubAllGlobals();
  });

  it('validates runtime overlay and hotkey messages strictly', () => {
    expect(isOverlayAppEventMessage({
      type: OVERLAY_APP_EVENT_MESSAGE,
      packId: 'pack-1',
      url: 'https://example.com/',
      event: {
        kind: 'mouse',
        eventType: 'pointerdown',
        button: 0,
        buttons: 1,
        x: 12,
        y: 20,
      },
    })).toBe(true);

    expect(isOverlayAppEventMessage({
      type: OVERLAY_APP_EVENT_MESSAGE,
      packId: 'pack-1',
      url: 'https://example.com/',
      event: {
        kind: 'mouse',
        eventType: 'pointerdown',
        button: 0,
        buttons: 1,
        x: Number.NaN,
        y: 20,
      },
    })).toBe(false);

    expect(isOverlayAppEventMessage({
      type: OVERLAY_APP_EVENT_MESSAGE,
      packId: 'pack-1',
      url: 'https://example.com/',
      event: {
        kind: 'keyboard',
        eventType: 'keydown',
        key: 'a',
        code: 'KeyA',
        keyCode: 65,
        injected: true,
      },
    })).toBe(false);

    expect(isHotkeyTriggerMessage({
      type: HOTKEY_TRIGGER_MESSAGE,
      hotkey: 'Ctrl+Shift+U',
      url: 'https://example.com/',
      selectedText: 'x'.repeat(65537),
    })).toBe(false);
  });

  it('blocks build until a terminal effect exists', () => {
    const workspace = createDefaultWorkspace();
    const result = compileWorkspace(workspace);

    expect(result.ok).toBe(false);
    expect(result.validation.errors.join(' ')).toContain('terminal side-effect');
  });

  it('allows storage-only workspaces without URL Data Out', () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const save = createWorkspaceNode('SaveLoad', { x: 260, y: 120 }, {
      saveLoadMode: 'SAVE',
      literalValue: 'debug:last-url',
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), save],
      edges: [createEdge(dataIn.id, 'url', save.id, 'value')],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    expect(compiled.pack!.vm.instructions.some((instruction) => instruction.op === 'SAVELOAD')).toBe(true);
  });

  it('allows display-only workspaces as terminal side effects', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const message = createWorkspaceNode('ShowMessage', { x: 260, y: 120 }, {
      promptMessage: 'Fallback message',
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), message],
      edges: [createEdge(dataIn.id, 'pageTitle', message.id, 'message')],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);

    const result = await executeCompiledActionPackV2(
      'https://example.com/',
      compiled.pack!,
      {
        ...runtime,
        readSource: async (source) => source === 'pageTitle' ? { type: 'string', value: 'Example Title' } : undefined,
        displayOverlay: async (request) => ({ type: 'dict', value: { displayed: { type: 'string', value: request.message } } }),
      },
      DEFAULT_SETTINGS,
    );

    expect(result.issues).toEqual([]);
    expect(result.trace).toContainEqual(expect.objectContaining({
      op: 'DISPLAY',
      message: 'Display completed',
    }));
  });

  it('keeps Show Message title and body separate', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const title = createWorkspaceNode('Constant', { x: 260, y: 40 }, {
      literalValue: 'Page notice',
      literalDataType: 'string',
    });
    const message = createWorkspaceNode('ShowMessage', { x: 520, y: 120 }, {
      promptTitle: 'Fallback title',
      promptMessage: 'Fallback message',
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), title, message],
      edges: [
        createEdge(title.id, 'value', message.id, 'title'),
        createEdge(dataIn.id, 'pageTitle', message.id, 'message'),
      ],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    expect(compiled.pack!.vm.instructions).toContainEqual(expect.objectContaining({
      op: 'DISPLAY',
      titleInput: `${title.id}.value`,
      input: `${dataIn.id}.pageTitle`,
    }));

    const seen: Array<{ title?: string; message: string }> = [];
    await executeCompiledActionPackV2(
      'https://example.com/',
      compiled.pack!,
      {
        ...runtime,
        readSource: async (source) => source === 'pageTitle' ? { type: 'string', value: 'Example Body' } : undefined,
        displayOverlay: async (request) => {
          seen.push({ title: request.title, message: request.message });
          return { type: 'dict', value: {} };
        },
      },
      DEFAULT_SETTINGS,
    );

    expect(seen).toEqual([{ title: 'Page notice', message: 'Example Body' }]);
  });

  it('allows Declare to initialize strings', async () => {
    const workspace = createDefaultWorkspace();
    const declaration = createWorkspaceNode('Declarations', { x: 260, y: 120 }, {
      variableName: 'greeting',
      literalValue: 'hello',
      literalDataType: 'string',
    });
    const message = createWorkspaceNode('ShowMessage', { x: 520, y: 120 }, {
      promptMessage: 'Terminal display',
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), declaration, message],
      edges: [],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    expect(compiled.pack!.vm.instructions).toContainEqual(expect.objectContaining({
      op: 'DECLARE',
      fallbackValue: { type: 'string', value: 'hello' },
    }));

    const result = await executeCompiledActionPackV2(
      'https://example.com/',
      compiled.pack!,
      {
        ...runtime,
        displayOverlay: async () => ({ type: 'dict', value: {} }),
      },
      DEFAULT_SETTINGS,
    );

    expect(result.trace).toContainEqual(expect.objectContaining({
      op: 'DECLARE',
      message: 'Declared $greeting',
      valueType: 'string',
      preview: 'hello',
    }));
  });

  it('builds substitution strings from connectors and declared variables', async () => {
    const workspace = createDefaultWorkspace();
    const declaration = createWorkspaceNode('Declarations', { x: 180, y: 40 }, {
      variableName: 'name',
      literalValue: 'Alice',
      literalDataType: 'string',
    });
    const constant = createWorkspaceNode('Constant', { x: 180, y: 180 }, {
      literalValue: 'World',
      literalDataType: 'string',
    });
    const substitution = createWorkspaceNode('Substitution', { x: 440, y: 120 }, {
      substitutionTemplate: 'Hello $1 from $name',
      substitutionInputCount: 2,
    });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 700, y: 120 });
    let written = '';
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), declaration, constant, substitution, extendedOut],
      edges: [
        createEdge(constant.id, 'value', substitution.id, 'value1'),
        createEdge(substitution.id, 'result', extendedOut.id, 'pageText'),
      ],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      writeDestination: async (_destination, value) => {
        written = String(value.value);
      },
    }, DEFAULT_SETTINGS);

    expect(written).toBe('Hello World from Alice');
  });

  it('scans active variables and ignores escaped dollar tokens', () => {
    expect(extractVariableReferences('$name \\$literal \\\\$stillLiteral $1').map((reference) => reference.token)).toEqual(['$name', '$1']);
    expect(resolveVariableText('\\$name \\\\$name $name', {
      resolveNamed: () => 'Alice',
    })).toBe('$name \\$name Alice');
  });

  it('copies and pastes selected workspace blocks with internal links', () => {
    const workspace = createDefaultWorkspace();
    const constant = createWorkspaceNode('Constant', { x: 100, y: 100 }, {
      literalValue: 'Hello',
      literalDataType: 'string',
    });
    const log = createWorkspaceNode('SaveStringToLog', { x: 360, y: 100 });
    const workspaceWithBlocks = {
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), constant, log],
      edges: [createEdge(constant.id, 'value', log.id, 'message')],
    };

    const clipboard = createWorkspaceBlockClipboard(workspaceWithBlocks, new Set([constant.id, log.id]));
    const pasted = pasteWorkspaceBlockClipboard(workspaceWithBlocks, clipboard, { x: 32, y: 40 });

    expect(pasted.pastedNodeIds).toHaveLength(2);
    expect(new Set(pasted.pastedNodeIds).has(constant.id)).toBe(false);
    expect(pasted.workspace.nodes).toHaveLength(workspaceWithBlocks.nodes.length + 2);
    expect(pasted.workspace.edges).toHaveLength(2);
    expect(pasted.workspace.edges.some((edge) => pasted.pastedNodeIds.includes(edge.source) && pasted.pastedNodeIds.includes(edge.target))).toBe(true);
    expect(pasted.workspace.nodes.find((node) => node.id === pasted.pastedNodeIds[0])?.position).toEqual({ x: 132, y: 140 });
  });

  it('writes log messages from declared string variables', async () => {
    const workspace = createDefaultWorkspace();
    const declaration = createWorkspaceNode('Declarations', { x: 120, y: 80 }, {
      variableName: 'string_1',
      literalValue: 'This is the first string.',
      literalDataType: 'string',
    });
    const log = createWorkspaceNode('SaveStringToLog', { x: 420, y: 80 }, {
      literalValue: '$string_1',
      logSeverity: 'warn',
    });
    const entries: Array<{ severity: string; message: string; nodeId: string }> = [];
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), declaration, log],
      edges: [],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      writeLog: async (entry) => {
        entries.push(entry);
      },
    }, DEFAULT_SETTINGS);

    expect(entries).toEqual([expect.objectContaining({ severity: 'warn', message: 'This is the first string.', nodeId: log.id })]);
  });

  it('writes escaped variable-looking log text literally', async () => {
    const workspace = createDefaultWorkspace();
    const declaration = createWorkspaceNode('Declarations', { x: 120, y: 80 }, {
      variableName: 'string_1',
      literalValue: 'This should not be used.',
      literalDataType: 'string',
    });
    const oneSlashLog = createWorkspaceNode('SaveStringToLog', { x: 420, y: 80 }, {
      literalValue: '\\$string_1',
      logSeverity: 'info',
    });
    const twoSlashLog = createWorkspaceNode('SaveStringToLog', { x: 420, y: 220 }, {
      literalValue: '\\\\$string_1',
      logSeverity: 'info',
    });
    const entries: Array<{ message: string }> = [];
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), declaration, oneSlashLog, twoSlashLog],
      edges: [],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      writeLog: async (entry) => {
        entries.push(entry);
      },
    }, DEFAULT_SETTINGS);

    expect(entries.map((entry) => entry.message)).toEqual(['$string_1', '\\$string_1']);
  });

  it('blocks missing and type-mismatched log variables', () => {
    const workspace = createDefaultWorkspace();
    const numberDeclaration = createWorkspaceNode('Declarations', { x: 120, y: 80 }, {
      variableName: 'count',
      literalValue: '2',
      literalDataType: 'number',
    });
    const missingLog = createWorkspaceNode('SaveStringToLog', { x: 420, y: 80 }, {
      literalValue: '$missing',
    });
    const wrongTypeLog = createWorkspaceNode('SaveStringToLog', { x: 420, y: 220 }, {
      literalValue: '$count',
    });
    const numberedLog = createWorkspaceNode('SaveStringToLog', { x: 420, y: 360 }, {
      literalValue: '$1',
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), numberDeclaration, missingLog, wrongTypeLog, numberedLog],
      edges: [],
    });

    expect(compiled.ok).toBe(false);
    expect(compiled.validation.errors.join(' ')).toContain('$missing is not declared');
    expect(compiled.validation.errors.join(' ')).toContain('$count is number, but Message expects string');
    expect(compiled.validation.errors.join(' ')).toContain('$1 is reserved for substitution connector inputs');
  });

  it('reserves numbered dollar names for substitution inputs', () => {
    const workspace = createDefaultWorkspace();
    const declaration = createWorkspaceNode('Declarations', { x: 260, y: 120 }, {
      variableName: '$1',
      literalValue: 'bad',
      literalDataType: 'string',
    });
    const message = createWorkspaceNode('ShowMessage', { x: 520, y: 120 }, {
      promptMessage: 'Terminal display',
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), declaration, message],
      edges: [],
    });

    expect(compiled.ok).toBe(false);
    expect(compiled.validation.errors.join(' ')).toContain('reserved for substitution connector inputs');
  });

  it('writes Action Pack log entries from the debug log block', async () => {
    const workspace = createDefaultWorkspace();
    const log = createWorkspaceNode('SaveStringToLog', { x: 260, y: 120 }, {
      literalValue: 'Reached checkpoint',
      logSeverity: 'warn',
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), log],
      edges: [],
    });
    const entries: Array<{ severity: string; message: string; nodeId: string }> = [];

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    const result = await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      writeLog: async (entry) => {
        entries.push(entry);
      },
    }, DEFAULT_SETTINGS);

    expect(result.exitCode).toBe(0);
    expect(entries).toEqual([expect.objectContaining({ severity: 'warn', message: 'Reached checkpoint', nodeId: log.id })]);
    expect(result.trace).toContainEqual(expect.objectContaining({ op: 'LOG', message: 'Logged warn' }));
  });

  it('aborts the current run when the Abort condition is true', async () => {
    const workspace = createDefaultWorkspace();
    const condition = createWorkspaceNode('Constant', { x: 180, y: 80 }, {
      literalValue: 'true',
      literalDataType: 'bool',
    });
    const abort = createWorkspaceNode('Abort', { x: 420, y: 80 }, {
      abortMessage: 'Stop here',
    });
    const saveAfterAbort = createWorkspaceNode('SharedState', { x: 680, y: 80 }, {
      sharedStateMode: 'SET',
      literalValue: 'after-abort',
      selectFalseValue: 'ran',
      literalDataType: 'string',
    });
    const session = new Map<string, GraphValue>();
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), condition, abort, saveAfterAbort],
      edges: [
        createEdge(condition.id, 'value', abort.id, 'condition'),
        createEdge(abort.id, 'result', saveAfterAbort.id, 'enabled'),
      ],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    const result = await executeCompiledActionPackV2('https://example.com/', compiled.pack!, {
      ...runtime,
      saveSessionValue: async (key, value) => {
        session.set(key, value);
      },
    }, DEFAULT_SETTINGS);

    expect(result.aborted).toBe(true);
    expect(result.exitCode).toBe(130);
    expect(session.has('after-abort')).toBe(false);
  });

  it('migrates older Declare fallback literals during import validation', () => {
    const workspace = createDefaultWorkspace();
    const declaration = createWorkspaceNode('Declarations', { x: 260, y: 120 }, {
      variableName: 'uppercaseOffset',
      literalValue: '32',
      literalDataType: 'number',
    });
    const message = createWorkspaceNode('ShowMessage', { x: 520, y: 120 }, {
      promptMessage: 'Terminal display',
    });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), declaration, message],
      edges: [],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);

    const legacyCandidate = structuredClone(compiled.pack!) as CompiledActionPackV2;
    const declareInstruction = legacyCandidate.vm.instructions.find((instruction) => instruction.op === 'DECLARE');
    const declareHandlerInstruction = legacyCandidate.vm.eventHandlers?.trigger?.find((instruction) => instruction.op === 'DECLARE');
    if (declareInstruction?.op === 'DECLARE') {
      (declareInstruction as unknown as { fallbackValue: string }).fallbackValue = '32';
    }
    if (declareHandlerInstruction?.op === 'DECLARE') {
      (declareHandlerInstruction as unknown as { fallbackValue: string }).fallbackValue = '32';
    }

    expect(validateCompiledActionPackV2(legacyCandidate)).toEqual(expect.objectContaining({ ok: true }));
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

  it('allows JSON values to feed string outputs without a pointless conversion block', () => {
    const workspace = createDefaultWorkspace();
    const input = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dict = createWorkspaceNode('DataStructure', { x: 260, y: 120 }, {
      dictKey: 'title',
    });
    const convert = createWorkspaceNode('Convert', { x: 520, y: 120 }, {
      convertMode: 'DICT_TO_JSON',
    });
    const extendedOut = createWorkspaceNode('ExtendedDataOut', { x: 780, y: 120 });
    const compiled = compileWorkspace({
      ...workspace,
      nodes: [...workspace.nodes.filter((node) => node.type !== 'DataFlowOut'), dict, convert, extendedOut],
      edges: [
        createEdge(input.id, 'pageTitle', dict.id, 'value'),
        createEdge(dict.id, 'result', convert.id, 'input'),
        createEdge(convert.id, 'result', extendedOut.id, 'clipboard'),
      ],
    });

    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
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
        instructions: compiled.pack!.vm.instructions.map((instruction) => instruction.op === 'GET_ASSET' ? { ...instruction, maxBytes: 99_999_999 } : instruction),
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

  it('requires a connected Condition Out block for conditional triggers', () => {
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
    expect(compiled.validation.errors.join(' ')).toContain('Conditional Run requires exactly one connected Condition Out block');
  });

  it('embeds and evaluates a condition VM for conditional triggers', async () => {
    const workspace = createConditionalWorkspace('1');
    const compiled = compileWorkspace(workspace, { conditionWorkspaces: [workspace] });

    expect(compiled.ok).toBe(true);
    expect(compiled.pack?.triggerPlan.conditionVm?.instructions.some((instruction) => instruction.op === 'CONDITION_OUT')).toBe(true);
    expect(compiled.pack?.triggerPlan.conditionStateKey).toContain(workspace.metadata.id);

    const condition = await evaluateCompiledActionPackCondition('https://example.com/', compiled.pack!, runtime, DEFAULT_SETTINGS);
    expect(condition.matched).toBe(true);
    expect(condition.issues).toEqual([]);
  });

  it('runs every Text Transform mode', async () => {
    const cases = [
      ['TRIM', '  Text  ', 'Text'],
      ['COLLAPSE_WHITESPACE', '  a\t b\n c  ', 'a b c'],
      ['NORMALIZE_LINE_ENDINGS', 'a\r\nb\rc', 'a\nb\nc'],
      ['STRIP_CONTROL_CHARS', 'a\u0000b\u0007c\n', 'abc\n'],
      ['UPPERCASE', 'Abc', 'ABC'],
      ['LOWERCASE', 'Abc', 'abc'],
      ['TITLE_CASE', 'hello world', 'Hello World'],
      ['URL_ENCODE', 'a b&c', 'a%20b%26c'],
      ['URL_DECODE', 'a%20b%26c', 'a b&c'],
    ] as const;

    for (const [mode, inputValue, expected] of cases) {
      const workspace = createDefaultWorkspace();
      const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
      const transform = createWorkspaceNode('TextTransform', { x: 260, y: 80 }, { textTransformMode: mode });
      const output = createWorkspaceNode('ExtendedDataOut', { x: 560, y: 80 });
      const result = await runWorkspaceForClipboard({
        ...workspace,
        trigger: { type: 'CONTEXT_MENU', inputSources: ['selectedText'] },
        nodes: [...workspace.nodes, transform, output],
        edges: [
          createEdge(dataIn.id, 'selectedText', transform.id, 'input'),
          createEdge(transform.id, 'result', output.id, 'clipboard'),
        ],
      }, { selectedText: { type: 'string', value: inputValue } });

      expect(result.clipboard).toBe(expected);
    }
  });

  it('runs Text Split/Join modes', async () => {
    const splitCases = [
      ['SPLIT_LINES', 'a\r\nb\nc', 'JOIN_CUSTOM', '|', 'a|b|c'],
      ['SPLIT_WHITESPACE', 'a  b\tc', 'JOIN_COMMA', ',', 'a, b, c'],
      ['SPLIT_COMMA', 'a, b,c', 'JOIN_SPACE', ' ', 'a b c'],
      ['SPLIT_CUSTOM', 'a|b|c', 'JOIN_LINES', '|', 'a\nb\nc'],
    ] as const;

    for (const [splitMode, inputValue, joinMode, separator, expected] of splitCases) {
      const workspace = createDefaultWorkspace();
      const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
      const split = createWorkspaceNode('TextSplitJoin', { x: 260, y: 80 }, { splitJoinMode: splitMode, splitJoinSeparator: separator });
      const join = createWorkspaceNode('TextSplitJoin', { x: 560, y: 80 }, { splitJoinMode: joinMode, splitJoinSeparator: separator });
      const output = createWorkspaceNode('ExtendedDataOut', { x: 860, y: 80 });
      const result = await runWorkspaceForClipboard({
        ...workspace,
        trigger: { type: 'CONTEXT_MENU', inputSources: ['selectedText'] },
        nodes: [...workspace.nodes, split, join, output],
        edges: [
          createEdge(dataIn.id, 'selectedText', split.id, 'input'),
          createEdge(split.id, 'result', join.id, 'input'),
          createEdge(join.id, 'result', output.id, 'clipboard'),
        ],
      }, { selectedText: { type: 'string', value: inputValue } });

      expect(result.clipboard).toBe(expected);
    }
  });

  it('runs URL Query modes', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const keep = createWorkspaceNode('UrlQuery', { x: 260, y: 80 }, { urlQueryMode: 'KEEP_PARAMS', urlQueryParams: 'id a' });
    const set = createWorkspaceNode('UrlQuery', { x: 520, y: 80 }, { urlQueryMode: 'SET_PARAM', urlQueryKey: 'page', urlQueryValue: '2' });
    const del = createWorkspaceNode('UrlQuery', { x: 780, y: 80 }, { urlQueryMode: 'DELETE_PARAM', urlQueryKey: 'a' });
    const sort = createWorkspaceNode('UrlQuery', { x: 1040, y: 80 }, { urlQueryMode: 'SORT_PARAMS' });
    const run = await executeCompiledActionPackV2(
      'https://example.com/path?b=2&id=7&a=1&utm=1',
      compileWorkspace({
        ...workspace,
        nodes: [...workspace.nodes, keep, set, del, sort],
        edges: [
          createEdge(dataIn.id, 'url', keep.id, 'input'),
          createEdge(keep.id, 'result', set.id, 'input'),
          createEdge(set.id, 'result', del.id, 'input'),
          createEdge(del.id, 'result', sort.id, 'input'),
          createEdge(sort.id, 'result', dataOut.id, 'url'),
        ],
      }).pack!,
      runtime,
      DEFAULT_SETTINGS,
    );
    expect(run.finalUrl).toBe('https://example.com/path?id=7&page=2');

    const parseWorkspace = createDefaultWorkspace();
    const parseInput = parseWorkspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const parse = createWorkspaceNode('UrlQuery', { x: 260, y: 80 }, { urlQueryMode: 'PARSE' });
    const rebuild = createWorkspaceNode('UrlQuery', { x: 520, y: 80 }, { urlQueryMode: 'REBUILD' });
    const get = createWorkspaceNode('UrlQuery', { x: 780, y: 80 }, { urlQueryMode: 'GET_PARAM', urlQueryKey: 'id' });
    const output = createWorkspaceNode('ExtendedDataOut', { x: 1040, y: 80 });
    const parsed = await runWorkspaceForClipboard({
      ...parseWorkspace,
      nodes: [...parseWorkspace.nodes, parse, rebuild, get, output],
      edges: [
        createEdge(parseInput.id, 'url', parse.id, 'input'),
        createEdge(parse.id, 'result', rebuild.id, 'input'),
        createEdge(rebuild.id, 'result', get.id, 'input'),
        createEdge(get.id, 'result', output.id, 'clipboard'),
      ],
    }, {}, 'https://example.com/path?id=7&a=1');
    expect(parsed.clipboard).toBe('7');
  });

  it('runs Dict Operation modes', async () => {
    const cases = [
      ['KEYS', 'a, b'],
      ['VALUES', 'one, two'],
      ['HAS_KEY', '1'],
      ['DELETE_KEY', '{"b":{"type":"string","value":"two"}}'],
      ['MERGE', '{"a":{"type":"string","value":"one"},"b":{"type":"string","value":"two"},"c":{"type":"string","value":"three"}}'],
    ] as const;

    for (const [mode, expected] of cases) {
      const workspace = createDefaultWorkspace();
      const dict = createWorkspaceNode('Constant', { x: 0, y: 40 }, { literalDataType: 'dict', literalValue: '{"a":"one","b":"two"}' });
      const other = createWorkspaceNode('Constant', { x: 0, y: 180 }, { literalDataType: 'dict', literalValue: '{"c":"three"}' });
      const op = createWorkspaceNode('DictOperation', { x: 280, y: 80 }, { dictOperationMode: mode, dictKey: 'a' });
      const asText = mode === 'HAS_KEY'
        ? createWorkspaceNode('TextTransform', { x: 560, y: 80 }, { textTransformMode: 'TRIM' })
        : mode === 'KEYS' || mode === 'VALUES'
          ? createWorkspaceNode('TextSplitJoin', { x: 560, y: 80 }, { splitJoinMode: 'JOIN_COMMA' })
          : createWorkspaceNode('Convert', { x: 560, y: 80 }, { convertMode: 'DICT_TO_JSON' });
      const output = createWorkspaceNode('ExtendedDataOut', { x: 840, y: 80 });
      const result = await runWorkspaceForClipboard({
        ...workspace,
        nodes: [...workspace.nodes, dict, other, op, asText, output],
        edges: [
          createEdge(dict.id, 'value', op.id, 'dict'),
          createEdge(other.id, 'value', op.id, 'other'),
          createEdge(op.id, 'result', asText.id, 'input'),
          createEdge(asText.id, 'result', output.id, 'clipboard'),
        ],
      });

      expect(result.clipboard).toBe(expected);
    }
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

  it('rejects imported conditional trigger plans without embedded condition programs', async () => {
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
    ).rejects.toThrow('triggerPlan.conditionVm is required');
  });

  it('rejects imported conditional condition VMs with side-effect instructions', async () => {
    const workspace = createConditionalWorkspace('1');
    const compiled = compileWorkspace(workspace, { conditionWorkspaces: [workspace] });
    expect(compiled.ok).toBe(true);
    const pack = compiled.pack!;
    const conditionVm = pack.triggerPlan.conditionVm!;
    const unsafePack: CompiledActionPackV2 = {
      ...pack,
      triggerPlan: {
        ...pack.triggerPlan,
        conditionVm: {
          ...conditionVm,
          instructions: [
            ...conditionVm.instructions,
            {
              op: 'OUTPUT',
              nodeId: 'unsafe-condition-output',
              input: pack.triggerPlan.conditionOutput,
              destination: 'clipboard',
              dataType: 'string',
              risk: 'high',
            },
          ],
        },
      },
    };

    await expect(
      importCompiledActionPackV2Binary(await exportCompiledActionPackV2Binary(unsafePack)),
    ).rejects.toThrow('not allowed in conditional Run checks');
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

    expect(BUNDLED_ACTION_PACK_EXAMPLES.map((example) => example.slug)).toEqual([
      'clean-share-link',
      'open-github-pr-files',
      'search-selected-text',
      'copy-markdown-citation',
      'normalize-clipboard-text',
      'research-trail',
      'redact-emails-for-screen-sharing',
      'fetch-and-preview-text',
      'confirmed-webhook-test',
      '20-20-20-break-reminder',
      'focus-sprint-timer',
      'normalize-text-custom-block-source',
    ]);
    expect(BUNDLED_ACTION_PACK_EXAMPLES.filter((example) => example.collection === 'bundled')).toHaveLength(6);
    expect(BUNDLED_ACTION_PACK_EXAMPLES.filter((example) => example.collection === 'examples')).toHaveLength(6);
    expect(BUNDLED_ACTION_PACK_EXAMPLES.some((example) => /snake|variable-use-across-runs/i.test(example.slug))).toBe(false);
    expect(formatRunType(BUNDLED_ACTION_PACK_EXAMPLES.find((example) => example.kind === 'custom-block-source')?.trigger)).toBe('Custom Block source');
    expect(workspaces).toHaveLength(12);
    expect(packs).toHaveLength(11);
    expect(new Set(BUNDLED_ACTION_PACK_EXAMPLES.map((example) => example.id)).size).toBe(12);
    expect(new Set(BUNDLED_ACTION_PACK_EXAMPLES.map((example) => example.slug)).size).toBe(12);

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

    expect(Array.from(usedActions).sort()).toEqual(['REMOVE', 'SUBSTITUTE']);
    expect(Array.from(usedMatchModes)).toEqual(['STANDARD']);
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
        const value: GraphValue = request.kind === 'CONFIRM'
          ? { type: 'bool', value: 1 }
          : request.kind === 'PROMPT_NUMBER'
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
      const inputUrl = pack.manifest.name === 'Open GitHub PR Files'
        ? 'https://github.com/acme/project/pull/42?tab=conversation'
        : 'https://example.com/path?utm_source=newsletter&ref=abc&id=123&keep=1';
      const result = await executeCompiledActionPackV2(inputUrl, pack, exampleRuntime, DEFAULT_SETTINGS, {
        handler: 'trigger',
        event: { kind: 'trigger', hotkey: pack.manifest.trigger.hotkey, url: inputUrl },
      });

      expect(result.issues, pack.manifest.name).toEqual([]);
    }

    expect(session.has('wellness:last-20-20-20-reminder')).toBe(true);
    expect(session.has('research-trail:last-title')).toBe(true);
    expect(session.has('research-trail:last-url')).toBe(true);
    expect(session.get('focus-sprint:remaining-ms')).toEqual({ type: 'number', value: 1_500_000 });
    expect(session.get('focus-sprint:paused')).toEqual({ type: 'number', value: 0 });
    expect(destinationWrites).toContain('pageText');
    expect(destinationWrites).toContain('clipboard');
  });

  it('only reads connected high-risk sources and gates page redaction behind confirmation', async () => {
    const redaction = createBundledExampleActionPacks().find((pack) => pack.manifest.name === 'Redact Emails for Screen Sharing');
    expect(redaction).toBeTruthy();

    const sourceInstructions = redaction!.vm.instructions.filter((instruction) => instruction.op === 'SOURCE');
    expect(sourceInstructions.map((instruction) => instruction.source)).toContain('pageText');
    expect(sourceInstructions.map((instruction) => instruction.source)).not.toContain('clipboard');

    const readSources: string[] = [];
    const mutations: GraphValue[] = [];
    let confirmed = false;
    const redactionRuntime: GraphRuntime = {
      ...runtime,
      readSource: async (source) => {
        readSources.push(source);
        if (source === 'clipboard') {
          throw new Error('clipboard should not be read for page redaction');
        }
        if (source === 'pageText') {
          return { type: 'string', value: 'Contact alice@example.com for access.' };
        }
        return undefined;
      },
      requestUserInteraction: async () => ({
        type: 'dict',
        value: {
          ok: { type: 'bool', value: 1 },
          cancelled: { type: 'bool', value: 0 },
          value: { type: 'bool', value: confirmed ? 1 : 0 },
        },
      }),
      displayOverlay: async () => ({ type: 'dict', value: { ok: { type: 'bool', value: 1 } } }),
      mutatePageText: async (value) => {
        mutations.push(value);
      },
    };

    const denied = await executeCompiledActionPackV2(
      'https://example.com/page',
      redaction!,
      redactionRuntime,
      DEFAULT_SETTINGS,
    );
    expect(denied.issues).toEqual([]);
    expect(mutations).toEqual([]);

    confirmed = true;
    const allowed = await executeCompiledActionPackV2('https://example.com/page', redaction!, redactionRuntime, DEFAULT_SETTINGS);
    expect(allowed.issues).toEqual([]);
    expect(readSources).not.toContain('clipboard');
    expect(mutations.at(-1)).toEqual({ type: 'string', value: 'Contact [email redacted] for access.' });
  });

  it('keeps remote examples prompted, bounded, preview-only, and confirmation-gated', async () => {
    const packs = new Map(createBundledExampleActionPacks().map((pack) => [pack.manifest.name, pack]));
    const remoteRequests: Array<{ url: string; method: 'GET' | 'POST'; body?: unknown }> = [];
    const shownMessages: string[] = [];
    const pageMutations: GraphValue[] = [];
    let confirmed = false;
    const remoteRuntime: GraphRuntime = {
      ...runtime,
      requestUserInteraction: async (request) => ({
        type: 'dict',
        value: {
          ok: { type: 'bool', value: 1 },
          cancelled: { type: 'bool', value: 0 },
          value: request.kind === 'CONFIRM'
            ? { type: 'bool', value: confirmed ? 1 : 0 }
            : { type: 'string', value: request.defaultValue ?? '' },
        },
      }),
      fetchRemote: async (request) => {
        remoteRequests.push({ url: request.url, method: request.method, body: request.body });
        return { type: request.outputDataType, value: 'bounded test response' } as GraphValue;
      },
      displayOverlay: async (request) => {
        shownMessages.push(request.message);
        return { type: 'dict', value: { ok: { type: 'bool', value: 1 } } };
      },
      mutatePageText: async (value) => {
        pageMutations.push(value);
      },
    };

    await executeCompiledActionPackV2('https://private.example/current', packs.get('Fetch and Preview Text')!, remoteRuntime, DEFAULT_SETTINGS);
    expect(remoteRequests).toHaveLength(1);
    expect(remoteRequests[0]).toMatchObject({ url: 'https://example.com/', method: 'GET' });
    expect(shownMessages.at(-1)).toContain('bounded test response');
    expect(pageMutations).toEqual([]);

    await executeCompiledActionPackV2('https://private.example/current', packs.get('Confirmed Webhook Test')!, remoteRuntime, DEFAULT_SETTINGS);
    expect(remoteRequests).toHaveLength(1);
    expect(shownMessages.at(-1)).toContain('No data was sent');

    confirmed = true;
    await executeCompiledActionPackV2('https://private.example/current', packs.get('Confirmed Webhook Test')!, remoteRuntime, DEFAULT_SETTINGS);
    expect(remoteRequests).toHaveLength(2);
    expect(remoteRequests[1]).toEqual({
      url: 'https://httpbin.org/post',
      method: 'POST',
      body: { source: 'URL Alchemist example', message: 'Confirmed webhook test' },
    });
    expect(JSON.stringify(remoteRequests[1]?.body)).not.toContain('private.example');
  });

  it('builds the Focus Sprint example from generic overlay event blocks', () => {
    const focusSprint = createBundledExampleWorkspaces().find((workspace) => workspace.metadata.name === 'Focus Sprint Timer');
    expect(focusSprint).toBeTruthy();

    const compiled = compileWorkspace(focusSprint!);
    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    expect(focusSprint!.nodes.some((node) => /focus|sprint/i.test(node.type))).toBe(false);
    expect(compiled.pack!.vm.instructions.some((instruction) => /focus|sprint/i.test(instruction.op))).toBe(false);
    expect(compiled.pack!.vm.eventHandlers?.trigger?.length).toBeGreaterThan(0);
    expect(compiled.pack!.vm.eventHandlers?.keyboard?.length).toBeGreaterThan(0);
    expect(compiled.pack!.vm.eventHandlers?.mouse ?? []).toHaveLength(0);
    expect(compiled.pack!.vm.eventHandlers?.tick?.length).toBeGreaterThan(0);
  });

  it('simulates Focus Sprint pause, resume, countdown, and close controls', async () => {
    const focusSprint = createBundledExampleWorkspaces().find((workspace) => workspace.metadata.name === 'Focus Sprint Timer')!;
    const compiled = compileWorkspace(focusSprint);
    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);

    const session = new Map<string, GraphValue>();
    const overlayEvents: string[] = [];
    let overlayActive = false;
    const focusRuntime: GraphRuntime = {
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

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, focusRuntime, DEFAULT_SETTINGS, {
      handler: 'trigger',
      event: { kind: 'trigger', hotkey: compiled.pack!.manifest.trigger.hotkey, url: 'https://example.com/' },
    });
    expect(overlayEvents).toContain('START');
    expect(session.get('focus-sprint:remaining-ms')).toEqual({ type: 'number', value: 1_500_000 });
    expect(session.get('focus-sprint:paused')).toEqual({ type: 'number', value: 0 });

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, focusRuntime, DEFAULT_SETTINGS, {
      handler: 'keyboard',
      event: { kind: 'keyboard', eventType: 'keydown', key: ' ', code: 'Space', keyCode: 32 },
    });
    expect(session.get('focus-sprint:paused')).toEqual({ type: 'number', value: 1 });

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, focusRuntime, DEFAULT_SETTINGS, {
      handler: 'tick',
      event: { kind: 'tick', tick: 1, deltaMs: 1_000 },
    });
    expect(session.get('focus-sprint:remaining-ms')).toEqual({ type: 'number', value: 1_500_000 });

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, focusRuntime, DEFAULT_SETTINGS, {
      handler: 'keyboard',
      event: { kind: 'keyboard', eventType: 'keydown', key: ' ', code: 'Space', keyCode: 32 },
    });
    expect(session.get('focus-sprint:paused')).toEqual({ type: 'number', value: 0 });

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, focusRuntime, DEFAULT_SETTINGS, {
      handler: 'tick',
      event: { kind: 'tick', tick: 2, deltaMs: 1_000 },
    });
    expect(session.get('focus-sprint:remaining-ms')).toEqual({ type: 'number', value: 1_499_000 });

    await executeCompiledActionPackV2('https://example.com/', compiled.pack!, focusRuntime, DEFAULT_SETTINGS, {
      handler: 'keyboard',
      event: { kind: 'keyboard', eventType: 'keydown', key: 'Escape', code: 'Escape', keyCode: 27 },
    });
    expect(overlayEvents).toContain('STOP');
  });

  it('round-trips generated bundled workspace and action pack artifacts', async () => {
    const indexPath = resolve(projectRoot, 'public/bundled-actionpacks/index.json');
    type IndexedExample = (typeof BUNDLED_ACTION_PACK_EXAMPLES)[number] & {
      artifactHashes: { workspaceSha256: string; actionPackSha256?: string };
    };
    const index = JSON.parse(await readFile(indexPath, 'utf8')) as { examples: IndexedExample[] };
    const indexedById = new Map(index.examples.map((example) => [example.id, example]));

    expect(index.examples.map((example) => example.id)).toEqual(BUNDLED_ACTION_PACK_EXAMPLES.map((example) => example.id));

    for (const example of BUNDLED_ACTION_PACK_EXAMPLES) {
      const workspaceBytes = new Uint8Array(await readFile(resolve(projectRoot, 'public', example.workspacePath)));
      const workspace = await importWorkspaceBinary(workspaceBytes);
      const indexedExample = indexedById.get(example.id);

      expect(workspace.workspace.metadata.id).toBe(example.id);
      expect(await sha256Hex(workspaceBytes)).toBe(indexedExample?.artifactHashes.workspaceSha256);
      expect(workspace.workspace.metadata.compatibility?.firefox?.status).toBe('supported');
      expect(workspace.workspace.metadata.compatibility?.firefoxAndroid?.status).toBe('source-only');
      if (example.actionPackPath) {
        const actionPackBytes = new Uint8Array(await readFile(resolve(projectRoot, 'public', example.actionPackPath)));
        const pack = await importCompiledActionPackV2Binary(actionPackBytes);
        expect(pack.pack.manifest.id).toBe(example.id);
        expect(await sha256Hex(actionPackBytes)).toBe(indexedExample?.artifactHashes.actionPackSha256);
      } else {
        expect(workspace.workspace.workspaceType).toBe('custom-block');
      }
    }
  });

  it('round-trips backup blobs with checksum validation', async () => {
    const state = {
      ...getDefaultState(),
      settings: {
        ...getDefaultState().settings,
        syncEnabled: true,
        aiWorkspaceInstructions: 'backup-specific AI guidance',
      },
      actionPacksV2: [createBasicCompiledPack()],
      workspacesV2: [createDefaultWorkspace()],
    };
    const backup = await exportBackupState(state);
    const restored = await importBackupState(backup);

    expect(restored.settings.syncEnabled).toBe(true);
    expect(restored.settings.aiWorkspaceInstructions).toBe('backup-specific AI guidance');
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
    expect(restored.settings.aiWorkspaceInstructions).toBe(DEFAULT_AI_WORKSPACE_INSTRUCTIONS);
  });

  it('preserves, caps, and keeps editable AI workspace instructions out of browser sync', () => {
    expect(normalizeAiWorkspaceInstructions('')).toBe('');
    expect(normalizeAiWorkspaceInstructions('custom guidance')).toBe('custom guidance');

    const oversizedInstructions = 'x'.repeat(AI_WORKSPACE_INSTRUCTIONS_MAX_CHARS + 25);
    const restored = normalizeStoredState({
      ...getDefaultState(),
      settings: {
        ...getDefaultState().settings,
        aiWorkspaceInstructions: oversizedInstructions,
      },
    });
    expect(restored.settings.aiWorkspaceInstructions).toBe('x'.repeat(AI_WORKSPACE_INSTRUCTIONS_MAX_CHARS));

    const empty = normalizeStoredState({
      ...getDefaultState(),
      settings: {
        ...getDefaultState().settings,
        aiWorkspaceInstructions: '',
      },
    });
    expect(empty.settings.aiWorkspaceInstructions).toBe('');

    const localState = {
      ...getDefaultState(),
      settings: {
        ...getDefaultState().settings,
        aiWorkspaceInstructions: 'private local guidance',
      },
    };
    const syncSnapshot = createSyncSnapshot(localState);
    expect(syncSnapshot.settings.aiWorkspaceInstructions).toBe(DEFAULT_AI_WORKSPACE_INSTRUCTIONS);
    expect(localState.settings.aiWorkspaceInstructions).toBe('private local guidance');
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

  it('executes polished starter workflows with useful, deterministic outcomes', async () => {
    const packs = new Map(createBundledExampleActionPacks().map((pack) => [pack.manifest.name, pack]));
    const written: Record<string, string> = {};
    const saved: Record<string, GraphValue> = {};
    const shownMessages: string[] = [];
    let clipboardText = '\u0000  First\r\n\r\nSecond\u0007 line  ';
    let selectedText = 'C++ & café';
    let pageTitle = 'Example Title';
    let linkUrl = 'https://github.com/acme/project/pull/42/files?diff=split';
    const contextRuntime: GraphRuntime = {
      ...runtime,
      readClipboard: async () => clipboardText,
      readSource: async (source) => {
        if (source === 'clipboard') {
          return { type: 'string', value: clipboardText };
        }

        if (source === 'selectedText') {
          return { type: 'string', value: selectedText };
        }

        if (source === 'pageTitle') {
          return { type: 'string', value: pageTitle };
        }

        if (source === 'linkUrl') {
          return { type: 'URL', value: linkUrl };
        }

        return undefined;
      },
      loadSessionValue: async (key) => saved[key],
      saveSessionValue: async (key, value) => {
        saved[key] = value;
      },
      writeDestination: async (destination, value) => {
        written[destination] = String(value.value);
      },
      displayOverlay: async (request) => {
        shownMessages.push(request.message);
        return { type: 'dict', value: { ok: { type: 'bool', value: 1 } } };
      },
      writeLog: async (entry) => {
        shownMessages.push(entry.message);
      },
    };

    const cleaned = await executeCompiledActionPackV2(
      'https://example.com/p?utm_source=x&sig=keep&utm_medium=y&foo=1#part',
      packs.get('Clean Share Link')!,
      contextRuntime,
      DEFAULT_SETTINGS,
    );
    expect(cleaned.finalUrl).toBe('https://example.com/p?sig=keep&foo=1#part');

    const githubFiles = await executeCompiledActionPackV2(
      'https://example.com/',
      packs.get('Open GitHub PR Files')!,
      contextRuntime,
      DEFAULT_SETTINGS,
    );
    expect(githubFiles.finalUrl).toBe(linkUrl);

    const selectedResult = await executeCompiledActionPackV2(
      'https://example.com/',
      packs.get('Search Selected Text')!,
      contextRuntime,
      DEFAULT_SETTINGS,
    );
    expect(selectedResult.finalUrl).toBe('https://www.google.com/search?q=C%2B%2B%20%26%20caf%C3%A9');

    await executeCompiledActionPackV2('https://example.com/', packs.get('Normalize Clipboard Text')!, contextRuntime, DEFAULT_SETTINGS);
    expect(written.clipboard).toBe('First\n\nSecond line');

    await executeCompiledActionPackV2('https://example.com/article', packs.get('Copy Markdown Citation')!, contextRuntime, DEFAULT_SETTINGS);
    expect(written.clipboard).toMatch(/^\*\*Example Title\*\*\n<https:\/\/example\.com\/article>\nAccessed /);

    await executeCompiledActionPackV2('https://example.com/first', packs.get('Research Trail')!, contextRuntime, DEFAULT_SETTINGS);
    expect(saved['research-trail:last-title']).toEqual({ type: 'string', value: 'Example Title' });
    expect(saved['research-trail:last-url']).toEqual({ type: 'URL', value: 'https://example.com/first' });
    expect(shownMessages.at(-1)).toContain('No previous page yet');

    pageTitle = 'Second Reference';
    await executeCompiledActionPackV2('https://example.com/second', packs.get('Research Trail')!, contextRuntime, DEFAULT_SETTINGS);
    expect(shownMessages.at(-1)).toContain('Example Title');
    expect(shownMessages.at(-1)).toContain('Second Reference');
    expect(saved['research-trail:last-url']).toEqual({ type: 'URL', value: 'https://example.com/second' });

    clipboardText = 'unused';
    selectedText = 'unused';
  });
});
