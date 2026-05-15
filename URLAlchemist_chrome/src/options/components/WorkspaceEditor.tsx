import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges as applyReactFlowEdgeChanges,
  applyNodeChanges as applyReactFlowNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { getHotkeyValidationError } from '../../shared/hotkeys';
import type { Activity } from '../../shared/types';
import { BLOCK_DEFINITIONS, getBlockDefinition, getEffectivePortDefinitions } from '../../shared/v2/blockRegistry';
import { compileWorkspace, getConnectionValidationError } from '../../shared/v2/compiler';
import { createEdge, createWorkspaceNode } from '../../shared/v2/workspace';
import type { BlockDefinition, BlockKind, GraphPortDefinition, WorkspaceBlockSettings, WorkspaceFileV2, WorkspaceNodeV2 } from '../../shared/v2/types';
import { toActivityDraft, updateActivityDraft, type ActivityDraft } from '../drafts';
import { buildRegexFromBuilder, validateEditorRegexPattern } from '../regexBuilder';
import { HotkeyRecorder } from './HotkeyRecorder';
import { RegexBuilderPanel } from './RegexBuilderPanel';

interface WorkspaceEditorProps {
  advancedModeEnabled: boolean;
  workspace: WorkspaceFileV2;
  onWorkspaceChange: (workspace: WorkspaceFileV2) => void;
  onBuildActionPack: () => void;
  onExportActionPack: () => void;
  onExportActionPackVersionFile: () => void;
  onExportWorkspace: () => void;
  onSaveWorkspace: () => void;
}

interface WorkspaceBlockData {
  [key: string]: unknown;
  definition: BlockDefinition;
  connectedInputs: string[];
  inputs: GraphPortDefinition[];
  invalidInputs: string[];
  node: WorkspaceNodeV2;
  outputs: GraphPortDefinition[];
  onDeleteNode: (nodeId: string) => void;
  onLockToggle: (nodeId: string) => void;
  onOpenRegexBuilder: (nodeId: string) => void;
  onSettingsChange: (nodeId: string, settings: Partial<WorkspaceBlockSettings>) => void;
}

type WorkspaceFlowNode = Node<WorkspaceBlockData, 'workspaceBlock'>;

const DATA_TYPE_COLORS: Record<string, string> = {
  bool: '#2563eb',
  number: '#0f766e',
  floatingPoint: '#0891b2',
  string: '#b45309',
  URL: '#7c3aed',
  JSON: '#16a34a',
  data: '#64748b',
  dict: '#db2777',
  Any: '#334155',
};

function settingText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function handleStyle(color: string): CSSProperties {
  return {
    '--handle-color': color,
  } as CSSProperties;
}

function updateNodeSettings(workspace: WorkspaceFileV2, nodeId: string, settings: Partial<WorkspaceBlockSettings>): WorkspaceFileV2 {
  return {
    ...workspace,
    metadata: {
      ...workspace.metadata,
      updated_at: Date.now(),
    },
    nodes: workspace.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            settings: {
              ...node.settings,
              ...settings,
            },
          }
        : node,
    ),
  };
}

