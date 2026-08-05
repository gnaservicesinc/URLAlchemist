import { GLOBAL_SCOPE_PATTERNS, REGEX_TIMEOUT_MS } from '../constants';
import { getHotkeyValidationError } from '../hotkeys';
import { assertSafeRegexPattern } from '../regex/executeRegexJob';
import { validateRemoteUrl } from './remoteUrl';
import {
  BUILT_IN_VARIABLE_TYPES,
  extractVariableReferences,
  getVariableFieldSpecs,
  normalizeVariableName,
  validateVariableName,
  variableDrivenInputHandles,
  variableTypeMatches,
} from './variables';
import {
  combineRisk,
  getEffectivePortDefinition,
  getEffectivePortDefinitions,
  getBlockDefinition,
  getRiskRank,
  isTypeCompatible,
} from './blockRegistry';
import { URL_ALCHEMIST_VERSION } from './buildInfo';
import { synchronizeCustomBlockInvocationMetadata } from './workspace';
import type {
  BlockKind,
  CompiledActionPackV2,
  CompiledCustomBlockV2,
  CompiledTriggerPlan,
  CompiledRiskSummary,
  GraphEventHandler,
  GraphCompileResult,
  GraphDataType,
  GraphValue,
  GraphVmInstruction,
  GraphVmProgram,
  GraphVmSafetyPolicy,
  RiskLevel,
  AssetFetchKind,
  ContentBlockerChallengeTask,
  ContentBlockerDecisionProgram,
  ContentBlockerSurfaceId,
  UserInteractionKind,
  WorkspaceInputSource,
  WorkspaceEdgeV2,
  WorkspaceFileV2,
  WorkspaceGraphSurface,
  WorkspaceNodeV2,
  WorkspaceValidationState,
} from './types';
import {
  ACTION_PACK_SCHEMA_VERSION,
  DEFAULT_ASSET_MAX_BYTES,
  DEFAULT_INTERVAL_TRIGGER_MS,
  DEFAULT_REMOTE_MAX_BYTES,
  DEFAULT_REMOTE_TIMEOUT_MS,
  INPUT_TRIGGER_BURST_LIMIT,
  INPUT_TRIGGER_BURST_WINDOW_MS,
  INPUT_TRIGGER_HISTORY_LIMIT,
  MAX_ASSET_MAX_BYTES,
  MIN_INTERVAL_TRIGGER_MS,
  isCustomBlockCategory,
} from './types';

const VM_STEP_BUDGET = 300;
const VM_LOOP_BUDGET = 500;
const VM_VALUE_BYTE_LIMIT = 256 * 1024;
const EVENT_HANDLERS: GraphEventHandler[] = ['trigger', 'keyboard', 'mouse', 'tick'];
const EVENT_SOURCE_BLOCKS = new Map<BlockKind, GraphEventHandler>([
  ['DataFlowIn', 'trigger'],
  ['ContentDataIn', 'trigger'],
  ['ExtendedDataIn', 'trigger'],
  ['OnTriggerEvent', 'trigger'],
  ['KeyboardIn', 'keyboard'],
  ['MouseIn', 'mouse'],
  ['OverlayTickIn', 'tick'],
]);
const SIDE_EFFECT_BLOCKS = new Set<BlockKind>([
  'ShowMessage',
  'ShowImage',
  'ShowVideo',
  'PlaySound',
  'OverlayInput',
  'OverlayControl',
  'OverlayDraw',
  'Sleep',
  'SaveStringToLog',
  'Abort',
]);
const CONDITION_SOURCE_BLOCKS = new Set<BlockKind>(['DataFlowIn']);
const CONTENT_BLOCKER_DECISION_ALLOWED_BLOCKS = new Set<BlockKind>([
  'ContentDataIn',
  'SystemData',
  'Constant',
  'Logical',
  'Math',
  'Convert',
  'TextTransform',
  'TextSplitJoin',
  'UrlQuery',
  'DataStructure',
  'DictGet',
  'DictOperation',
  'ListOperation',
  'AddStringToList',
  'ConditionSelect',
  'LogicalFlow',
  'CheckListForUrl',
  'CustomBlock',
  'RandomNumber',
  'SaveLoad',
  'SharedState',
  'Declarations',
  'Substitution',
  'RegExpression',
  'DecisionOut',
  'SaveStringToLog',
]);
const CONTENT_BLOCKER_CHALLENGE_BLOCKS = new Set<BlockKind>([
  'ChallengeTimer',
  'ChallengeTyper',
  'ChallengeClicker',
  'ChallengeConfirm',
  'ChallengeReason',
]);
const CONDITION_ALLOWED_BLOCKS = new Set<BlockKind>([
  'DataFlowIn',
  'SystemData',
  'Constant',
  'Logical',
  'Math',
  'Convert',
  'TextTransform',
  'TextSplitJoin',
  'UrlQuery',
  'DataStructure',
  'DictGet',
  'DictOperation',
  'ListOperation',
  'ConditionSelect',
  'SaveLoad',
  'SharedState',
  'Declarations',
  'ConditionOut',
]);
const TEXT_TRANSFORM_MODES = ['TRIM', 'COLLAPSE_WHITESPACE', 'NORMALIZE_LINE_ENDINGS', 'STRIP_CONTROL_CHARS', 'UPPERCASE', 'LOWERCASE', 'TITLE_CASE', 'URL_ENCODE', 'URL_DECODE'] as const;
const TEXT_SPLIT_JOIN_MODES = ['SPLIT_LINES', 'SPLIT_WHITESPACE', 'SPLIT_COMMA', 'SPLIT_CUSTOM', 'JOIN_LINES', 'JOIN_SPACE', 'JOIN_COMMA', 'JOIN_CUSTOM'] as const;
const URL_QUERY_MODES = ['PARSE', 'GET_PARAM', 'SET_PARAM', 'DELETE_PARAM', 'KEEP_PARAMS', 'SORT_PARAMS', 'REBUILD'] as const;
const DICT_OPERATION_MODES = ['MERGE', 'DELETE_KEY', 'HAS_KEY', 'KEYS', 'VALUES'] as const;
const WORKSPACE_INPUT_SOURCE_IDS = new Set<WorkspaceInputSource>([
  'url',
  'linkUrl',
  'selectedText',
  'pageTitle',
  'pageMetadata',
  'secondsOnPage',
  'clipboard',
  'pageText',
  'rawHtml',
  'mediaData',
  'pageLinks',
  'jsMetadata',
  'consoleOutput',
]);

interface CompileOptions {
  builderUuid?: string;
  buildTimeUtc?: number;
  conditionWorkspaces?: WorkspaceFileV2[];
  customBlocks?: CompiledCustomBlockV2[];
}

function validateRegexPattern(pattern: string): string | null {
  if (!pattern.trim()) {
    return 'The generated pattern is empty.';
  }

  try {
    assertSafeRegexPattern(pattern);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'The regex pattern is invalid.';
  }
}

function cleanUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  try {
    const url = new URL(trimmed);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash) {
      return undefined;
    }

    return url.href;
  } catch {
    return undefined;
  }
}

function cleanLocateValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.length > 254 || !/^[A-Za-z0-9._%+@:-]+$/.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}

function symbol(nodeId: string, portId: string): string {
  return `${nodeId}.${portId}`;
}

function edgeKey(edge: WorkspaceEdgeV2): string {
  return `${edge.target}:${edge.targetHandle}`;
}

function findNode(workspace: WorkspaceFileV2, nodeId: string): WorkspaceNodeV2 | null {
  return workspace.nodes.find((node) => node.id === nodeId) ?? null;
}

function sourceType(workspace: WorkspaceFileV2, edge: WorkspaceEdgeV2): GraphDataType | null {
  const sourceNode = findNode(workspace, edge.source);
  if (!sourceNode) {
    return null;
  }

  return getEffectivePortDefinition(sourceNode, 'output', edge.sourceHandle)?.dataType ?? null;
}

function targetType(workspace: WorkspaceFileV2, edge: WorkspaceEdgeV2): GraphDataType | null {
  const targetNode = findNode(workspace, edge.target);
  if (!targetNode) {
    return null;
  }

  return getEffectivePortDefinition(targetNode, 'input', edge.targetHandle)?.dataType ?? null;
}

function connectedInput(edgesByTarget: Map<string, WorkspaceEdgeV2>, nodeId: string, inputId: string): string | undefined {
  const edge = edgesByTarget.get(`${nodeId}:${inputId}`);
  return edge ? symbol(edge.source, edge.sourceHandle) : undefined;
}

function isLogicalFlowConditionEdge(workspace: WorkspaceFileV2, edge: WorkspaceEdgeV2): boolean {
  return edge.targetHandle === 'condition' && (workspace.logicalFlows ?? []).some((group) => group.controlNodeId === edge.target);
}

function visibleWorkspaceEdges(workspace: WorkspaceFileV2): WorkspaceEdgeV2[] {
  return workspace.edges.filter((edge) => !isLogicalFlowConditionEdge(workspace, edge));
}

function connectedOutputHandles(
  workspace: WorkspaceFileV2,
  nodeId: string,
  includedNodeIds: Set<string>,
): Set<string> {
  const handles = new Set<string>();
  visibleWorkspaceEdges(workspace).forEach((edge) => {
    if (edge.source === nodeId && includedNodeIds.has(edge.target)) {
      handles.add(edge.sourceHandle);
    }
  });

  return handles;
}

function assetKindForNode(type: BlockKind): AssetFetchKind {
  if (type === 'GetVideo') {
    return 'video';
  }

  if (type === 'GetAudio') {
    return 'audio';
  }

  return 'image';
}

function interactionKindForNode(type: BlockKind): UserInteractionKind {
  switch (type) {
    case 'PromptNumber':
      return 'PROMPT_NUMBER';
    case 'Confirm':
      return 'CONFIRM';
    case 'PickFileOrUrl':
      return 'PICK_FILE_OR_URL';
    case 'PromptText':
    default:
      return 'PROMPT_TEXT';
  }
}

function upstreamNodeIds(workspace: WorkspaceFileV2, nodeId: string): Set<string> {
  const reachable = new Set<string>();
  const stack = [nodeId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) {
      continue;
    }

    reachable.add(current);
    visibleWorkspaceEdges(workspace)
      .filter((edge) => edge.target === current)
      .forEach((edge) => {
        stack.push(edge.source);
      });
    (workspace.logicalFlows ?? [])
      .filter((group) => group.controlNodeId === current)
      .forEach((group) => {
        stack.push(group.conditionNodeId);
      });
  }

  return reachable;
}

function handlersForNodeIds(workspace: WorkspaceFileV2, nodeIds: Set<string>): Set<GraphEventHandler> {
  const handlers = new Set<GraphEventHandler>();
  workspace.nodes.forEach((node) => {
    if (!nodeIds.has(node.id)) {
      return;
    }

    const handler = EVENT_SOURCE_BLOCKS.get(node.type);
    if (handler) {
      handlers.add(handler);
    }
  });

  if (handlers.size === 0) {
    handlers.add('trigger');
  }

  return handlers;
}

function isTerminalNode(node: WorkspaceNodeV2): boolean {
  return (
    node.type === 'DataFlowOut' ||
    node.type === 'ExtendedDataOut' ||
    node.type === 'ConditionOut' ||
    node.type === 'DecisionOut' ||
    node.type === 'CustomBlockOutput' ||
    (node.type === 'SaveLoad' && (node.settings.saveLoadMode ?? 'SAVE') === 'SAVE') ||
    SIDE_EFFECT_BLOCKS.has(node.type) ||
    (node.type === 'SharedState' && ['SET', 'DELETE'].includes(node.settings.sharedStateMode ?? 'GET'))
  );
}

function hasRunnableTerminalNode(workspace: WorkspaceFileV2, edgesByTarget: Map<string, WorkspaceEdgeV2>): boolean {
  return workspace.nodes.some((node) => {
    if (node.type === 'DataFlowOut' || node.type === 'ExtendedDataOut') {
      return getEffectivePortDefinitions(node, 'input').some((input) => edgesByTarget.has(`${node.id}:${input.id}`));
    }

    if (node.type === 'ConditionOut') {
      return edgesByTarget.has(`${node.id}:condition`);
    }

    if (node.type === 'DecisionOut') {
      return edgesByTarget.has(`${node.id}:decision`);
    }

    if (node.type === 'CustomBlockOutput') {
      return edgesByTarget.has(`${node.id}:value`);
    }

    return isTerminalNode(node);
  });
}

function settingString(settings: WorkspaceNodeV2['settings'], setting: keyof WorkspaceNodeV2['settings']): string {
  const value = settings[setting];
  return typeof value === 'string' ? value : '';
}

function collectDeclaredVariableTypes(
  workspace: WorkspaceFileV2,
  edgesByTarget: Map<string, WorkspaceEdgeV2>,
): Map<string, GraphDataType> {
  const declared = new Map<string, GraphDataType>(Object.entries(BUILT_IN_VARIABLE_TYPES));
  workspace.nodes.forEach((node) => {
    if (node.type !== 'Declarations' || !node.settings.variableName?.trim() || validateVariableName(node.settings.variableName)) {
      return;
    }

    const valueEdge = edgesByTarget.get(`${node.id}:value`);
    declared.set(
      normalizeVariableName(node.settings.variableName),
      valueEdge ? sourceType(workspace, valueEdge) ?? 'Any' : node.settings.literalDataType ?? 'string',
    );
  });
  return declared;
}

