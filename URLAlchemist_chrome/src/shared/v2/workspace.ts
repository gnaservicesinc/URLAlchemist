import { getDefaultHotkey } from '../hotkeys';
import type { ActionPack } from '../types';
import { BLOCK_REGISTRY, getBlockDefinition } from './blockRegistry';
import type { BlockKind, WorkspaceEdgeV2, WorkspaceFileV2, WorkspaceNodeV2, WorkspaceTrigger } from './types';
import { BLOCK_TYPE_IDS, LEGACY_WORKSPACE_SCHEMA_VERSION, WORKSPACE_SCHEMA_VERSION } from './types';

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

export function isWorkspaceNode(value: unknown): value is WorkspaceNodeV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as WorkspaceNodeV2;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.type === 'string' &&
    candidate.type in BLOCK_REGISTRY &&
    candidate.typeId === BLOCK_TYPE_IDS[candidate.type as BlockKind] &&
    typeof candidate.position?.x === 'number' &&
    typeof candidate.position?.y === 'number' &&
    typeof candidate.settings === 'object' &&
    candidate.settings !== null
  );
}

export function isWorkspaceEdge(value: unknown): value is WorkspaceEdgeV2 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as WorkspaceEdgeV2;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.source === 'string' &&
    typeof candidate.sourceHandle === 'string' &&
    typeof candidate.target === 'string' &&
    typeof candidate.targetHandle === 'string'
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
    ...candidate,
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
    scope_regex: undefined,
  };
}

export function migrateWorkspaceFile(value: WorkspaceFileV2): WorkspaceFileV2 {
  return {
    ...value,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    trigger: normalizeWorkspaceTrigger(value.trigger),
  };
}

export function validateWorkspaceFile(value: unknown): { ok: true; value: WorkspaceFileV2 } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, errors: ['Workspace must be an object'] };
  }

  const candidate = value as WorkspaceFileV2;
  if (candidate.kind !== 'workspace.v2') {
    errors.push('Workspace kind is invalid');
  }

  if (![WORKSPACE_SCHEMA_VERSION, LEGACY_WORKSPACE_SCHEMA_VERSION].includes(candidate.schemaVersion)) {
    errors.push(`Unsupported workspace schema version: ${String(candidate.schemaVersion)}`);
  }

  if (!candidate.metadata || typeof candidate.metadata.name !== 'string' || !candidate.metadata.name.trim()) {
    errors.push('Workspace name is required');
  }

  if (!candidate.trigger || typeof candidate.trigger.type !== 'string') {
    errors.push('Workspace trigger is required');
  }

  if (!Array.isArray(candidate.nodes)) {
    errors.push('Workspace nodes must be an array');
  } else {
    candidate.nodes.forEach((node, index) => {
      if (!isWorkspaceNode(node)) {
        errors.push(`Workspace node ${index + 1} is invalid`);
      }
    });
  }

  if (!Array.isArray(candidate.edges)) {
    errors.push('Workspace edges must be an array');
  } else {
    candidate.edges.forEach((edge, index) => {
      if (!isWorkspaceEdge(edge)) {
        errors.push(`Workspace edge ${index + 1} is invalid`);
      }
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
