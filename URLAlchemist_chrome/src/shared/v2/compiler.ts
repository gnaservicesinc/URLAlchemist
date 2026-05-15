import { GLOBAL_SCOPE_PATTERNS, REGEX_TIMEOUT_MS } from '../constants';
import { getHotkeyValidationError } from '../hotkeys';
import { assertSafeRegexPattern } from '../regex/executeRegexJob';
import { validateRemoteUrl } from './remoteUrl';
import {
  combineRisk,
  getEffectivePortDefinition,
  getEffectivePortDefinitions,
  getBlockDefinition,
  getRiskRank,
  isTypeCompatible,
} from './blockRegistry';
import { URL_ALCHEMIST_VERSION } from './buildInfo';
import type {
  BlockKind,
  CompiledActionPackV2,
  CompiledTriggerPlan,
  CompiledRiskSummary,
  GraphCompileResult,
  GraphDataType,
  GraphVmInstruction,
  GraphVmSafetyPolicy,
  RiskLevel,
  WorkspaceInputSource,
  WorkspaceEdgeV2,
  WorkspaceFileV2,
  WorkspaceNodeV2,
  WorkspaceValidationState,
} from './types';
import {
  ACTION_PACK_SCHEMA_VERSION,
  DEFAULT_INTERVAL_TRIGGER_MS,
  DEFAULT_REMOTE_MAX_BYTES,
  DEFAULT_REMOTE_TIMEOUT_MS,
  INPUT_TRIGGER_BURST_LIMIT,
  INPUT_TRIGGER_BURST_WINDOW_MS,
  INPUT_TRIGGER_HISTORY_LIMIT,
  MIN_INTERVAL_TRIGGER_MS,
} from './types';