function validateVariableFieldReferences(
  workspace: WorkspaceFileV2,
  node: WorkspaceNodeV2,
  edgesByTarget: Map<string, WorkspaceEdgeV2>,
  declaredVariableTypes: Map<string, GraphDataType>,
  errors: string[],
  invalidEdgeIds: string[],
): void {
  const definition = getBlockDefinition(node.type);
  getVariableFieldSpecs(node).forEach((field) => {
    const value = settingString(node.settings, field.setting);
    const references = extractVariableReferences(value);
    if (references.length === 0) {
      return;
    }

    if (field.inputHandle) {
      const blockedEdge = edgesByTarget.get(`${node.id}:${field.inputHandle}`);
      if (blockedEdge) {
        invalidEdgeIds.push(blockedEdge.id);
        errors.push(`${node.settings.label || definition.label}: ${field.label} uses a variable, so the ${field.inputHandle} input cannot be connected.`);
      }
    }

    references.forEach((reference) => {
      if (reference.kind === 'numeric') {
        if (field.numericMode === 'forbidden') {
          errors.push(`${node.settings.label || definition.label}: ${reference.token} is reserved for substitution connector inputs.`);
        }
        return;
      }

      const actualType = declaredVariableTypes.get(reference.token);
      if (!actualType) {
        errors.push(`${node.settings.label || definition.label}: ${reference.token} is not declared.`);
        return;
      }

      if (!variableTypeMatches(actualType, field.expectedType)) {
        errors.push(`${node.settings.label || definition.label}: ${reference.token} is ${actualType}, but ${field.label} expects ${field.expectedType}.`);
      }
    });
  });
}

function collectHandlerReachability(workspace: WorkspaceFileV2): Record<GraphEventHandler, Set<string>> {
  const reachable: Record<GraphEventHandler, Set<string>> = {
    trigger: new Set<string>(),
    keyboard: new Set<string>(),
    mouse: new Set<string>(),
    tick: new Set<string>(),
  };
  const terminals = workspace.nodes.filter(isTerminalNode);

  terminals.forEach((terminal) => {
    const upstream = upstreamNodeIds(workspace, terminal.id);
    handlersForNodeIds(workspace, upstream).forEach((handler) => {
      upstream.forEach((nodeId) => reachable[handler].add(nodeId));
    });
  });

  workspace.nodes.forEach((node) => {
    const definition = getBlockDefinition(node.type);
    if (!(definition.flags.alwaysProcess || node.settings.alwaysProcess || definition.flags.processBeforeRun || node.settings.processBeforeRun)) {
      return;
    }

    const activeHandlers = EVENT_HANDLERS.filter((handler) => reachable[handler].size > 0);
    const targetHandlers: GraphEventHandler[] = activeHandlers.length > 0 ? activeHandlers : ['trigger'];
    targetHandlers.forEach((handler) => {
      reachable[handler].add(node.id);
    });
  });

  return reachable;
}

function collectReachableNodes(workspace: WorkspaceFileV2): Set<string> {
  const byHandler = collectHandlerReachability(workspace);
  const reachable = new Set<string>();
  EVENT_HANDLERS.forEach((handler) => {
    byHandler[handler].forEach((nodeId) => reachable.add(nodeId));
  });
  return reachable;
}

function downstreamNodeIdsFromHandle(workspace: WorkspaceFileV2, sourceId: string, sourceHandle: string): Set<string> {
  const reachable = new Set<string>();
  const stack = visibleWorkspaceEdges(workspace)
    .filter((edge) => edge.source === sourceId && edge.sourceHandle === sourceHandle)
    .map((edge) => edge.target);

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);
    visibleWorkspaceEdges(workspace)
      .filter((edge) => edge.source === current)
      .forEach((edge) => stack.push(edge.target));
  }

  return reachable;
}

function logicalFlowConditionSymbol(workspace: WorkspaceFileV2, controlNodeId: string): string | undefined {
  const group = (workspace.logicalFlows ?? []).find((candidate) => candidate.controlNodeId === controlNodeId);
  if (!group || !workspace.nodes.some((node) => node.id === group.conditionNodeId)) {
    return undefined;
  }
  return symbol(group.conditionNodeId, 'result');
}

function logicalFlowGuards(workspace: WorkspaceFileV2, edgesByTarget: Map<string, WorkspaceEdgeV2>): Map<string, { guard: string; expected: 0 | 1 }> {
  const guards = new Map<string, { guard: string; expected: 0 | 1 }>();
  workspace.nodes
    .filter((node) => node.type === 'LogicalFlow')
    .forEach((node) => {
      const guard = logicalFlowConditionSymbol(workspace, node.id) ?? connectedInput(edgesByTarget, node.id, 'condition');
      if (!guard) {
        return;
      }
      downstreamNodeIdsFromHandle(workspace, node.id, 'trueValue').forEach((nodeId) => {
        guards.set(nodeId, { guard, expected: 1 });
      });
      downstreamNodeIdsFromHandle(workspace, node.id, 'falseValue').forEach((nodeId) => {
        guards.set(nodeId, { guard, expected: 0 });
      });
    });
  return guards;
}

function withInstructionGuard(instructions: GraphVmInstruction[], guard?: { guard: string; expected: 0 | 1 }): GraphVmInstruction[] {
  if (!guard) {
    return instructions;
  }
  return instructions.map((instruction) => ({
    ...instruction,
    guard: instruction.guard ?? guard.guard,
    guardExpected: instruction.guardExpected ?? guard.expected,
  }));
}

function customBlockInstructionReferences(instructions: GraphVmInstruction[]): string[] {
  return instructions.flatMap((instruction) => {
    if (instruction.op !== 'CUSTOM_BLOCK') {
      return [];
    }
    return [
      instruction.blockId,
      ...customBlockInstructionReferences(instruction.program.instructions),
      ...Object.values(instruction.program.eventHandlers ?? {}).flatMap((handlerInstructions) =>
        customBlockInstructionReferences(handlerInstructions ?? []),
      ),
    ];
  });
}

function installedCustomBlockReferences(block: CompiledCustomBlockV2): string[] {
  return [
    ...customBlockInstructionReferences(block.vm.instructions),
    ...Object.values(block.vm.eventHandlers ?? {}).flatMap((instructions) => customBlockInstructionReferences(instructions ?? [])),
  ];
}

function customBlockReferenceReachesTarget(blockId: string, targetBlockId: string, customBlocks: CompiledCustomBlockV2[], seen = new Set<string>()): boolean {
  if (blockId === targetBlockId) {
    return true;
  }
  if (seen.has(blockId)) {
    return false;
  }
  seen.add(blockId);
  const block = customBlocks.find((candidate) => candidate.blockId === blockId);
  if (!block) {
    return false;
  }
  return installedCustomBlockReferences(block).some((reference) => customBlockReferenceReachesTarget(reference, targetBlockId, customBlocks, seen));
}

function customBlockRecursionErrors(workspace: WorkspaceFileV2, customBlocks: CompiledCustomBlockV2[]): string[] {
  if (workspace.workspaceType !== 'custom-block' || !workspace.customBlock) {
    return [];
  }
  const targetBlockId = workspace.customBlock.blockId;
  return workspace.nodes
    .filter((node) => node.type === 'CustomBlock' && node.settings.customBlockId)
    .flatMap((node) => {
      const referencedBlockId = node.settings.customBlockId!;
      if (customBlockReferenceReachesTarget(referencedBlockId, targetBlockId, customBlocks)) {
        return [`Custom Block "${workspace.customBlock!.label}" cannot reference itself directly or through "${node.settings.customBlockName ?? referencedBlockId}".`];
      }
      return [];
    });
}

function topologicalSort(workspace: WorkspaceFileV2, includedNodeIds: Set<string>): { ok: true; nodes: WorkspaceNodeV2[] } | { ok: false; cycleIds: string[] } {
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  workspace.nodes.forEach((node) => {
    if (!includedNodeIds.has(node.id)) {
      return;
    }

    inDegree.set(node.id, 0);
    outgoing.set(node.id, []);
  });

  visibleWorkspaceEdges(workspace).forEach((edge) => {
    if (!includedNodeIds.has(edge.source) || !includedNodeIds.has(edge.target)) {
      return;
    }

    outgoing.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  });

  (workspace.logicalFlows ?? []).forEach((group) => {
    if (!includedNodeIds.has(group.conditionNodeId) || !includedNodeIds.has(group.controlNodeId)) {
      return;
    }
    outgoing.get(group.conditionNodeId)?.push(group.controlNodeId);
    inDegree.set(group.controlNodeId, (inDegree.get(group.controlNodeId) ?? 0) + 1);
  });

  const queue = workspace.nodes.filter((node) => includedNodeIds.has(node.id) && (inDegree.get(node.id) ?? 0) === 0);
  const sorted: WorkspaceNodeV2[] = [];

  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);

    outgoing.get(node.id)?.forEach((targetId) => {
      const nextDegree = (inDegree.get(targetId) ?? 0) - 1;
      inDegree.set(targetId, nextDegree);
      if (nextDegree === 0) {
        const target = findNode(workspace, targetId);
        if (target) {
          queue.push(target);
        }
      }
    });
  }

  if (sorted.length !== includedNodeIds.size) {
    return {
      ok: false,
      cycleIds: Array.from(includedNodeIds).filter((nodeId) => !sorted.some((node) => node.id === nodeId)),
    };
  }

  const preflight = sorted.filter((node) => getBlockDefinition(node.type).flags.processBeforeRun || node.settings.processBeforeRun);
  const main = sorted.filter((node) => !preflight.includes(node));

  return {
    ok: true,
    nodes: [...preflight, ...main],
  };
}

function emptyRisk(): CompiledRiskSummary {
  return {
    highest: 'safe',
    usesExtendedInput: false,
    usesExtendedOutput: false,
    usesHighRiskInput: false,
    usesHighRiskOutput: false,
    reasons: [],
  };
}

function addRisk(risk: CompiledRiskSummary, level: RiskLevel, reason: string, direction: 'input' | 'output'): void {
  risk.highest = combineRisk(risk.highest, level);
  if (!risk.reasons.includes(reason) && level !== 'safe') {
    risk.reasons.push(reason);
  }

  if (level === 'extended') {
    if (direction === 'input') {
      risk.usesExtendedInput = true;
    } else {
      risk.usesExtendedOutput = true;
    }
  }

  if (level === 'high') {
    if (direction === 'input') {
      risk.usesHighRiskInput = true;
    } else {
      risk.usesHighRiskOutput = true;
    }
  }
}

function surfaceNode(surface: WorkspaceGraphSurface, nodeId: string): WorkspaceNodeV2 | null {
  return surface.nodes.find((node) => node.id === nodeId) ?? null;
}

function validateSurfaceConnections(
  surface: WorkspaceGraphSurface,
  allowedBlocks: Set<BlockKind>,
  errors: string[],
  invalidEdgeIds: string[],
  risk: CompiledRiskSummary,
): Map<string, WorkspaceEdgeV2> {
  const nodeIds = new Set(surface.nodes.map((node) => node.id));
  const edgesByTarget = new Map<string, WorkspaceEdgeV2>();

  surface.nodes.forEach((node) => {
    const definition = getBlockDefinition(node.type);
    if (!allowedBlocks.has(node.type)) {
      errors.push(`${surface.label}: ${node.settings.label || definition.label} cannot be used on this surface.`);
    }
  });

  surface.edges.forEach((edge) => {
    const sourceNode = surfaceNode(surface, edge.source);
    const targetNode = surfaceNode(surface, edge.target);
    if (targetNode?.type === 'LogicalFlow' && edge.targetHandle === 'condition') {
      return;
    }
    const sourcePort = sourceNode ? getEffectivePortDefinition(sourceNode, 'output', edge.sourceHandle) : null;
    const targetPort = targetNode ? getEffectivePortDefinition(targetNode, 'input', edge.targetHandle) : null;

    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || !sourcePort || !targetPort) {
      invalidEdgeIds.push(edge.id);
      errors.push(`${surface.label}: connection ${edge.id} references a missing block or port.`);
      return;
    }

    const targetKey = edgeKey(edge);
    if (edgesByTarget.has(targetKey)) {
      invalidEdgeIds.push(edge.id);
      errors.push(`${surface.label}: only one connection can feed ${targetNode!.settings.label || targetNode!.type}.${targetPort.label}.`);
      return;
    }
    edgesByTarget.set(targetKey, edge);

    if (!isTypeCompatible(sourcePort.dataType, targetPort.dataType)) {
      invalidEdgeIds.push(edge.id);
      errors.push(`${surface.label}: ${sourcePort.label} (${sourcePort.dataType}) cannot connect to ${targetPort.label} (${targetPort.dataType}).`);
    }

    if (sourcePort.risk && sourcePort.risk !== 'safe') {
      addRisk(risk, sourcePort.risk, `${surface.label}: ${sourcePort.label} input is ${sourcePort.risk} risk.`, 'input');
    }
    if (targetPort.risk && targetPort.risk !== 'safe') {
      addRisk(risk, targetPort.risk, `${surface.label}: ${targetPort.label} output is ${targetPort.risk} risk.`, 'output');
    }
  });

  surface.nodes.forEach((node) => {
    const definition = getBlockDefinition(node.type);
    getEffectivePortDefinitions(node, 'input').forEach((input) => {
      if (input.required && !edgesByTarget.has(`${node.id}:${input.id}`)) {
        errors.push(`${surface.label}: ${node.settings.label || definition.label} requires ${input.label}.`);
      }
    });

    if (node.type === 'RegExpression') {
      const patternError = validateRegexPattern(node.settings.pattern ?? '');
      if (patternError) {
        errors.push(`${surface.label}: ${node.settings.label || definition.label}: ${patternError}`);
      }
    }

    if (node.type === 'SaveStringToLog') {
      addRisk(risk, 'extended', `${surface.label}: Action Pack logging stores local run data.`, 'output');
    }
  });

  return edgesByTarget;
}

