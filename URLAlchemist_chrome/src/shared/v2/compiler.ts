import { GLOBAL_SCOPE_PATTERNS } from '../constants';
import { getHotkeyValidationError } from '../hotkeys';
import { assertSafeRegexPattern } from '../regex/executeRegexJob';
import {
  combineRisk,
  getBlockDefinition,
  getPortDefinition,
  getRiskRank,
  isTypeCompatible,
} from './blockRegistry';
import type {
  BlockKind,
  CompiledActionPackV2,
  CompiledRiskSummary,
  GraphCompileResult,
  GraphDataType,
  GraphVmInstruction,
  RiskLevel,
  WorkspaceEdgeV2,
  WorkspaceFileV2,
  WorkspaceNodeV2,
  WorkspaceValidationState,
} from './types';
import { ACTION_PACK_SCHEMA_VERSION } from './types';

const VM_STEP_BUDGET = 300;
const VM_LOOP_BUDGET = 500;
const VM_VALUE_BYTE_LIMIT = 256 * 1024;

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

  return getPortDefinition(sourceNode.type, 'output', edge.sourceHandle)?.dataType ?? null;
}

function targetType(workspace: WorkspaceFileV2, edge: WorkspaceEdgeV2): GraphDataType | null {
  const targetNode = findNode(workspace, edge.target);
  if (!targetNode) {
    return null;
  }

  return getPortDefinition(targetNode.type, 'input', edge.targetHandle)?.dataType ?? null;
}

function connectedInput(edgesByTarget: Map<string, WorkspaceEdgeV2>, nodeId: string, inputId: string): string | undefined {
  const edge = edgesByTarget.get(`${nodeId}:${inputId}`);
  return edge ? symbol(edge.source, edge.sourceHandle) : undefined;
}

