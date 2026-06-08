import { getDefaultHotkey } from '../hotkeys';
import { WORKSPACE_TRIGGER_TYPES } from '../types';
import type { ActionPack } from '../types';
import { assertSafeRegexPattern } from '../regex/executeRegexJob';
import { BLOCK_REGISTRY, getBlockDefinition } from './blockRegistry';
import type {
  BlockKind,
  WorkspaceEdgeV2,
  WorkspaceFileV2,
  WorkspaceGraphSurface,
  WorkspaceInputSource,
  WorkspaceMetadata,
  WorkspaceNodeV2,
  WorkspaceTrigger,
  WorkspaceType,
  WorkspaceViewport,
} from './types';
import { BLOCK_TYPE_IDS, SUPPORTED_WORKSPACE_SCHEMA_VERSIONS, WORKSPACE_SCHEMA_VERSION } from './types';

const MAX_WORKSPACE_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_WORKSPACE_NODES = 500;
const MAX_WORKSPACE_EDGES = 1200;
const MAX_WORKSPACE_ID_LENGTH = 128;
const MAX_WORKSPACE_NAME_LENGTH = 200;
const MAX_WORKSPACE_TEXT_BYTES = 65536;
const MAX_WORKSPACE_URL_BYTES = 8192;
const MAX_WORKSPACE_REGEX_BYTES = 4000;
const MAX_WORKSPACE_SETTINGS_BYTES = 256 * 1024;
const MAX_WORKSPACE_SETTING_STRING_BYTES = 65536;
const MAX_WORKSPACE_SETTING_DEPTH = 12;
const MAX_WORKSPACE_SOURCE_FILTERS = 64;
const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const WORKSPACE_INPUT_SOURCES: readonly WorkspaceInputSource[] = [
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
];
const WORKSPACE_COMPATIBILITY_TARGETS = ['chrome', 'firefox', 'firefoxAndroid'] as const;
const WORKSPACE_COMPATIBILITY_STATUSES = ['supported', 'source-only', 'pending-v2-runtime', 'unsupported'] as const;
const WORKSPACE_TYPES = ['data-modifier', 'content-blocker', 'custom-block'] as const;
const CONTENT_BLOCKER_SURFACE_IDS = ['page-load', 'recurring', 'challenge'] as const;

function createNodeId(kind: BlockKind): string {
  return `${BLOCK_TYPE_IDS[kind]}-${crypto.randomUUID()}`;
}

export function createWorkspaceNode(
  kind: BlockKind,
  position: WorkspaceNodeV2['position'],
  settings: WorkspaceNodeV2['settings'] = {},
): WorkspaceNodeV2 {
  const definition = getBlockDefinition(kind);

  return {
    id: createNodeId(kind),
    type: kind,
    typeId: definition.typeId,
    position,
    settings: {
      ...definition.defaultSettings,
      ...settings,
    },
  };
}

export function createDefaultWorkspace(): WorkspaceFileV2 {
  const now = Date.now();
  const input = createWorkspaceNode('DataFlowIn', { x: 0, y: 120 });
  const output = createWorkspaceNode('DataFlowOut', { x: 760, y: 120 });

  return {
    kind: 'workspace.v2',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceType: 'data-modifier',
    metadata: {
      id: crypto.randomUUID(),
      name: 'Untitled Workspace',
      version: 1,
      author: '',
      description: '',
      created_at: now,
      updated_at: now,
    },
    trigger: {
      type: 'INPUT_DATA',
      hotkey: getDefaultHotkey(),
      inputSources: ['url'],
      sourceFilters: [],
    },
    nodes: [input, output],
    edges: [],
    viewport: {
      x: 0,
      y: 0,
      zoom: 1,
    },
  };
}