function contentBlockerSurface(workspace: WorkspaceFileV2, id: ContentBlockerSurfaceId): WorkspaceGraphSurface | null {
  return workspace.surfaces?.find((surface) => surface.id === id) ?? null;
}

function validateContentBlockerWorkspace(workspace: WorkspaceFileV2): WorkspaceValidationState {
  const errors: string[] = [];
  const warnings: string[] = [];
  const invalidEdgeIds: string[] = [];
  const risk = emptyRisk();

  if (!workspace.metadata.name.trim()) {
    errors.push('Workspace name is required.');
  }

  if (workspace.workspaceType === 'custom-block') {
    if (!workspace.customBlock) {
      errors.push('Custom Block workspace metadata is required.');
    }
    if (!workspace.nodes.some((node) => node.type === 'CustomBlockInput')) {
      errors.push('Custom Block workspaces require at least one Custom Input block.');
    }
    if (!workspace.nodes.some((node) => node.type === 'CustomBlockOutput')) {
      errors.push('Custom Block workspaces require at least one Custom Output block.');
    }
  }

  const pageLoad = contentBlockerSurface(workspace, 'page-load');
  const recurring = contentBlockerSurface(workspace, 'recurring');
  const challenge = contentBlockerSurface(workspace, 'challenge');
  if (!pageLoad || !recurring || !challenge) {
    errors.push('Content Blocker workspaces require Page Load Decision, Recurring Check, and Challenge Page surfaces.');
  }

  if ((workspace.contentBlocker?.recurringIntervalSeconds ?? 30) < 5) {
    errors.push('Content Blocker recurring interval must be at least 5 seconds.');
  }

  if (pageLoad) {
    const edgesByTarget = validateSurfaceConnections(pageLoad, CONTENT_BLOCKER_DECISION_ALLOWED_BLOCKS, errors, invalidEdgeIds, risk);
    const terminals = pageLoad.nodes.filter((node) => node.type === 'DecisionOut' && edgesByTarget.has(`${node.id}:decision`));
    if (terminals.length !== 1) {
      errors.push('Page Load Decision requires exactly one connected Decision Out block.');
    }
  }

  if (recurring && recurring.nodes.length > 0) {
    const edgesByTarget = validateSurfaceConnections(recurring, CONTENT_BLOCKER_DECISION_ALLOWED_BLOCKS, errors, invalidEdgeIds, risk);
    const terminals = recurring.nodes.filter((node) => node.type === 'DecisionOut' && edgesByTarget.has(`${node.id}:decision`));
    if (terminals.length !== 1) {
      errors.push('Recurring Check requires exactly one connected Decision Out block when it is not empty.');
    }
  }

  if (challenge) {
    const allowedChallengeBlocks = new Set<BlockKind>([
      ...CONTENT_BLOCKER_CHALLENGE_BLOCKS,
      'ChallengeComplete',
      'Logical',
      'LogicalFlow',
      'Math',
      'Constant',
      'ConditionSelect',
      'Convert',
      'TextSplitJoin',
      'UrlQuery',
      'DataStructure',
      'DictGet',
      'DictOperation',
      'ListOperation',
      'AddStringToList',
      'CustomBlock',
      'RandomNumber',
      'SaveLoad',
      'SharedState',
      'Declarations',
      'Substitution',
      'TextTransform',
    ]);
    validateSurfaceConnections(challenge, allowedChallengeBlocks, errors, invalidEdgeIds, risk);
    if (!challenge.nodes.some((node) => node.type === 'ChallengeComplete')) {
      errors.push('Challenge Page requires a Challenge Result block.');
    }
    if (!challenge.nodes.some((node) => CONTENT_BLOCKER_CHALLENGE_BLOCKS.has(node.type))) {
      errors.push('Challenge Page requires at least one Timer, Typer, Clicker, Confirm Choice, or Reason Prompt block.');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    invalidEdgeIds,
    risk,
  };
}

function validateCustomBlockMetadata(workspace: WorkspaceFileV2, errors: string[]): void {
  const metadata = workspace.customBlock;
  if (!metadata) {
    return;
  }
  if (!isCustomBlockCategory(metadata.category)) {
    errors.push('Custom Block category must be a specific Block Library category; choose a category other than Custom.');
  }
  if (metadata.label !== workspace.metadata.name) {
    errors.push('Custom Block name must match Workspace Name.');
  }
  if (metadata.version !== workspace.metadata.version) {
    errors.push('Custom Block version must match Workspace Version.');
  }

  const validateDirection = (
    nodeType: Extract<BlockKind, 'CustomBlockInput' | 'CustomBlockOutput'>,
    ports: typeof metadata.inputs,
    label: string,
  ): void => {
    const boundaryNodes = workspace.nodes.filter((node) => node.type === nodeType);
    if (boundaryNodes.length !== ports.length) {
      errors.push(`Custom Block ${label} metadata must have exactly one matching ${nodeType} block per port.`);
    }
    const seenPortIds = new Set<string>();
    ports.forEach((port) => {
      if (seenPortIds.has(port.id)) {
        errors.push(`Custom Block ${label} metadata has duplicate port id "${port.id}".`);
        return;
      }
      seenPortIds.add(port.id);
      const matchingNodes = boundaryNodes.filter((node) => node.settings.customPortId === port.id);
      if (matchingNodes.length !== 1) {
        errors.push(`Custom Block ${label} port "${port.id}" must have exactly one matching ${nodeType} block.`);
        return;
      }
      const node = matchingNodes[0];
      if ((node.settings.customPortLabel ?? '') !== port.label) {
        errors.push(`Custom Block ${label} port "${port.id}" label does not match its ${nodeType} block.`);
      }
      if ((node.settings.customPortDataType ?? 'Any') !== port.dataType) {
        errors.push(`Custom Block ${label} port "${port.id}" type does not match its ${nodeType} block.`);
      }
      if ((node.settings.customPortTooltip ?? '') !== (port.tooltip ?? '')) {
        errors.push(`Custom Block ${label} port "${port.id}" tooltip does not match its ${nodeType} block.`);
      }
    });
  };

  validateDirection('CustomBlockInput', metadata.inputs, 'input');
  validateDirection('CustomBlockOutput', metadata.outputs, 'output');
}

function validateWorkspace(workspace: WorkspaceFileV2): WorkspaceValidationState {
  if (workspace.workspaceType === 'content-blocker') {
    return validateContentBlockerWorkspace(workspace);
  }

  const contentBlockerNodes = new Set<BlockKind>([
    'ContentDataIn',
    'DecisionOut',
    'ChallengeTimer',
    'ChallengeTyper',
    'ChallengeClicker',
    'ChallengeConfirm',
    'ChallengeReason',
    'ChallengeComplete',
  ]);
  const errors: string[] = [];
  const warnings: string[] = [];
  const invalidEdgeIds: string[] = [];
  const risk = emptyRisk();
  const nodeIds = new Set(workspace.nodes.map((node) => node.id));
  const targetConnectionKeys = new Set<string>();

  if (!workspace.metadata.name.trim()) {
    errors.push('Workspace name is required.');
  }

  if (workspace.workspaceType === 'custom-block') {
    if (!workspace.customBlock) {
      errors.push('Custom Block workspace metadata is required.');
    } else {
      validateCustomBlockMetadata(workspace, errors);
    }
    if (!workspace.nodes.some((node) => node.type === 'CustomBlockInput')) {
      errors.push('Custom Block workspaces require at least one Custom Input block.');
    }
    if (!workspace.nodes.some((node) => node.type === 'CustomBlockOutput')) {
      errors.push('Custom Block workspaces require at least one Custom Output block.');
    }
  }

  const triggerType = workspace.trigger.type === 'ALWAYS' ? 'INPUT_DATA' : workspace.trigger.type;
  const hotkeyError =
    triggerType === 'HOTKEY' ? getHotkeyValidationError(workspace.trigger.hotkey, []) : null;
  if (hotkeyError) {
    errors.push(`Hotkey: ${hotkeyError}`);
  }

  if (!['INPUT_DATA', 'HOTKEY', 'CONTEXT_MENU', 'INTERVAL', 'CONDITIONAL', 'NEVER'].includes(triggerType)) {
    errors.push(`Trigger ${String(workspace.trigger.type)} is not supported.`);
  }

  if (triggerType === 'INTERVAL') {
    const intervalMs = Math.trunc(workspace.trigger.intervalMs ?? DEFAULT_INTERVAL_TRIGGER_MS);
    if (intervalMs < MIN_INTERVAL_TRIGGER_MS) {
      errors.push(`Interval trigger must be at least ${MIN_INTERVAL_TRIGGER_MS / 1000} seconds.`);
    }
  }

  if (triggerType === 'CONDITIONAL') {
    if (!['RISING_EDGE', 'WHILE_TRUE'].includes(workspace.trigger.conditionalMode ?? 'RISING_EDGE')) {
      errors.push('Conditional trigger mode must be Rising Edge or While True.');
    }
  }

  const sourceFilters = [
    ...(workspace.trigger.sourceFilters ?? []),
    ...(workspace.trigger.scope_regex?.trim()
      ? [{ source: 'url' as const, pattern: workspace.trigger.scope_regex.trim() }]
      : []),
  ];
  sourceFilters.forEach((filter) => {
    if (!WORKSPACE_INPUT_SOURCE_IDS.has(filter.source)) {
      errors.push(`Input filter source ${filter.source} is not supported.`);
      return;
    }

    if (filter.pattern.trim()) {
      const scopeError = validateRegexPattern(filter.pattern);
      if (scopeError) {
        errors.push(`${filter.source} input filter: ${scopeError}`);
      }
    }
  });

  visibleWorkspaceEdges(workspace).forEach((edge) => {
    const sourceNode = findNode(workspace, edge.source);
    const targetNode = findNode(workspace, edge.target);
    const sourcePort = sourceNode ? getEffectivePortDefinition(sourceNode, 'output', edge.sourceHandle) : null;
    const targetPort = targetNode ? getEffectivePortDefinition(targetNode, 'input', edge.targetHandle) : null;

    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target) || !sourcePort || !targetPort) {
      invalidEdgeIds.push(edge.id);
      errors.push(`Connection ${edge.id} references a missing block or port.`);
      return;
    }

    if (targetConnectionKeys.has(edgeKey(edge))) {
      invalidEdgeIds.push(edge.id);
      errors.push(`Only one connection can feed ${targetNode!.settings.label || targetNode!.type}.${targetPort.label}.`);
      return;
    }

    targetConnectionKeys.add(edgeKey(edge));

    if (targetNode && variableDrivenInputHandles(targetNode).has(edge.targetHandle)) {
      invalidEdgeIds.push(edge.id);
      errors.push(`${targetNode.settings.label || targetNode.type}.${targetPort.label} is disabled because its literal field uses a variable.`);
      return;
    }

    if (!isTypeCompatible(sourcePort.dataType, targetPort.dataType)) {
      invalidEdgeIds.push(edge.id);
      errors.push(`${sourcePort.label} (${sourcePort.dataType}) cannot connect to ${targetPort.label} (${targetPort.dataType}).`);
    }

    if (sourcePort.risk && sourcePort.risk !== 'safe') {
      addRisk(risk, sourcePort.risk, `${sourcePort.label} input is ${sourcePort.risk} risk.`, 'input');
    }

    if (targetPort.risk && targetPort.risk !== 'safe') {
      addRisk(risk, targetPort.risk, `${targetPort.label} output is ${targetPort.risk} risk.`, 'output');
    }
  });

  const edgesByTarget = new Map(visibleWorkspaceEdges(workspace).map((edge) => [`${edge.target}:${edge.targetHandle}`, edge]));
  const declaredVariableTypes = collectDeclaredVariableTypes(workspace, edgesByTarget);
  if (!hasRunnableTerminalNode(workspace, edgesByTarget)) {
    errors.push('Add a URL output, data output, storage write, overlay action, or other terminal side-effect before building an Action Pack.');
  }

  workspace.nodes.forEach((node) => {
    const definition = getBlockDefinition(node.type);
    if (contentBlockerNodes.has(node.type)) {
      errors.push(`${definition.label} can only be used in Content Blocker workspaces.`);
    }
    getEffectivePortDefinitions(node, 'input').forEach((input) => {
      if (input.required && !edgesByTarget.has(`${node.id}:${input.id}`)) {
        errors.push(`${node.settings.label || definition.label} requires ${input.label}.`);
      }
    });
    validateVariableFieldReferences(workspace, node, edgesByTarget, declaredVariableTypes, errors, invalidEdgeIds);

    if (node.type === 'RegExpression') {
      const pattern = node.settings.pattern ?? '';
      const patternError = validateRegexPattern(pattern);
      if (patternError) {
        errors.push(`${node.settings.label || definition.label}: ${patternError}`);
      }

      if (node.settings.payloadVars && node.settings.payload?.includes('{clipboard}')) {
        addRisk(risk, 'high', 'Clipboard payload interpolation is high risk.', 'input');
      }
    }

    if (node.type === 'FetchData' || node.type === 'HttpRequest' || node.type === 'GetImage' || node.type === 'GetVideo' || node.type === 'GetAudio') {
      const remoteDataNode = node.type === 'FetchData' || node.type === 'HttpRequest';
      const urlInput = connectedInput(edgesByTarget, node.id, 'url');
      const hasEmbeddedAsset = !remoteDataNode && Boolean(node.settings.assetDataBase64?.trim());
      const hasResourceAsset = !remoteDataNode && Boolean(node.settings.assetResourceId?.trim());
      addRisk(risk, 'high', remoteDataNode ? 'Remote data access is high risk.' : hasEmbeddedAsset || hasResourceAsset ? 'Local media access is high risk for imported packs.' : 'Remote media access is high risk.', 'input');
      const fallbackUrl = urlInput ? '' : (remoteDataNode ? node.settings.remoteUrl : node.settings.assetUrl)?.trim() ?? '';
      if (!urlInput && !fallbackUrl && !hasEmbeddedAsset) {
        errors.push(`${node.settings.label || definition.label}: remote URL or embedded asset is required unless the URL input is connected.`);
      }

      if (fallbackUrl) {
        try {
          validateRemoteUrl(fallbackUrl);
        } catch (error) {
          errors.push(`${node.settings.label || definition.label}: ${error instanceof Error ? error.message : 'remote URL is invalid'}.`);
        }
      }

      const timeoutMs = Math.trunc(node.settings.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS);
      if (timeoutMs < 500 || timeoutMs > 30_000) {
        errors.push(`${node.settings.label || definition.label}: timeout must be between 500ms and 30000ms.`);
      }

      const maxBytes = Math.trunc(node.settings.remoteMaxBytes ?? (remoteDataNode ? DEFAULT_REMOTE_MAX_BYTES : DEFAULT_ASSET_MAX_BYTES));
      if (remoteDataNode && (maxBytes < 1_024 || maxBytes > 512 * 1024)) {
        errors.push(`${node.settings.label || definition.label}: max bytes must be between 1KB and 512KB.`);
      }

      if (!remoteDataNode && (maxBytes < 1 || maxBytes > MAX_ASSET_MAX_BYTES)) {
        errors.push(`${node.settings.label || definition.label}: asset byte budget must be between 1 byte and ${Math.round(MAX_ASSET_MAX_BYTES / (1024 * 1024))}MB.`);
      }

      if (node.type === 'HttpRequest' && !['GET', 'POST'].includes(node.settings.remoteMethod ?? 'GET')) {
        errors.push(`${node.settings.label || definition.label}: method must be GET or POST.`);
      }
    }

    if (node.type === 'SystemData' && !['NOW_MS', 'EPOCH_SECONDS', 'ISO_DATE', 'TIMEZONE_OFFSET_MINUTES', 'LOCALE_DATE', 'LOCALE_TIME'].includes(node.settings.systemDataMode ?? 'NOW_MS')) {
      errors.push(`${node.settings.label || definition.label}: system data mode is invalid.`);
    }

    if (node.type === 'PromptText' || node.type === 'PromptNumber' || node.type === 'Confirm') {
      addRisk(risk, 'extended', 'User interaction is extended risk.', 'input');
    }

    if (node.type === 'PickFileOrUrl') {
      addRisk(risk, 'high', 'File selection or user-provided URL is high risk.', 'input');
    }

    if (node.type === 'ShowMessage' || node.type === 'ShowImage' || node.type === 'ShowVideo' || node.type === 'PlaySound' || node.type === 'OverlayInput') {
      addRisk(risk, 'extended', node.type === 'OverlayInput' ? 'Overlay input can capture keyboard or mouse while it is open.' : 'Page overlay display is extended risk.', 'output');
      if (!['OVERLAY', 'REPLACE_PAGE', 'NEW_TAB'].includes(node.settings.displayMode ?? 'OVERLAY')) {
        errors.push(`${node.settings.label || definition.label}: display mode is invalid.`);
      }

      const timeoutMs = node.settings.displayTimeoutMs;
      if (timeoutMs !== undefined && (Math.trunc(timeoutMs) < 0 || Math.trunc(timeoutMs) > 3_600_000)) {
        errors.push(`${node.settings.label || definition.label}: timeout must be between 0ms and 3600000ms.`);
      }
    }

    if (node.type === 'Loop') {
      const loopLimit = Math.trunc(node.settings.loopLimit ?? 10);
      if (loopLimit < 1 || loopLimit > 100) {
        errors.push(`${node.settings.label || definition.label}: loop limit must be between 1 and 100.`);
      }
    }

    if (node.type === 'SaveStringToLog' && !['debug', 'info', 'warn', 'error'].includes(node.settings.logSeverity ?? 'info')) {
      errors.push(`${node.settings.label || definition.label}: severity must be Debug, Info, Warn, or Error.`);
    }

    if (node.type === 'Substitution') {
      const inputCount = Math.trunc(node.settings.substitutionInputCount ?? 1);
      if (inputCount < 1 || inputCount > 24) {
        errors.push(`${node.settings.label || definition.label}: substitution connectors must be between 1 and 24.`);
      }
    }

    if (node.type === 'CustomBlock') {
      if (!node.settings.customBlockId?.trim()) {
        errors.push(`${node.settings.label || definition.label}: choose an installed Custom Block.`);
      }
    }

    if ((node.type === 'CustomBlockInput' || node.type === 'CustomBlockOutput') && !node.settings.customPortId?.trim()) {
      errors.push(`${node.settings.label || definition.label}: custom port id is required.`);
    }

    if (node.type === 'TextTransform' && !TEXT_TRANSFORM_MODES.includes(node.settings.textTransformMode ?? 'TRIM')) {
      errors.push(`${node.settings.label || definition.label}: text transform mode is invalid.`);
    }

    if (node.type === 'TextSplitJoin' && !TEXT_SPLIT_JOIN_MODES.includes(node.settings.splitJoinMode ?? 'SPLIT_LINES')) {
      errors.push(`${node.settings.label || definition.label}: split/join mode is invalid.`);
    }

    if (node.type === 'UrlQuery' && !URL_QUERY_MODES.includes(node.settings.urlQueryMode ?? 'PARSE')) {
      errors.push(`${node.settings.label || definition.label}: URL query mode is invalid.`);
    }

    if (node.type === 'DictOperation' && !DICT_OPERATION_MODES.includes(node.settings.dictOperationMode ?? 'KEYS')) {
      errors.push(`${node.settings.label || definition.label}: dict operation mode is invalid.`);
    }

    if (node.type === 'Declarations') {
      if (!node.settings.variableName?.trim()) {
        warnings.push(`${node.settings.label || definition.label} has no variable name and will be ignored.`);
      } else {
        const error = validateVariableName(node.settings.variableName);
        if (error) {
          errors.push(`${node.settings.label || definition.label}: ${error}`);
        }
      }
    }
  });

  const reachable = collectReachableNodes(workspace);
  const unused = workspace.nodes.filter((node) => !reachable.has(node.id) && !['DataFlowIn', 'DataFlowOut'].includes(node.type));
  if (unused.length > 0) {
    warnings.push(`${unused.length} disconnected block${unused.length === 1 ? '' : 's'} will be saved but not compiled.`);
  }

  if (isGlobalScope(workspace.trigger.scope_regex) && risk.highest !== 'safe') {
    warnings.push('This pack uses extended data with a global trigger scope.');
  }

  return {
    valid: errors.length === 0,
    errors: Array.from(new Set(errors)),
    warnings: Array.from(new Set(warnings)),
    invalidEdgeIds,
    risk,
  };
}

