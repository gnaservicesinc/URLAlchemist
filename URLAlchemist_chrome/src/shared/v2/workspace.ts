import { getDefaultHotkey } from '../hotkeys';
import { WORKSPACE_TRIGGER_TYPES } from '../types';
import type { ActionPack } from '../types';
import { assertSafeRegexPattern } from '../regex/executeRegexJob';
import { BLOCK_REGISTRY, getBlockDefinition } from './blockRegistry';
import type {
  BlockKind,
  WorkspaceEdgeV2,
  WorkspaceFileV2,
  WorkspaceInputSource,
  WorkspaceMetadata,
  WorkspaceNodeV2,
  WorkspaceTrigger,
  WorkspaceViewport,
} from './types';
import { BLOCK_TYPE_IDS, SUPPORTED_WORKSPACE_SCHEMA_VERSIONS, WORKSPACE_SCHEMA_VERSION } from './types';

const MAX_WORKSPACE_TOTAL_BYTES = 1024 * 1024;
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
  const profile: WorkspaceMetadata['profile'] = value.profile === 'content-blocker'
    ? 'content-blocker'
    : value.profile === 'standard'
      ? 'standard'
      : undefined;

  return omitUndefined({
    id: value.id,
    name: value.name,
    version: value.version,
    author: value.author,
    description: value.description,
    compatibility: normalizeCompatibilityMetadata(value.compatibility),
    profile,
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
  return {
    kind: 'workspace.v2',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    metadata: normalizeWorkspaceMetadata(value.metadata),
    trigger: normalizeWorkspaceTrigger(value.trigger),
    nodes: value.nodes.map(normalizeWorkspaceNode),
    edges: value.edges.map(normalizeWorkspaceEdge),
    assets: Array.isArray(value.assets) ? value.assets : undefined,
    viewport: normalizeWorkspaceViewport(value.viewport),
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

  validateWorkspaceMetadata(candidate.metadata, errors);
  validateWorkspaceTrigger(candidate.trigger, errors);
  validateViewport(candidate.viewport, errors);

  if (!Array.isArray(candidate.nodes)) {
    errors.push('Workspace nodes must be an array');
  } else if (candidate.nodes.length === 0 || candidate.nodes.length > MAX_WORKSPACE_NODES) {
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