export function createDefaultContentBlockerWorkspace(): WorkspaceFileV2 {
  const now = Date.now();
  const pageInput = createWorkspaceNode('ContentDataIn', { x: 0, y: 120 });
  const allow = createWorkspaceNode('Constant', { x: 360, y: 120 }, {
    literalDataType: 'number',
    literalValue: '0',
    label: 'Allow',
  });
  const pageDecision = createWorkspaceNode('DecisionOut', { x: 720, y: 120 });
  const challengeTimer = createWorkspaceNode('ChallengeTimer', { x: 0, y: 120 });
  const challengeComplete = createWorkspaceNode('ChallengeComplete', { x: 360, y: 120 });

  return {
    kind: 'workspace.v2',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceType: 'content-blocker',
    metadata: {
      id: crypto.randomUUID(),
      name: 'Untitled Content Blocker',
      version: 1,
      author: '',
      description: '',
      created_at: now,
      updated_at: now,
    },
    trigger: {
      type: 'INPUT_DATA',
      hotkey: getDefaultHotkey(),
      inputSources: ['url', 'pageTitle', 'pageMetadata'],
      sourceFilters: [],
    },
    nodes: [],
    edges: [],
    surfaces: [
      {
        id: 'page-load',
        label: 'Page Load Decision',
        nodes: [pageInput, allow, pageDecision],
        edges: [createEdge(allow.id, 'value', pageDecision.id, 'decision')],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      {
        id: 'recurring',
        label: 'Recurring Check',
        nodes: [],
        edges: [],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      {
        id: 'challenge',
        label: 'Challenge Page',
        nodes: [challengeTimer, challengeComplete],
        edges: [createEdge(challengeTimer.id, 'result', challengeComplete.id, 'complete')],
        viewport: { x: 0, y: 0, zoom: 1 },
      },
    ],
    contentBlocker: {
      lockLevel: 0,
      allowLockIncrease: false,
      recurringIntervalSeconds: 30,
      blockPageTitle: 'Page blocked',
      blockPageMessage: 'This page is blocked by URL Alchemist.',
      challengePageTitle: 'Challenge required',
      challengePageMessage: 'Complete the challenge to continue to the page.',
    },
    viewport: {
      x: 0,
      y: 0,
      zoom: 1,
    },
  };
}

export function createDefaultCustomBlockWorkspace(): WorkspaceFileV2 {
  const now = Date.now();
  const input = createWorkspaceNode('CustomBlockInput', { x: 0, y: 120 }, {
    customPortId: 'input',
    customPortLabel: 'Input',
    customPortDataType: 'Any',
    locked: true,
  });
  const output = createWorkspaceNode('CustomBlockOutput', { x: 560, y: 120 }, {
    customPortId: 'result',
    customPortLabel: 'Result',
    customPortDataType: 'Any',
    locked: true,
  });
  const blockId = `custom-${crypto.randomUUID()}`;

  return {
    kind: 'workspace.v2',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceType: 'custom-block',
    metadata: {
      id: crypto.randomUUID(),
      name: 'Untitled Custom Block',
      version: 1,
      author: '',
      description: '',
      created_at: now,
      updated_at: now,
    },
    trigger: {
      type: 'NEVER',
      hotkey: getDefaultHotkey(),
      inputSources: ['url'],
      sourceFilters: [],
    },
    nodes: [input, output],
    edges: [],
    viewport: {
      x: 0,
      y: 0,
      zoom: 1,
    },
    customBlock: {
      blockId,
      label: 'Untitled Custom Block',
      version: 1,
      category: 'custom',
      visibleWorkspaceTypes: ['data-modifier', 'content-blocker'],
      description: 'Reusable workspace block.',
      tips: [],
      inputs: [{ id: 'input', label: 'Input', dataType: 'Any' }],
      outputs: [{ id: 'result', label: 'Result', dataType: 'Any' }],
      fields: [],
    },
  };
}

export function createEdge(source: string, sourceHandle: string, target: string, targetHandle: string): WorkspaceEdgeV2 {
  return {
    id: `${source}:${sourceHandle}->${target}:${targetHandle}`,
    source,
    sourceHandle,
    target,
    targetHandle,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function jsonByteLength(value: unknown): number {
  try {
    return utf8ByteLength(JSON.stringify(value));
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function hasNoDangerousKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => !DANGEROUS_RECORD_KEYS.has(key));
}

function hasNoDangerousKeysDeep(value: unknown, depth = 0): boolean {
  if (depth > MAX_WORKSPACE_SETTING_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.every((entry) => hasNoDangerousKeysDeep(entry, depth + 1));
  }
  if (!isRecord(value)) return true;
  return hasNoDangerousKeys(value) && Object.values(value).every((entry) => hasNoDangerousKeysDeep(entry, depth + 1));
}

function settingsStringsWithinLimit(value: unknown, depth = 0): boolean {
  if (depth > MAX_WORKSPACE_SETTING_DEPTH) return false;
  if (typeof value === 'string') return utf8ByteLength(value) <= MAX_WORKSPACE_SETTING_STRING_BYTES;
  if (Array.isArray(value)) return value.every((entry) => settingsStringsWithinLimit(entry, depth + 1));
  if (!isRecord(value)) return true;
  return Object.values(value).every((entry) => settingsStringsWithinLimit(entry, depth + 1));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringWithin(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && utf8ByteLength(value) <= maxBytes;
}

function isOptionalStringWithin(value: unknown, maxBytes: number): boolean {
  return value === undefined || isStringWithin(value, maxBytes);
}

function isWorkspaceInputSource(value: unknown): value is WorkspaceInputSource {
  return typeof value === 'string' && WORKSPACE_INPUT_SOURCES.includes(value as WorkspaceInputSource);
}

function validateCompatibilityMetadata(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push('Compatibility metadata has an invalid shape');
    return;
  }

  for (const target of WORKSPACE_COMPATIBILITY_TARGETS) {
    const entry = value[target];
    if (entry === undefined) continue;
    if (!isRecord(entry) || !hasNoDangerousKeys(entry)) {
      errors.push(`Compatibility metadata for ${target} has an invalid shape`);
      continue;
    }
    if (!isStringWithin(entry.version, 64)) {
      errors.push(`Compatibility metadata for ${target} is missing a valid version`);
    }
    if (typeof entry.status !== 'string' || !WORKSPACE_COMPATIBILITY_STATUSES.includes(entry.status as never)) {
      errors.push(`Compatibility metadata for ${target} has an unsupported status`);
    }
  }
}

function validateWorkspaceMetadata(value: unknown, errors: string[]): void {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push('Workspace metadata has an invalid shape');
    return;
  }

  if (!isStringWithin(value.id, MAX_WORKSPACE_ID_LENGTH) || !value.id.trim()) {
    errors.push('Workspace id is required');
  }
  if (!isStringWithin(value.name, MAX_WORKSPACE_NAME_LENGTH) || !value.name.trim()) {
    errors.push('Workspace name is required');
  }
  if (!Number.isInteger(value.version) || (value.version as number) < 1) {
    errors.push('Workspace version is invalid');
  }
  if (!isFiniteNumber(value.created_at) || (value.created_at as number) < 0) {
    errors.push('Workspace created_at timestamp is invalid');
  }
  if (!isFiniteNumber(value.updated_at) || (value.updated_at as number) < 0) {
    errors.push('Workspace updated_at timestamp is invalid');
  }
  if (!isOptionalStringWithin(value.author, 200)) {
    errors.push('Workspace author is too large');
  }
  if (!isOptionalStringWithin(value.description, MAX_WORKSPACE_TEXT_BYTES)) {
    errors.push('Workspace description is too large');
  }
  if (value.profile !== undefined && value.profile !== 'standard' && value.profile !== 'content-blocker') {
    errors.push('Workspace profile is unsupported');
  }
  validateCompatibilityMetadata((value as { compatibility?: unknown }).compatibility, errors);
}

function workspaceTypeForCandidate(candidate: Partial<WorkspaceFileV2>): WorkspaceType {
  if (candidate.workspaceType === 'custom-block') {
    return 'custom-block';
  }
  if (candidate.workspaceType === 'content-blocker' || candidate.metadata?.profile === 'content-blocker') {
    return 'content-blocker';
  }
  return 'data-modifier';
}

function validateWorkspaceTrigger(value: unknown, errors: string[]): void {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push('Workspace trigger is required');
    return;
  }

  if (typeof value.type !== 'string' || !([...WORKSPACE_TRIGGER_TYPES, 'ALWAYS'] as string[]).includes(value.type)) {
    errors.push('Workspace trigger type is unsupported');
  }
  if (!isOptionalStringWithin(value.hotkey, 128)) {
    errors.push('Workspace hotkey is too large');
  }
  if (!isOptionalStringWithin(value.scope_regex, MAX_WORKSPACE_REGEX_BYTES)) {
    errors.push('Workspace scope regex is too large');
  }
  if (typeof value.scope_regex === 'string' && value.scope_regex.trim()) {
    try {
      assertSafeRegexPattern(value.scope_regex);
    } catch {
      errors.push('Workspace scope regex is unsafe');
    }
  }
  if (value.inputSources !== undefined) {
    if (!Array.isArray(value.inputSources) || value.inputSources.length > WORKSPACE_INPUT_SOURCES.length) {
      errors.push('Workspace input sources have an invalid shape');
    } else {
      const seen = new Set<WorkspaceInputSource>();
      value.inputSources.forEach((source) => {
        if (!isWorkspaceInputSource(source)) {
          errors.push('Workspace input sources contain an unsupported value');
          return;
        }
        if (seen.has(source)) {
          errors.push('Workspace input sources contain a duplicate value');
        }
        seen.add(source);
      });
    }
  }
  if (value.sourceFilters !== undefined) {
    if (!Array.isArray(value.sourceFilters) || value.sourceFilters.length > MAX_WORKSPACE_SOURCE_FILTERS) {
      errors.push('Workspace source filters have an invalid shape');
    } else {
      value.sourceFilters.forEach((filter) => {
        if (!isRecord(filter) || !hasNoDangerousKeys(filter)) {
          errors.push('Workspace source filters contain an invalid entry');
          return;
        }
        if (!isWorkspaceInputSource(filter.source)) {
          errors.push('Workspace source filters contain an unsupported source');
        }
        if (!isStringWithin(filter.pattern, MAX_WORKSPACE_REGEX_BYTES)) {
          errors.push('Workspace source filters contain an invalid pattern');
        } else if (filter.pattern.trim()) {
          try {
            assertSafeRegexPattern(filter.pattern);
          } catch {
            errors.push('Workspace source filters contain an unsafe regex pattern');
          }
        }
      });
    }
  }
  if (value.intervalMs !== undefined && (!isFiniteNumber(value.intervalMs) || value.intervalMs < 0)) {
    errors.push('Workspace interval trigger has an invalid interval');
  }
  if (value.conditionalMode !== undefined && value.conditionalMode !== 'RISING_EDGE' && value.conditionalMode !== 'WHILE_TRUE') {
    errors.push('Workspace conditional trigger has an unsupported mode');
  }
  if (!isOptionalStringWithin(value.conditionWorkspaceId, MAX_WORKSPACE_ID_LENGTH)) {
    errors.push('Workspace conditional trigger id is too large');
  }
}

function validateViewport(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push('Workspace viewport has an invalid shape');
    return;
  }
  if (!isFiniteNumber(value.x) || !isFiniteNumber(value.y) || !isFiniteNumber(value.zoom) || value.zoom <= 0 || value.zoom > 4) {
    errors.push('Workspace viewport contains invalid coordinates');
  }
}

function validateContentBlockerConfig(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push('Content Blocker settings have an invalid shape');
    return;
  }
  if (![0, 1, 2, 3].includes(Number(value.lockLevel))) {
    errors.push('Content Blocker lock level is invalid');
  }
  if (value.allowLockIncrease !== undefined && typeof value.allowLockIncrease !== 'boolean') {
    errors.push('Content Blocker lock increase setting must be boolean');
  }
  if (value.recurringIntervalSeconds !== undefined && (!isFiniteNumber(value.recurringIntervalSeconds) || value.recurringIntervalSeconds < 5)) {
    errors.push('Content Blocker recurring interval must be at least 5 seconds');
  }
  if (!isOptionalStringWithin(value.blockPageTitle, 200)) {
    errors.push('Content Blocker block page title is too large');
  }
  if (!isOptionalStringWithin(value.blockPageMessage, MAX_WORKSPACE_TEXT_BYTES)) {
    errors.push('Content Blocker block page message is too large');
  }
  if (!isOptionalStringWithin(value.challengePageTitle, 200)) {
    errors.push('Content Blocker challenge page title is too large');
  }
  if (!isOptionalStringWithin(value.challengePageMessage, MAX_WORKSPACE_TEXT_BYTES)) {
    errors.push('Content Blocker challenge page message is too large');
  }
}