function isGlobalScope(scopeRegex?: string): boolean {
  return GLOBAL_SCOPE_PATTERNS.has((scopeRegex ?? '').trim());
}

function graphValueFromPlain(value: unknown, preferredType: GraphDataType = 'Any'): GraphValue {
  if (preferredType === 'list') {
    if (Array.isArray(value)) {
      return { type: 'list', value: value.flatMap((entry) => Array.isArray(entry) ? entry : [entry]).map((entry) => String(entry)).filter(Boolean) };
    }
    if (typeof value === 'string') {
      return { type: 'list', value: value.replace(/\r\n?/g, '\n').split('\n').map((entry) => entry.trim()).filter(Boolean) };
    }
    return { type: 'list', value: [] };
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

  if (typeof value === 'object' && value !== null) {
    return {
      type: 'dict',
      value: Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
          key,
          graphValueFromPlain(entry),
        ]),
      ),
    };
  }

  return { type: preferredType, value } as GraphValue;
}

function normalizeUrlListEntries(entries: string[]): string[] {
  const normalized = new Set<string>();
  entries.forEach((entry) => {
    try {
      normalized.add(new URL(entry).toString());
    } catch {
      // URL lists intentionally drop invalid entries instead of preserving unusable values.
    }
  });
  return Array.from(normalized);
}

function literalGraphValue(raw: string | undefined, dataType: GraphDataType = 'string', listType: WorkspaceNodeV2['settings']['literalListType'] = 'string'): GraphValue {
  const value = raw ?? '';
  switch (dataType) {
    case 'bool':
      return { type: 'bool', value: value.trim() === '1' || value.trim().toLowerCase() === 'true' ? 1 : 0 };
    case 'number': {
      const numeric = Number.parseFloat(value);
      return { type: 'number', value: Number.isFinite(numeric) ? Math.trunc(numeric) : 0 };
    }
    case 'floatingPoint': {
      const numeric = Number.parseFloat(value);
      return { type: 'floatingPoint', value: Number.isFinite(numeric) ? numeric : 0 };
    }
    case 'URL':
      return { type: 'URL', value };
    case 'JSON':
      return { type: 'JSON', value };
    case 'list': {
      const entries = value.replace(/\r\n?/g, '\n').split('\n').map((entry) => entry.trim()).filter(Boolean);
      return { type: 'list', value: listType === 'URL' ? normalizeUrlListEntries(entries) : entries };
    }
    case 'dict':
    case 'data':
    case 'Any':
      try {
        const parsed = JSON.parse(value || (dataType === 'data' ? '[]' : '{}'));
        const graphValue = graphValueFromPlain(parsed, dataType);
        if (dataType === 'dict' && graphValue.type !== 'dict') {
          return { type: 'dict', value: {} };
        }
        if (dataType === 'data' && graphValue.type !== 'data') {
          return { type: 'data', value: parsed };
        }
        return graphValue;
      } catch {
        return dataType === 'data' ? { type: 'data', value: [] } : dataType === 'dict' ? { type: 'dict', value: {} } : { type: 'Any', value };
      }
    case 'asset':
      return { type: 'asset', value: { source: 'embedded', kind: 'unknown', mimeType: '' } };
    case 'string':
    default:
      return { type: 'string', value };
  }
}