function renderBlockSettings(
  node: WorkspaceNodeV2,
  connectedInputs: Set<string>,
  onSettingsChange: (settings: Partial<WorkspaceBlockSettings>) => void,
  onOpenRegexBuilder: (() => void) | undefined,
) {
  const inputClass = 'nodrag rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-800 outline-none focus:border-amber-400';

  switch (node.type) {
    case 'RegExpression': {
      const payloadConnected = connectedInputs.has('payload');
      return (
        <div className="mt-3 grid gap-2">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <input className={inputClass} placeholder="Pattern" value={settingText(node.settings.pattern)} onChange={(event) => onSettingsChange({ pattern: event.target.value, regexSourceMode: 'MANUAL', regexHelperInput: event.target.value })} />
            <button className="nodrag rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:border-amber-300 hover:bg-amber-50" type="button" onClick={onOpenRegexBuilder}>
              Builder
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <select className={inputClass} value={node.settings.action ?? 'SUBSTITUTE'} onChange={(event) => onSettingsChange({ action: event.target.value as WorkspaceBlockSettings['action'] })}>
              <option value="SUBSTITUTE">Substitute</option>
              <option value="REMOVE">Remove</option>
              <option value="APPEND">Append</option>
              <option value="PREPEND">Prepend</option>
            </select>
            <select className={inputClass} value={node.settings.matchMode ?? 'STANDARD'} onChange={(event) => onSettingsChange({ matchMode: event.target.value as WorkspaceBlockSettings['matchMode'] })}>
              <option value="STANDARD">Standard</option>
              <option value="BEFORE_PATTERN">Before</option>
              <option value="AFTER_PATTERN">After</option>
              <option value="NTH_OCCURRENCE">Nth</option>
            </select>
          </div>
          <textarea className={`${inputClass} min-h-14 disabled:bg-slate-100 disabled:text-slate-400`} disabled={payloadConnected} placeholder={payloadConnected ? 'Connected payload input' : 'Payload'} value={payloadConnected ? '' : settingText(node.settings.payload)} onChange={(event) => onSettingsChange({ payload: event.target.value })} />
          <label className="nodrag flex items-center gap-2 text-[11px] text-slate-600">
            <input checked={Boolean(node.settings.payloadVars)} type="checkbox" onChange={(event) => onSettingsChange({ payloadVars: event.target.checked })} />
            Use replacement tokens
          </label>
        </div>
      );
    }
    case 'Logical':
      return (
        <div className="mt-3 grid grid-cols-[1fr_0.8fr] gap-2">
          <select className={inputClass} value={node.settings.operator ?? 'EQ'} onChange={(event) => onSettingsChange({ operator: event.target.value as WorkspaceBlockSettings['operator'] })}>
            <option value="LT">Less</option>
            <option value="LTE">Less/Equal</option>
            <option value="EQ">Equal</option>
            <option value="GT">Greater</option>
            <option value="GTE">Greater/Equal</option>
          </select>
          <input className={inputClass} value={settingText(node.settings.compareValue ?? '1')} onChange={(event) => onSettingsChange({ compareValue: event.target.value })} />
        </div>
      );
    case 'Math':
      return (
        <div className="mt-3 grid gap-2">
          <select className={inputClass} value={node.settings.mathOperation ?? 'ADD'} onChange={(event) => onSettingsChange({ mathOperation: event.target.value as WorkspaceBlockSettings['mathOperation'] })}>
            <option value="ADD">Add</option>
            <option value="SUBTRACT">Subtract</option>
            <option value="MULTIPLY">Multiply</option>
            <option value="DIVIDE">Divide</option>
            <option value="MODULO">Modulo</option>
          </select>
          <input className={inputClass} placeholder="Fallback A" value={settingText(node.settings.literalValue ?? '0')} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          <input className={inputClass} placeholder="Fallback B" value={settingText(node.settings.compareValue ?? '0')} onChange={(event) => onSettingsChange({ compareValue: event.target.value })} />
        </div>
      );
    case 'Convert':
      return (
        <div className="mt-3 grid gap-2">
          <select className={inputClass} value={node.settings.convertMode ?? 'STRING_TO_URL'} onChange={(event) => onSettingsChange({ convertMode: event.target.value as WorkspaceBlockSettings['convertMode'] })}>
            <option value="STRING_TO_URL">String to URL</option>
            <option value="FLOAT_TO_NUMBER">Float to Number</option>
            <option value="DICT_TO_JSON">Dict to JSON</option>
            <option value="JSON_TO_DICT">JSON to Dict</option>
            <option value="NUMBER_TO_STRING">Number to String</option>
            <option value="DATA_TO_STRING">Data to String</option>
          </select>
          {node.settings.convertMode === 'NUMBER_TO_STRING' ? (
            <label className="nodrag flex items-center gap-2 text-[11px] text-slate-600">
              <input checked={node.settings.convertOrd ?? true} type="checkbox" onChange={(event) => onSettingsChange({ convertOrd: event.target.checked })} />
              ORD
            </label>
          ) : null}
        </div>
      );
    case 'Declarations':
      return (
        <div className="mt-3 grid gap-2">
          <input className={inputClass} placeholder="Global or _local" value={settingText(node.settings.variableName)} onChange={(event) => onSettingsChange({ variableName: event.target.value })} />
          <input className={inputClass} placeholder="Default value" value={settingText(node.settings.literalValue ?? '0')} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
        </div>
      );
    case 'SaveLoad':
      return (
        <div className="mt-3 grid gap-2">
          <select className={inputClass} value={node.settings.saveLoadMode ?? 'SAVE'} onChange={(event) => onSettingsChange({ saveLoadMode: event.target.value as WorkspaceBlockSettings['saveLoadMode'] })}>
            <option value="SAVE">Save</option>
            <option value="EXISTS">Exists</option>
            <option value="GET">Get</option>
          </select>
          <input className={inputClass} placeholder="Fallback key" value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
        </div>
      );
    case 'DataStructure':
      return (
        <div className="mt-3 grid gap-2">
          <input className={inputClass} placeholder="Global dict name" value={settingText(node.settings.variableName)} onChange={(event) => onSettingsChange({ variableName: event.target.value })} />
          <input className={inputClass} placeholder="Fallback key" value={settingText(node.settings.dictKey)} onChange={(event) => onSettingsChange({ dictKey: event.target.value })} />
        </div>
      );
    case 'Loop':
      return (
        <div className="mt-3">
          <input className={inputClass} min={1} max={100} type="number" value={node.settings.loopLimit ?? 10} onChange={(event) => onSettingsChange({ loopLimit: Number.parseInt(event.target.value || '1', 10) })} />
        </div>
      );
    case 'FetchData':
      return (
        <div className="mt-3 grid gap-2">
          <input className={inputClass} disabled={connectedInputs.has('url')} placeholder="https://example.com/data.json" value={connectedInputs.has('url') ? '' : settingText(node.settings.remoteUrl)} onChange={(event) => onSettingsChange({ remoteUrl: event.target.value })} />
          <select className={inputClass} value={node.settings.remoteDataType ?? 'data'} onChange={(event) => onSettingsChange({ remoteDataType: event.target.value as WorkspaceBlockSettings['remoteDataType'] })}>
            <option value="data">Data</option>
            <option value="string">String</option>
            <option value="JSON">JSON</option>
            <option value="dict">Dict</option>
          </select>
          <input className={inputClass} min={500} max={30000} type="number" value={node.settings.remoteTimeoutMs ?? 5000} onChange={(event) => onSettingsChange({ remoteTimeoutMs: Number.parseInt(event.target.value || '5000', 10) })} />
          <input className={inputClass} min={1024} max={524288} type="number" value={node.settings.remoteMaxBytes ?? 131072} onChange={(event) => onSettingsChange({ remoteMaxBytes: Number.parseInt(event.target.value || '131072', 10) })} />
        </div>
      );
    case 'HttpRequest':
      return (
        <div className="mt-3 grid gap-2">
          <select className={inputClass} value={node.settings.remoteMethod ?? 'GET'} onChange={(event) => onSettingsChange({ remoteMethod: event.target.value as WorkspaceBlockSettings['remoteMethod'] })}>
            <option value="GET">GET</option>
            <option value="POST">POST</option>
          </select>
          <input className={inputClass} disabled={connectedInputs.has('url')} placeholder="https://example.com/api" value={connectedInputs.has('url') ? '' : settingText(node.settings.remoteUrl)} onChange={(event) => onSettingsChange({ remoteUrl: event.target.value })} />
          <select className={inputClass} value={node.settings.remoteDataType ?? 'data'} onChange={(event) => onSettingsChange({ remoteDataType: event.target.value as WorkspaceBlockSettings['remoteDataType'] })}>
            <option value="data">Data</option>
            <option value="string">String</option>
            <option value="JSON">JSON</option>
            <option value="dict">Dict</option>
          </select>
          <input className={inputClass} min={500} max={30000} type="number" value={node.settings.remoteTimeoutMs ?? 5000} onChange={(event) => onSettingsChange({ remoteTimeoutMs: Number.parseInt(event.target.value || '5000', 10) })} />
          <input className={inputClass} min={1024} max={524288} type="number" value={node.settings.remoteMaxBytes ?? 131072} onChange={(event) => onSettingsChange({ remoteMaxBytes: Number.parseInt(event.target.value || '131072', 10) })} />
        </div>
      );
    default:
      return null;
  }
}