function validateCustomBlockPort(value: unknown, label: string, errors: string[]): void {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push(`${label} has an invalid shape`);
    return;
  }
  if (!isStringWithin(value.id, MAX_WORKSPACE_ID_LENGTH) || !value.id.trim()) {
    errors.push(`${label} id is required`);
  }
  if (!isStringWithin(value.label, 80) || !value.label.trim()) {
    errors.push(`${label} label is required`);
  }
  if (typeof value.dataType !== 'string' || !['bool', 'number', 'floatingPoint', 'string', 'URL', 'JSON', 'data', 'dict', 'asset', 'Any'].includes(value.dataType)) {
    errors.push(`${label} data type is unsupported`);
  }
  if (!isOptionalStringWithin(value.tooltip, MAX_WORKSPACE_TEXT_BYTES)) {
    errors.push(`${label} tooltip is too large`);
  }
}

function validateCustomBlockDefinition(value: unknown, workspaceType: WorkspaceType, errors: string[]): void {
  if (workspaceType !== 'custom-block') {
    return;
  }
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push('Custom Block metadata is required');
    return;
  }
  if (!isStringWithin(value.blockId, MAX_WORKSPACE_ID_LENGTH) || !value.blockId.trim()) {
    errors.push('Custom Block id is required');
  }
  if (!isStringWithin(value.label, MAX_WORKSPACE_NAME_LENGTH) || !value.label.trim()) {
    errors.push('Custom Block label is required');
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    errors.push('Custom Block version is invalid');
  }
  if (typeof value.category !== 'string') {
    errors.push('Custom Block category is required');
  }
  if (!Array.isArray(value.visibleWorkspaceTypes) || value.visibleWorkspaceTypes.some((entry) => !(WORKSPACE_TYPES as readonly string[]).includes(entry))) {
    errors.push('Custom Block workspace visibility is invalid');
  }
  if (!Array.isArray(value.inputs) || value.inputs.length === 0 || value.inputs.length > 24) {
    errors.push('Custom Block must define between 1 and 24 inputs');
  } else {
    value.inputs.forEach((entry, index) => validateCustomBlockPort(entry, `Custom Block input ${index + 1}`, errors));
  }
  if (!Array.isArray(value.outputs) || value.outputs.length === 0 || value.outputs.length > 24) {
    errors.push('Custom Block must define between 1 and 24 outputs');
  } else {
    value.outputs.forEach((entry, index) => validateCustomBlockPort(entry, `Custom Block output ${index + 1}`, errors));
  }
  if (value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.length > 48)) {
    errors.push('Custom Block fields are invalid');
  }
}

