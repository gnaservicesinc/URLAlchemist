import { describe, expect, it } from 'vitest';

import { getEffectivePortDefinitions } from '../shared/v2/blockRegistry';
import { compileWorkspace } from '../shared/v2/compiler';
import {
  CUSTOM_BLOCK_CATEGORY_VALUES,
  type CompiledCustomBlockV2,
  type CustomBlockFieldDefinition,
  type GraphDataType,
  type WorkspaceBlockSettings,
  type WorkspaceFileV2,
} from '../shared/v2/types';
import {
  createEdge,
  createDefaultContentBlockerWorkspace,
  createDefaultCustomBlockWorkspace,
  createDefaultWorkspace,
  createWorkspaceNode,
  synchronizeCustomBlockIdentity,
  synchronizeCustomBlockInvocationMetadata,
  updateCustomBlockPortMetadata,
  updateWorkspaceMetadataFields,
  updateWorkspaceNodeSettings,
} from '../shared/v2/workspace';
import {
  availableBlockDefinitions,
  customBlockDefinition,
  settingsForDefinition,
  visibleCustomBlockFields,
} from './components/WorkspaceEditor';

function validCustomBlockWorkspace(): WorkspaceFileV2 {
  const workspace = createDefaultCustomBlockWorkspace();
  const inputNode = workspace.nodes.find((node) => node.type === 'CustomBlockInput')!;
  const outputNode = workspace.nodes.find((node) => node.type === 'CustomBlockOutput')!;
  return {
    ...workspace,
    metadata: {
      ...workspace.metadata,
      name: 'Format Text',
      version: 4,
    },
    customBlock: {
      ...workspace.customBlock!,
      blockId: 'format-text',
      label: 'Format Text',
      version: 4,
      category: 'convert',
      visibleWorkspaceTypes: ['data-modifier', 'content-blocker'],
      description: '',
      tips: ['Connect text to Source.', 'Read the formatted result.'],
      inputs: [{ id: 'source', label: 'Source text', dataType: 'string', tooltip: 'Text to format.' }],
      outputs: [{ id: 'formatted', label: 'Formatted text', dataType: 'string', tooltip: 'The formatted result.' }],
      fields: [{
        id: 'mode',
        label: 'Mode',
        dataType: 'string',
        defaultValue: 'plain',
        tooltip: 'Formatting mode.',
        visibility: 'advanced',
      }],
    },
    nodes: workspace.nodes.map((node) => node.type === 'CustomBlockInput'
      ? {
          ...node,
          settings: {
            ...node.settings,
            label: 'Source text',
            customPortId: 'source',
            customPortLabel: 'Source text',
            customPortDataType: 'string',
            customPortTooltip: 'Text to format.',
          },
        }
      : {
          ...node,
          settings: {
            ...node.settings,
            label: 'Formatted text',
            customPortId: 'formatted',
            customPortLabel: 'Formatted text',
            customPortDataType: 'string',
            customPortTooltip: 'The formatted result.',
          },
        }),
    edges: [createEdge(inputNode.id, 'value', outputNode.id, 'value')],
  };
}

function compiledCustomBlock(): CompiledCustomBlockV2 {
  const compiled = compileWorkspace(validCustomBlockWorkspace());
  expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
  expect(compiled.customBlock).toBeDefined();
  return compiled.customBlock!;
}

function compiledCustomBlockVersion(options: {
  name: string;
  version: number;
  inputId?: string;
  inputLabel: string;
  inputType: GraphDataType;
  inputTooltip: string;
  outputId?: string;
  outputLabel: string;
  outputType: GraphDataType;
  outputTooltip: string;
  fields: CustomBlockFieldDefinition[];
}): CompiledCustomBlockV2 {
  let workspace = updateWorkspaceMetadataFields(validCustomBlockWorkspace(), {
    name: options.name,
    version: options.version,
  });
  workspace = updateCustomBlockPortMetadata(workspace, 'input', 0, {
    id: options.inputId ?? 'source',
    label: options.inputLabel,
    dataType: options.inputType,
    tooltip: options.inputTooltip,
  });
  workspace = updateCustomBlockPortMetadata(workspace, 'output', 0, {
    id: options.outputId ?? 'formatted',
    label: options.outputLabel,
    dataType: options.outputType,
    tooltip: options.outputTooltip,
  });
  workspace = {
    ...workspace,
    customBlock: { ...workspace.customBlock!, fields: options.fields },
  };
  const compiled = compileWorkspace(workspace);
  expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
  return compiled.customBlock!;
}