const WorkspaceBlockNode = memo(function WorkspaceBlockNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const { connectedInputs, definition, inputs, invalidInputs, node, outputs, onDeleteNode, onLockToggle, onOpenRegexBuilder, onSettingsChange } = data;
  const locked = Boolean(node.settings.locked);

  return (
    <div className={`min-w-56 rounded-xl border bg-white shadow-[0_14px_28px_rgba(15,23,42,0.12)] ${selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-slate-900">{node.settings.label || definition.label}</div>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={`nodrag rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] transition ${locked ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'}`}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onLockToggle(node.id);
            }}
          >
            {locked ? 'Locked' : 'Unlocked'}
          </button>
          <button
            aria-label={`Delete ${node.settings.label || definition.label}`}
            className="nodrag flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-[11px] font-bold text-slate-500 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 disabled:cursor-not-allowed disabled:opacity-35"
            disabled={locked}
            title={locked ? 'Unlock this block before deleting it.' : 'Delete block'}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onDeleteNode(node.id);
            }}
          >
            X
          </button>
        </div>
      </div>

      <div className="px-4 py-3">
        <input
          className="nodrag w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-800 outline-none focus:border-amber-400"
          value={node.settings.label ?? ''}
          placeholder={definition.label}
          onChange={(event) => onSettingsChange(node.id, { label: event.target.value })}
        />

        {renderBlockSettings(
          node,
          new Set(connectedInputs),
          (settings) => onSettingsChange(node.id, settings),
          node.type === 'RegExpression' ? () => onOpenRegexBuilder(node.id) : undefined,
        )}

        <div className="mt-3 grid gap-2">
          {inputs.map((input) => (
            <div key={input.id} className="relative flex min-h-7 items-center rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600">
              <Handle
                className="workspace-port-handle workspace-port-handle-target"
                id={input.id}
                position={Position.Left}
                style={handleStyle(invalidInputs.includes(input.id) ? '#dc2626' : DATA_TYPE_COLORS[input.dataType])}
                type="target"
              />
              <span className="ml-2">{input.label}</span>
              <span className="ml-auto font-mono text-[10px]">{input.dataType}</span>
            </div>
          ))}
          {outputs.map((output) => (
            <div key={output.id} className="relative flex min-h-7 items-center rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600">
              <span>{output.label}</span>
              <span className="ml-auto mr-2 font-mono text-[10px]">{output.dataType}</span>
              <Handle
                className="workspace-port-handle workspace-port-handle-source"
                id={output.id}
                position={Position.Right}
                style={handleStyle(DATA_TYPE_COLORS[output.dataType])}
                type="source"
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
});

const nodeTypes = {
  workspaceBlock: WorkspaceBlockNode,
};

function regexActivityFromNode(node: WorkspaceNodeV2): Activity {
  return {
    id: node.id,
    order: 1,
    action: node.settings.action ?? 'SUBSTITUTE',
    pattern: node.settings.pattern ?? '',
    match_mode: node.settings.matchMode ?? 'STANDARD',
    nth_occurrence: node.settings.nthOccurrence ?? 1,
    payload: node.settings.payload ?? '',
    payload_vars: Boolean(node.settings.payloadVars),
  };
}

function regexDraftFromNode(node: WorkspaceNodeV2): ActivityDraft {
  const draft = toActivityDraft(regexActivityFromNode(node));
  const regexBuilder = node.settings.regexBuilder ?? draft.regexBuilder;
  const regexSourceMode = node.settings.regexSourceMode ?? draft.regexSourceMode;

  return {
    ...draft,
    helperMode: 'REGEX',
    helperInput: node.settings.regexHelperInput ?? draft.helperInput,
    pattern: regexSourceMode === 'VISUAL' ? buildRegexFromBuilder(regexBuilder) : node.settings.pattern ?? draft.pattern,
    regexBuilder,
    regexSourceMode,
  };
}

function regexSettingsFromDraft(draft: ActivityDraft): Partial<WorkspaceBlockSettings> {
  return {
    action: draft.action,
    matchMode: draft.match_mode,
    nthOccurrence: draft.nth_occurrence,
    pattern: draft.pattern,
    payload: draft.payload,
    payloadVars: draft.payload_vars,
    regexBuilder: draft.regexBuilder,
    regexHelperInput: draft.helperInput,
    regexSourceMode: draft.regexSourceMode,
  };
}

interface WorkspaceFlowProps {
  advancedModeEnabled: boolean;
  workspace: WorkspaceFileV2;
  onWorkspaceChange: (workspace: WorkspaceFileV2) => void;
  invalidEdgeIds: Set<string>;
}

function WorkspaceFlow({ advancedModeEnabled, workspace, onWorkspaceChange, invalidEdgeIds }: WorkspaceFlowProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [regexBuilderNodeId, setRegexBuilderNodeId] = useState<string | null>(null);

  const handleSettingsChange = useCallback(
    (nodeId: string, settings: Partial<WorkspaceBlockSettings>): void => {
      onWorkspaceChange(updateNodeSettings(workspace, nodeId, settings));
    },
    [onWorkspaceChange, workspace],
  );

  const handleLockToggle = useCallback(
    (nodeId: string): void => {
      const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        return;
      }

      onWorkspaceChange(updateNodeSettings(workspace, nodeId, { locked: !node.settings.locked }));
    },
    [onWorkspaceChange, workspace],
  );

  const handleDeleteNodes = useCallback(
    (nodeIds: string[]): void => {
      const removedIds = new Set(
        nodeIds.filter((nodeId) => {
          const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
          return node && getBlockDefinition(node.type).flags.canDelete && !node.settings.locked;
        }),
      );

      if (removedIds.size === 0) {
        return;
      }

      onWorkspaceChange({
        ...workspace,
        metadata: { ...workspace.metadata, updated_at: Date.now() },
        nodes: workspace.nodes.filter((node) => !removedIds.has(node.id)),
        edges: workspace.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)),
      });
    },
    [onWorkspaceChange, workspace],
  );

  const handleDeleteNode = useCallback((nodeId: string): void => {
    handleDeleteNodes([nodeId]);
  }, [handleDeleteNodes]);

  const workspaceNodes = useMemo<WorkspaceFlowNode[]>(
    () =>
      workspace.nodes.map((node) => {
        const definition = getBlockDefinition(node.type);
        const inputs = getEffectivePortDefinitions(node, 'input');
        const outputs = getEffectivePortDefinitions(node, 'output');
        const invalidInputs = workspace.edges
          .filter((edge) => edge.target === node.id && invalidEdgeIds.has(edge.id))
          .map((edge) => edge.targetHandle);
        const connectedInputs = workspace.edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => edge.targetHandle);

        return {
          id: node.id,
          type: 'workspaceBlock',
          position: node.position,
          data: {
            connectedInputs,
            definition,
            inputs,
            invalidInputs,
            node,
            outputs,
            onDeleteNode: handleDeleteNode,
            onLockToggle: handleLockToggle,
            onOpenRegexBuilder: setRegexBuilderNodeId,
            onSettingsChange: handleSettingsChange,
          },
          deletable: definition.flags.canDelete && !node.settings.locked,
          draggable: !node.settings.locked,
        };
      }),
    [workspace, invalidEdgeIds, handleDeleteNode, handleLockToggle, handleSettingsChange],
  );

  const workspaceEdges = useMemo<Edge[]>(
    () =>
      workspace.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        sourceHandle: edge.sourceHandle,
        target: edge.target,
        targetHandle: edge.targetHandle,
        animated: invalidEdgeIds.has(edge.id),
        style: {
          stroke: invalidEdgeIds.has(edge.id) ? '#dc2626' : '#475569',
          strokeWidth: 2,
        },
      })),
    [workspace.edges, invalidEdgeIds],
  );

  const [flowNodes, setFlowNodes] = useState<WorkspaceFlowNode[]>(workspaceNodes);
  const [flowEdges, setFlowEdges] = useState<Edge[]>(workspaceEdges);

  useEffect(() => {
    setFlowNodes(workspaceNodes);
  }, [workspaceNodes]);

  useEffect(() => {
    setFlowEdges(workspaceEdges);
  }, [workspaceEdges]);

  const handleNodeChanges = useCallback((changes: NodeChange[]): void => {
    const allowedChanges = changes.filter((change) => {
      if (change.type !== 'remove') {
        return true;
      }

      const node = workspace.nodes.find((candidate) => candidate.id === change.id);
      return Boolean(node && getBlockDefinition(node.type).flags.canDelete && !node.settings.locked);
    });
    const removedIds = new Set(
      allowedChanges
        .filter((change) => change.type === 'remove')
        .map((change) => change.id)
    );

    if (removedIds.size === 0) {
      setFlowNodes((currentNodes) => applyReactFlowNodeChanges(allowedChanges, currentNodes) as WorkspaceFlowNode[]);
      return;
    }

    handleDeleteNodes(Array.from(removedIds));
  }, [handleDeleteNodes, workspace]);

  const handleNodeDragStop = useCallback((_event: ReactMouseEvent, node: Node, draggedNodes: Node[]): void => {
    const movedNodes = draggedNodes.length > 0 ? draggedNodes : [node];
    const positions = new Map(movedNodes.map((candidate) => [candidate.id, candidate.position]));
    let changed = false;
    const nodes = workspace.nodes.map((candidate) => {
      const position = positions.get(candidate.id);
      if (!position || candidate.settings.locked) {
        return candidate;
      }

      if (candidate.position.x === position.x && candidate.position.y === position.y) {
        return candidate;
      }

      changed = true;
      return {
        ...candidate,
        position,
      };
    });

    if (!changed) {
      return;
    }

    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes,
    });
  }, [onWorkspaceChange, workspace]);

  const handleEdgeChanges = useCallback((changes: EdgeChange[]): void => {
    const removedIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
    if (removedIds.size === 0) {
      setFlowEdges((currentEdges) => applyReactFlowEdgeChanges(changes, currentEdges));
      return;
    }

    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      edges: workspace.edges.filter((edge) => !removedIds.has(edge.id)),
    });
  }, [onWorkspaceChange, workspace]);

  function canConnect(connection: Connection | Edge): boolean {
    if (!connection.source || !connection.sourceHandle || !connection.target || !connection.targetHandle) {
      return false;
    }

    return (
      getConnectionValidationError(
        workspace,
        createEdge(connection.source, connection.sourceHandle, connection.target, connection.targetHandle),
      ) === null
    );
  }

  function connect(connection: Connection): void {
    if (!connection.source || !connection.sourceHandle || !connection.target || !connection.targetHandle) {
      return;
    }

    const nextEdge = createEdge(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
    const nextEdges = workspace.edges.filter(
      (edge) => !(edge.target === nextEdge.target && edge.targetHandle === nextEdge.targetHandle),
    );

    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      edges: [...nextEdges, nextEdge],
    });
  }

  function addBlock(kind: WorkspaceNodeV2['type'], x = 360, y = 220): void {
    setContextMenu(null);
    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: [...workspace.nodes, createWorkspaceNode(kind, { x, y })],
    });
  }

  return (
    <div className="relative h-[720px] overflow-hidden rounded-[1.25rem] border border-slate-200 bg-white">
      <ReactFlow
        colorMode="light"
        connectionLineStyle={{ stroke: '#c76a1a', strokeWidth: 2 }}
        defaultViewport={workspace.viewport}
        deleteKeyCode={['Backspace', 'Delete']}
        edges={flowEdges}
        isValidConnection={canConnect}
        multiSelectionKeyCode="Shift"
        nodeTypes={nodeTypes}
        nodes={flowNodes}
        onlyRenderVisibleElements
        onConnect={connect}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault();
          onWorkspaceChange({
            ...workspace,
            edges: workspace.edges.filter((candidate) => candidate.id !== edge.id),
          });
        }}
        onEdgesChange={handleEdgeChanges}
        onInit={setFlowInstance}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodeChanges}
        onPaneClick={() => setContextMenu(null)}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          const flowPosition = flowInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 360, y: 220 };
          setContextMenu({ x: event.clientX, y: event.clientY, flowX: flowPosition.x, flowY: flowPosition.y });
        }}
        selectionKeyCode="Shift"
        selectionOnDrag
        selectNodesOnDrag={false}
      >
        <Background color="#e2e8f0" gap={22} />
        <Controls showInteractive={false} />
        <MiniMap nodeColor="#c76a1a" pannable zoomable />
      </ReactFlow>

      {contextMenu ? (
        <div
          className="absolute z-20 grid max-h-96 w-64 gap-1 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-[0_20px_60px_rgba(15,23,42,0.22)]"
          style={{ left: contextMenu.x - 24, top: contextMenu.y - 128 }}
        >
          {BLOCK_DEFINITIONS.map((definition) => (
            <button
              key={definition.kind}
              className="rounded-xl px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-amber-50"
              type="button"
              onClick={() => addBlock(definition.kind, contextMenu.flowX, contextMenu.flowY)}
            >
              {definition.label}
            </button>
          ))}
        </div>
      ) : null}

      {regexBuilderNodeId ? createPortal((() => {
        const node = workspace.nodes.find((candidate) => candidate.id === regexBuilderNodeId && candidate.type === 'RegExpression');
        if (!node) {
          return null;
        }

        const draft = regexDraftFromNode(node);
        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 px-4 py-10 backdrop-blur-md">
            <div className="reveal-panel w-full max-w-5xl rounded-[1.75rem] border border-white/70 bg-[rgba(255,252,246,0.98)] p-5 shadow-[0_32px_90px_rgba(15,23,42,0.26)]">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="eyebrow">Regex</p>
                  <h3 className="mt-2 text-2xl font-semibold text-slate-900">Regex builder</h3>
                </div>
                <button className="ghost-button" type="button" onClick={() => setRegexBuilderNodeId(null)}>
                  Close
                </button>
              </div>
              <div className="mt-5">
                <RegexBuilderPanel
                  activity={draft}
                  advancedModeEnabled={advancedModeEnabled}
                  validationError={validateEditorRegexPattern(draft.pattern)}
                  onUpdate={(updates) => {
                    const nextDraft = updateActivityDraft(draft, updates);
                    handleSettingsChange(node.id, regexSettingsFromDraft(nextDraft));
                  }}
                />
              </div>
            </div>
          </div>
        );
      })(), document.body) : null}
    </div>
  );
}