function validateLogicalFlows(value: unknown, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_NODES) {
    errors.push('Logical Flow metadata has an invalid shape');
    return;
  }
  value.forEach((entry, index) => {
    if (!isRecord(entry) || !hasNoDangerousKeys(entry)) {
      errors.push(`Logical Flow ${index + 1} is invalid`);
      return;
    }
    if (!isStringWithin(entry.id, MAX_WORKSPACE_ID_LENGTH) || !isStringWithin(entry.conditionNodeId, MAX_WORKSPACE_ID_LENGTH) || !isStringWithin(entry.controlNodeId, MAX_WORKSPACE_ID_LENGTH)) {
      errors.push(`Logical Flow ${index + 1} has invalid ids`);
    }
    const depth = entry.depth;
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > 24) {
      errors.push(`Logical Flow ${index + 1} depth is invalid`);
    }
    if (entry.locked !== undefined && typeof entry.locked !== 'boolean') {
      errors.push(`Logical Flow ${index + 1} lock state is invalid`);
    }
  });
}

function validateWorkspaceSurface(value: unknown, errors: string[], index: number): void {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push(`Workspace surface ${index + 1} has an invalid shape`);
    return;
  }
  if (typeof value.id !== 'string' || !(CONTENT_BLOCKER_SURFACE_IDS as readonly string[]).includes(value.id)) {
    errors.push(`Workspace surface ${index + 1} has an unsupported id`);
  }
  if (!isStringWithin(value.label, 80)) {
    errors.push(`Workspace surface ${index + 1} is missing a valid label`);
  }
  if (!Array.isArray(value.nodes)) {
    errors.push(`Workspace surface ${index + 1} nodes must be an array`);
  } else if (value.nodes.length > MAX_WORKSPACE_NODES) {
    errors.push(`Workspace surface ${index + 1} has too many nodes`);
  } else {
    const nodeIds = new Set<string>();
    value.nodes.forEach((node, nodeIndex) => {
      if (!isWorkspaceNode(node)) {
        errors.push(`Workspace surface ${index + 1} node ${nodeIndex + 1} is invalid`);
        return;
      }
      const candidate = node as WorkspaceNodeV2;
      if (nodeIds.has(candidate.id)) {
        errors.push(`Workspace surface ${index + 1} node ${nodeIndex + 1} has a duplicate id`);
      }
      nodeIds.add(candidate.id);
    });
  }
  if (!Array.isArray(value.edges)) {
    errors.push(`Workspace surface ${index + 1} edges must be an array`);
  } else if (value.edges.length > MAX_WORKSPACE_EDGES) {
    errors.push(`Workspace surface ${index + 1} has too many edges`);
  } else {
    const edgeIds = new Set<string>();
    value.edges.forEach((edge, edgeIndex) => {
      if (!isWorkspaceEdge(edge)) {
        errors.push(`Workspace surface ${index + 1} edge ${edgeIndex + 1} is invalid`);
        return;
      }
      const candidate = edge as WorkspaceEdgeV2;
      if (edgeIds.has(candidate.id)) {
        errors.push(`Workspace surface ${index + 1} edge ${edgeIndex + 1} has a duplicate id`);
      }
      edgeIds.add(candidate.id);
    });
  }
  validateViewport(value.viewport, errors);
}