const VM_STEP_BUDGET = 300;
const VM_LOOP_BUDGET = 500;
const VM_VALUE_BYTE_LIMIT = 256 * 1024;
const WORKSPACE_INPUT_SOURCE_IDS = new Set<WorkspaceInputSource>([
  'url',
  'linkUrl',
  'selectedText',
  'pageTitle',
  'pageMetadata',
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

  const dataOutCount = workspace.nodes.filter((node) => node.type === 'DataFlowOut').length;
  if (dataOutCount < 1) {
    errors.push('At least one Data Out block is required.');
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
    errors.push('Conditional triggers are not supported by the Chrome runtime yet.');
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

  workspace.edges.forEach((edge) => {
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
    getEffectivePortDefinitions(node, 'input').forEach((input) => {
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

    if (node.type === 'FetchData' || node.type === 'HttpRequest') {
      addRisk(risk, 'high', 'Remote data access is high risk.', 'input');
      const fallbackUrl = node.settings.remoteUrl?.trim() ?? '';
      if (!connectedInput(edgesByTarget, node.id, 'url') && !fallbackUrl) {
        errors.push(`${node.settings.label || definition.label}: remote URL is required unless the URL input is connected.`);
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

      const maxBytes = Math.trunc(node.settings.remoteMaxBytes ?? DEFAULT_REMOTE_MAX_BYTES);
      if (maxBytes < 1_024 || maxBytes > 512 * 1024) {
        errors.push(`${node.settings.label || definition.label}: max bytes must be between 1KB and 512KB.`);
      }

      if (node.type === 'HttpRequest' && !['GET', 'POST'].includes(node.settings.remoteMethod ?? 'GET')) {
        errors.push(`${node.settings.label || definition.label}: method must be GET or POST.`);
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
        payloadInput: connectedInput(edgesByTarget, node.id, 'payload'),
        payloadVars: Boolean(node.settings.payloadVars),
      });
      break;
    case 'FetchData':
      instructions.push({
        op: 'FETCH_GET',
        nodeId: node.id,
        url: connectedInput(edgesByTarget, node.id, 'url'),
        output: symbol(node.id, 'result'),
        fallbackUrl: node.settings.remoteUrl ?? '',
        outputDataType: node.settings.remoteDataType ?? 'data',
        timeoutMs: Math.max(500, Math.min(30_000, Math.trunc(node.settings.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS))),
        maxBytes: Math.max(1_024, Math.min(512 * 1024, Math.trunc(node.settings.remoteMaxBytes ?? DEFAULT_REMOTE_MAX_BYTES))),
      });
      break;
    case 'HttpRequest':
      instructions.push({
        op: 'HTTP_REQUEST',
        nodeId: node.id,
        url: connectedInput(edgesByTarget, node.id, 'url'),
        body: connectedInput(edgesByTarget, node.id, 'body'),
        output: symbol(node.id, 'result'),
        method: node.settings.remoteMethod ?? 'GET',
        fallbackUrl: node.settings.remoteUrl ?? '',
        outputDataType: node.settings.remoteDataType ?? 'data',
        timeoutMs: Math.max(500, Math.min(30_000, Math.trunc(node.settings.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS))),
        maxBytes: Math.max(1_024, Math.min(512 * 1024, Math.trunc(node.settings.remoteMaxBytes ?? DEFAULT_REMOTE_MAX_BYTES))),
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
        ord: node.settings.convertOrd ?? true,
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
    getEffectivePortDefinitions(node, 'output').forEach((output) => {
      symbolTable[symbol(node.id, output.id)] = output.dataType;
    });
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

    if (instruction.op === 'OUTPUT' && instruction.destination === 'clipboard') {
      permissions.add('clipboardWrite');
    }
  });

  return Array.from(permissions);
}

function deriveInputSources(workspace: WorkspaceFileV2, reachable: Set<string>): WorkspaceInputSource[] {
  const sources = new Set<WorkspaceInputSource>();
  workspace.edges.forEach((edge) => {
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

function compileTriggerPlan(workspace: WorkspaceFileV2, inputSources: WorkspaceInputSource[]): CompiledTriggerPlan {
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
    intervalMs: type === 'INTERVAL'
      ? Math.max(MIN_INTERVAL_TRIGGER_MS, Math.trunc(workspace.trigger.intervalMs ?? DEFAULT_INTERVAL_TRIGGER_MS))
      : undefined,
    conditionalMode: type === 'CONDITIONAL' ? workspace.trigger.conditionalMode ?? 'RISING_EDGE' : undefined,
    conditionWorkspaceId: type === 'CONDITIONAL' ? workspace.trigger.conditionWorkspaceId : undefined,
    safety: {
      timestampHistoryLimit: INPUT_TRIGGER_HISTORY_LIMIT,
      burstLimit: INPUT_TRIGGER_BURST_LIMIT,
      burstWindowMs: INPUT_TRIGGER_BURST_WINDOW_MS,
    },
  };
}

function buildSafetyPolicy(instructions: GraphVmInstruction[]): GraphVmSafetyPolicy {
  return {
    abortOnFailure: true,
    regexTimeoutMs: REGEX_TIMEOUT_MS,
    remoteTimeoutMs: DEFAULT_REMOTE_TIMEOUT_MS,
    remoteMaxBytes: DEFAULT_REMOTE_MAX_BYTES,
    rules: instructions.map((instruction) => {
      if (instruction.op === 'REGEX_TRANSFORM') {
        return {
          nodeId: instruction.nodeId,
          op: instruction.op,
          requiresWatchdog: true,
          maxRuntimeMs: REGEX_TIMEOUT_MS,
        };
      }

      if (instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST') {
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

      return {
        nodeId: instruction.nodeId,
        op: instruction.op,
        requiresWatchdog: false,
      };
    }),
  };
}

export function compileWorkspace(workspace: WorkspaceFileV2, options: CompileOptions = {}): GraphCompileResult {
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
  const triggerPlan = compileTriggerPlan(workspace, deriveInputSources(workspace, reachable));
  const safety = buildSafetyPolicy(instructions);
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
        versionFileUrl: cleanUrl(workspace.metadata.versionFileUrl),
        versionFileSignatureUrl: cleanUrl(workspace.metadata.versionFileSignatureUrl),
        downloadUrl: cleanUrl(workspace.metadata.downloadUrl),
        publicKeyLocateValue: cleanLocateValue(workspace.metadata.publicKeyLocateValue),
        created_at: workspace.metadata.created_at,
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
    requiredPermissions: requiredPermissionsForInstructions(instructions),
    vm: {
      instructions,
      constants: {},
      symbolTable: buildSymbolTable(workspace),
      stepBudget: VM_STEP_BUDGET,
      loopBudget: VM_LOOP_BUDGET,
      valueByteLimit: VM_VALUE_BYTE_LIMIT,
      safety,
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