export function WorkspaceEditor({
  advancedModeEnabled,
  workspace,
  onWorkspaceChange,
  onBuildActionPack,
  onExportActionPack,
  onExportActionPackVersionFile,
  onExportWorkspace,
  onSaveWorkspace,
}: WorkspaceEditorProps) {
  const compileResult = useMemo(() => compileWorkspace(workspace), [workspace]);
  const invalidEdgeIds = useMemo(() => new Set(compileResult.validation.invalidEdgeIds), [compileResult.validation.invalidEdgeIds]);
  const hotkeyError = workspace.trigger.type === 'HOTKEY' ? getHotkeyValidationError(workspace.trigger.hotkey, []) : null;
  const hasDataOut = workspace.nodes.some((node) => node.type === 'DataFlowOut');
  const urlFilter = workspace.trigger.sourceFilters?.find((filter) => filter.source === 'url')?.pattern ?? '';

  function updateWorkspace(updates: Partial<WorkspaceFileV2>): void {
    onWorkspaceChange({
      ...workspace,
      ...updates,
      metadata: {
        ...workspace.metadata,
        ...(updates.metadata ?? {}),
        updated_at: Date.now(),
      },
    });
  }

  function addToolbarBlock(kind: BlockKind): void {
    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: [...workspace.nodes, createWorkspaceNode(kind, { x: 320 + workspace.nodes.length * 24, y: 260 + workspace.nodes.length * 18 })],
    });
  }

  function updateUrlFilter(pattern: string): void {
    const otherFilters = (workspace.trigger.sourceFilters ?? []).filter((filter) => filter.source !== 'url');
    updateWorkspace({
      trigger: {
        ...workspace.trigger,
        sourceFilters: pattern.trim() ? [...otherFilters, { source: 'url', pattern }] : otherFilters,
      },
    });
  }

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Node action builder</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Workspaces can be saved while otherwise invalid, but at least one Data Out block is required. Building a distributable Action Pack is blocked until every required connection and type check passes.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button className="ghost-button" disabled={!hasDataOut} type="button" onClick={onSaveWorkspace}>
            Save Workspace
          </button>
          <button className="ghost-button" disabled={!hasDataOut} type="button" onClick={onExportWorkspace}>
            Export Workspace
          </button>
          <button className="secondary-button" disabled={!compileResult.ok} type="button" onClick={onBuildActionPack}>
            Build Action Pack
          </button>
          <button className="primary-button" disabled={!compileResult.ok} type="button" onClick={onExportActionPack}>
            Export .actionpack
          </button>
          <button className="ghost-button" disabled={!compileResult.ok} type="button" onClick={onExportActionPackVersionFile}>
            Export Version File
          </button>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-4">
        <label className="field-shell">
          <span className="field-label">Workspace Name</span>
          <input className="field-input" value={workspace.metadata.name} onChange={(event) => updateWorkspace({ metadata: { ...workspace.metadata, name: event.target.value } })} />
        </label>
        <label className="field-shell">
          <span className="field-label">Version</span>
          <input className="field-input" min={1} type="number" value={workspace.metadata.version} onChange={(event) => updateWorkspace({ metadata: { ...workspace.metadata, version: Math.max(1, Number.parseInt(event.target.value || '1', 10)) } })} />
        </label>
        <label className="field-shell">
          <span className="field-label">Author</span>
          <input className="field-input" value={workspace.metadata.author ?? ''} onChange={(event) => updateWorkspace({ metadata: { ...workspace.metadata, author: event.target.value } })} />
        </label>
        <label className="field-shell">
          <span className="field-label">Trigger</span>
          <select className="field-select" value={workspace.trigger.type} onChange={(event) => updateWorkspace({ trigger: { ...workspace.trigger, type: event.target.value as WorkspaceFileV2['trigger']['type'] } })}>
            <option value="INPUT_DATA">Run on input data</option>
            <option value="HOTKEY">Hotkey</option>
            <option value="CONTEXT_MENU">Context Menu</option>
            <option value="INTERVAL">Recurring interval</option>
            <option disabled value="CONDITIONAL">Conditional (not available)</option>
            <option value="NEVER">Never</option>
          </select>
        </label>
        <label className="field-shell lg:col-span-2">
          <span className="field-label">URL Input Filter</span>
          <input className="field-input" placeholder="Optional regex for URL inputs" value={urlFilter} onChange={(event) => updateUrlFilter(event.target.value)} />
        </label>
        {workspace.trigger.type === 'INTERVAL' ? (
          <label className="field-shell lg:col-span-2">
            <span className="field-label">Interval Seconds</span>
            <input className="field-input" min={30} type="number" value={Math.max(30, Math.round((workspace.trigger.intervalMs ?? 60000) / 1000))} onChange={(event) => updateWorkspace({ trigger: { ...workspace.trigger, intervalMs: Math.max(30, Number.parseInt(event.target.value || '30', 10)) * 1000 } })} />
          </label>
        ) : null}
        {workspace.trigger.type === 'CONDITIONAL' ? (
          <>
            <label className="field-shell">
              <span className="field-label">Condition Mode</span>
              <select className="field-select" value={workspace.trigger.conditionalMode ?? 'RISING_EDGE'} onChange={(event) => updateWorkspace({ trigger: { ...workspace.trigger, conditionalMode: event.target.value as WorkspaceFileV2['trigger']['conditionalMode'] } })}>
                <option value="RISING_EDGE">False to true once</option>
                <option value="WHILE_TRUE">Repeat while true</option>
              </select>
            </label>
            <label className="field-shell">
              <span className="field-label">Condition Workspace ID</span>
              <input className="field-input" placeholder="Optional condition workspace UUID" value={workspace.trigger.conditionWorkspaceId ?? ''} onChange={(event) => updateWorkspace({ trigger: { ...workspace.trigger, conditionWorkspaceId: event.target.value } })} />
            </label>
          </>
        ) : null}
        <label className="field-shell lg:col-span-2">
          <span className="field-label">Version File URL</span>
          <input className="field-input" placeholder="https://example.com/path/pack.version" value={workspace.metadata.versionFileUrl ?? ''} onChange={(event) => updateWorkspace({ metadata: { ...workspace.metadata, versionFileUrl: event.target.value } })} />
        </label>
        <label className="field-shell lg:col-span-2">
          <span className="field-label">Download URL</span>
          <input className="field-input" placeholder="https://example.com/path/pack.actionpack" value={workspace.metadata.downloadUrl ?? ''} onChange={(event) => updateWorkspace({ metadata: { ...workspace.metadata, downloadUrl: event.target.value } })} />
        </label>
        <label className="field-shell lg:col-span-2">
          <span className="field-label">Signature URL</span>
          <input className="field-input" placeholder="https://example.com/path/pack.version.asc" value={workspace.metadata.versionFileSignatureUrl ?? ''} onChange={(event) => updateWorkspace({ metadata: { ...workspace.metadata, versionFileSignatureUrl: event.target.value } })} />
        </label>
        <label className="field-shell lg:col-span-2">
          <span className="field-label">Public Key Locator</span>
          <input className="field-input" placeholder="author@example.com" value={workspace.metadata.publicKeyLocateValue ?? ''} onChange={(event) => updateWorkspace({ metadata: { ...workspace.metadata, publicKeyLocateValue: event.target.value } })} />
        </label>
        {workspace.trigger.type === 'HOTKEY' ? (
          <div className="lg:col-span-2">
            <HotkeyRecorder
              validationError={hotkeyError}
              value={workspace.trigger.hotkey}
              onChange={(hotkey) => updateWorkspace({ trigger: { ...workspace.trigger, hotkey } })}
            />
          </div>
        ) : null}
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {BLOCK_DEFINITIONS.map((definition) => (
          <button key={definition.kind} className="ghost-button" type="button" onClick={() => addToolbarBlock(definition.kind)}>
            {definition.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        <ReactFlowProvider>
          <WorkspaceFlow advancedModeEnabled={advancedModeEnabled} workspace={workspace} onWorkspaceChange={onWorkspaceChange} invalidEdgeIds={invalidEdgeIds} />
        </ReactFlowProvider>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className={`rounded-[1.25rem] border px-5 py-4 ${compileResult.validation.valid ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
          <p className="text-sm font-semibold">{compileResult.validation.valid ? 'Workspace can build.' : 'Build is blocked.'}</p>
          {compileResult.validation.errors.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {compileResult.validation.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="rounded-[1.25rem] border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p className="font-semibold">
            {compileResult.validation.risk.highest === 'high'
              ? 'Install warning: strong'
              : compileResult.validation.risk.highest === 'extended'
                ? 'Install notice: extended access'
                : 'Install notice: standard'}
          </p>
          {compileResult.validation.risk.reasons.length > 0 ? (
            <div className="mt-2 space-y-2">
              <p>
                {compileResult.validation.risk.highest === 'high'
                  ? 'Users will see a prominent warning and may be discouraged from installing this pack. That warning can be ignored for personal-use packs when you know exactly what the pack does.'
                  : 'Users will be told that this pack touches data outside the safe core and should enable trace after installation.'}
              </p>
              <ul className="list-disc pl-5">
              {compileResult.validation.risk.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
              </ul>
            </div>
          ) : (
            <p className="mt-2">Safe core inputs and outputs only.</p>
          )}
          {compileResult.validation.warnings.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {compileResult.validation.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}