function instructionForNode(
  node: WorkspaceNodeV2,
  workspace: WorkspaceFileV2,
  edgesByTarget: Map<string, WorkspaceEdgeV2>,
  includedNodeIds: Set<string>,
  customBlocks: CompiledCustomBlockV2[] = [],
): GraphVmInstruction[] {
  const instructions: GraphVmInstruction[] = [];

  switch (node.type) {
    case 'DataFlowIn':
    case 'ContentDataIn':
    case 'ExtendedDataIn':
    case 'OnTriggerEvent':
    case 'KeyboardIn':
    case 'MouseIn':
    case 'OverlayTickIn': {
      const definition = getBlockDefinition(node.type);
      const usedHandles = connectedOutputHandles(workspace, node.id, includedNodeIds);
      definition.outputs.forEach((output) => {
        if (!usedHandles.has(output.id)) {
          return;
        }

        instructions.push({
          op: 'SOURCE',
          nodeId: node.id,
          source: output.id,
          output: symbol(node.id, output.id),
          dataType: output.dataType,
          risk: output.risk ?? definition.risk,
        });
      });
      break;
    }
    case 'RegExpression':
      instructions.push({
        op: 'REGEX_TRANSFORM',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'input'),
        output: symbol(node.id, 'result'),
        pattern: node.settings.pattern ?? '',
        action: node.settings.action ?? 'SUBSTITUTE',
        matchMode: node.settings.matchMode ?? 'STANDARD',
        nthOccurrence: node.settings.nthOccurrence ?? 1,
        payload: node.settings.payload ?? '',
        payloadInput: connectedInput(edgesByTarget, node.id, 'payload'),
        payloadVars: Boolean(node.settings.payloadVars),
      });
      break;
    case 'FetchData':
      {
        const urlInput = connectedInput(edgesByTarget, node.id, 'url');
        instructions.push({
        op: 'FETCH_GET',
        nodeId: node.id,
        url: urlInput,
        output: symbol(node.id, 'result'),
        fallbackUrl: urlInput ? '' : node.settings.remoteUrl ?? '',
        outputDataType: node.settings.remoteDataType ?? 'data',
        timeoutMs: Math.max(500, Math.min(30_000, Math.trunc(node.settings.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS))),
        maxBytes: Math.max(1_024, Math.min(512 * 1024, Math.trunc(node.settings.remoteMaxBytes ?? DEFAULT_REMOTE_MAX_BYTES))),
        });
      }
      break;
    case 'HttpRequest':
      {
        const urlInput = connectedInput(edgesByTarget, node.id, 'url');
        instructions.push({
        op: 'HTTP_REQUEST',
        nodeId: node.id,
        url: urlInput,
        body: connectedInput(edgesByTarget, node.id, 'body'),
        output: symbol(node.id, 'result'),
        method: node.settings.remoteMethod ?? 'GET',
        fallbackUrl: urlInput ? '' : node.settings.remoteUrl ?? '',
        outputDataType: node.settings.remoteDataType ?? 'data',
        timeoutMs: Math.max(500, Math.min(30_000, Math.trunc(node.settings.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS))),
        maxBytes: Math.max(1_024, Math.min(512 * 1024, Math.trunc(node.settings.remoteMaxBytes ?? DEFAULT_REMOTE_MAX_BYTES))),
        });
      }
      break;
    case 'SystemData':
      instructions.push({
        op: 'SYSTEM_DATA',
        nodeId: node.id,
        output: symbol(node.id, 'result'),
        mode: node.settings.systemDataMode ?? 'NOW_MS',
      });
      break;
    case 'PromptText':
    case 'PromptNumber':
    case 'Confirm':
    case 'PickFileOrUrl':
      instructions.push({
        op: 'USER_INTERACTION',
        nodeId: node.id,
        output: symbol(node.id, 'result'),
        interaction: interactionKindForNode(node.type),
        messageInput: connectedInput(edgesByTarget, node.id, 'message'),
        message: node.settings.promptMessage ?? getBlockDefinition(node.type).label,
        placeholder: node.settings.promptPlaceholder,
        defaultValue: node.settings.promptDefaultValue,
        minValue: node.settings.minValue,
        maxValue: node.settings.maxValue,
      });
      break;
    case 'GetImage':
    case 'GetVideo':
    case 'GetAudio':
      {
        const urlInput = connectedInput(edgesByTarget, node.id, 'url');
        instructions.push({
        op: 'GET_ASSET',
        nodeId: node.id,
        url: urlInput,
        output: symbol(node.id, 'result'),
        fallbackUrl: urlInput ? '' : node.settings.assetUrl ?? '',
        kind: node.settings.assetKind ?? assetKindForNode(node.type),
        embedded: node.settings.assetResourceId
          ? {
              source: 'resource',
              kind: node.settings.assetKind ?? assetKindForNode(node.type),
              mimeType: node.settings.assetMimeType ?? 'application/octet-stream',
              name: node.settings.assetName,
              resourceId: node.settings.assetResourceId,
              sha256: node.settings.assetResourceId,
            }
          : node.settings.assetDataBase64
          ? {
              source: 'embedded',
              kind: node.settings.assetKind ?? assetKindForNode(node.type),
              mimeType: node.settings.assetMimeType ?? '',
              name: node.settings.assetName,
              dataBase64: node.settings.assetDataBase64,
              compression: node.settings.assetCompression ?? 'gzip',
            }
          : undefined,
        timeoutMs: Math.max(500, Math.min(30_000, Math.trunc(node.settings.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS))),
        maxBytes: Math.max(1, Math.min(MAX_ASSET_MAX_BYTES, Math.trunc(node.settings.remoteMaxBytes ?? DEFAULT_ASSET_MAX_BYTES))),
        });
      }
      break;
    case 'ShowMessage':
      instructions.push({
        op: 'DISPLAY',
        nodeId: node.id,
        titleInput: connectedInput(edgesByTarget, node.id, 'title'),
        input: connectedInput(edgesByTarget, node.id, 'message'),
        output: symbol(node.id, 'result'),
        displayType: 'message',
        title: node.settings.promptTitle ?? 'URL Alchemist',
        message: node.settings.promptMessage ?? '',
        mode: node.settings.displayMode ?? 'OVERLAY',
        timeoutMs: node.settings.displayTimeoutMs,
      });
      break;
    case 'ShowImage':
    case 'ShowVideo':
    case 'PlaySound':
      instructions.push({
        op: 'DISPLAY',
        nodeId: node.id,
        asset: connectedInput(edgesByTarget, node.id, 'asset'),
        input: connectedInput(edgesByTarget, node.id, 'caption'),
        output: symbol(node.id, 'result'),
        displayType: node.type === 'ShowVideo' ? 'video' : node.type === 'PlaySound' ? 'sound' : 'image',
        title: node.settings.promptTitle,
        message: node.settings.promptMessage ?? '',
        mode: node.settings.displayMode ?? 'OVERLAY',
        stopMode: node.type === 'ShowImage' ? node.settings.imageStopMode ?? 'CLOSE_BUTTON' : undefined,
        timeoutMs: node.settings.displayTimeoutMs,
      });
      break;
    case 'OverlayInput':
      instructions.push({
        op: 'DISPLAY',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'message'),
        output: symbol(node.id, 'result'),
        displayType: 'input-capture',
        message: node.settings.promptMessage ?? 'Use the keyboard or mouse while this overlay is open.',
        mode: 'OVERLAY',
        timeoutMs: node.settings.displayTimeoutMs,
        captureKeyboard: node.settings.captureKeyboard ?? true,
        captureMouse: node.settings.captureMouse ?? true,
      });
      break;
    case 'Constant':
      instructions.push({
        op: 'CONSTANT',
        nodeId: node.id,
        output: symbol(node.id, 'value'),
        value: literalGraphValue(node.settings.literalValue, node.settings.literalDataType ?? 'string', node.settings.literalListType),
      });
      break;
    case 'Sleep':
      instructions.push({
        op: 'SLEEP',
        nodeId: node.id,
        duration: connectedInput(edgesByTarget, node.id, 'duration'),
        enabled: connectedInput(edgesByTarget, node.id, 'enabled'),
        output: symbol(node.id, 'result'),
        fallbackMs: Math.max(0, Math.min(60_000, Math.trunc(node.settings.sleepMs ?? 0))),
      });
      break;
    case 'SharedState':
      instructions.push({
        op: 'SHARED_STATE',
        nodeId: node.id,
        key: connectedInput(edgesByTarget, node.id, 'key'),
        value: connectedInput(edgesByTarget, node.id, 'value'),
        enabled: connectedInput(edgesByTarget, node.id, 'enabled'),
        output: symbol(node.id, 'result'),
        mode: node.settings.sharedStateMode ?? 'GET',
        fallbackKey: node.settings.literalValue ?? '',
        fallbackValue: literalGraphValue(node.settings.selectFalseValue ?? node.settings.literalValue, node.settings.literalDataType ?? 'Any'),
        fallbackRaw: node.settings.selectFalseValue,
      });
      break;
    case 'DictGet':
      instructions.push({
        op: 'DICT_GET',
        nodeId: node.id,
        dict: connectedInput(edgesByTarget, node.id, 'dict'),
        key: connectedInput(edgesByTarget, node.id, 'key'),
        output: symbol(node.id, 'result'),
        fallbackKey: node.settings.dictKey ?? '',
        fallbackValue: literalGraphValue(node.settings.literalValue, node.settings.literalDataType ?? 'Any'),
      });
      break;
    case 'ListOperation':
      instructions.push({
        op: 'LIST_OP',
        nodeId: node.id,
        list: connectedInput(edgesByTarget, node.id, 'list'),
        item: connectedInput(edgesByTarget, node.id, 'item'),
        index: connectedInput(edgesByTarget, node.id, 'index'),
        output: symbol(node.id, 'result'),
        operation: node.settings.listOperation ?? 'APPEND',
        fallbackList: literalGraphValue(node.settings.literalValue, 'data'),
        fallbackItem: literalGraphValue(node.settings.selectTrueValue, node.settings.literalDataType ?? 'Any'),
      });
      break;
    case 'AddStringToList':
      instructions.push({
        op: 'ADD_STRING_TO_LIST',
        nodeId: node.id,
        list: connectedInput(edgesByTarget, node.id, 'list'),
        item: connectedInput(edgesByTarget, node.id, 'item'),
        output: symbol(node.id, 'result'),
        fallbackList: literalGraphValue(node.settings.literalValue, 'list', node.settings.literalListType),
        fallbackItem: literalGraphValue(node.settings.selectTrueValue, 'string'),
        variableName: node.settings.listVariableName ?? '',
      });
      break;
    case 'ConditionSelect':
      instructions.push({
        op: 'SELECT',
        nodeId: node.id,
        condition: connectedInput(edgesByTarget, node.id, 'condition'),
        trueValue: connectedInput(edgesByTarget, node.id, 'trueValue'),
        falseValue: connectedInput(edgesByTarget, node.id, 'falseValue'),
        output: symbol(node.id, 'result'),
        fallbackTrue: literalGraphValue(node.settings.selectTrueValue, node.settings.literalDataType ?? 'Any'),
        fallbackFalse: literalGraphValue(node.settings.selectFalseValue, node.settings.literalDataType ?? 'Any'),
      });
      break;
    case 'LogicalFlow':
      instructions.push({
        op: 'BRANCH',
        nodeId: node.id,
        condition: logicalFlowConditionSymbol(workspace, node.id) ?? connectedInput(edgesByTarget, node.id, 'condition'),
        input: connectedInput(edgesByTarget, node.id, 'input'),
        trueOutput: symbol(node.id, 'trueValue'),
        falseOutput: symbol(node.id, 'falseValue'),
        fallbackInput: literalGraphValue(node.settings.literalValue, node.settings.literalDataType ?? 'Any'),
      });
      break;
    case 'CustomBlockInput':
      instructions.push({
        op: 'CUSTOM_INPUT',
        nodeId: node.id,
        inputId: node.settings.customPortId ?? 'input',
        output: symbol(node.id, 'value'),
        fallback: literalGraphValue(node.settings.literalValue, node.settings.customPortDataType ?? 'Any'),
      });
      break;
    case 'CustomBlockOutput':
      instructions.push({
        op: 'CUSTOM_OUTPUT',
        nodeId: node.id,
        outputId: node.settings.customPortId ?? 'result',
        value: connectedInput(edgesByTarget, node.id, 'value'),
        fallback: literalGraphValue(node.settings.literalValue, node.settings.customPortDataType ?? 'Any'),
      });
      break;
    case 'CustomBlock': {
      const block = customBlocks.find((candidate) => candidate.blockId === node.settings.customBlockId);
      if (!block) {
        break;
      }
      instructions.push({
        op: 'CUSTOM_BLOCK',
        nodeId: node.id,
        blockId: block.blockId,
        version: block.version,
        inputSymbols: Object.fromEntries(block.inputs.map((input) => [input.id, connectedInput(edgesByTarget, node.id, input.id)])),
        outputSymbols: Object.fromEntries(block.outputs.map((output) => [output.id, symbol(node.id, output.id)])),
        program: block.vm,
        inputDefaults: Object.fromEntries([
          ...block.inputs.map((input) => [input.id, literalGraphValue(node.settings.customFieldValues?.[input.id], input.dataType)] as const),
          ...block.fields.map((field) => [field.id, literalGraphValue(node.settings.customFieldValues?.[field.id] ?? field.defaultValue, field.dataType)] as const),
        ]),
        outputIds: block.outputs.map((output) => output.id),
      });
      break;
    }
    case 'RandomNumber':
      instructions.push({
        op: 'RANDOM_INT',
        nodeId: node.id,
        min: connectedInput(edgesByTarget, node.id, 'min'),
        max: connectedInput(edgesByTarget, node.id, 'max'),
        output: symbol(node.id, 'result'),
        fallbackMin: Math.trunc(node.settings.randomMin ?? 0),
        fallbackMax: Math.trunc(node.settings.randomMax ?? 10),
      });
      break;
    case 'Substitution': {
      const inputCount = Math.max(1, Math.min(24, Math.trunc(node.settings.substitutionInputCount ?? 1)));
      instructions.push({
        op: 'SUBSTITUTE',
        nodeId: node.id,
        output: symbol(node.id, 'result'),
        template: node.settings.substitutionTemplate ?? '',
        values: Array.from({ length: inputCount }, (_, index) => connectedInput(edgesByTarget, node.id, `value${index + 1}`) ?? ''),
      });
      break;
    }
    case 'TextTransform':
      instructions.push({
        op: 'TEXT_TRANSFORM',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'input'),
        output: symbol(node.id, 'result'),
        mode: node.settings.textTransformMode ?? 'TRIM',
      });
      break;
    case 'TextSplitJoin':
      instructions.push({
        op: 'TEXT_SPLIT_JOIN',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'input'),
        output: symbol(node.id, 'result'),
        mode: node.settings.splitJoinMode ?? 'SPLIT_LINES',
        separator: node.settings.splitJoinSeparator ?? ',',
      });
      break;
    case 'UrlQuery':
      instructions.push({
        op: 'URL_QUERY',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'input'),
        key: connectedInput(edgesByTarget, node.id, 'key'),
        value: connectedInput(edgesByTarget, node.id, 'value'),
        output: symbol(node.id, 'result'),
        mode: node.settings.urlQueryMode ?? 'PARSE',
        fallbackKey: node.settings.urlQueryKey ?? '',
        fallbackValue: node.settings.urlQueryValue ?? '',
        fallbackParams: node.settings.urlQueryParams ?? '',
      });
      break;
    case 'DictOperation':
      instructions.push({
        op: 'DICT_OP',
        nodeId: node.id,
        dict: connectedInput(edgesByTarget, node.id, 'dict'),
        other: connectedInput(edgesByTarget, node.id, 'other'),
        key: connectedInput(edgesByTarget, node.id, 'key'),
        output: symbol(node.id, 'result'),
        mode: node.settings.dictOperationMode ?? 'KEYS',
        fallbackKey: node.settings.dictKey ?? '',
      });
      break;
    case 'ConditionOut':
      instructions.push({
        op: 'CONDITION_OUT',
        nodeId: node.id,
        condition: connectedInput(edgesByTarget, node.id, 'condition'),
        output: symbol(node.id, 'condition'),
      });
      break;
    case 'DecisionOut':
      instructions.push({
        op: 'DECISION_OUT',
        nodeId: node.id,
        decision: connectedInput(edgesByTarget, node.id, 'decision'),
        output: symbol(node.id, 'decision'),
      });
      break;
    case 'CheckListForUrl':
      instructions.push({
        op: 'CHECK_LIST_FOR_URL',
        nodeId: node.id,
        url: connectedInput(edgesByTarget, node.id, 'url'),
        list: connectedInput(edgesByTarget, node.id, 'list'),
        output: symbol(node.id, 'decision'),
        fallbackUrl: node.settings.urlQueryValue ?? '',
        fallbackList: literalGraphValue(node.settings.literalValue, 'list', 'URL'),
        matchDecision: node.settings.contentBlockerMatchDecision === 1 ? 1 : 2,
      });
      break;
    case 'SaveStringToLog':
      instructions.push({
        op: 'LOG',
        nodeId: node.id,
        message: connectedInput(edgesByTarget, node.id, 'message'),
        output: symbol(node.id, 'result'),
        severity: node.settings.logSeverity ?? 'info',
        fallbackMessage: node.settings.literalValue ?? '',
      });
      break;
    case 'Abort':
      instructions.push({
        op: 'ABORT',
        nodeId: node.id,
        condition: connectedInput(edgesByTarget, node.id, 'condition'),
        output: symbol(node.id, 'result'),
        message: node.settings.abortMessage ?? 'Workflow requested abort.',
      });
      break;
    case 'OverlayControl':
      instructions.push({
        op: 'OVERLAY_CONTROL',
        nodeId: node.id,
        enabled: connectedInput(edgesByTarget, node.id, 'enabled'),
        messageInput: connectedInput(edgesByTarget, node.id, 'message'),
        output: symbol(node.id, 'result'),
        action: node.settings.overlayControlAction ?? 'START',
        message: node.settings.overlayText ?? node.settings.promptMessage ?? '',
        width: Math.max(1, Math.min(200, Math.trunc(node.settings.overlayWidth ?? 24))),
        height: Math.max(1, Math.min(200, Math.trunc(node.settings.overlayHeight ?? 18))),
        cellSize: Math.max(4, Math.min(96, Math.trunc(node.settings.overlayCellSize ?? 24))),
        tickMs: Math.max(16, Math.min(5_000, Math.trunc(node.settings.overlayTickMs ?? 120))),
        background: node.settings.overlayBackground ?? '#ffffff',
      });
      break;
    case 'OverlayDraw':
      instructions.push({
        op: 'OVERLAY_DRAW',
        nodeId: node.id,
        enabled: connectedInput(edgesByTarget, node.id, 'enabled'),
        cells: connectedInput(edgesByTarget, node.id, 'cells'),
        text: connectedInput(edgesByTarget, node.id, 'text'),
        output: symbol(node.id, 'result'),
        width: Math.max(1, Math.min(200, Math.trunc(node.settings.overlayWidth ?? 24))),
        height: Math.max(1, Math.min(200, Math.trunc(node.settings.overlayHeight ?? 18))),
        cellSize: Math.max(4, Math.min(96, Math.trunc(node.settings.overlayCellSize ?? 24))),
        background: node.settings.overlayBackground ?? '#ffffff',
      });
      break;
    case 'Logical':
      instructions.push({
        op: 'COMPARE',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'input'),
        compareInput: connectedInput(edgesByTarget, node.id, 'compare'),
        output: symbol(node.id, 'result'),
        operator: node.settings.operator ?? 'EQ',
        compareValue: node.settings.compareValue ?? '1',
        booleanOutput: true,
      });
      break;
    case 'Math':
      instructions.push({
        op: 'MATH',
        nodeId: node.id,
        left: connectedInput(edgesByTarget, node.id, 'left'),
        right: connectedInput(edgesByTarget, node.id, 'right'),
        output: symbol(node.id, 'result'),
        operation: node.settings.mathOperation ?? 'ADD',
        fallbackLeft: node.settings.literalValue ?? '0',
        fallbackRight: node.settings.compareValue ?? '0',
      });
      break;
    case 'Convert':
      instructions.push({
        op: 'CONVERT',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'input'),
        output: symbol(node.id, 'result'),
        mode: node.settings.convertMode ?? 'STRING_TO_URL',
        ord: node.settings.convertOrd ?? true,
        rounding: node.settings.rounding ?? 'ROUND',
      });
      break;
    case 'Declarations':
      if (node.settings.variableName?.trim()) {
        instructions.push({
          op: 'DECLARE',
          nodeId: node.id,
          name: normalizeVariableName(node.settings.variableName),
          value: connectedInput(edgesByTarget, node.id, 'value'),
          fallbackValue: literalGraphValue(node.settings.literalValue, node.settings.literalDataType ?? 'string', node.settings.literalListType),
        });
      }
      break;
    case 'SaveLoad':
      instructions.push({
        op: 'SAVELOAD',
        nodeId: node.id,
        key: connectedInput(edgesByTarget, node.id, 'key'),
        value: connectedInput(edgesByTarget, node.id, 'value'),
        output: symbol(node.id, 'result'),
        mode: node.settings.saveLoadMode ?? 'SAVE',
        fallbackKey: node.settings.literalValue ?? '',
      });
      break;
    case 'DataStructure':
      instructions.push({
        op: 'DICT_SET',
        nodeId: node.id,
        dict: connectedInput(edgesByTarget, node.id, 'dict'),
        key: connectedInput(edgesByTarget, node.id, 'key'),
        value: connectedInput(edgesByTarget, node.id, 'value'),
        output: symbol(node.id, 'result'),
        fallbackDictName: node.settings.variableName ?? '',
        fallbackKey: node.settings.dictKey ?? '',
      });
      break;
    case 'Loop':
      instructions.push({
        op: 'LOOP',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'input'),
        count: connectedInput(edgesByTarget, node.id, 'count'),
        output: symbol(node.id, 'result'),
        loopLimit: Math.max(1, Math.min(100, Math.trunc(node.settings.loopLimit ?? 10))),
      });
      break;
    case 'DataFlowOut':
    case 'ExtendedDataOut': {
      const definition = getBlockDefinition(node.type);
      definition.inputs.forEach((input) => {
        const connected = connectedInput(edgesByTarget, node.id, input.id);
        if (!connected) {
          return;
        }

        instructions.push({
          op: 'OUTPUT',
          nodeId: node.id,
          input: connected,
          destination: input.id,
          dataType: input.dataType,
          risk: input.risk ?? definition.risk,
        });
      });
      break;
    }
    default:
      break;
  }

  return instructions;
}