function validateWorkspaceSurfaces(value: unknown, workspaceType: WorkspaceType, errors: string[]): void {
  if (workspaceType !== 'content-blocker') {
    return;
  }
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    errors.push('Content Blocker workspaces require graph surfaces');
    return;
  }
  const seen = new Set<string>();
  value.forEach((surface, index) => {
    validateWorkspaceSurface(surface, errors, index);
    if (isRecord(surface) && typeof surface.id === 'string') {
      if (seen.has(surface.id)) {
        errors.push(`Content Blocker surface ${surface.id} is duplicated`);
      }
      seen.add(surface.id);
    }
  });
  CONTENT_BLOCKER_SURFACE_IDS.forEach((id) => {
    if (!seen.has(id)) {
      errors.push(`Content Blocker workspace is missing the ${id} surface`);
    }
  });
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function normalizeCompatibilityMetadata(value: WorkspaceMetadata['compatibility']): WorkspaceMetadata['compatibility'] {
  if (!value) return undefined;
  const compatibility = omitUndefined({
    chrome: value.chrome ? { version: value.chrome.version, status: value.chrome.status } : undefined,
    firefox: value.firefox ? { version: value.firefox.version, status: value.firefox.status } : undefined,
    firefoxAndroid: value.firefoxAndroid ? { version: value.firefoxAndroid.version, status: value.firefoxAndroid.status } : undefined,
  });
  return Object.keys(compatibility).length > 0 ? compatibility : undefined;
}

function normalizeWorkspaceMetadata(value: WorkspaceMetadata): WorkspaceMetadata {
  return omitUndefined({
    id: value.id,
    name: value.name,
    version: value.version,
    author: value.author,
    description: value.description,
    compatibility: normalizeCompatibilityMetadata(value.compatibility),
    created_at: value.created_at,
    updated_at: value.updated_at,
  });
}

