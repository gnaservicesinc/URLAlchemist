import { memo, useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
import { BLOCK_DEFINITIONS, getBlockDefinition, getPortDefinition } from '../../shared/v2/blockRegistry';
import { compileWorkspace, getConnectionValidationError } from '../../shared/v2/compiler';
import { createEdge, createWorkspaceNode } from '../../shared/v2/workspace';
import type { BlockDefinition, BlockKind, WorkspaceBlockSettings, WorkspaceFileV2, WorkspaceNodeV2 } from '../../shared/v2/types';
import { HotkeyRecorder } from './HotkeyRecorder';

interface WorkspaceEditorProps {
  workspace: WorkspaceFileV2;
  onWorkspaceChange: (workspace: WorkspaceFileV2) => void;
  onBuildActionPack: () => void;
  onExportActionPack: () => void;
  onExportWorkspace: () => void;
  onSaveWorkspace: () => void;
}

interface WorkspaceBlockData {
  [key: string]: unknown;
  definition: BlockDefinition;
  invalidInputs: string[];
  node: WorkspaceNodeV2;
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

function renderBlockSettings(node: WorkspaceNodeV2, onSettingsChange: (settings: Partial<WorkspaceBlockSettings>) => void) {
  const inputClass = 'nodrag rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-800 outline-none focus:border-amber-400';

  switch (node.type) {
    case 'RegExpression':
      return (
        <div className="mt-3 grid gap-2">
          <input className={inputClass} placeholder="Pattern" value={settingText(node.settings.pattern)} onChange={(event) => onSettingsChange({ pattern: event.target.value })} />
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
          <textarea className={`${inputClass} min-h-14`} placeholder="Payload" value={settingText(node.settings.payload)} onChange={(event) => onSettingsChange({ payload: event.target.value })} />
          <label className="nodrag flex items-center gap-2 text-[11px] text-slate-600">
            <input checked={Boolean(node.settings.payloadVars)} type="checkbox" onChange={(event) => onSettingsChange({ payloadVars: event.target.checked })} />
            Resolve variables
          </label>
        </div>
      );
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
    default:
      return null;
  }
}

const WorkspaceBlockNode = memo(function WorkspaceBlockNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const { definition, invalidInputs, node, onSettingsChange } = data;
  const locked = !definition.flags.canDelete || node.settings.locked;

  return (
    <div className={`min-w-56 rounded-xl border bg-white shadow-[0_14px_28px_rgba(15,23,42,0.12)] ${selected ? 'border-amber-500 ring-2 ring-amber-200' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">Type {definition.typeId}</div>
          <div className="mt-1 text-sm font-semibold text-slate-900">{node.settings.label || definition.label}</div>
        </div>
        <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] ${definition.risk === 'high' ? 'bg-rose-100 text-rose-700' : definition.risk === 'extended' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
          {locked ? 'Locked' : definition.risk}
        </span>
      </div>

      <div className="px-4 py-3">
        <input
          className="nodrag w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-800 outline-none focus:border-amber-400"
          value={node.settings.label ?? ''}
          placeholder={definition.label}
          onChange={(event) => onSettingsChange(node.id, { label: event.target.value })}
        />

        {renderBlockSettings(node, (settings) => onSettingsChange(node.id, settings))}

        <div className="mt-3 grid gap-2">
          {definition.inputs.map((input) => (
            <div key={input.id} className="relative flex min-h-7 items-center rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600">
              <Handle
                id={input.id}
                position={Position.Left}
                style={{ background: invalidInputs.includes(input.id) ? '#dc2626' : DATA_TYPE_COLORS[input.dataType] }}
                type="target"
              />
              <span className="ml-2">{input.label}</span>
              <span className="ml-auto font-mono text-[10px]">{input.dataType}</span>
            </div>
          ))}
          {definition.outputs.map((output) => (
            <div key={output.id} className="relative flex min-h-7 items-center rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600">
              <span>{output.label}</span>
              <span className="ml-auto mr-2 font-mono text-[10px]">{output.dataType}</span>
              <Handle
                id={output.id}
                position={Position.Right}
                style={{ background: DATA_TYPE_COLORS[output.dataType] }}
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

function WorkspaceFlow({ workspace, onWorkspaceChange }: Pick<WorkspaceEditorProps, 'workspace' | 'onWorkspaceChange'>) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const compileResult = useMemo(() => compileWorkspace(workspace), [workspace]);
  const invalidEdgeIds = useMemo(
    () => new Set(compileResult.validation.invalidEdgeIds),
    [compileResult.validation.invalidEdgeIds],
  );

  const handleSettingsChange = useCallback(
    (nodeId: string, settings: Partial<WorkspaceBlockSettings>): void => {
      onWorkspaceChange(updateNodeSettings(workspace, nodeId, settings));
    },
    [onWorkspaceChange, workspace],
  );

  const workspaceNodes = useMemo<WorkspaceFlowNode[]>(
    () =>
      workspace.nodes.map((node) => {
        const definition = getBlockDefinition(node.type);
        const invalidInputs = workspace.edges
          .filter((edge) => edge.target === node.id && invalidEdgeIds.has(edge.id))
          .map((edge) => edge.targetHandle);

        return {
          id: node.id,
          type: 'workspaceBlock',
          position: node.position,
          data: {
            definition,
            invalidInputs,
            node,
            onSettingsChange: handleSettingsChange,
          },
          deletable: definition.flags.canDelete && !node.settings.locked,
        };
      }),
    [workspace, invalidEdgeIds],
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
    const removedIds = new Set(
      changes
        .filter((change) => change.type === 'remove')
        .map((change) => change.id)
        .filter((nodeId) => {
          const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
          return node && getBlockDefinition(node.type).flags.canDelete && !node.settings.locked;
        }),
    );

    if (removedIds.size === 0) {
      setFlowNodes((currentNodes) => applyReactFlowNodeChanges(changes, currentNodes) as WorkspaceFlowNode[]);
      return;
    }

    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: workspace.nodes.filter((node) => !removedIds.has(node.id)),
      edges: workspace.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target)),
    });
  }, [onWorkspaceChange, workspace]);

  const handleNodeDragStop = useCallback((_event: ReactMouseEvent, node: Node): void => {
    const currentNode = workspace.nodes.find((candidate) => candidate.id === node.id);
    if (!currentNode) {
      return;
    }

    if (currentNode.position.x === node.position.x && currentNode.position.y === node.position.y) {
      return;
    }

    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: workspace.nodes.map((candidate) =>
        candidate.id === node.id
          ? {
              ...candidate,
              position: node.position,
            }
          : candidate,
      ),
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
        edges={flowEdges}
        isValidConnection={canConnect}
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
          {BLOCK_DEFINITIONS.filter((definition) => !['DataFlowIn', 'DataFlowOut'].includes(definition.kind)).map((definition) => (
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
    </div>
  );
}

export function WorkspaceEditor({
  workspace,
  onWorkspaceChange,
  onBuildActionPack,
  onExportActionPack,
  onExportWorkspace,
  onSaveWorkspace,
}: WorkspaceEditorProps) {
  const compileResult = useMemo(() => compileWorkspace(workspace), [workspace]);
  const hotkeyError = workspace.trigger.type === 'HOTKEY' ? getHotkeyValidationError(workspace.trigger.hotkey, []) : null;

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

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Workspace</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Node action builder</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Workspaces can be saved while invalid. Building a distributable Action Pack is blocked until every required connection and type check passes.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <button className="ghost-button" type="button" onClick={onSaveWorkspace}>
            Save Workspace
          </button>
          <button className="ghost-button" type="button" onClick={onExportWorkspace}>
            Export Workspace
          </button>
          <button className="secondary-button" disabled={!compileResult.ok} type="button" onClick={onBuildActionPack}>
            Build Action Pack
          </button>
          <button className="primary-button" disabled={!compileResult.ok} type="button" onClick={onExportActionPack}>
            Export .actionpack
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
            <option value="ALWAYS">Always</option>
            <option value="HOTKEY">Hotkey</option>
            <option value="CONTEXT_MENU">Context Menu</option>
            <option value="NEVER">Never</option>
          </select>
        </label>
        <label className="field-shell lg:col-span-2">
          <span className="field-label">Scope Regex</span>
          <input className="field-input" placeholder="Leave blank to run globally" value={workspace.trigger.scope_regex ?? ''} onChange={(event) => updateWorkspace({ trigger: { ...workspace.trigger, scope_regex: event.target.value } })} />
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
        {BLOCK_DEFINITIONS.filter((definition) => !['DataFlowIn', 'DataFlowOut'].includes(definition.kind)).map((definition) => (
          <button key={definition.kind} className="ghost-button" type="button" onClick={() => addToolbarBlock(definition.kind)}>
            {definition.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        <ReactFlowProvider>
          <WorkspaceFlow workspace={workspace} onWorkspaceChange={onWorkspaceChange} />
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
          <p className="font-semibold">Risk: {compileResult.validation.risk.highest.toUpperCase()}</p>
          {compileResult.validation.risk.reasons.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {compileResult.validation.risk.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
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
