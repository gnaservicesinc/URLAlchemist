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
  GraphEventHandler,
  GraphCompileResult,
  GraphDataType,
  GraphValue,
  GraphVmInstruction,
  GraphVmSafetyPolicy,
  RiskLevel,
  AssetFetchKind,
  UserInteractionKind,
  WorkspaceInputSource,
  WorkspaceEdgeV2,
  WorkspaceFileV2,
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
} from './types';

const VM_STEP_BUDGET = 300;
const VM_LOOP_BUDGET = 500;
const VM_VALUE_BYTE_LIMIT = 256 * 1024;
const EVENT_HANDLERS: GraphEventHandler[] = ['trigger', 'keyboard', 'mouse', 'tick'];
const EVENT_SOURCE_BLOCKS = new Map<BlockKind, GraphEventHandler>([
  ['DataFlowIn', 'trigger'],
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

function connectedOutputHandles(
  workspace: WorkspaceFileV2,
  nodeId: string,
  includedNodeIds: Set<string>,
): Set<string> {
  const handles = new Set<string>();
  workspace.edges.forEach((edge) => {
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
    workspace.edges
      .filter((edge) => edge.target === current)
      .forEach((edge) => {
        stack.push(edge.source);
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

    return isTerminalNode(node);
  });
}

function normalizedVariableName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.startsWith('$') || trimmed.startsWith('_')) {
    return trimmed;
  }

  return `$${trimmed}`;
}

function variableNameError(name: string): string | null {
  const trimmed = name.trim();
  const normalized = normalizedVariableName(trimmed);
  if (!normalized) {
    return 'variable name is required.';
  }

  if (/^\$?\d+$/.test(trimmed) || /^\$\d+/.test(normalized)) {
    return 'variable names like $1 are reserved for substitution connector inputs.';
  }

  if (!/^(_[A-Za-z][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z][A-Za-z0-9_]*)$/.test(trimmed)) {
    return 'variable names can use letters, numbers, and underscores, and may start with $ or _.';
  }

  return null;
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

  const edgesByTarget = new Map(workspace.edges.map((edge) => [`${edge.target}:${edge.targetHandle}`, edge]));
  if (!hasRunnableTerminalNode(workspace, edgesByTarget)) {
    errors.push('Add a URL output, data output, storage write, overlay action, or other terminal side-effect before building an Action Pack.');
  }

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

    if (node.type === 'FetchData' || node.type === 'HttpRequest' || node.type === 'GetImage' || node.type === 'GetVideo' || node.type === 'GetAudio') {
      const remoteDataNode = node.type === 'FetchData' || node.type === 'HttpRequest';
      const urlInput = connectedInput(edgesByTarget, node.id, 'url');
      const hasEmbeddedAsset = !remoteDataNode && Boolean(node.settings.assetDataBase64?.trim());
      addRisk(risk, 'high', remoteDataNode ? 'Remote data access is high risk.' : hasEmbeddedAsset ? 'Embedded media access is high risk.' : 'Remote media access is high risk.', 'input');
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

    if (node.type === 'Declarations') {
      if (!node.settings.variableName?.trim()) {
        warnings.push(`${node.settings.label || definition.label} has no variable name and will be ignored.`);
      } else {
        const error = variableNameError(node.settings.variableName);
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

function literalGraphValue(raw: string | undefined, dataType: GraphDataType = 'string'): GraphValue {
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
): GraphVmInstruction[] {
  const instructions: GraphVmInstruction[] = [];

  switch (node.type) {
    case 'DataFlowIn':
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
        embedded: node.settings.assetDataBase64
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
        value: literalGraphValue(node.settings.literalValue, node.settings.literalDataType ?? 'string'),
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
          name: normalizedVariableName(node.settings.variableName),
          value: connectedInput(edgesByTarget, node.id, 'value'),
          fallbackValue: literalGraphValue(node.settings.literalValue, node.settings.literalDataType ?? 'string'),
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

    if (instruction.op === 'OUTPUT' && ['clipboard', 'clipboardBinary'].includes(instruction.destination)) {
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

  const reachableByHandler = collectHandlerReachability(workspace);
  const reachable = collectReachableNodes(workspace);
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

  const edgesByTarget = new Map(workspace.edges.map((edge) => [`${edge.target}:${edge.targetHandle}`, edge]));
  const eventHandlers = Object.fromEntries(
    EVENT_HANDLERS.map((handler) => [
      handler,
      sortedByHandler.get(handler)?.flatMap((node) => instructionForNode(node, workspace, edgesByTarget, reachableByHandler[handler])) ?? [],
    ]),
  ) as Record<GraphEventHandler, GraphVmInstruction[]>;
  const instructions = uniqueInstructions(EVENT_HANDLERS.flatMap((handler) => eventHandlers[handler]));
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
      eventHandlers,
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