function normalizeWorkspaceNode(node: WorkspaceNodeV2): WorkspaceNodeV2 {
  return {
    id: node.id,
    type: node.type,
    typeId: node.typeId,
    position: {
      x: node.position.x,
      y: node.position.y,
    },
    settings: node.settings,
  };
}

function normalizeWorkspaceEdge(edge: WorkspaceEdgeV2): WorkspaceEdgeV2 {
  return {
    id: edge.id,
    source: edge.source,
    sourceHandle: edge.sourceHandle,
    target: edge.target,
    targetHandle: edge.targetHandle,
  };
}

function normalizeWorkspaceViewport(viewport: WorkspaceViewport): WorkspaceViewport {
  return {
    x: viewport.x,
    y: viewport.y,
    zoom: viewport.zoom,
  };
}

function defaultContentBlockerConfig(): NonNullable<WorkspaceFileV2['contentBlocker']> {
  return {
    lockLevel: 0,
    allowLockIncrease: false,
    recurringIntervalSeconds: 30,
    blockPageTitle: 'Page blocked',
    blockPageMessage: 'This page is blocked by URL Alchemist.',
    challengePageTitle: 'Challenge required',
    challengePageMessage: 'Complete the challenge to continue to the page.',
  };
}

function normalizeContentBlockerConfig(value: WorkspaceFileV2['contentBlocker']): NonNullable<WorkspaceFileV2['contentBlocker']> {
  const defaults = defaultContentBlockerConfig();
  return {
    lockLevel: [0, 1, 2, 3].includes(Number(value?.lockLevel)) ? value!.lockLevel : defaults.lockLevel,
    allowLockIncrease: value?.allowLockIncrease ?? defaults.allowLockIncrease,
    recurringIntervalSeconds: Math.max(5, Math.trunc(value?.recurringIntervalSeconds ?? defaults.recurringIntervalSeconds)),
    blockPageTitle: value?.blockPageTitle || defaults.blockPageTitle,
    blockPageMessage: value?.blockPageMessage || defaults.blockPageMessage,
    challengePageTitle: value?.challengePageTitle || defaults.challengePageTitle,
    challengePageMessage: value?.challengePageMessage || defaults.challengePageMessage,
  };
}

function normalizeWorkspaceSurface(surface: WorkspaceGraphSurface): WorkspaceGraphSurface {
  return {
    id: surface.id,
    label: surface.label,
    nodes: surface.nodes.map(normalizeWorkspaceNode),
    edges: surface.edges.map(normalizeWorkspaceEdge),
    viewport: normalizeWorkspaceViewport(surface.viewport),
  };
}