function hostWorkspaceFor(block: CompiledCustomBlockV2): WorkspaceFileV2 {
  const workspace = createDefaultWorkspace();
  const inputNode = workspace.nodes.find((node) => node.type === 'DataFlowIn')!;
  const outputNode = workspace.nodes.find((node) => node.type === 'DataFlowOut')!;
  const invocation = createWorkspaceNode('CustomBlock', { x: 380, y: 120 }, {
    ...settingsForDefinition(customBlockDefinition(block)),
    label: 'Caller alias',
    customFieldValues: { mode: 'caller choice' },
  });
  return {
    ...workspace,
    nodes: [...workspace.nodes, invocation],
    edges: [
      createEdge(inputNode.id, 'url', invocation.id, block.inputs[0].id),
      createEdge(invocation.id, block.outputs[0].id, outputNode.id, 'url'),
    ],
  };
}

function contentBlockerWorkspaceFor(block: CompiledCustomBlockV2): WorkspaceFileV2 {
  const workspace = createDefaultContentBlockerWorkspace();
  const pageLoad = workspace.surfaces!.find((surface) => surface.id === 'page-load')!;
  const decision = pageLoad.nodes.find((node) => node.type === 'DecisionOut')!;
  const constant = createWorkspaceNode('Constant', { x: 80, y: 120 }, {
    literalDataType: 'number',
    literalValue: '1',
  });
  const invocation = createWorkspaceNode('CustomBlock', { x: 420, y: 120 },
    settingsForDefinition(customBlockDefinition(block)));

  return {
    ...workspace,
    surfaces: workspace.surfaces!.map((surface) => surface.id === 'page-load'
      ? {
          ...surface,
          nodes: [constant, invocation, decision],
          edges: [
            createEdge(constant.id, 'value', invocation.id, block.inputs[0].id),
            createEdge(invocation.id, block.outputs[0].id, decision.id, 'decision'),
          ],
        }
      : surface),
  };
}

function updateInputNode(
  workspace: WorkspaceFileV2,
  updates: Partial<WorkspaceBlockSettings>,
): WorkspaceFileV2 {
  return {
    ...workspace,
    nodes: workspace.nodes.map((node) => node.type === 'CustomBlockInput'
      ? { ...node, settings: { ...node.settings, ...updates } }
      : node),
  };
}