function collectReachableNodes(workspace: WorkspaceFileV2): Set<string> {
  const reachable = new Set<string>();
  const outputEdges = workspace.edges.filter((edge) => {
    const target = findNode(workspace, edge.target);
    return target?.type === 'DataFlowOut' || target?.type === 'ExtendedDataOut';
  });
  const stack = outputEdges.map((edge) => edge.source);
  outputEdges.forEach((edge) => {
    reachable.add(edge.target);
  });

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (reachable.has(nodeId)) {
      continue;
    }

    reachable.add(nodeId);
    workspace.edges
      .filter((edge) => edge.target === nodeId)
      .forEach((edge) => {
        stack.push(edge.source);
      });
  }

  workspace.nodes.forEach((node) => {
    const definition = getBlockDefinition(node.type);
    if (definition.flags.alwaysProcess || node.settings.alwaysProcess || definition.flags.processBeforeRun || node.settings.processBeforeRun) {
      reachable.add(node.id);
    }
  });

  return reachable;
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

  workspace.edges.forEach((edge) => {
    if (!includedNodeIds.has(edge.source) || !includedNodeIds.has(edge.target)) {
      return;
    }

    outgoing.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
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

function validateWorkspace(workspace: WorkspaceFileV2): WorkspaceValidationState {
  const errors: string[] = [];
  const warnings: string[] = [];
  const invalidEdgeIds: string[] = [];
  const risk = emptyRisk();
  const nodeIds = new Set(workspace.nodes.map((node) => node.id));
  const targetConnectionKeys = new Set<string>();

  if (!workspace.metadata.name.trim()) {
    errors.push('Workspace name is required.');
  }

  const dataInCount = workspace.nodes.filter((node) => node.type === 'DataFlowIn').length;
  const dataOutCount = workspace.nodes.filter((node) => node.type === 'DataFlowOut').length;
  if (dataInCount < 1) {
    errors.push('At least one Data In block is required.');
  }

  if (dataOutCount < 1) {
    errors.push('At least one Data Out block is required.');
  }

  const hotkeyError =
    workspace.trigger.type === 'HOTKEY' ? getHotkeyValidationError(workspace.trigger.hotkey, []) : null;
  if (hotkeyError) {
    errors.push(`Hotkey: ${hotkeyError}`);
  }

  if (workspace.trigger.scope_regex?.trim()) {
    const scopeError = validateRegexPattern(workspace.trigger.scope_regex);
    if (scopeError) {
      errors.push(`Scope regex: ${scopeError}`);
    }
  }

  workspace.edges.forEach((edge) => {
    const sourceNode = findNode(workspace, edge.source);
    const targetNode = findNode(workspace, edge.target);
    const sourcePort = sourceNode ? getPortDefinition(sourceNode.type, 'output', edge.sourceHandle) : null;
    const targetPort = targetNode ? getPortDefinition(targetNode.type, 'input', edge.targetHandle) : null;

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

  const outputEdges = workspace.edges.filter((edge) => {
    const target = findNode(workspace, edge.target);
    return target?.type === 'DataFlowOut' || target?.type === 'ExtendedDataOut';
  });

  if (outputEdges.length < 1) {
    errors.push('Connect at least one value to Data Out before building an Action Pack.');
  }

  const edgesByTarget = new Map(workspace.edges.map((edge) => [`${edge.target}:${edge.targetHandle}`, edge]));
  workspace.nodes.forEach((node) => {
    const definition = getBlockDefinition(node.type);
    definition.inputs.forEach((input) => {
      if (input.required && !edgesByTarget.has(`${node.id}:${input.id}`)) {
        errors.push(`${node.settings.label || definition.label} requires ${input.label}.`);
      }
    });

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

    if (node.type === 'Loop') {
      const loopLimit = Math.trunc(node.settings.loopLimit ?? 10);
      if (loopLimit < 1 || loopLimit > 100) {
        errors.push(`${node.settings.label || definition.label}: loop limit must be between 1 and 100.`);
      }
    }

    if (node.type === 'Declarations' && !node.settings.variableName?.trim()) {
      warnings.push(`${node.settings.label || definition.label} has no variable name and will be ignored.`);
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

function instructionForNode(
  node: WorkspaceNodeV2,
  workspace: WorkspaceFileV2,
  edgesByTarget: Map<string, WorkspaceEdgeV2>,
): GraphVmInstruction[] {
  const instructions: GraphVmInstruction[] = [];

  switch (node.type) {
    case 'DataFlowIn':
    case 'ExtendedDataIn': {
      const definition = getBlockDefinition(node.type);
      definition.outputs.forEach((output) => {
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
        payloadVars: Boolean(node.settings.payloadVars),
      });
      break;
    case 'Logical':
      instructions.push({
        op: 'COMPARE',
        nodeId: node.id,
        input: connectedInput(edgesByTarget, node.id, 'input'),
        output: symbol(node.id, 'result'),
        operator: node.settings.operator ?? 'EQ',
        compareValue: node.settings.compareValue ?? '1',
        booleanOutput: node.settings.booleanOutput ?? true,
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
        rounding: node.settings.rounding ?? 'ROUND',
      });
      break;
    case 'Declarations':
      if (node.settings.variableName?.trim()) {
        instructions.push({
          op: 'DECLARE',
          nodeId: node.id,
          name: node.settings.variableName,
          value: connectedInput(edgesByTarget, node.id, 'value'),
          fallbackValue: node.settings.literalValue ?? '0',
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
    definition.outputs.forEach((output) => {
      symbolTable[symbol(node.id, output.id)] = output.dataType;
    });
  });

  return symbolTable;
}

function requiredPermissionsForRisk(risk: CompiledRiskSummary): string[] {
  const permissions = new Set<string>();
  if (risk.reasons.some((reason) => reason.toLowerCase().includes('clipboard'))) {
    permissions.add('clipboardRead');
  }

  return Array.from(permissions);
}

export function compileWorkspace(workspace: WorkspaceFileV2): GraphCompileResult {
  const validation = validateWorkspace(workspace);
  const workspaceWithValidation: WorkspaceFileV2 = {
    ...workspace,
    validationState: validation,
  };

  if (!validation.valid) {
    return {
      ok: false,
      workspace: workspaceWithValidation,
      validation,
    };
  }

  const reachable = collectReachableNodes(workspace);
  const sorted = topologicalSort(workspace, reachable);
  if (!sorted.ok) {
    const cycleValidation: WorkspaceValidationState = {
      ...validation,
      valid: false,
      errors: [...validation.errors, `Workspace contains a cycle involving ${sorted.cycleIds.length} blocks.`],
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

  const edgesByTarget = new Map(workspace.edges.map((edge) => [`${edge.target}:${edge.targetHandle}`, edge]));
  const instructions = sorted.nodes.flatMap((node) => instructionForNode(node, workspace, edgesByTarget));
  const risk = { ...validation.risk };
  instructions.forEach((instruction) => {
    if ('risk' in instruction && getRiskRank(instruction.risk) > 0) {
      const label = instruction.op === 'OUTPUT' ? instruction.destination : instruction.source;
      addRisk(
        risk,
        instruction.risk,
        `${label} is ${instruction.risk} risk.`,
        instruction.op === 'OUTPUT' ? 'output' : 'input',
      );
    }
  });

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
      },
      trigger: workspace.trigger,
    },
    sourceWorkspaceId: workspace.metadata.id,
    risk,
    requiredPermissions: requiredPermissionsForRisk(risk),
    vm: {
      instructions,
      constants: {},
      symbolTable: buildSymbolTable(workspace),
      stepBudget: VM_STEP_BUDGET,
      loopBudget: VM_LOOP_BUDGET,
      valueByteLimit: VM_VALUE_BYTE_LIMIT,
    },
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