function legacyContentBlockerSurfaces(value: WorkspaceFileV2): WorkspaceGraphSurface[] {
  const defaultChallenge = createDefaultContentBlockerWorkspace().surfaces?.find((surface) => surface.id === 'challenge');
  return [
    {
      id: 'page-load',
      label: 'Page Load Decision',
      nodes: value.nodes.map(normalizeWorkspaceNode),
      edges: value.edges.map(normalizeWorkspaceEdge),
      viewport: normalizeWorkspaceViewport(value.viewport),
    },
    {
      id: 'recurring',
      label: 'Recurring Check',
      nodes: [],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    {
      id: 'challenge',
      label: 'Challenge Page',
      nodes: defaultChallenge?.nodes ?? [],
      edges: defaultChallenge?.edges ?? [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  ];
}

function normalizeContentBlockerSurfaces(value: WorkspaceFileV2): WorkspaceGraphSurface[] {
  const defaults = createDefaultContentBlockerWorkspace().surfaces ?? [];
  const source = Array.isArray(value.surfaces) && value.surfaces.length > 0
    ? value.surfaces
    : legacyContentBlockerSurfaces(value);

  return CONTENT_BLOCKER_SURFACE_IDS.map((id) => {
    const existing = source.find((surface) => surface.id === id);
    const fallback = defaults.find((surface) => surface.id === id)!;
    return normalizeWorkspaceSurface(existing ?? fallback);
  });
}

function normalizeLogicalFlows(value: WorkspaceFileV2['logicalFlows']): WorkspaceFileV2['logicalFlows'] {
  return Array.isArray(value)
    ? value.map((flow) => ({
        id: flow.id,
        conditionNodeId: flow.conditionNodeId,
        controlNodeId: flow.controlNodeId,
        depth: Math.max(0, Math.trunc(flow.depth ?? 0)),
        locked: Boolean(flow.locked),
      }))
    : undefined;
}

function normalizeCustomBlockDefinition(value: WorkspaceFileV2['customBlock']): WorkspaceFileV2['customBlock'] {
  if (!value) {
    return undefined;
  }
  return {
    blockId: value.blockId,
    label: value.label,
    version: Math.max(1, Math.trunc(value.version)),
    category: value.category,
    visibleWorkspaceTypes: value.visibleWorkspaceTypes,
    description: value.description,
    tips: Array.isArray(value.tips) ? value.tips : [],
    inputs: value.inputs,
    outputs: value.outputs,
    fields: Array.isArray(value.fields) ? value.fields : [],
  };
}

export function isWorkspaceNode(value: unknown): value is WorkspaceNodeV2 {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    return false;
  }

  const candidate = value as unknown as WorkspaceNodeV2;
  return (
    isStringWithin(candidate.id, MAX_WORKSPACE_ID_LENGTH) &&
    candidate.id.trim().length > 0 &&
    typeof candidate.type === 'string' &&
    candidate.type in BLOCK_REGISTRY &&
    candidate.typeId === BLOCK_TYPE_IDS[candidate.type as BlockKind] &&
    isRecord(candidate.position) &&
    hasNoDangerousKeys(candidate.position) &&
    isFiniteNumber(candidate.position.x) &&
    isFiniteNumber(candidate.position.y) &&
    isRecord(candidate.settings) &&
    hasNoDangerousKeysDeep(candidate.settings) &&
    settingsStringsWithinLimit(candidate.settings) &&
    jsonByteLength(candidate.settings) <= MAX_WORKSPACE_SETTINGS_BYTES
  );
}

export function isWorkspaceEdge(value: unknown): value is WorkspaceEdgeV2 {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    return false;
  }

  const candidate = value as unknown as WorkspaceEdgeV2;
  return (
    isStringWithin(candidate.id, MAX_WORKSPACE_ID_LENGTH) &&
    candidate.id.trim().length > 0 &&
    isStringWithin(candidate.source, MAX_WORKSPACE_ID_LENGTH) &&
    isStringWithin(candidate.sourceHandle, MAX_WORKSPACE_ID_LENGTH) &&
    isStringWithin(candidate.target, MAX_WORKSPACE_ID_LENGTH) &&
    isStringWithin(candidate.targetHandle, MAX_WORKSPACE_ID_LENGTH)
  );
}

function normalizeWorkspaceTrigger(trigger: unknown): WorkspaceTrigger {
  const candidate = typeof trigger === 'object' && trigger !== null ? trigger as Partial<WorkspaceTrigger> : {};
  const type = candidate.type === 'ALWAYS' ? 'INPUT_DATA' : candidate.type;
  const sourceFilters = [...(Array.isArray(candidate.sourceFilters) ? candidate.sourceFilters : [])];
  if (candidate.scope_regex?.trim()) {
    sourceFilters.push({
      source: 'url',
      pattern: candidate.scope_regex.trim(),
    });
  }

  return {
    type: ['INPUT_DATA', 'HOTKEY', 'CONTEXT_MENU', 'INTERVAL', 'CONDITIONAL', 'NEVER'].includes(type ?? '')
      ? type as WorkspaceTrigger['type']
      : 'INPUT_DATA',
    hotkey: candidate.hotkey,
    inputSources: Array.isArray(candidate.inputSources) && candidate.inputSources.length > 0
      ? candidate.inputSources
      : ['url'],
    sourceFilters,
    intervalMs: candidate.intervalMs,
    conditionalMode: candidate.conditionalMode ?? 'RISING_EDGE',
    conditionWorkspaceId: candidate.conditionWorkspaceId,
  };
}

export function migrateWorkspaceFile(value: WorkspaceFileV2): WorkspaceFileV2 {
  const workspaceType = workspaceTypeForCandidate(value);
  return {
    kind: 'workspace.v2',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceType,
    metadata: normalizeWorkspaceMetadata(value.metadata),
    trigger: normalizeWorkspaceTrigger(value.trigger),
    nodes: workspaceType === 'content-blocker' ? [] : value.nodes.map(normalizeWorkspaceNode),
    edges: workspaceType === 'content-blocker' ? [] : value.edges.map(normalizeWorkspaceEdge),
    surfaces: workspaceType === 'content-blocker' ? normalizeContentBlockerSurfaces(value) : undefined,
    contentBlocker: workspaceType === 'content-blocker' ? normalizeContentBlockerConfig(value.contentBlocker) : undefined,
    assets: Array.isArray(value.assets) ? value.assets : undefined,
    viewport: normalizeWorkspaceViewport(value.viewport),
    logicalFlows: normalizeLogicalFlows(value.logicalFlows),
    customBlock: workspaceType === 'custom-block' ? normalizeCustomBlockDefinition(value.customBlock) : undefined,
    embeddedCustomBlocks: Array.isArray(value.embeddedCustomBlocks) ? value.embeddedCustomBlocks : undefined,
  };
}

export function validateWorkspaceFile(value: unknown): { ok: true; value: WorkspaceFileV2 } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['Workspace must be an object'] };
  }

  const candidate = value as WorkspaceFileV2;
  if (!hasNoDangerousKeys(candidate as unknown as Record<string, unknown>)) {
    errors.push('Workspace contains unsupported object keys');
  }
  if (jsonByteLength(candidate) > MAX_WORKSPACE_TOTAL_BYTES) {
    errors.push('Workspace file is too large');
  }

  if (candidate.kind !== 'workspace.v2') {
    errors.push('Workspace kind is invalid');
  }

  if (!(SUPPORTED_WORKSPACE_SCHEMA_VERSIONS as readonly number[]).includes(candidate.schemaVersion)) {
    errors.push(`Unsupported workspace schema version: ${String(candidate.schemaVersion)}`);
  }

  const workspaceType = workspaceTypeForCandidate(candidate);
  if (candidate.workspaceType !== undefined && !(WORKSPACE_TYPES as readonly string[]).includes(candidate.workspaceType)) {
    errors.push('Workspace type is unsupported');
  }
  validateWorkspaceMetadata(candidate.metadata, errors);
  validateWorkspaceTrigger(candidate.trigger, errors);
  validateViewport(candidate.viewport, errors);
  validateContentBlockerConfig(candidate.contentBlocker, errors);
  validateWorkspaceSurfaces(candidate.surfaces, workspaceType, errors);
  validateCustomBlockDefinition(candidate.customBlock, workspaceType, errors);
  validateLogicalFlows(candidate.logicalFlows, errors);

  if (!Array.isArray(candidate.nodes)) {
    errors.push('Workspace nodes must be an array');
  } else if ((workspaceType !== 'content-blocker' && candidate.nodes.length === 0) || candidate.nodes.length > MAX_WORKSPACE_NODES) {
    errors.push('Workspace node count is invalid');
  } else {
    const nodeIds = new Set<string>();
    candidate.nodes.forEach((node, index) => {
      if (!isWorkspaceNode(node)) {
        errors.push(`Workspace node ${index + 1} is invalid`);
        return;
      }
      if (nodeIds.has(node.id)) {
        errors.push(`Workspace node ${index + 1} has a duplicate id`);
      }
      nodeIds.add(node.id);
    });
  }

  if (!Array.isArray(candidate.edges)) {
    errors.push('Workspace edges must be an array');
  } else if (candidate.edges.length > MAX_WORKSPACE_EDGES) {
    errors.push('Workspace edge count is invalid');
  } else {
    const edgeIds = new Set<string>();
    candidate.edges.forEach((edge, index) => {
      if (!isWorkspaceEdge(edge)) {
        errors.push(`Workspace edge ${index + 1} is invalid`);
        return;
      }
      if (edgeIds.has(edge.id)) {
        errors.push(`Workspace edge ${index + 1} has a duplicate id`);
      }
      edgeIds.add(edge.id);
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: migrateWorkspaceFile(candidate),
  };
}

export function workspaceFromLegacyPack(pack: ActionPack): WorkspaceFileV2 {
  const now = Date.now();
  const input = createWorkspaceNode('DataFlowIn', { x: 0, y: 160 });
  const output = createWorkspaceNode('DataFlowOut', { x: 420 + pack.activities.length * 260, y: 160 });
  const nodes: WorkspaceNodeV2[] = [input];
  const edges: WorkspaceEdgeV2[] = [];
  let previousNode = input;
  let previousHandle = 'url';

  pack.activities
    .slice()
    .sort((left, right) => left.order - right.order)
    .forEach((activity, index) => {
      const node = createWorkspaceNode(
        'RegExpression',
        {
          x: 260 + index * 260,
          y: 130,
        },
        {
          label: `Activity ${activity.order}`,
          pattern: activity.pattern,
          action: activity.action,
          matchMode: activity.match_mode,
          nthOccurrence: activity.nth_occurrence ?? 1,
          payload: activity.payload,
          payloadVars: activity.payload_vars,
        },
      );

      nodes.push(node);
      edges.push(createEdge(previousNode.id, previousHandle, node.id, 'input'));
      previousNode = node;
      previousHandle = 'result';
    });

  nodes.push(output);
  edges.push(createEdge(previousNode.id, previousHandle, output.id, 'url'));

  return {
    kind: 'workspace.v2',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceType: 'data-modifier',
    metadata: {
      id: crypto.randomUUID(),
      name: `${pack.name} Workspace`,
      version: Math.max(1, pack.version),
      author: pack.metadata.author,
      description: pack.metadata.description
        ? `${pack.metadata.description}\n\nConverted from a v1 URL pack.`
        : 'Converted from a v1 URL pack.',
      created_at: pack.metadata.created_at || now,
      updated_at: now,
    },
    trigger: {
      type: pack.trigger.type === 'ALWAYS' ? 'INPUT_DATA' : pack.trigger.type,
      hotkey: pack.trigger.hotkey,
      inputSources: ['url'],
      sourceFilters: pack.trigger.scope_regex?.trim()
        ? [{ source: 'url', pattern: pack.trigger.scope_regex.trim() }]
        : [],
    },
    nodes,
    edges,
    viewport: {
      x: 0,
      y: 0,
      zoom: 0.85,
    },
  };
}