describe('Custom Block metadata parity', () => {
  it('preserves every user-authored field when building a picker definition and node settings', () => {
    const block = compiledCustomBlock();
    const definition = customBlockDefinition(block);

    expect(definition).toMatchObject({
      kind: 'CustomBlock',
      label: 'Format Text',
      category: 'convert',
      description: '',
      tips: ['Connect text to Source.', 'Read the formatted result.'],
      custom: {
        blockId: 'format-text',
        version: 4,
        sourceWorkspaceId: block.sourceWorkspaceId,
      },
      visibleWorkspaceTypes: ['data-modifier', 'content-blocker'],
      inputs: [{ id: 'source', label: 'Source text', dataType: 'string', description: 'Text to format.' }],
      outputs: [{ id: 'formatted', label: 'Formatted text', dataType: 'string', description: 'The formatted result.' }],
      defaultSettings: {
        label: 'Format Text',
        customBlockId: 'format-text',
        customBlockName: 'Format Text',
        customBlockVersion: 4,
        customBlockInputs: block.inputs,
        customBlockOutputs: block.outputs,
        customBlockFields: block.fields,
        customFieldValues: { mode: 'plain' },
      },
    });

    expect(settingsForDefinition(definition)).toMatchObject({
      customBlockId: 'format-text',
      customBlockName: 'Format Text',
      customBlockVersion: 4,
      customBlockInputs: [{ id: 'source', label: 'Source text', dataType: 'string', tooltip: 'Text to format.' }],
      customBlockOutputs: [{ id: 'formatted', label: 'Formatted text', dataType: 'string', tooltip: 'The formatted result.' }],
      customBlockFields: block.fields,
      customFieldValues: { mode: 'plain' },
    });
  });

  it('filters stale catch-all categories, unknown categories, incompatible blocks, and boundary pseudo-blocks', () => {
    const valid = compiledCustomBlock();
    const stale = { ...valid, blockId: 'stale-custom', category: 'custom' as const };
    const unknown = { ...valid, blockId: 'unknown-category', category: 'miscellaneous' as CompiledCustomBlockV2['category'] };
    const contentOnly = { ...valid, blockId: 'content-only', visibleWorkspaceTypes: ['content-blocker' as const] };

    expect(CUSTOM_BLOCK_CATEGORY_VALUES).not.toContain('custom');
    expect(createDefaultCustomBlockWorkspace().customBlock?.category).toBe('');
    const dataDefinitions = availableBlockDefinitions('data-modifier', [valid, stale, unknown, contentOnly]);
    expect(dataDefinitions.filter((definition) => definition.custom).map((definition) => definition.custom?.blockId)).toEqual(['format-text']);
    expect(dataDefinitions.some((definition) => definition.kind === 'CustomBlockInput' || definition.kind === 'CustomBlockOutput')).toBe(false);

    const contentDefinitions = availableBlockDefinitions('content-blocker', [valid, stale, unknown, contentOnly]);
    expect(contentDefinitions.filter((definition) => definition.custom).map((definition) => definition.custom?.blockId)).toEqual(['format-text', 'content-only']);
  });

  it('keeps workspace name and version authoritative for Custom Block identity', () => {
    const workspace = validCustomBlockWorkspace();
    const desynchronized = {
      ...workspace,
      customBlock: { ...workspace.customBlock!, label: 'Old display name', version: 1 },
    };
    const synchronized = synchronizeCustomBlockIdentity(desynchronized);
    expect(synchronized.customBlock?.label).toBe('Format Text');
    expect(synchronized.customBlock?.version).toBe(4);

    const renamed = updateWorkspaceMetadataFields(workspace, { name: 'Format Document', version: 8 }, 1234);
    expect(renamed.metadata).toMatchObject({ name: 'Format Document', version: 8, updated_at: 1234 });
    expect(renamed.customBlock).toMatchObject({ label: 'Format Document', version: 8 });

    const compiled = compileWorkspace(renamed);
    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    expect(compiled.customBlock).toMatchObject({ label: 'Format Document', version: 8 });
  });

  it('synchronizes ID, label, type, and tooltip from metadata into both boundary node kinds', () => {
    let workspace = updateCustomBlockPortMetadata(validCustomBlockWorkspace(), 'input', 0, {
      id: 'body',
      label: 'Body',
      dataType: 'JSON',
      tooltip: 'Structured body.',
    }, 2000);
    workspace = updateCustomBlockPortMetadata(workspace, 'output', 0, {
      id: 'rendered',
      label: 'Rendered',
      dataType: 'URL',
      tooltip: 'Rendered URL.',
    }, 2001);

    expect(workspace.customBlock?.inputs[0]).toEqual({ id: 'body', label: 'Body', dataType: 'JSON', tooltip: 'Structured body.' });
    expect(workspace.customBlock?.outputs[0]).toEqual({ id: 'rendered', label: 'Rendered', dataType: 'URL', tooltip: 'Rendered URL.' });
    expect(workspace.nodes.find((node) => node.type === 'CustomBlockInput')?.settings).toMatchObject({
      label: 'Body',
      customPortId: 'body',
      customPortLabel: 'Body',
      customPortDataType: 'JSON',
      customPortTooltip: 'Structured body.',
    });
    expect(workspace.nodes.find((node) => node.type === 'CustomBlockOutput')?.settings).toMatchObject({
      label: 'Rendered',
      customPortId: 'rendered',
      customPortLabel: 'Rendered',
      customPortDataType: 'URL',
      customPortTooltip: 'Rendered URL.',
    });
    expect(workspace.metadata.updated_at).toBe(2001);
  });

  it('synchronizes ID, label, type, and tooltip from both boundary node kinds into metadata', () => {
    const original = validCustomBlockWorkspace();
    const inputId = original.nodes.find((node) => node.type === 'CustomBlockInput')!.id;
    const outputId = original.nodes.find((node) => node.type === 'CustomBlockOutput')!.id;

    let workspace = updateWorkspaceNodeSettings(original, inputId, {
      customPortId: 'body',
      customPortLabel: 'Body',
      customPortDataType: 'JSON',
      customPortTooltip: 'Structured body.',
    }, 3000);
    workspace = updateWorkspaceNodeSettings(workspace, outputId, {
      label: 'Rendered',
      customPortId: 'rendered',
      customPortDataType: 'URL',
      customPortTooltip: 'Rendered URL.',
    }, 3001);

    expect(workspace.customBlock?.inputs[0]).toEqual({ id: 'body', label: 'Body', dataType: 'JSON', tooltip: 'Structured body.' });
    expect(workspace.customBlock?.outputs[0]).toEqual({ id: 'rendered', label: 'Rendered', dataType: 'URL', tooltip: 'Rendered URL.' });
    expect(workspace.nodes.find((node) => node.id === inputId)?.settings).toMatchObject({ label: 'Body', customPortLabel: 'Body' });
    expect(workspace.nodes.find((node) => node.id === outputId)?.settings).toMatchObject({ label: 'Rendered', customPortLabel: 'Rendered' });
    expect(workspace.metadata.updated_at).toBe(3001);
  });

  it('keeps each metadata row paired with exactly one boundary node while duplicate IDs are being corrected', () => {
    const original = validCustomBlockWorkspace();
    const firstInput = original.nodes.find((node) => node.type === 'CustomBlockInput')!;
    const secondInput = createWorkspaceNode('CustomBlockInput', { x: 0, y: 270 }, { ...firstInput.settings });
    const withDuplicateIds: WorkspaceFileV2 = {
      ...original,
      customBlock: {
        ...original.customBlock!,
        inputs: [...original.customBlock!.inputs, { ...original.customBlock!.inputs[0] }],
      },
      nodes: [...original.nodes, secondInput],
    };

    const metadataEdited = updateCustomBlockPortMetadata(withDuplicateIds, 'input', 1, {
      id: 'secondary',
      label: 'Secondary',
      dataType: 'number',
      tooltip: 'Second value.',
    });
    const metadataEditedInputs = metadataEdited.nodes.filter((node) => node.type === 'CustomBlockInput');
    expect(metadataEditedInputs[0].settings.customPortId).toBe('source');
    expect(metadataEditedInputs[1].settings).toMatchObject({
      customPortId: 'secondary',
      customPortLabel: 'Secondary',
      customPortDataType: 'number',
      customPortTooltip: 'Second value.',
    });

    const nodeEdited = updateWorkspaceNodeSettings(withDuplicateIds, secondInput.id, {
      customPortId: 'secondary',
      customPortLabel: 'Secondary',
      customPortDataType: 'number',
      customPortTooltip: 'Second value.',
    });
    expect(nodeEdited.customBlock?.inputs[0]).toEqual(original.customBlock!.inputs[0]);
    expect(nodeEdited.customBlock?.inputs[1]).toEqual({
      id: 'secondary',
      label: 'Secondary',
      dataType: 'number',
      tooltip: 'Second value.',
    });
  });

  it('refreshes existing invocation metadata from the installed definition without overwriting caller values', () => {
    const version1 = compiledCustomBlockVersion({
      name: 'Format Text',
      version: 1,
      inputLabel: 'Source',
      inputType: 'Any',
      inputTooltip: 'Old input help.',
      outputLabel: 'Formatted',
      outputType: 'Any',
      outputTooltip: 'Old output help.',
      fields: [{ id: 'mode', label: 'Mode', dataType: 'string', defaultValue: 'plain', visibility: 'visible' }],
    });
    const version2 = compiledCustomBlockVersion({
      name: 'Format URL',
      version: 2,
      inputLabel: 'Source URL',
      inputType: 'URL',
      inputTooltip: 'Current input help.',
      outputLabel: 'Formatted URL',
      outputType: 'URL',
      outputTooltip: 'Current output help.',
      fields: [
        { id: 'mode', label: 'URL mode', dataType: 'string', defaultValue: 'strict', tooltip: 'Current mode help.', visibility: 'advanced' },
        { id: 'suffix', label: 'Suffix', dataType: 'string', defaultValue: '!', tooltip: 'Optional suffix.', visibility: 'hidden' },
      ],
    });
    const host = hostWorkspaceFor(version1);
    const inputNode = host.nodes.find((node) => node.type === 'DataFlowIn')!;
    const outputNode = host.nodes.find((node) => node.type === 'DataFlowOut')!;
    const invocationId = host.nodes.find((node) => node.type === 'CustomBlock')!.id;

    const result = compileWorkspace(host, { customBlocks: [version2] });
    expect(result.ok, result.validation.errors.join('; ')).toBe(true);
    const invocation = result.workspace.nodes.find((node) => node.id === invocationId)!;
    expect(invocation.settings).toMatchObject({
      label: 'Caller alias',
      customBlockName: 'Format URL',
      customBlockVersion: 2,
      customBlockInputs: version2.inputs,
      customBlockOutputs: version2.outputs,
      customBlockFields: version2.fields,
      customFieldValues: { mode: 'caller choice', suffix: '!' },
    });
    expect(getEffectivePortDefinitions(invocation, 'input')).toEqual([
      { id: 'source', label: 'Source URL', dataType: 'URL', description: 'Current input help.' },
    ]);
    expect(getEffectivePortDefinitions(invocation, 'output')).toEqual([
      { id: 'formatted', label: 'Formatted URL', dataType: 'URL', description: 'Current output help.' },
    ]);
    expect(result.pack?.vm.instructions.find((instruction) => instruction.op === 'CUSTOM_BLOCK')).toMatchObject({
      op: 'CUSTOM_BLOCK',
      nodeId: invocationId,
      blockId: version2.blockId,
      version: 2,
      inputSymbols: { source: `${inputNode.id}.url` },
      outputSymbols: { formatted: `${invocationId}.formatted` },
    });
    expect(result.pack?.vm.instructions.some((instruction) =>
      instruction.op === 'OUTPUT' && instruction.input === `${invocationId}.formatted` && instruction.nodeId === outputNode.id,
    )).toBe(true);
  });

  it('blocks stale renamed port handles until the caller reconnects them', () => {
    const version1 = compiledCustomBlockVersion({
      name: 'Format Text',
      version: 1,
      inputLabel: 'Source',
      inputType: 'Any',
      inputTooltip: '',
      outputLabel: 'Formatted',
      outputType: 'Any',
      outputTooltip: '',
      fields: [],
    });
    const version2 = compiledCustomBlockVersion({
      name: 'Format URL',
      version: 2,
      inputId: 'body',
      inputLabel: 'Body URL',
      inputType: 'URL',
      inputTooltip: 'Current input.',
      outputId: 'rendered',
      outputLabel: 'Rendered URL',
      outputType: 'URL',
      outputTooltip: 'Current output.',
      fields: [],
    });
    const stale = hostWorkspaceFor(version1);
    const invocationId = stale.nodes.find((node) => node.type === 'CustomBlock')!.id;
    const failed = compileWorkspace(stale, { customBlocks: [version2] });
    expect(failed.ok).toBe(false);
    expect(failed.validation.errors.join('\n')).toContain('references a missing block or port');

    const reconnected = {
      ...failed.workspace,
      edges: failed.workspace.edges.map((edge) => ({
        ...edge,
        ...(edge.target === invocationId ? { targetHandle: 'body' } : {}),
        ...(edge.source === invocationId ? { sourceHandle: 'rendered' } : {}),
      })),
    };
    const compiled = compileWorkspace(reconnected, { customBlocks: [version2] });
    expect(compiled.ok, compiled.validation.errors.join('; ')).toBe(true);
    expect(compiled.pack?.vm.instructions.find((instruction) => instruction.op === 'CUSTOM_BLOCK')).toMatchObject({
      inputSymbols: { body: expect.any(String) },
      outputSymbols: { rendered: `${invocationId}.rendered` },
    });
  });

  it('refreshes invocation snapshots inside Content Blocker surfaces', () => {
    const current = compiledCustomBlockVersion({
      name: 'Surface Helper',
      version: 7,
      inputLabel: 'Current input',
      inputType: 'URL',
      inputTooltip: 'Surface input.',
      outputLabel: 'Current output',
      outputType: 'URL',
      outputTooltip: 'Surface output.',
      fields: [],
    });
    const staleInvocation = createWorkspaceNode('CustomBlock', { x: 300, y: 200 }, {
      customBlockId: current.blockId,
      customBlockName: 'Old name',
      customBlockVersion: 1,
      customBlockInputs: [],
      customBlockOutputs: [],
      customBlockFields: [],
    });
    const workspace = createDefaultContentBlockerWorkspace();
    workspace.surfaces = workspace.surfaces?.map((surface, index) =>
      index === 0 ? { ...surface, nodes: [...surface.nodes, staleInvocation] } : surface,
    );

    const synchronized = synchronizeCustomBlockInvocationMetadata(workspace, [current]);
    expect(synchronized.surfaces?.[0].nodes.find((node) => node.id === staleInvocation.id)?.settings).toMatchObject({
      customBlockName: 'Surface Helper',
      customBlockVersion: 7,
      customBlockInputs: current.inputs,
      customBlockOutputs: current.outputs,
    });
  });

  it('blocks missing Custom Block dependencies referenced by Content Blocker surfaces', () => {
    const dependency = compiledCustomBlockVersion({
      name: 'Surface Decision',
      version: 1,
      inputLabel: 'Candidate',
      inputType: 'number',
      inputTooltip: 'Decision candidate.',
      outputLabel: 'Decision',
      outputType: 'number',
      outputTooltip: 'Decision result.',
      fields: [],
    });
    const result = compileWorkspace(contentBlockerWorkspaceFor(dependency), { customBlocks: [] });

    expect(result.ok).toBe(false);
    expect(result.validation.errors.join('\n')).toContain(
      'Custom Block "Surface Decision" is not installed or embedded for this workspace.',
    );
  });

  it('treats legacy Custom-category definitions as unavailable on top-level and Content Blocker surfaces', () => {
    const topLevelDependency = compiledCustomBlockVersion({
      name: 'Top-Level Legacy',
      version: 1,
      inputLabel: 'Source URL',
      inputType: 'URL',
      inputTooltip: '',
      outputLabel: 'Result URL',
      outputType: 'URL',
      outputTooltip: '',
      fields: [],
    });
    const surfaceDependency = compiledCustomBlockVersion({
      name: 'Surface Legacy',
      version: 1,
      inputLabel: 'Candidate',
      inputType: 'number',
      inputTooltip: '',
      outputLabel: 'Decision',
      outputType: 'number',
      outputTooltip: '',
      fields: [],
    });

    [
      { workspace: hostWorkspaceFor(topLevelDependency), block: topLevelDependency },
      { workspace: contentBlockerWorkspaceFor(surfaceDependency), block: surfaceDependency },
    ].forEach(({ workspace, block }) => {
      const legacyCategoryBlock = { ...block, category: 'custom' } as unknown as CompiledCustomBlockV2;
      const result = compileWorkspace(workspace, { customBlocks: [legacyCategoryBlock] });
      expect(result.ok).toBe(false);
      expect(result.validation.errors.join('\n')).toContain(
        `Custom Block "${block.label}" is not installed or embedded for this workspace.`,
      );
    });
  });

  it('merges invoked Custom Block risk into Content Blocker surface and pack risk', () => {
    const dependency = compiledCustomBlockVersion({
      name: 'Risky Surface Decision',
      version: 1,
      inputLabel: 'Candidate',
      inputType: 'number',
      inputTooltip: '',
      outputLabel: 'Decision',
      outputType: 'number',
      outputTooltip: '',
      fields: [],
    });
    const riskReason = 'Custom Block reads sensitive page data.';
    const riskyDependency: CompiledCustomBlockV2 = {
      ...dependency,
      risk: {
        highest: 'high',
        usesExtendedInput: false,
        usesExtendedOutput: false,
        usesHighRiskInput: true,
        usesHighRiskOutput: false,
        reasons: [riskReason],
      },
    };
    const result = compileWorkspace(contentBlockerWorkspaceFor(riskyDependency), {
      customBlocks: [riskyDependency],
    });

    expect(result.ok, result.validation.errors.join('; ')).toBe(true);
    expect(result.pack?.install?.contentBlocker?.pageLoad.vm.instructions).toContainEqual(
      expect.objectContaining({ op: 'CUSTOM_BLOCK', blockId: riskyDependency.blockId }),
    );
    expect(result.pack?.risk).toMatchObject({
      highest: 'high',
      usesHighRiskInput: true,
    });
    expect(result.pack?.risk.reasons).toContain(riskReason);
    expect(result.validation.risk.reasons).toContain(riskReason);
  });

  it('honors visible, advanced, and hidden Custom Block field metadata', () => {
    const fields: CustomBlockFieldDefinition[] = [
      { id: 'visible', label: 'Visible', dataType: 'string', visibility: 'visible' },
      { id: 'advanced', label: 'Advanced', dataType: 'string', visibility: 'advanced' },
      { id: 'hidden', label: 'Hidden', dataType: 'string', visibility: 'hidden' },
      { id: 'default', label: 'Default visible', dataType: 'string' },
    ];
    expect(visibleCustomBlockFields(fields, false).map((field) => field.id)).toEqual(['visible', 'default']);
    expect(visibleCustomBlockFields(fields, true).map((field) => field.id)).toEqual(['visible', 'advanced', 'default']);
  });

  it('rejects invalid categories and every boundary metadata mismatch before compilation', () => {
    const invalidCategory = validCustomBlockWorkspace();
    invalidCategory.customBlock = { ...invalidCategory.customBlock!, category: 'custom' };
    const invalidCategoryResult = compileWorkspace(invalidCategory);
    expect(invalidCategoryResult.ok).toBe(false);
    expect(invalidCategoryResult.validation.errors.join('\n')).toContain('choose a category other than Custom');

    const mismatches: Array<{ updates: Partial<WorkspaceBlockSettings>; message: string }> = [
      { updates: { customPortId: 'different' }, message: 'must have exactly one matching CustomBlockInput block' },
      { updates: { customPortLabel: 'Different label' }, message: 'label does not match' },
      { updates: { customPortDataType: 'number' }, message: 'type does not match' },
      { updates: { customPortTooltip: 'Different tooltip.' }, message: 'tooltip does not match' },
    ];
    mismatches.forEach(({ updates, message }) => {
      const result = compileWorkspace(updateInputNode(validCustomBlockWorkspace(), updates));
      expect(result.ok).toBe(false);
      expect(result.validation.errors.join('\n')).toContain(message);
    });
  });
});
