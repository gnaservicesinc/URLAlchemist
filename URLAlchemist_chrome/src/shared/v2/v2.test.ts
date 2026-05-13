import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../constants';
import { executeRegexJobRequest } from '../regex/executeRegexJob';
import type { ActionPack, RegexTransformRequest } from '../types';
import { compileWorkspace } from './compiler';
import { executeCompiledActionPackV2, type GraphRuntime } from './vm';
import { createEdge, createDefaultWorkspace, createWorkspaceNode, workspaceFromLegacyPack } from './workspace';
import { exportCompiledActionPackV2Binary, exportWorkspaceBinary, importAnyArtifact } from './vault';

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

describe('v2 workspace compiler and VM', () => {
  it('blocks build until Data Out is connected', () => {
    const workspace = createDefaultWorkspace();
    const result = compileWorkspace(workspace);

    expect(result.ok).toBe(false);
    expect(result.validation.errors.join(' ')).toContain('Data Out');
  });

  it('compiles a basic URL regex flow and executes it', async () => {
    const workspace = createDefaultWorkspace();
    const dataIn = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
    const dataOut = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
    const regex = createWorkspaceNode('RegExpression', { x: 260, y: 120 }, {
      pattern: 'utm_[^&]+&?',
      action: 'REMOVE',
      matchMode: 'STANDARD',
    });
    const nextWorkspace = {
      ...workspace,
      nodes: [...workspace.nodes, regex],
      edges: [
        createEdge(dataIn.id, 'url', regex.id, 'input'),
        createEdge(regex.id, 'result', dataOut.id, 'url'),
      ],
    };
    const compiled = compileWorkspace(nextWorkspace);

    expect(compiled.ok).toBe(true);
    const result = await executeCompiledActionPackV2(
      'https://example.com/?utm_source=newsletter&keep=1',
      compiled.pack!,
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
    expect(compiled.pack!.vm.instructions.some((instruction) => instruction.op === 'REGEX_TRANSFORM')).toBe(true);
  });

  it('detects workspace and action pack artifacts by header instead of extension', async () => {
    const workspace = workspaceFromLegacyPack(createLegacyPack());
    const compiled = compileWorkspace(workspace);
    const workspaceArtifact = await importAnyArtifact(await exportWorkspaceBinary(workspace));
    const packArtifact = await importAnyArtifact(await exportCompiledActionPackV2Binary(compiled.pack!));

    expect(workspaceArtifact.kind).toBe('workspace');
    expect(packArtifact.kind).toBe('action-pack');
  });
});