function buildSymbolTable(workspace: WorkspaceFileV2): Record<string, GraphDataType> {
  const symbolTable: Record<string, GraphDataType> = {};
  workspace.nodes.forEach((node) => {
    const definition = getBlockDefinition(node.type);
    getEffectivePortDefinitions(node, 'output').forEach((output) => {
      symbolTable[symbol(node.id, output.id)] = output.dataType;
    });
    if (node.type === 'ConditionOut') {
      symbolTable[symbol(node.id, 'condition')] = 'bool';
    }
    if (node.type === 'DecisionOut') {
      symbolTable[symbol(node.id, 'decision')] = 'number';
    }
  });

  return symbolTable;
}

function requiredPermissionsForInstructions(instructions: GraphVmInstruction[]): string[] {
  const permissions = new Set<string>();
  instructions.forEach((instruction) => {
    if (
      (instruction.op === 'SOURCE' && instruction.source === 'clipboard') ||
      (instruction.op === 'REGEX_TRANSFORM' && instruction.payloadVars && instruction.payload.includes('{clipboard}'))
    ) {
      permissions.add('clipboardRead');
    }

    if (instruction.op === 'OUTPUT' && ['clipboard', 'clipboardBinary'].includes(instruction.destination)) {
      permissions.add('clipboardWrite');
    }

    if (instruction.op === 'CUSTOM_BLOCK') {
      requiredPermissionsForInstructions(instruction.program.instructions).forEach((permission) => permissions.add(permission));
      Object.values(instruction.program.eventHandlers ?? {}).flat().forEach((nestedInstruction) => {
        requiredPermissionsForInstructions([nestedInstruction]).forEach((permission) => permissions.add(permission));
      });
    }
  });

  return Array.from(permissions);
}

function deriveInputSources(workspace: WorkspaceFileV2, reachable: Set<string>): WorkspaceInputSource[] {
  const sources = new Set<WorkspaceInputSource>();
  visibleWorkspaceEdges(workspace).forEach((edge) => {
    if (!reachable.has(edge.source) || !reachable.has(edge.target)) {
      return;
    }

    const sourceNode = findNode(workspace, edge.source);
    if (!sourceNode || (sourceNode.type !== 'DataFlowIn' && sourceNode.type !== 'ExtendedDataIn')) {
      return;
    }

    if (WORKSPACE_INPUT_SOURCE_IDS.has(edge.sourceHandle as WorkspaceInputSource)) {
      sources.add(edge.sourceHandle as WorkspaceInputSource);
    }
  });

  if (workspace.trigger.inputSources) {
    workspace.trigger.inputSources.forEach((source) => {
      if (WORKSPACE_INPUT_SOURCE_IDS.has(source)) {
        sources.add(source);
      }
    });
  }

  if (sources.size === 0) {
    sources.add('url');
  }

  return Array.from(sources).sort();
}

function compileTriggerPlan(workspace: WorkspaceFileV2, inputSources: WorkspaceInputSource[], condition?: ConditionCompileResult): CompiledTriggerPlan {
  const type = workspace.trigger.type === 'ALWAYS' ? 'INPUT_DATA' : workspace.trigger.type;
  const sourceFilters = [
    ...(workspace.trigger.sourceFilters ?? []),
    ...(workspace.trigger.scope_regex?.trim()
      ? [{ source: 'url' as const, pattern: workspace.trigger.scope_regex.trim() }]
      : []),
  ].filter((filter) => WORKSPACE_INPUT_SOURCE_IDS.has(filter.source) && filter.pattern.trim());

  return {
    type,
    inputSources,
    sourceFilters,
    intervalMs: type === 'INTERVAL' || type === 'CONDITIONAL'
      ? Math.max(MIN_INTERVAL_TRIGGER_MS, Math.trunc(workspace.trigger.intervalMs ?? DEFAULT_INTERVAL_TRIGGER_MS))
      : undefined,
    conditionalMode: type === 'CONDITIONAL' ? workspace.trigger.conditionalMode ?? 'RISING_EDGE' : undefined,
    conditionWorkspaceId: type === 'CONDITIONAL' ? workspace.trigger.conditionWorkspaceId : undefined,
    conditionVm: type === 'CONDITIONAL' ? condition?.vm : undefined,
    conditionOutput: type === 'CONDITIONAL' ? condition?.output : undefined,
    conditionStateKey: type === 'CONDITIONAL' ? `url-alchemist-condition:${workspace.metadata.id}` : undefined,
    safety: {
      timestampHistoryLimit: INPUT_TRIGGER_HISTORY_LIMIT,
      burstLimit: INPUT_TRIGGER_BURST_LIMIT,
      burstWindowMs: INPUT_TRIGGER_BURST_WINDOW_MS,
    },
  };
}

