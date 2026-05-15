import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_SETTINGS } from '../constants';
import { exportBackupState, importBackupState } from '../backup';
import { executeRegexJobRequest } from '../regex/executeRegexJob';
import type { ActionPack, RegexTransformRequest } from '../types';
import { getDefaultState } from '../storage';
import { validateCompiledActionPackV2 } from './actionPackValidator';
import { BUNDLED_ACTION_PACK_EXAMPLES, createBundledExampleActionPacks, createBundledExampleWorkspaces } from './bundledExamples';
import { compileWorkspace } from './compiler';
import { createSandboxGraphRuntime } from './sandboxRuntime';
import { BLOCK_TYPE_IDS, type BlockKind, type CompiledActionPackV2 } from './types';
import { executeCompiledActionPackV2, type GraphRuntime } from './vm';
import { createEdge, createDefaultWorkspace, createWorkspaceNode, workspaceFromLegacyPack } from './workspace';
import {
  exportCompiledActionPackV2Binary,
  exportWorkspaceBinary,
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

  it('migrates legacy compiled ALWAYS packs into input-data trigger plans', () => {
    const pack = createBasicCompiledPack();
    const legacy = {
      ...pack,
      schemaVersion: 2,
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
      expect(validation.pack.schemaVersion).toBe(3);
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

  it('compiles every bundled example and covers the v2 block surface', () => {
    const workspaces = createBundledExampleWorkspaces();
    const packs = createBundledExampleActionPacks();
    const usedBlockKinds = new Set<BlockKind>();
    const usedActions = new Set<string>();
    const usedMatchModes = new Set<string>();

    expect(workspaces).toHaveLength(10);
    expect(packs).toHaveLength(10);

    workspaces.forEach((workspace) => {
      const compiled = compileWorkspace(workspace);
      expect(compiled.ok, `${workspace.metadata.name}: ${compiled.validation.errors.join('; ')}`).toBe(true);
      workspace.nodes.forEach((node) => {
        usedBlockKinds.add(node.type);
        if (node.type === 'RegExpression') {
          usedActions.add(node.settings.action ?? 'SUBSTITUTE');
          usedMatchModes.add(node.settings.matchMode ?? 'STANDARD');
        }
      });
    });

    expect(Array.from(usedBlockKinds).sort()).toEqual((Object.keys(BLOCK_TYPE_IDS) as BlockKind[]).sort());
    expect(Array.from(usedActions).sort()).toEqual(['APPEND', 'PREPEND', 'REMOVE', 'SUBSTITUTE']);
    expect(Array.from(usedMatchModes).sort()).toEqual(['AFTER_PATTERN', 'BEFORE_PATTERN', 'NTH_OCCURRENCE', 'STANDARD']);
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