function buildSafetyPolicy(instructions: GraphVmInstruction[]): GraphVmSafetyPolicy {
  const remoteMaxBytes = Math.max(
    DEFAULT_REMOTE_MAX_BYTES,
    ...instructions
      .filter((instruction) => instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST' || instruction.op === 'GET_ASSET')
      .map((instruction) => instruction.maxBytes),
  );

  return {
    abortOnFailure: true,
    regexTimeoutMs: REGEX_TIMEOUT_MS,
    remoteTimeoutMs: DEFAULT_REMOTE_TIMEOUT_MS,
    remoteMaxBytes,
    rules: instructions.map((instruction) => {
      if (instruction.op === 'REGEX_TRANSFORM') {
        return {
          nodeId: instruction.nodeId,
          op: instruction.op,
          requiresWatchdog: true,
          maxRuntimeMs: REGEX_TIMEOUT_MS,
        };
      }

      if (instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST' || instruction.op === 'GET_ASSET') {
        return {
          nodeId: instruction.nodeId,
          op: instruction.op,
          requiresWatchdog: true,
          maxRuntimeMs: instruction.timeoutMs,
          maxBytes: instruction.maxBytes,
        };
      }

      if (instruction.op === 'DECLARE') {
        return {
          nodeId: instruction.nodeId,
          op: instruction.op,
          requiresWatchdog: false,
          rangeCheck: 'numeric values must fit the declared runtime data range',
        };
      }

      if (instruction.op === 'LOOP') {
        return {
          nodeId: instruction.nodeId,
          op: instruction.op,
          requiresWatchdog: false,
          rangeCheck: `loop count is capped at ${instruction.loopLimit}`,
        };
      }

      if (instruction.op === 'ABORT') {
        return {
          nodeId: instruction.nodeId,
          op: instruction.op,
          requiresWatchdog: false,
          rangeCheck: 'abort exits the current Action Pack run when the condition is true',
        };
      }

      return {
        nodeId: instruction.nodeId,
        op: instruction.op,
        requiresWatchdog: false,
      };
    }),
  };
}

function instructionKey(instruction: GraphVmInstruction): string {
  return JSON.stringify(instruction);
}

function uniqueInstructions(instructions: GraphVmInstruction[]): GraphVmInstruction[] {
  const seen = new Set<string>();
  return instructions.filter((instruction) => {
    const key = instructionKey(instruction);
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}

interface ConditionCompileResult {
  vm: NonNullable<CompiledTriggerPlan['conditionVm']>;
  output: string;
}

function mergeRiskSummary(target: CompiledRiskSummary, source: CompiledRiskSummary): void {
  target.highest = combineRisk(target.highest, source.highest);
  target.usesExtendedInput = target.usesExtendedInput || source.usesExtendedInput;
  target.usesExtendedOutput = target.usesExtendedOutput || source.usesExtendedOutput;
  target.usesHighRiskInput = target.usesHighRiskInput || source.usesHighRiskInput;
  target.usesHighRiskOutput = target.usesHighRiskOutput || source.usesHighRiskOutput;
  source.reasons.forEach((reason) => {
    if (!target.reasons.includes(reason)) {
      target.reasons.push(reason);
    }
  });
}

function findConditionWorkspace(workspace: WorkspaceFileV2, options: CompileOptions): WorkspaceFileV2 | null {
  const conditionWorkspaceId = workspace.trigger.conditionWorkspaceId?.trim();
  if (!conditionWorkspaceId || conditionWorkspaceId === workspace.metadata.id) {
    return workspace;
  }

  return options.conditionWorkspaces?.find((candidate) => candidate.metadata.id === conditionWorkspaceId) ?? null;
}

function validateConditionNodes(workspace: WorkspaceFileV2, includedNodeIds: Set<string>): string[] {
  const errors: string[] = [];
  workspace.nodes.forEach((node) => {
    if (!includedNodeIds.has(node.id)) {
      return;
    }

    if (!CONDITION_ALLOWED_BLOCKS.has(node.type)) {
      errors.push(`${node.settings.label || getBlockDefinition(node.type).label}: ${getBlockDefinition(node.type).label} cannot run in a conditional Run check.`);
      return;
    }

    if (!CONDITION_SOURCE_BLOCKS.has(node.type) && (node.type === 'ExtendedDataIn' || node.type === 'OnTriggerEvent' || node.type === 'KeyboardIn' || node.type === 'MouseIn' || node.type === 'OverlayTickIn')) {
      errors.push(`${node.settings.label || getBlockDefinition(node.type).label}: event and extended page sources are not available to conditional Run checks.`);
    }

    if (node.type === 'SaveLoad' && !['GET', 'EXISTS'].includes(node.settings.saveLoadMode ?? 'GET')) {
      errors.push(`${node.settings.label || getBlockDefinition(node.type).label}: conditional Run checks can only use SaveLoad Get or Exists.`);
    }

    if (node.type === 'SharedState' && !['GET', 'EXISTS'].includes(node.settings.sharedStateMode ?? 'GET')) {
      errors.push(`${node.settings.label || getBlockDefinition(node.type).label}: conditional Run checks can only use Shared State Get or Exists.`);
    }
  });

  visibleWorkspaceEdges(workspace).forEach((edge) => {
    if (!includedNodeIds.has(edge.source) || !includedNodeIds.has(edge.target)) {
      return;
    }

    const sourceNode = findNode(workspace, edge.source);
    if (sourceNode?.type === 'DataFlowIn' && edge.sourceHandle !== 'url') {
      errors.push(`${sourceNode.settings.label || getBlockDefinition(sourceNode.type).label}: conditional Run checks can only read the current URL from Data In.`);
    }
  });

  return errors;
}

function compileConditionProgram(workspace: WorkspaceFileV2): { ok: true; result: ConditionCompileResult; risk: CompiledRiskSummary; instructions: GraphVmInstruction[] } | { ok: false; errors: string[] } {
  const edgesByTarget = new Map(visibleWorkspaceEdges(workspace).map((edge) => [`${edge.target}:${edge.targetHandle}`, edge]));
  const terminals = workspace.nodes.filter((node) => node.type === 'ConditionOut' && edgesByTarget.has(`${node.id}:condition`));
  if (terminals.length !== 1) {
    return { ok: false, errors: ['Conditional Run requires exactly one connected Condition Out block in the selected condition workspace.'] };
  }

  const includedNodeIds = upstreamNodeIds(workspace, terminals[0].id);
  const nodeErrors = validateConditionNodes(workspace, includedNodeIds);
  if (nodeErrors.length > 0) {
    return { ok: false, errors: nodeErrors };
  }

  const sorted = topologicalSort(workspace, includedNodeIds);
  if (!sorted.ok) {
    return { ok: false, errors: [`Condition workspace contains a cycle involving ${sorted.cycleIds.length} blocks.`] };
  }

  const instructions = uniqueInstructions(sorted.nodes.flatMap((node) => instructionForNode(node, workspace, edgesByTarget, includedNodeIds)));
  const risk = emptyRisk();
  instructions.forEach((instruction) => {
    if (instruction.op === 'SAVELOAD') {
      addRisk(risk, 'extended', 'Session storage access is extended risk.', 'output');
    }
    if (instruction.op === 'SHARED_STATE') {
      addRisk(risk, 'extended', 'Session-scoped shared state is extended risk.', 'output');
    }
  });

  return {
    ok: true,
    result: {
      vm: {
        instructions,
        constants: {},
        symbolTable: buildSymbolTable(workspace),
        stepBudget: VM_STEP_BUDGET,
        loopBudget: VM_LOOP_BUDGET,
        valueByteLimit: VM_VALUE_BYTE_LIMIT,
        safety: buildSafetyPolicy(instructions),
      },
      output: symbol(terminals[0].id, 'condition'),
    },
    risk,
    instructions,
  };
}

function compileConditionForWorkspace(workspace: WorkspaceFileV2, options: CompileOptions): { ok: true; result?: ConditionCompileResult; risk?: CompiledRiskSummary; instructions: GraphVmInstruction[] } | { ok: false; errors: string[] } {
  const triggerType = workspace.trigger.type === 'ALWAYS' ? 'INPUT_DATA' : workspace.trigger.type;
  if (triggerType !== 'CONDITIONAL') {
    return { ok: true, instructions: [] };
  }

  const conditionWorkspace = findConditionWorkspace(workspace, options);
  if (!conditionWorkspace) {
    return { ok: false, errors: [`Conditional Run could not find condition workspace ${workspace.trigger.conditionWorkspaceId}.`] };
  }

  const compiled = compileConditionProgram(conditionWorkspace);
  if (!compiled.ok) {
    return compiled;
  }

  return {
    ok: true,
    result: compiled.result,
    risk: compiled.risk,
    instructions: compiled.instructions,
  };
}

function workspaceForSurface(workspace: WorkspaceFileV2, surface: WorkspaceGraphSurface): WorkspaceFileV2 {
  return {
    ...workspace,
    workspaceType: 'data-modifier',
    nodes: surface.nodes,
    edges: surface.edges,
    viewport: surface.viewport,
    surfaces: undefined,
    contentBlocker: undefined,
    trigger: {
      type: 'INPUT_DATA',
      inputSources: ['url', 'pageTitle', 'pageMetadata', 'pageText', 'secondsOnPage'],
      sourceFilters: [],
    },
  };
}

function compileDecisionSurfaceProgram(
  workspace: WorkspaceFileV2,
  surface: WorkspaceGraphSurface,
  options: CompileOptions,
): { ok: true; program: ContentBlockerDecisionProgram; risk: CompiledRiskSummary; instructions: GraphVmInstruction[] } | { ok: false; errors: string[] } {
  const surfaceWorkspace = workspaceForSurface(workspace, surface);
  const edgesByTarget = new Map(visibleWorkspaceEdges(surfaceWorkspace).map((edge) => [`${edge.target}:${edge.targetHandle}`, edge]));
  const terminals = surfaceWorkspace.nodes.filter((node) => node.type === 'DecisionOut' && edgesByTarget.has(`${node.id}:decision`));
  if (terminals.length !== 1) {
    return { ok: false, errors: [`${surface.label} requires exactly one connected Decision Out block.`] };
  }

  const includedNodeIds = upstreamNodeIds(surfaceWorkspace, terminals[0].id);
  const sorted = topologicalSort(surfaceWorkspace, includedNodeIds);
  if (!sorted.ok) {
    return { ok: false, errors: [`${surface.label} contains a cycle involving ${sorted.cycleIds.length} blocks.`] };
  }

  const branchGuards = logicalFlowGuards(surfaceWorkspace, edgesByTarget);
  const instructions = uniqueInstructions(sorted.nodes.flatMap((node) =>
    withInstructionGuard(
      instructionForNode(node, surfaceWorkspace, edgesByTarget, includedNodeIds, options.customBlocks ?? []),
      branchGuards.get(node.id),
    ),
  ));
  const risk = emptyRisk();
  instructions.forEach((instruction) => {
    if ('risk' in instruction && getRiskRank(instruction.risk) > 0) {
      const label = instruction.op === 'SOURCE' ? instruction.source : instruction.op;
      addRisk(risk, instruction.risk, `${surface.label}: ${label} input is ${instruction.risk} risk.`, 'input');
    }
    if (instruction.op === 'SAVELOAD' || instruction.op === 'SHARED_STATE') {
      addRisk(risk, 'extended', `${surface.label}: session state access is extended risk.`, 'output');
    }
    if (instruction.op === 'LOG') {
      addRisk(risk, 'extended', `${surface.label}: Action Pack logging stores local run data.`, 'output');
    }
    if (instruction.op === 'CUSTOM_BLOCK') {
      const block = options.customBlocks?.find((candidate) => candidate.blockId === instruction.blockId);
      if (block) {
        mergeRiskSummary(risk, block.risk);
      }
    }
  });

  return {
    ok: true,
    program: {
      surfaceId: surface.id as Extract<ContentBlockerSurfaceId, 'page-load' | 'recurring'>,
      vm: {
        instructions,
        constants: {},
        symbolTable: buildSymbolTable(surfaceWorkspace),
        stepBudget: VM_STEP_BUDGET,
        loopBudget: VM_LOOP_BUDGET,
        valueByteLimit: VM_VALUE_BYTE_LIMIT,
        safety: buildSafetyPolicy(instructions),
      },
      output: symbol(terminals[0].id, 'decision'),
    },
    risk,
    instructions,
  };
}

function challengeTaskForNode(node: WorkspaceNodeV2): ContentBlockerChallengeTask | null {
  const label = node.settings.label || getBlockDefinition(node.type).label;
  switch (node.type) {
    case 'ChallengeTimer':
      return {
        id: node.id,
        kind: 'timer',
        label,
        seconds: Math.max(1, Math.min(3600, Math.trunc(node.settings.challengeSeconds ?? node.settings.sleepMs ?? 30))),
      };
    case 'ChallengeTyper':
      return {
        id: node.id,
        kind: 'typer',
        label,
        text: String(node.settings.challengeText || node.settings.literalValue || 'I want to continue'),
        count: Math.max(1, Math.min(25, Math.trunc((node.settings.challengeCount ?? Number.parseInt(node.settings.compareValue ?? '1', 10)) || 1))),
      };
    case 'ChallengeClicker':
      return {
        id: node.id,
        kind: 'clicker',
        label,
        count: Math.max(1, Math.min(1000, Math.trunc(node.settings.challengeCount ?? 10))),
      };
    case 'ChallengeConfirm':
      return {
        id: node.id,
        kind: 'confirm',
        label,
        text: node.settings.challengeText || 'Confirm that you want to continue.',
      };
    case 'ChallengeReason':
      return {
        id: node.id,
        kind: 'reason',
        label,
        text: node.settings.challengeText || 'Why do you want to continue?',
      };
    default:
      return null;
  }
}

function compileChallengeTasks(surface: WorkspaceGraphSurface): ContentBlockerChallengeTask[] {
  return surface.nodes
    .filter((node) => CONTENT_BLOCKER_CHALLENGE_BLOCKS.has(node.type))
    .slice()
    .sort((left, right) => left.position.x === right.position.x ? left.position.y - right.position.y : left.position.x - right.position.x)
    .map(challengeTaskForNode)
    .filter((task): task is ContentBlockerChallengeTask => Boolean(task));
}

function compileContentBlockerWorkspace(
  workspace: WorkspaceFileV2,
  validation: WorkspaceValidationState,
  workspaceWithValidation: WorkspaceFileV2,
  options: CompileOptions,
): GraphCompileResult {
  const pageLoad = contentBlockerSurface(workspace, 'page-load');
  const recurring = contentBlockerSurface(workspace, 'recurring');
  const challenge = contentBlockerSurface(workspace, 'challenge');
  if (!pageLoad || !recurring || !challenge) {
    return { ok: false, workspace: workspaceWithValidation, validation };
  }

  const pageLoadProgram = compileDecisionSurfaceProgram(workspace, pageLoad, options);
  if (!pageLoadProgram.ok) {
    const nextValidation = {
      ...validation,
      valid: false,
      errors: [...validation.errors, ...pageLoadProgram.errors],
    };
    return { ok: false, workspace: { ...workspaceWithValidation, validationState: nextValidation }, validation: nextValidation };
  }

  const recurringProgram = recurring.nodes.length > 0 ? compileDecisionSurfaceProgram(workspace, recurring, options) : undefined;
  if (recurringProgram && !recurringProgram.ok) {
    const nextValidation = {
      ...validation,
      valid: false,
      errors: [...validation.errors, ...recurringProgram.errors],
    };
    return { ok: false, workspace: { ...workspaceWithValidation, validationState: nextValidation }, validation: nextValidation };
  }

  const risk = { ...validation.risk };
  mergeRiskSummary(risk, pageLoadProgram.risk);
  if (recurringProgram?.ok) {
    mergeRiskSummary(risk, recurringProgram.risk);
  }

  const allInstructions = [
    ...pageLoadProgram.instructions,
    ...(recurringProgram?.ok ? recurringProgram.instructions : []),
  ];
  const safety = buildSafetyPolicy([]);
  const triggerPlan = compileTriggerPlan(workspaceForSurface(workspace, pageLoad), ['url', 'pageTitle', 'pageMetadata', 'pageText'], undefined);
  const contentBlocker = workspace.contentBlocker ?? {
    lockLevel: 0,
    allowLockIncrease: false,
    recurringIntervalSeconds: 30,
    blockPageTitle: 'Page blocked',
    blockPageMessage: 'This page is blocked by URL Alchemist.',
    challengePageTitle: 'Challenge required',
    challengePageMessage: 'Complete the challenge to continue to the page.',
  };

  const pack: CompiledActionPackV2 = {
    kind: 'action-pack.v2',
    schemaVersion: ACTION_PACK_SCHEMA_VERSION,
    manifest: {
      id: workspace.metadata.id,
      name: workspace.metadata.name,
      version: workspace.metadata.version,
      enabled: true,
      metadata: {
        author: workspace.metadata.author,
        description: workspace.metadata.description,
        created_at: workspace.metadata.created_at,
        workspaceType: 'content-blocker',
      },
      trigger: {
        type: 'INPUT_DATA',
        inputSources: ['url', 'pageTitle', 'pageMetadata', 'pageText'],
        sourceFilters: [],
      },
    },
    sourceWorkspaceId: workspace.metadata.id,
    builder: {
      urlAlchemistVersion: URL_ALCHEMIST_VERSION,
      buildTimeUtc: options.buildTimeUtc ?? Math.floor(Date.now() / 1000),
      builderUuid: options.builderUuid ?? crypto.randomUUID(),
    },
    risk,
    triggerPlan,
    requiredPermissions: requiredPermissionsForInstructions(allInstructions),
    vm: {
      instructions: [],
      eventHandlers: {
        trigger: [],
        keyboard: [],
        mouse: [],
        tick: [],
      },
      constants: {},
      symbolTable: {},
      stepBudget: VM_STEP_BUDGET,
      loopBudget: VM_LOOP_BUDGET,
      valueByteLimit: VM_VALUE_BYTE_LIMIT,
      safety,
    },
    install: {
      source: 'content-blocker',
      trustStatus: 'trusted',
      loggingEnabled: true,
      installedAt: Date.now(),
      contentBlocker: {
        pageLoad: pageLoadProgram.program,
        recurring: recurringProgram?.ok ? recurringProgram.program : undefined,
        recurringIntervalSeconds: Math.max(5, Math.trunc(contentBlocker.recurringIntervalSeconds)),
        challengeTitle: contentBlocker.challengePageTitle,
        challengeMessage: contentBlocker.challengePageMessage,
        blockTitle: contentBlocker.blockPageTitle,
        blockMessage: contentBlocker.blockPageMessage,
        challengeTasks: compileChallengeTasks(challenge),
        allowLockIncrease: contentBlocker.allowLockIncrease,
      },
    },
  };

  return {
    ok: true,
    workspace: workspaceWithValidation,
    validation: {
      ...validation,
      risk,
    },
    pack,
  };
}

export function compileWorkspace(workspace: WorkspaceFileV2, options: CompileOptions = {}): GraphCompileResult {
  const customBlocks = (options.customBlocks ?? []).filter((block) => isCustomBlockCategory(block.category));
  options = { ...options, customBlocks };
  workspace = synchronizeCustomBlockInvocationMetadata(workspace, customBlocks);
  const validation = validateWorkspace(workspace);
  const workspaceWithValidation: WorkspaceFileV2 = {
    ...workspace,
    validationState: validation,
  };

  const availableCustomBlockIds = new Set(customBlocks.map((block) => block.blockId));
  const customBlockInvocationNodes = [
    ...workspace.nodes,
    ...(workspace.surfaces ?? []).flatMap((surface) => surface.nodes),
  ];
  const missingCustomBlocks = customBlockInvocationNodes
    .filter((node) => node.type === 'CustomBlock' && node.settings.customBlockId && !availableCustomBlockIds.has(node.settings.customBlockId))
    .map((node) => node.settings.customBlockName || node.settings.customBlockId || 'Custom Block');
  const recursionErrors = customBlockRecursionErrors(workspace, customBlocks);
  if (missingCustomBlocks.length > 0) {
    const customValidation: WorkspaceValidationState = {
      ...validation,
      valid: false,
      errors: [...validation.errors, ...missingCustomBlocks.map((name) => `Custom Block "${name}" is not installed or embedded for this workspace.`)],
    };
    return {
      ok: false,
      workspace: {
        ...workspaceWithValidation,
        validationState: customValidation,
      },
      validation: customValidation,
    };
  }
  if (recursionErrors.length > 0) {
    const customValidation: WorkspaceValidationState = {
      ...validation,
      valid: false,
      errors: [...validation.errors, ...recursionErrors],
    };
    return {
      ok: false,
      workspace: {
        ...workspaceWithValidation,
        validationState: customValidation,
      },
      validation: customValidation,
    };
  }

  if (!validation.valid) {
    return {
      ok: false,
      workspace: workspaceWithValidation,
      validation,
    };
  }

  if (workspace.workspaceType === 'content-blocker') {
    return compileContentBlockerWorkspace(workspace, validation, workspaceWithValidation, options);
  }

  const customBlockNodeIds = new Set(workspace.nodes.map((node) => node.id));
  const reachableByHandler = workspace.workspaceType === 'custom-block'
    ? {
      trigger: customBlockNodeIds,
      keyboard: new Set<string>(),
      mouse: new Set<string>(),
      tick: new Set<string>(),
    }
    : collectHandlerReachability(workspace);
  const reachable = workspace.workspaceType === 'custom-block' ? customBlockNodeIds : collectReachableNodes(workspace);
  const sortedByHandler = new Map<GraphEventHandler, WorkspaceNodeV2[]>();
  for (const handler of EVENT_HANDLERS) {
    const sorted = topologicalSort(workspace, reachableByHandler[handler]);
    if (!sorted.ok) {
      const cycleValidation: WorkspaceValidationState = {
        ...validation,
        valid: false,
        errors: [...validation.errors, `Workspace ${handler} handler contains a cycle involving ${sorted.cycleIds.length} blocks.`],
      };

      return {
        ok: false,
        workspace: {
          ...workspaceWithValidation,
          validationState: cycleValidation,
        },
        validation: cycleValidation,
      };
    }

    sortedByHandler.set(handler, sorted.nodes);
  }

  if (EVENT_HANDLERS.every((handler) => (sortedByHandler.get(handler)?.length ?? 0) === 0)) {
    const cycleValidation: WorkspaceValidationState = {
      ...validation,
      valid: false,
      errors: [...validation.errors, 'Workspace has no compiled trigger or overlay event handler blocks.'],
    };

    return {
      ok: false,
      workspace: {
        ...workspaceWithValidation,
        validationState: cycleValidation,
      },
      validation: cycleValidation,
    };
  }

  const edgesByTarget = new Map(visibleWorkspaceEdges(workspace).map((edge) => [`${edge.target}:${edge.targetHandle}`, edge]));
  const branchGuards = logicalFlowGuards(workspace, edgesByTarget);
  const eventHandlers = Object.fromEntries(
    EVENT_HANDLERS.map((handler) => [
      handler,
      sortedByHandler.get(handler)?.flatMap((node) =>
        withInstructionGuard(
          instructionForNode(node, workspace, edgesByTarget, reachableByHandler[handler], options.customBlocks ?? []),
          branchGuards.get(node.id),
        ),
      ) ?? [],
    ]),
  ) as Record<GraphEventHandler, GraphVmInstruction[]>;
  const instructions = uniqueInstructions(EVENT_HANDLERS.flatMap((handler) => eventHandlers[handler]));
  const condition = compileConditionForWorkspace(workspace, options);
  if (!condition.ok) {
    const conditionValidation: WorkspaceValidationState = {
      ...validation,
      valid: false,
      errors: [...validation.errors, ...condition.errors],
    };

    return {
      ok: false,
      workspace: {
        ...workspaceWithValidation,
        validationState: conditionValidation,
      },
      validation: conditionValidation,
    };
  }

  const triggerPlan = compileTriggerPlan(workspace, deriveInputSources(workspace, reachable), condition.result);
  const safety = buildSafetyPolicy(instructions);
  const risk = { ...validation.risk };
  if (condition.risk) {
    mergeRiskSummary(risk, condition.risk);
  }
  const allInstructions = [...instructions, ...condition.instructions];
  allInstructions.forEach((instruction) => {
    if ('risk' in instruction && getRiskRank(instruction.risk) > 0) {
      const label = instruction.op === 'OUTPUT' ? instruction.destination : instruction.source;
      addRisk(
        risk,
        instruction.risk,
        `${label} is ${instruction.risk} risk.`,
        instruction.op === 'OUTPUT' ? 'output' : 'input',
      );
    }

    if (instruction.op === 'SAVELOAD') {
      addRisk(risk, 'extended', 'Session storage access is extended risk.', 'output');
    }

    if (instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST') {
      addRisk(risk, 'high', 'Remote data access is high risk.', 'input');
      const host = instruction.fallbackUrl ? cleanUrl(instruction.fallbackUrl) : undefined;
      addRisk(
        risk,
        'high',
        host ? `Remote host ${new URL(host).host} may receive or provide data.` : 'Dynamic remote host may receive or provide data.',
        'input',
      );
    }

    if (instruction.op === 'GET_ASSET') {
      addRisk(risk, 'high', instruction.embedded ? 'Embedded media access is high risk.' : 'Remote media access is high risk.', 'input');
      const host = instruction.fallbackUrl ? cleanUrl(instruction.fallbackUrl) : undefined;
      if (!instruction.embedded) {
        addRisk(
          risk,
          'high',
          host ? `Remote media host ${new URL(host).host} may provide displayable content.` : 'Dynamic remote media host may provide displayable content.',
          'input',
        );
      }
    }

    if (instruction.op === 'USER_INTERACTION') {
      addRisk(
        risk,
        instruction.interaction === 'PICK_FILE_OR_URL' ? 'high' : 'extended',
        instruction.interaction === 'PICK_FILE_OR_URL' ? 'File selection or user-provided URL is high risk.' : 'User interaction is extended risk.',
        'input',
      );
    }

    if (instruction.op === 'DISPLAY') {
      addRisk(
        risk,
        'extended',
        instruction.displayType === 'input-capture'
          ? 'Overlay input can capture keyboard or mouse while it is open.'
          : 'Page overlay display is extended risk.',
        'output',
      );
    }

    if (instruction.op === 'SHARED_STATE') {
      addRisk(risk, 'extended', 'Session-scoped shared state is extended risk.', 'output');
    }

    if (instruction.op === 'LOG') {
      addRisk(risk, 'extended', 'Action Pack logging stores local run data.', 'output');
    }

    if (instruction.op === 'OVERLAY_CONTROL' || instruction.op === 'OVERLAY_DRAW') {
      addRisk(risk, 'extended', 'Interactive overlay display is extended risk.', 'output');
    }

    if (instruction.op === 'CUSTOM_BLOCK') {
      const block = options.customBlocks?.find((candidate) => candidate.blockId === instruction.blockId);
      if (block) {
        mergeRiskSummary(risk, block.risk);
      }
    }
  });

  if (workspace.workspaceType === 'custom-block' && workspace.customBlock) {
    const vm: GraphVmProgram = {
      instructions,
      eventHandlers,
      constants: {},
      symbolTable: buildSymbolTable(workspace),
      stepBudget: VM_STEP_BUDGET,
      loopBudget: VM_LOOP_BUDGET,
      valueByteLimit: VM_VALUE_BYTE_LIMIT,
      safety,
    };

    return {
      ok: true,
      workspace: {
        ...workspace,
        validationState: validation,
      },
      validation,
      customBlock: {
        kind: 'custom-block.v2',
        schemaVersion: ACTION_PACK_SCHEMA_VERSION,
        blockId: workspace.customBlock.blockId,
        label: workspace.metadata.name,
        version: workspace.metadata.version,
        category: workspace.customBlock.category as CompiledCustomBlockV2['category'],
        description: workspace.customBlock.description,
        tips: workspace.customBlock.tips,
        visibleWorkspaceTypes: workspace.customBlock.visibleWorkspaceTypes,
        inputs: workspace.customBlock.inputs,
        outputs: workspace.customBlock.outputs,
        fields: workspace.customBlock.fields,
        sourceWorkspaceId: workspace.metadata.id,
        sourceWorkspace: workspace,
        vm,
        risk,
        installedAt: Date.now(),
      },
    };
  }

  const pack: CompiledActionPackV2 = {
    kind: 'action-pack.v2',
    schemaVersion: ACTION_PACK_SCHEMA_VERSION,
    manifest: {
      id: workspace.metadata.id,
      name: workspace.metadata.name,
      version: workspace.metadata.version,
      enabled: true,
      metadata: {
        author: workspace.metadata.author,
        description: workspace.metadata.description,
        created_at: workspace.metadata.created_at,
        workspaceType: workspace.workspaceType,
      },
      trigger: {
        ...workspace.trigger,
        type: workspace.trigger.type === 'ALWAYS' ? 'INPUT_DATA' : workspace.trigger.type,
        inputSources: triggerPlan.inputSources,
        sourceFilters: triggerPlan.sourceFilters,
        intervalMs: triggerPlan.intervalMs,
        conditionalMode: triggerPlan.conditionalMode,
        conditionWorkspaceId: triggerPlan.conditionWorkspaceId,
        scope_regex: undefined,
      },
    },
    sourceWorkspaceId: workspace.metadata.id,
    builder: {
      urlAlchemistVersion: URL_ALCHEMIST_VERSION,
      buildTimeUtc: options.buildTimeUtc ?? Math.floor(Date.now() / 1000),
      builderUuid: options.builderUuid ?? crypto.randomUUID(),
    },
    risk,
    triggerPlan,
    requiredPermissions: requiredPermissionsForInstructions(allInstructions),
    vm: {
      instructions,
      eventHandlers,
      constants: {},
      symbolTable: buildSymbolTable(workspace),
      stepBudget: VM_STEP_BUDGET,
      loopBudget: VM_LOOP_BUDGET,
      valueByteLimit: VM_VALUE_BYTE_LIMIT,
      safety,
    },
    embeddedCustomBlocks: workspace.embeddedCustomBlocks,
  };

  return {
    ok: true,
    workspace: {
      ...workspace,
      validationState: validation,
    },
    validation,
    pack,
  };
}

export function getConnectionValidationError(workspace: WorkspaceFileV2, edge: WorkspaceEdgeV2): string | null {
  const source = sourceType(workspace, edge);
  const target = targetType(workspace, edge);

  if (!source || !target) {
    return 'Missing source or target port.';
  }

  if (!isTypeCompatible(source, target)) {
    return `${source} cannot connect to ${target}.`;
  }

  return null;
}
