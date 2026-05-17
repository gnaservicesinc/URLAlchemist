import {
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Panel,
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
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { DEFAULT_SETTINGS } from '../../shared/constants';
import { getHotkeyValidationError } from '../../shared/hotkeys';
import type { Activity } from '../../shared/types';
import { BLOCK_DEFINITIONS, getBlockDefinition, getEffectivePortDefinitions } from '../../shared/v2/blockRegistry';
import { compileWorkspace, getConnectionValidationError } from '../../shared/v2/compiler';
import { formatEventHandler, formatRunType } from '../../shared/v2/labels';
import { createSandboxGraphRuntime } from '../../shared/v2/sandboxRuntime';
import { createEdge, createWorkspaceNode } from '../../shared/v2/workspace';
import type { BlockDefinition, BlockKind, GraphEventHandler, GraphPortDefinition, GraphValue, WorkspaceBlockSettings, WorkspaceFileV2, WorkspaceNodeV2 } from '../../shared/v2/types';
import { executeCompiledActionPackV2 } from '../../shared/v2/vm';
import { toActivityDraft, updateActivityDraft, type ActivityDraft } from '../drafts';
import { createPageRegexExecutor } from '../../shared/regex/pageRunner';
import { buildRegexFromBuilder, validateEditorRegexPattern } from '../regexBuilder';
import { HelpTooltip } from './HelpTooltip';
import { HotkeyRecorder } from './HotkeyRecorder';
import { RegexBuilderPanel } from './RegexBuilderPanel';

export interface WorkspaceChangeOptions {
  viewportOnly?: boolean;
}

interface WorkspaceEditorProps {
  advancedModeEnabled: boolean;
  allWorkspaces: WorkspaceFileV2[];
  isDirty: boolean;
  workspace: WorkspaceFileV2;
  onNewWorkspace: () => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onWorkspaceChange: (workspace: WorkspaceFileV2, options?: WorkspaceChangeOptions) => void;
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
  variables: DeclaredVariable[];
  onCollapseToggle: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onLockToggle: (nodeId: string) => void;
  onOpenRegexBuilder: (nodeId: string) => void;
  onSettingsChange: (nodeId: string, settings: Partial<WorkspaceBlockSettings>) => void;
}

interface DeclaredVariable {
  nodeId: string;
  rawName: string;
  token: string;
  dataType: string;
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
  asset: '#ea580c',
  Any: '#334155',
};

const CATEGORY_LABELS: Record<BlockDefinition['category'], string> = {
  convert: 'Convert',
  data: 'Data',
  debug: 'Debug',
  flow: 'Flow',
  interaction: 'Interaction',
  logic: 'Logic',
  math: 'Math',
  media: 'Media',
  regex: 'Regex',
  storage: 'Storage',
};

const EVENT_LANE_DEFINITIONS = [
  { id: 'trigger', label: 'Trigger', sourceTypes: new Set<BlockKind>(['DataFlowIn', 'ExtendedDataIn', 'OnTriggerEvent']) },
  { id: 'keyboard', label: 'Keyboard', sourceTypes: new Set<BlockKind>(['KeyboardIn']) },
  { id: 'mouse', label: 'Mouse', sourceTypes: new Set<BlockKind>(['MouseIn']) },
  { id: 'tick', label: 'Tick', sourceTypes: new Set<BlockKind>(['OverlayTickIn']) },
] as const;

type EventLaneId = (typeof EVENT_LANE_DEFINITIONS)[number]['id'] | 'other';

function blockTitle(node: WorkspaceNodeV2, definition = getBlockDefinition(node.type)): string {
  return node.settings.label || definition.label;
}

function shortDataType(type: string): string {
  switch (type) {
    case 'floatingPoint':
      return 'float';
    case 'number':
      return 'num';
    default:
      return type;
  }
}

function categoryLabel(category: BlockDefinition['category']): string {
  return CATEGORY_LABELS[category] ?? category;
}

function settingText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function variableToken(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed || trimmed.startsWith('$') || trimmed.startsWith('_')) {
    return trimmed;
  }

  return `$${trimmed}`;
}

function isReservedVariableName(rawName: string): boolean {
  const trimmed = rawName.trim();
  return /^\$?\d+$/.test(trimmed) || /^\$\d+/.test(variableToken(trimmed));
}

function collectDeclaredVariables(workspace: WorkspaceFileV2): DeclaredVariable[] {
  return workspace.nodes
    .filter((node) => node.type === 'Declarations' && node.settings.variableName?.trim())
    .map((node) => ({
      nodeId: node.id,
      rawName: node.settings.variableName!.trim(),
      token: variableToken(node.settings.variableName!),
      dataType: node.settings.literalDataType ?? 'Any',
    }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fieldUsesVariable(value: unknown, variables: DeclaredVariable[]): boolean {
  const text = settingText(value);
  if (!text) {
    return false;
  }

  return variables.some((variable) => {
    const token = variable.token;
    if (!token) {
      return false;
    }
    const pattern = new RegExp(`${escapeRegExp(token)}(?![A-Za-z0-9_])`);
    return pattern.test(text);
  });
}

function usedVariableTokens(workspace: WorkspaceFileV2, variables: DeclaredVariable[]): Set<string> {
  const used = new Set<string>();
  workspace.nodes.forEach((node) => {
    Object.entries(node.settings).forEach(([key, value]) => {
      if (key === 'variableName') {
        return;
      }

      variables.forEach((variable) => {
        if (fieldUsesVariable(value, [variable])) {
          used.add(variable.token);
        }
      });
    });
  });
  return used;
}

function variableAwareClass(value: unknown, variables: DeclaredVariable[], baseClass: string): string {
  return fieldUsesVariable(value, variables)
    ? `${baseClass} border-amber-300 bg-amber-50 text-amber-950`
    : baseClass;
}

function handleStyle(color: string): CSSProperties {
  return {
    '--handle-color': color,
  } as CSSProperties;
}

const blockInputClass = 'nodrag rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-800 outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-100';
const blockLabelClass = 'nodrag grid gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500';

function BoundsText({ children }: { children: string }) {
  return <span className="normal-case tracking-normal text-slate-400">{children}</span>;
}

function SettingLabel({ children, help }: { children: string; help?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span>{children}</span>
      {help ? <HelpTooltip label={children} text={help} /> : null}
    </span>
  );
}

function SettingField({
  children,
  className = '',
  help,
  hint,
  label,
}: {
  children: ReactNode;
  className?: string;
  help?: string;
  hint?: string;
  label: string;
}) {
  const labelledChildren = isValidElement(children)
    ? cloneElement(children as ReactElement<{ 'aria-label'?: string }>, {
        'aria-label': (children.props as { 'aria-label'?: string })['aria-label'] ?? label,
      })
    : children;

  return (
    <div className={`${blockLabelClass} ${className}`}>
      <SettingLabel help={help}>{label}</SettingLabel>
      {labelledChildren}
      {hint ? <BoundsText>{hint}</BoundsText> : null}
    </div>
  );
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
  variables: DeclaredVariable[],
  onSettingsChange: (settings: Partial<WorkspaceBlockSettings>) => void,
  onOpenRegexBuilder: (() => void) | undefined,
) {
  const inputClass = blockInputClass;
  const isConnected = (portId: string): boolean => connectedInputs.has(portId);
  const connectedNote = (label: string) => (
    <p className="mt-1 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
      {label} is provided by a connected input.
    </p>
  );

  switch (node.type) {
    case 'RegExpression': {
      const payloadConnected = connectedInputs.has('payload');
      return (
        <div className="mt-3 grid gap-2">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <SettingField
              help="The JavaScript regular expression used to find text in the input value."
              label="Regex pattern"
            >
              <input className={inputClass} placeholder="utm_source=[^&]+" value={settingText(node.settings.pattern)} onChange={(event) => onSettingsChange({ pattern: event.target.value, regexSourceMode: 'MANUAL', regexHelperInput: event.target.value })} />
            </SettingField>
            <button aria-label="Open regex builder" className="nodrag self-end rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50" type="button" onClick={onOpenRegexBuilder}>
              Builder
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <SettingField help="Controls how matched text is transformed." label="Action">
              <select className={inputClass} value={node.settings.action ?? 'SUBSTITUTE'} onChange={(event) => onSettingsChange({ action: event.target.value as WorkspaceBlockSettings['action'] })}>
                <option value="SUBSTITUTE">Substitute</option>
                <option value="REMOVE">Remove</option>
                <option value="APPEND">Append</option>
                <option value="PREPEND">Prepend</option>
              </select>
            </SettingField>
            <SettingField help="Controls which part of the match is transformed." label="Match mode">
              <select className={inputClass} value={node.settings.matchMode ?? 'STANDARD'} onChange={(event) => onSettingsChange({ matchMode: event.target.value as WorkspaceBlockSettings['matchMode'] })}>
                <option value="STANDARD">Standard</option>
                <option value="BEFORE_PATTERN">Before</option>
                <option value="AFTER_PATTERN">After</option>
                <option value="NTH_OCCURRENCE">Nth</option>
              </select>
            </SettingField>
          </div>
          {node.settings.matchMode === 'NTH_OCCURRENCE' ? (
            <SettingField help="The 1-based occurrence to transform when match mode is Nth." hint="1 or greater" label="Occurrence number">
              <input className={inputClass} min={1} type="number" value={node.settings.nthOccurrence ?? 1} onChange={(event) => onSettingsChange({ nthOccurrence: Math.max(1, Number.parseInt(event.target.value || '1', 10)) })} />
            </SettingField>
          ) : null}
          <SettingField
            help="Replacement text. It is ignored for Remove and disabled when a payload input is connected."
            label="Payload"
          >
            <textarea className={`${variableAwareClass(node.settings.payload, variables, inputClass)} min-h-14 disabled:bg-slate-100 disabled:text-slate-400`} disabled={payloadConnected} placeholder={payloadConnected ? 'Connected payload input' : 'Replacement text'} value={payloadConnected ? '' : settingText(node.settings.payload)} onChange={(event) => onSettingsChange({ payload: event.target.value })} />
          </SettingField>
          <label className="nodrag flex items-center gap-2 text-[11px] text-slate-600">
            <input checked={Boolean(node.settings.payloadVars)} type="checkbox" onChange={(event) => onSettingsChange({ payloadVars: event.target.checked })} />
            <span className="flex items-center gap-1.5">
              Use replacement tokens
              <HelpTooltip label="Replacement tokens" text="Allows regex groups like $1 plus safe placeholders such as {date}. Clipboard placeholders request clipboard permission." />
            </span>
          </label>
        </div>
      );
    }
    case 'Logical':
      return (
        <div className="mt-3 grid grid-cols-[1fr_0.8fr] gap-2">
          <SettingField help="Comparison operator for the numeric input." label="Operator">
            <select className={inputClass} value={node.settings.operator ?? 'EQ'} onChange={(event) => onSettingsChange({ operator: event.target.value as WorkspaceBlockSettings['operator'] })}>
              <option value="LT">Less</option>
              <option value="LTE">Less/Equal</option>
              <option value="EQ">Equal</option>
              <option value="GT">Greater</option>
              <option value="GTE">Greater/Equal</option>
            </select>
          </SettingField>
          <SettingField help="Fallback value used when the comparison side is not connected." label="Compare value">
            <input className={inputClass} value={settingText(node.settings.compareValue ?? '1')} onChange={(event) => onSettingsChange({ compareValue: event.target.value })} />
          </SettingField>
        </div>
      );
    case 'Math':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Numeric operation applied to A and B." label="Operation">
            <select className={inputClass} value={node.settings.mathOperation ?? 'ADD'} onChange={(event) => onSettingsChange({ mathOperation: event.target.value as WorkspaceBlockSettings['mathOperation'] })}>
              <option value="ADD">Add</option>
              <option value="SUBTRACT">Subtract</option>
              <option value="MULTIPLY">Multiply</option>
              <option value="DIVIDE">Divide</option>
              <option value="MODULO">Modulo</option>
            </select>
          </SettingField>
          {!isConnected('left') ? <SettingField help="Used for input A when the A port is not connected." label="A value">
            <input className={inputClass} value={settingText(node.settings.literalValue ?? '0')} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField> : connectedNote('A value')}
          {!isConnected('right') ? <SettingField help="Used for input B when the B port is not connected." label="B value">
            <input className={inputClass} value={settingText(node.settings.compareValue ?? '0')} onChange={(event) => onSettingsChange({ compareValue: event.target.value })} />
          </SettingField> : connectedNote('B value')}
        </div>
      );
    case 'Convert':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Changes the value type before it flows to the next block." label="Conversion mode">
            <select className={inputClass} value={node.settings.convertMode ?? 'STRING_TO_URL'} onChange={(event) => onSettingsChange({ convertMode: event.target.value as WorkspaceBlockSettings['convertMode'] })}>
              <option value="STRING_TO_URL">String to URL</option>
              <option value="FLOAT_TO_NUMBER">Float to Number</option>
              <option value="DICT_TO_JSON">Dict to JSON</option>
              <option value="JSON_TO_DICT">JSON to Dict</option>
              <option value="NUMBER_TO_STRING">Number to String</option>
              <option value="DATA_TO_STRING">Data to String</option>
            </select>
          </SettingField>
          {node.settings.convertMode === 'NUMBER_TO_STRING' ? (
            <label className="nodrag flex items-center gap-2 text-[11px] text-slate-600">
              <input checked={node.settings.convertOrd ?? true} type="checkbox" onChange={(event) => onSettingsChange({ convertOrd: event.target.checked })} />
              <span className="flex items-center gap-1.5">
                ORD digit mode
                <HelpTooltip label="ORD digit mode" text="When enabled, numbers are converted through their digit character codes before printable text cleanup." />
              </span>
            </label>
          ) : null}
        </div>
      );
    case 'Declarations':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Names starting with _ are local to this run. Other names are shared within the pack execution." label="Variable name">
            <input className={inputClass} placeholder="Global or _local" value={settingText(node.settings.variableName)} onChange={(event) => onSettingsChange({ variableName: event.target.value })} />
          </SettingField>
          {node.settings.variableName && isReservedVariableName(node.settings.variableName) ? (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-2 py-1 text-[11px] text-rose-700">
              $1, $2, and other numbered names are reserved for substitution connector inputs.
            </p>
          ) : null}
          {!isConnected('value') ? <SettingField help="Controls how the initial value is parsed." label="Initial value type">
            <select className={inputClass} value={node.settings.literalDataType ?? 'string'} onChange={(event) => onSettingsChange({ literalDataType: event.target.value as WorkspaceBlockSettings['literalDataType'] })}>
              <option value="bool">Bool</option>
              <option value="number">Number</option>
              <option value="floatingPoint">Floating Point</option>
              <option value="string">String</option>
              <option value="URL">URL</option>
              <option value="JSON">JSON</option>
              <option value="data">Data</option>
              <option value="dict">Dict</option>
              <option value="Any">Any</option>
            </select>
          </SettingField> : null}
          {!isConnected('value') ? <SettingField help="Initial value used when the value input is not connected." label="Initial value">
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField> : connectedNote('Initial value')}
        </div>
      );
    case 'SaveLoad':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Save writes a value, Exists returns true or false, and Get reads the saved value." label="Storage mode">
            <select className={inputClass} value={node.settings.saveLoadMode ?? 'SAVE'} onChange={(event) => onSettingsChange({ saveLoadMode: event.target.value as WorkspaceBlockSettings['saveLoadMode'] })}>
              <option value="SAVE">Save</option>
              <option value="EXISTS">Exists</option>
              <option value="GET">Get</option>
            </select>
          </SettingField>
          {!isConnected('key') ? <SettingField help="Used when the Key input is not connected. Empty keys are skipped at runtime." label="Storage key">
            <input className={inputClass} placeholder="session-key" value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField> : connectedNote('Storage key')}
        </div>
      );
    case 'DataStructure':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('dict') ? <SettingField help="Optional global dictionary to read or update when the Dict input is not connected." label="Global dict name">
            <input className={inputClass} placeholder="notes" value={settingText(node.settings.variableName)} onChange={(event) => onSettingsChange({ variableName: event.target.value })} />
          </SettingField> : connectedNote('Dictionary')}
          {!isConnected('key') ? <SettingField help="Used when the Key input is not connected." label="Key">
            <input className={inputClass} placeholder="title" value={settingText(node.settings.dictKey)} onChange={(event) => onSettingsChange({ dictKey: event.target.value })} />
          </SettingField> : connectedNote('Key')}
        </div>
      );
    case 'Loop':
      return (
        <div className="mt-3">
          <SettingField help="Maximum iterations this block can consume before VM loop budgets stop execution." hint="1-100 iterations" label="Loop limit">
            <input className={inputClass} min={1} max={100} type="number" value={node.settings.loopLimit ?? 10} onChange={(event) => onSettingsChange({ loopLimit: Number.parseInt(event.target.value || '1', 10) })} />
          </SettingField>
        </div>
      );
    case 'FetchData':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('url') ? (
            <SettingField help="HTTPS-only URL used when the URL input is not connected." label="Remote URL">
              <input className={inputClass} placeholder="https://example.com/data.json" value={settingText(node.settings.remoteUrl)} onChange={(event) => onSettingsChange({ remoteUrl: event.target.value })} />
            </SettingField>
          ) : connectedNote('Remote URL')}
          <SettingField help="Controls how the remote response is typed inside the graph." label="Response type">
            <select className={inputClass} value={node.settings.remoteDataType ?? 'data'} onChange={(event) => onSettingsChange({ remoteDataType: event.target.value as WorkspaceBlockSettings['remoteDataType'] })}>
              <option value="data">Data</option>
              <option value="string">String</option>
              <option value="JSON">JSON</option>
              <option value="dict">Dict</option>
            </select>
          </SettingField>
          <SettingField help="Aborts the remote request when this time budget expires." hint="500-30000 ms" label="Timeout (ms)">
            <input className={inputClass} min={500} max={30000} type="number" value={node.settings.remoteTimeoutMs ?? 5000} onChange={(event) => onSettingsChange({ remoteTimeoutMs: Number.parseInt(event.target.value || '5000', 10) })} />
          </SettingField>
          <SettingField help="Stops reading the response after this many bytes." hint="1024-524288 bytes" label="Max response bytes">
            <input className={inputClass} min={1024} max={524288} type="number" value={node.settings.remoteMaxBytes ?? 131072} onChange={(event) => onSettingsChange({ remoteMaxBytes: Number.parseInt(event.target.value || '131072', 10) })} />
          </SettingField>
        </div>
      );
    case 'HttpRequest':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="HTTP verb for the HTTPS request. POST sends the connected Body as JSON." label="Method">
            <select className={inputClass} value={node.settings.remoteMethod ?? 'GET'} onChange={(event) => onSettingsChange({ remoteMethod: event.target.value as WorkspaceBlockSettings['remoteMethod'] })}>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </SettingField>
          {!isConnected('url') ? (
            <SettingField help="HTTPS-only URL used when the URL input is not connected." label="Remote URL">
              <input className={inputClass} placeholder="https://example.com/api" value={settingText(node.settings.remoteUrl)} onChange={(event) => onSettingsChange({ remoteUrl: event.target.value })} />
            </SettingField>
          ) : connectedNote('Remote URL')}
          <SettingField help="Controls how the remote response is typed inside the graph." label="Response type">
            <select className={inputClass} value={node.settings.remoteDataType ?? 'data'} onChange={(event) => onSettingsChange({ remoteDataType: event.target.value as WorkspaceBlockSettings['remoteDataType'] })}>
              <option value="data">Data</option>
              <option value="string">String</option>
              <option value="JSON">JSON</option>
              <option value="dict">Dict</option>
            </select>
          </SettingField>
          <SettingField help="Aborts the remote request when this time budget expires." hint="500-30000 ms" label="Timeout (ms)">
            <input className={inputClass} min={500} max={30000} type="number" value={node.settings.remoteTimeoutMs ?? 5000} onChange={(event) => onSettingsChange({ remoteTimeoutMs: Number.parseInt(event.target.value || '5000', 10) })} />
          </SettingField>
          <SettingField help="Stops reading the response after this many bytes." hint="1024-524288 bytes" label="Max response bytes">
            <input className={inputClass} min={1024} max={524288} type="number" value={node.settings.remoteMaxBytes ?? 131072} onChange={(event) => onSettingsChange({ remoteMaxBytes: Number.parseInt(event.target.value || '131072', 10) })} />
          </SettingField>
        </div>
      );
    case 'SystemData':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Chooses which local time value is emitted when the pack runs." label="System value">
            <select className={inputClass} value={node.settings.systemDataMode ?? 'NOW_MS'} onChange={(event) => onSettingsChange({ systemDataMode: event.target.value as WorkspaceBlockSettings['systemDataMode'] })}>
              <option value="NOW_MS">Now ms</option>
              <option value="EPOCH_SECONDS">Epoch seconds</option>
              <option value="ISO_DATE">ISO date</option>
              <option value="TIMEZONE_OFFSET_MINUTES">Timezone offset minutes</option>
              <option value="LOCALE_DATE">Locale date</option>
              <option value="LOCALE_TIME">Locale time</option>
            </select>
          </SettingField>
        </div>
      );
    case 'PromptText':
    case 'PromptNumber':
    case 'Confirm':
    case 'PickFileOrUrl':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('message') ? <SettingField help="Text shown to the user in the page overlay prompt." label="Prompt message">
            <input className={inputClass} placeholder="Prompt message" value={settingText(node.settings.promptMessage)} onChange={(event) => onSettingsChange({ promptMessage: event.target.value })} />
          </SettingField> : connectedNote('Prompt message')}
          {node.type === 'PromptText' || node.type === 'PromptNumber' ? (
            <>
              <SettingField help="Pre-filled value shown in the input before the user edits it." label="Default value">
                <input className={inputClass} value={settingText(node.settings.promptDefaultValue)} onChange={(event) => onSettingsChange({ promptDefaultValue: event.target.value })} />
              </SettingField>
              <SettingField help="Hint text shown only when the prompt input is empty." label="Placeholder">
                <input className={inputClass} value={settingText(node.settings.promptPlaceholder)} onChange={(event) => onSettingsChange({ promptPlaceholder: event.target.value })} />
              </SettingField>
            </>
          ) : null}
          {node.type === 'PromptNumber' ? (
            <div className="grid grid-cols-2 gap-2">
              <SettingField help="Optional lower bound for the number prompt." label="Minimum">
                <input className={inputClass} type="number" value={node.settings.minValue ?? ''} onChange={(event) => onSettingsChange({ minValue: event.target.value ? Number(event.target.value) : undefined })} />
              </SettingField>
              <SettingField help="Optional upper bound for the number prompt." label="Maximum">
                <input className={inputClass} type="number" value={node.settings.maxValue ?? ''} onChange={(event) => onSettingsChange({ maxValue: event.target.value ? Number(event.target.value) : undefined })} />
              </SettingField>
            </div>
          ) : null}
        </div>
      );
    case 'ShowMessage':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('title') ? (
            <SettingField help="Heading used when the Title input is not connected." label="Title">
              <input className={inputClass} placeholder="URL Alchemist" value={settingText(node.settings.promptTitle ?? 'URL Alchemist')} onChange={(event) => onSettingsChange({ promptTitle: event.target.value })} />
            </SettingField>
          ) : connectedNote('Title')}
          {!isConnected('message') ? (
            <SettingField help="Message text used when the Message input is not connected." label="Message">
              <textarea className={`${inputClass} min-h-14`} placeholder="Message" value={settingText(node.settings.promptMessage)} onChange={(event) => onSettingsChange({ promptMessage: event.target.value })} />
            </SettingField>
          ) : connectedNote('Message')}
          <SettingField help="Controls whether the display appears as an overlay, a replacement page, or a new tab." label="Display mode">
            <select className={inputClass} value={node.settings.displayMode ?? 'OVERLAY'} onChange={(event) => onSettingsChange({ displayMode: event.target.value as WorkspaceBlockSettings['displayMode'] })}>
              <option value="OVERLAY">Page overlay</option>
              <option value="REPLACE_PAGE">Replace page</option>
              <option value="NEW_TAB">New tab</option>
            </select>
          </SettingField>
          <SettingField help="Optional auto-close time. Leave empty for no configured timeout." hint="0-3600000 ms" label="Timeout (ms)">
            <input className={inputClass} min={0} max={3600000} type="number" value={node.settings.displayTimeoutMs ?? ''} onChange={(event) => onSettingsChange({ displayTimeoutMs: event.target.value ? Number(event.target.value) : undefined })} />
          </SettingField>
        </div>
      );
    case 'ShowImage':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Determines what ends the image display and returns a result." label="Stop mode">
            <select className={inputClass} value={node.settings.imageStopMode ?? 'CLOSE_BUTTON'} onChange={(event) => onSettingsChange({ imageStopMode: event.target.value as WorkspaceBlockSettings['imageStopMode'] })}>
              <option value="CLOSE_BUTTON">Close button</option>
              <option value="CLICK">Click image</option>
              <option value="TIMEOUT">Timeout</option>
              <option value="CONFIRM">Require confirmation</option>
            </select>
          </SettingField>
          <SettingField help="Auto-close time used by timeout-style image displays." hint="0-3600000 ms" label="Timeout (ms)">
            <input className={inputClass} min={0} max={3600000} type="number" value={node.settings.displayTimeoutMs ?? 5000} onChange={(event) => onSettingsChange({ displayTimeoutMs: Number(event.target.value || '0') })} />
          </SettingField>
        </div>
      );
    case 'ShowVideo':
    case 'PlaySound':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Controls whether media plays in an overlay, replacement page, or new tab fallback." label="Display mode">
            <select className={inputClass} value={node.settings.displayMode ?? 'OVERLAY'} onChange={(event) => onSettingsChange({ displayMode: event.target.value as WorkspaceBlockSettings['displayMode'] })}>
              <option value="OVERLAY">Page overlay</option>
              <option value="REPLACE_PAGE">Replace page</option>
              <option value="NEW_TAB">New tab</option>
            </select>
          </SettingField>
        </div>
      );
    case 'OverlayInput':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('message') ? (
            <SettingField help="Overlay text shown while keyboard or mouse capture is active." label="Overlay message">
              <textarea className={`${inputClass} min-h-14`} placeholder="Overlay message" value={settingText(node.settings.promptMessage)} onChange={(event) => onSettingsChange({ promptMessage: event.target.value })} />
            </SettingField>
          ) : connectedNote('Overlay message')}
          <SettingField help="Maximum time the capture overlay stays open." hint="0-3600000 ms" label="Timeout (ms)">
            <input className={inputClass} min={0} max={3600000} type="number" value={node.settings.displayTimeoutMs ?? 10000} onChange={(event) => onSettingsChange({ displayTimeoutMs: Number(event.target.value || '0') })} />
          </SettingField>
          <label className="nodrag flex items-center gap-2 text-[11px] text-slate-600">
            <input checked={node.settings.captureKeyboard ?? true} type="checkbox" onChange={(event) => onSettingsChange({ captureKeyboard: event.target.checked })} />
            <span className="flex items-center gap-1.5">
              Capture keyboard while overlay is open
              <HelpTooltip label="Capture keyboard" text="Captures trusted key events only while the page overlay is active and returns a bounded event summary." />
            </span>
          </label>
          <label className="nodrag flex items-center gap-2 text-[11px] text-slate-600">
            <input checked={node.settings.captureMouse ?? true} type="checkbox" onChange={(event) => onSettingsChange({ captureMouse: event.target.checked })} />
            <span className="flex items-center gap-1.5">
              Capture mouse while overlay is open
              <HelpTooltip label="Capture mouse" text="Records bounded pointer summaries inside the overlay panel, not arbitrary page data." />
            </span>
          </label>
        </div>
      );
    case 'OnTriggerEvent':
    case 'KeyboardIn':
    case 'MouseIn':
    case 'OverlayTickIn':
      return (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
          Event source blocks run their connected chain only when the matching overlay or trigger event arrives.
        </p>
      );
    case 'Constant':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Controls the output port type and how the literal is parsed." label="Value type">
            <select className={inputClass} value={node.settings.literalDataType ?? 'string'} onChange={(event) => onSettingsChange({ literalDataType: event.target.value as WorkspaceBlockSettings['literalDataType'] })}>
              <option value="bool">Bool</option>
              <option value="number">Number</option>
              <option value="floatingPoint">Floating Point</option>
              <option value="string">String</option>
              <option value="URL">URL</option>
              <option value="JSON">JSON</option>
              <option value="data">Data</option>
              <option value="dict">Dict</option>
              <option value="Any">Any</option>
            </select>
          </SettingField>
          <SettingField help="Literal value. Data, Dict, and Any can parse JSON." label="Literal">
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField>
        </div>
      );
    case 'Substitution': {
      const template = settingText(node.settings.substitutionTemplate);
      return (
        <div className="mt-3 grid gap-2">
          <SettingField
            help="Builds a string from this template. $1, $2, and so on use the connected inputs in order. Declared variables like $name are substituted from the current run."
            label="String pattern"
          >
            <textarea
              className={`${variableAwareClass(template, variables, inputClass)} min-h-16`}
              placeholder="Hello $1 from $name"
              value={template}
              onChange={(event) => onSettingsChange({ substitutionTemplate: event.target.value })}
            />
          </SettingField>
          <SettingField help="Visible connector count. Connecting the last connector automatically adds another one." hint="1-24 connectors" label="Connectors">
            <input
              className={inputClass}
              min={1}
              max={24}
              type="number"
              value={node.settings.substitutionInputCount ?? 1}
              onChange={(event) => onSettingsChange({ substitutionInputCount: Math.max(1, Math.min(24, Number.parseInt(event.target.value || '1', 10))) })}
            />
          </SettingField>
        </div>
      );
    }
    case 'SaveStringToLog':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Severity used in the Action Pack log entry." label="Severity">
            <select className={inputClass} value={node.settings.logSeverity ?? 'info'} onChange={(event) => onSettingsChange({ logSeverity: event.target.value as WorkspaceBlockSettings['logSeverity'] })}>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="error">Error</option>
            </select>
          </SettingField>
          {!isConnected('message') ? (
            <SettingField help="Text written to the local log when the Message input is not connected." label="Message">
              <textarea className={`${variableAwareClass(node.settings.literalValue, variables, inputClass)} min-h-16`} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
            </SettingField>
          ) : connectedNote('Message')}
        </div>
      );
    case 'Abort':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Recorded in the trace when the condition is true and the Action Pack exits." label="Abort message">
            <input className={variableAwareClass(node.settings.abortMessage, variables, inputClass)} value={settingText(node.settings.abortMessage)} onChange={(event) => onSettingsChange({ abortMessage: event.target.value })} />
          </SettingField>
          {!isConnected('condition') ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-800">
              Connect a bool to Condition. Without a connection, this block aborts whenever it runs.
            </p>
          ) : connectedNote('Condition')}
        </div>
      );
    case 'Sleep':
      return (
        <div className="mt-3">
          {!isConnected('duration') ? <SettingField help="Delay used when the Duration input is not connected." hint="0-60000 ms" label="Delay">
            <input className={inputClass} min={0} max={60000} type="number" value={node.settings.sleepMs ?? 100} onChange={(event) => onSettingsChange({ sleepMs: Number.parseInt(event.target.value || '0', 10) })} />
          </SettingField> : connectedNote('Delay')}
        </div>
      );
    case 'SharedState':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Get reads, Set writes, Exists returns a bool, and Delete clears a session-scoped key." label="Mode">
            <select className={inputClass} value={node.settings.sharedStateMode ?? 'GET'} onChange={(event) => onSettingsChange({ sharedStateMode: event.target.value as WorkspaceBlockSettings['sharedStateMode'] })}>
              <option value="GET">Get</option>
              <option value="SET">Set</option>
              <option value="EXISTS">Exists</option>
              <option value="DELETE">Delete</option>
            </select>
          </SettingField>
          {!isConnected('key') ? <SettingField help="Used when the Key input is not connected." label="Key">
            <input className={inputClass} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField> : connectedNote('Key')}
          {node.settings.sharedStateMode === 'SET' && isConnected('value') ? connectedNote('Value') : (
          <SettingField help={node.settings.sharedStateMode === 'SET' ? 'Value to save when the Value input is not connected.' : 'Default value returned when the key does not exist.'} label={node.settings.sharedStateMode === 'SET' ? 'Value' : 'Default when missing'}>
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.selectFalseValue)} onChange={(event) => onSettingsChange({ selectFalseValue: event.target.value })} />
          </SettingField>
          )}
          <SettingField help="Parser for the typed value above." label="Value type">
            <select className={inputClass} value={node.settings.literalDataType ?? 'Any'} onChange={(event) => onSettingsChange({ literalDataType: event.target.value as WorkspaceBlockSettings['literalDataType'] })}>
              <option value="bool">Bool</option>
              <option value="number">Number</option>
              <option value="string">String</option>
              <option value="data">Data</option>
              <option value="dict">Dict</option>
              <option value="Any">Any</option>
            </select>
          </SettingField>
        </div>
      );
    case 'DictGet':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('key') ? <SettingField help="Used when the Key input is not connected." label="Key">
            <input className={inputClass} value={settingText(node.settings.dictKey)} onChange={(event) => onSettingsChange({ dictKey: event.target.value })} />
          </SettingField> : connectedNote('Key')}
          <SettingField help="Returned when the key is not present." label="Default when missing">
            <input className={inputClass} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField>
        </div>
      );
    case 'ListOperation':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Operation applied to the list input or fallback list." label="Operation">
            <select className={inputClass} value={node.settings.listOperation ?? 'APPEND'} onChange={(event) => onSettingsChange({ listOperation: event.target.value as WorkspaceBlockSettings['listOperation'] })}>
              <option value="APPEND">Append</option>
              <option value="PREPEND">Prepend</option>
              <option value="DROP_LAST">Drop Last</option>
              <option value="GET">Get</option>
              <option value="LENGTH">Length</option>
              <option value="CONTAINS_POINT">Contains Point</option>
            </select>
          </SettingField>
          {!isConnected('list') ? <SettingField help="JSON list used when the List input is not connected." label="List value">
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.literalValue ?? '[]')} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField> : connectedNote('List value')}
          {!isConnected('item') ? <SettingField help="Item literal used when the Item input is not connected." label="Item value">
            <input className={inputClass} value={settingText(node.settings.selectTrueValue)} onChange={(event) => onSettingsChange({ selectTrueValue: event.target.value })} />
          </SettingField> : connectedNote('Item value')}
        </div>
      );
    case 'ConditionSelect':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Fallback parser for the True and False literal values." label="Fallback type">
            <select className={inputClass} value={node.settings.literalDataType ?? 'number'} onChange={(event) => onSettingsChange({ literalDataType: event.target.value as WorkspaceBlockSettings['literalDataType'] })}>
              <option value="bool">Bool</option>
              <option value="number">Number</option>
              <option value="string">String</option>
              <option value="data">Data</option>
              <option value="dict">Dict</option>
              <option value="Any">Any</option>
            </select>
          </SettingField>
          {!isConnected('trueValue') ? <SettingField help="Used when the True input is not connected." label="True value">
            <input className={inputClass} value={settingText(node.settings.selectTrueValue)} onChange={(event) => onSettingsChange({ selectTrueValue: event.target.value })} />
          </SettingField> : connectedNote('True value')}
          {!isConnected('falseValue') ? <SettingField help="Used when the False input is not connected." label="False value">
            <input className={inputClass} value={settingText(node.settings.selectFalseValue)} onChange={(event) => onSettingsChange({ selectFalseValue: event.target.value })} />
          </SettingField> : connectedNote('False value')}
        </div>
      );
    case 'RandomNumber':
      return (
        <div className="mt-3 grid grid-cols-2 gap-2">
          {!isConnected('min') ? <SettingField help="Inclusive lower bound used when Min is not connected." label="Min">
            <input className={inputClass} type="number" value={node.settings.randomMin ?? 0} onChange={(event) => onSettingsChange({ randomMin: Number.parseInt(event.target.value || '0', 10) })} />
          </SettingField> : connectedNote('Min')}
          {!isConnected('max') ? <SettingField help="Inclusive upper bound used when Max is not connected." label="Max">
            <input className={inputClass} type="number" value={node.settings.randomMax ?? 10} onChange={(event) => onSettingsChange({ randomMax: Number.parseInt(event.target.value || '10', 10) })} />
          </SettingField> : connectedNote('Max')}
        </div>
      );
    case 'OverlayControl':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Start, stop, toggle, or read status for the URL Alchemist-owned overlay session." label="Action">
            <select className={inputClass} value={node.settings.overlayControlAction ?? 'START'} onChange={(event) => onSettingsChange({ overlayControlAction: event.target.value as WorkspaceBlockSettings['overlayControlAction'] })}>
              <option value="START">Start</option>
              <option value="STOP">Stop</option>
              <option value="TOGGLE">Toggle</option>
              <option value="STATUS">Status</option>
            </select>
          </SettingField>
          {!isConnected('message') ? <SettingField help="Text shown in the visible overlay header." label="Overlay text">
            <input className={inputClass} value={settingText(node.settings.overlayText ?? node.settings.promptMessage)} onChange={(event) => onSettingsChange({ overlayText: event.target.value, promptMessage: event.target.value })} />
          </SettingField> : connectedNote('Overlay text')}
          <div className="grid grid-cols-2 gap-2">
            <SettingField help="Grid columns." hint="1-200" label="Width">
              <input className={inputClass} min={1} max={200} type="number" value={node.settings.overlayWidth ?? 24} onChange={(event) => onSettingsChange({ overlayWidth: Number.parseInt(event.target.value || '24', 10) })} />
            </SettingField>
            <SettingField help="Grid rows." hint="1-200" label="Height">
              <input className={inputClass} min={1} max={200} type="number" value={node.settings.overlayHeight ?? 18} onChange={(event) => onSettingsChange({ overlayHeight: Number.parseInt(event.target.value || '18', 10) })} />
            </SettingField>
            <SettingField help="Rendered pixel size per grid cell." hint="4-96 px" label="Cell size">
              <input className={inputClass} min={4} max={96} type="number" value={node.settings.overlayCellSize ?? 24} onChange={(event) => onSettingsChange({ overlayCellSize: Number.parseInt(event.target.value || '24', 10) })} />
            </SettingField>
            <SettingField help="Overlay tick interval." hint="16-5000 ms" label="Tick ms">
              <input className={inputClass} min={16} max={5000} type="number" value={node.settings.overlayTickMs ?? 120} onChange={(event) => onSettingsChange({ overlayTickMs: Number.parseInt(event.target.value || '120', 10) })} />
            </SettingField>
          </div>
          <SettingField help="Visible full-page overlay background." label="Background">
            <input className={inputClass} value={settingText(node.settings.overlayBackground ?? '#ffffff')} onChange={(event) => onSettingsChange({ overlayBackground: event.target.value })} />
          </SettingField>
        </div>
      );
    case 'OverlayDraw':
      return (
        <div className="mt-3 grid gap-2">
          <div className="grid grid-cols-2 gap-2">
            <SettingField help="Grid columns." hint="1-200" label="Width">
              <input className={inputClass} min={1} max={200} type="number" value={node.settings.overlayWidth ?? 24} onChange={(event) => onSettingsChange({ overlayWidth: Number.parseInt(event.target.value || '24', 10) })} />
            </SettingField>
            <SettingField help="Grid rows." hint="1-200" label="Height">
              <input className={inputClass} min={1} max={200} type="number" value={node.settings.overlayHeight ?? 18} onChange={(event) => onSettingsChange({ overlayHeight: Number.parseInt(event.target.value || '18', 10) })} />
            </SettingField>
            <SettingField help="Rendered pixel size per grid cell." hint="4-96 px" label="Cell size">
              <input className={inputClass} min={4} max={96} type="number" value={node.settings.overlayCellSize ?? 24} onChange={(event) => onSettingsChange({ overlayCellSize: Number.parseInt(event.target.value || '24', 10) })} />
            </SettingField>
            <SettingField help="Canvas clear color." label="Background">
              <input className={inputClass} value={settingText(node.settings.overlayBackground ?? '#ffffff')} onChange={(event) => onSettingsChange({ overlayBackground: event.target.value })} />
            </SettingField>
          </div>
        </div>
      );
    case 'GetImage':
    case 'GetVideo':
    case 'GetAudio':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('url') ? (
            <SettingField help="HTTPS-only media URL used when the URL input is not connected." label="Media URL">
              <input className={inputClass} placeholder={`https://example.com/file.${node.type === 'GetVideo' ? 'mp4' : node.type === 'GetAudio' ? 'mp3' : 'png'}`} value={settingText(node.settings.assetUrl)} onChange={(event) => onSettingsChange({ assetUrl: event.target.value })} />
            </SettingField>
          ) : connectedNote('Media URL')}
          <SettingField help="Optional MIME type hint for embedded or fetched media." label="MIME type">
            <input className={inputClass} placeholder={node.type === 'GetVideo' ? 'video/mp4' : node.type === 'GetAudio' ? 'audio/mpeg' : 'image/png'} value={settingText(node.settings.assetMimeType)} onChange={(event) => onSettingsChange({ assetMimeType: event.target.value })} />
          </SettingField>
          <SettingField help="Aborts the media request when this time budget expires." hint="500-30000 ms" label="Timeout (ms)">
            <input className={inputClass} min={500} max={30000} type="number" value={node.settings.remoteTimeoutMs ?? 5000} onChange={(event) => onSettingsChange({ remoteTimeoutMs: Number.parseInt(event.target.value || '5000', 10) })} />
          </SettingField>
          <SettingField help="Streams and reassembles the media response up to this safety budget, then aborts the request." hint="Default 10MB, maximum 50MB" label="Asset byte budget">
            <input className={inputClass} min={1} max={52428800} type="number" value={node.settings.remoteMaxBytes ?? 10485760} onChange={(event) => onSettingsChange({ remoteMaxBytes: Number.parseInt(event.target.value || '10485760', 10) })} />
          </SettingField>
        </div>
      );
    default:
      return null;
  }
}

const WorkspaceBlockNode = memo(function WorkspaceBlockNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const { connectedInputs, definition, inputs, invalidInputs, node, outputs, variables, onCollapseToggle, onDeleteNode, onLockToggle, onOpenRegexBuilder, onSettingsChange } = data;
  const locked = Boolean(node.settings.locked);
  const collapsed = Boolean(node.settings.collapsed);
  const title = blockTitle(node, definition);

  const compactPortRows = (ports: GraphPortDefinition[], direction: 'input' | 'output') => (
    <div className="grid gap-1.5">
      {ports.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-300">
          No {direction === 'input' ? 'inputs' : 'outputs'}
        </div>
      ) : ports.map((port) => (
        <div key={port.id} className={`relative flex min-h-6 items-center rounded-md bg-slate-50 px-2 py-1 text-[10px] text-slate-600 ${direction === 'input' ? 'pl-3' : 'pr-3'}`}>
          {direction === 'input' ? (
            <Handle
              className="workspace-port-handle workspace-port-handle-target workspace-port-handle-compact"
              id={port.id}
              position={Position.Left}
              style={handleStyle(invalidInputs.includes(port.id) ? '#dc2626' : DATA_TYPE_COLORS[port.dataType])}
              type="target"
            />
          ) : null}
          <span className="truncate">{port.label}</span>
          <span className={`${direction === 'input' ? 'ml-auto' : 'ml-1 mr-auto'} font-mono text-[9px] text-slate-400`}>{shortDataType(port.dataType)}</span>
          {direction === 'output' ? (
            <Handle
              className="workspace-port-handle workspace-port-handle-source workspace-port-handle-compact"
              id={port.id}
              position={Position.Right}
              style={handleStyle(DATA_TYPE_COLORS[port.dataType])}
              type="source"
            />
          ) : null}
        </div>
      ))}
    </div>
  );

  return (
    <div className={`${collapsed ? 'w-56' : 'min-w-56'} rounded-lg border bg-white shadow-[0_12px_24px_rgba(31,41,55,0.11)] ${selected ? 'border-teal-600 ring-2 ring-teal-100' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-slate-900">{title}</div>
          {collapsed ? (
            <div className="mt-1 flex flex-wrap gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">
              <span>{categoryLabel(definition.category)}</span>
              <span>{inputs.length} in</span>
              <span>{outputs.length} out</span>
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          <button
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
            className="nodrag flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-[11px] font-bold text-slate-500 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-700"
            title={collapsed ? 'Expand block' : 'Collapse block'}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCollapseToggle(node.id);
            }}
          >
            <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24">
              {collapsed ? (
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
              ) : (
                <path d="M5 12h14" stroke="currentColor" strokeLinecap="round" strokeWidth="2.4" />
              )}
            </svg>
          </button>
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

      {collapsed ? (
        <div className="grid grid-cols-2 gap-2 px-3 py-3">
          {compactPortRows(inputs, 'input')}
          {compactPortRows(outputs, 'output')}
        </div>
      ) : (
      <div className="px-4 py-3">
        <SettingField help="Optional display name for this block. Leaving it empty uses the block type name." label="Block label">
          <input
            className="nodrag w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-800 outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-100"
            value={node.settings.label ?? ''}
            placeholder={definition.label}
            onChange={(event) => onSettingsChange(node.id, { label: event.target.value })}
          />
        </SettingField>

        {renderBlockSettings(
          node,
          new Set(connectedInputs),
          data.variables,
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
              <span className="ml-2 flex items-center gap-1.5">
                {input.label}
                {input.description ? <HelpTooltip label={`${input.label} input`} text={input.description} /> : null}
              </span>
              <span className="ml-auto font-mono text-[10px]">{input.dataType}</span>
            </div>
          ))}
          {outputs.map((output) => (
            <div key={output.id} className="relative flex min-h-7 items-center rounded-lg bg-slate-50 px-2 py-1 text-xs text-slate-600">
              <span className="flex items-center gap-1.5">
                {output.label}
                {output.description ? <HelpTooltip label={`${output.label} output`} text={output.description} /> : null}
              </span>
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
      )}
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

function buildDownstreamNodeIds(workspace: WorkspaceFileV2, sourceTypes: Set<BlockKind>): Set<string> {
  const sourceIds = workspace.nodes.filter((node) => sourceTypes.has(node.type)).map((node) => node.id);
  const visited = new Set(sourceIds);
  const queue = [...sourceIds];

  while (queue.length > 0) {
    const current = queue.shift()!;
    workspace.edges
      .filter((edge) => edge.source === current)
      .forEach((edge) => {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push(edge.target);
        }
      });
  }

  return visited;
}

function buildEventLaneTargets(workspace: WorkspaceFileV2): Record<EventLaneId, Set<string>> {
  const targets = EVENT_LANE_DEFINITIONS.reduce((accumulator, lane) => {
    accumulator[lane.id] = buildDownstreamNodeIds(workspace, lane.sourceTypes);
    return accumulator;
  }, {} as Record<EventLaneId, Set<string>>);
  const known = new Set<string>();
  EVENT_LANE_DEFINITIONS.forEach((lane) => {
    targets[lane.id].forEach((nodeId) => known.add(nodeId));
  });
  targets.other = new Set(workspace.nodes.filter((node) => !known.has(node.id)).map((node) => node.id));
  return targets;
}

function tidyWorkspaceByEventLanes(workspace: WorkspaceFileV2): WorkspaceFileV2 {
  const targets = buildEventLaneTargets(workspace);
  const laneOrder: EventLaneId[] = ['trigger', 'keyboard', 'mouse', 'tick', 'other'];
  const laneByNode = new Map<string, EventLaneId>();
  laneOrder.forEach((lane) => {
    targets[lane].forEach((nodeId) => {
      if (!laneByNode.has(nodeId)) {
        laneByNode.set(nodeId, lane);
      }
    });
  });

  const nodesByLane = laneOrder.reduce((accumulator, lane) => {
    accumulator[lane] = workspace.nodes
      .filter((node) => (laneByNode.get(node.id) ?? 'other') === lane)
      .slice()
      .sort((left, right) => left.position.x - right.position.x || left.position.y - right.position.y);
    return accumulator;
  }, {} as Record<EventLaneId, WorkspaceNodeV2[]>);

  const yBase: Record<EventLaneId, number> = {
    trigger: 80,
    keyboard: 520,
    mouse: 960,
    tick: 1400,
    other: 1840,
  };
  const positionById = new Map<string, WorkspaceNodeV2['position']>();
  laneOrder.forEach((lane) => {
    nodesByLane[lane].forEach((node, index) => {
      positionById.set(node.id, {
        x: 80 + Math.floor(index / 3) * 300,
        y: yBase[lane] + (index % 3) * 132,
      });
    });
  });

  return {
    ...workspace,
    metadata: { ...workspace.metadata, updated_at: Date.now() },
    nodes: workspace.nodes.map((node) => ({
      ...node,
      position: positionById.get(node.id) ?? node.position,
    })),
  };
}

function debugEventForHandler(handler: GraphEventHandler, url: string) {
  switch (handler) {
    case 'keyboard':
      return { kind: 'keyboard' as const, eventType: 'keydown' as const, key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 };
    case 'mouse':
      return { kind: 'mouse' as const, eventType: 'pointerdown' as const, button: 0, buttons: 1, x: 4, y: 4 };
    case 'tick':
      return { kind: 'tick' as const, tick: 1, deltaMs: 120 };
    case 'trigger':
    default:
      return { kind: 'trigger' as const, hotkey: 'Ctrl+Shift+D', url };
  }
}

function groupedRiskReasons(reasons: string[]): Array<{ key: string; summary: string; details: string[] }> {
  const grouped = new Map<string, string[]>();
  const output: Array<{ key: string; summary: string; details: string[] }> = [];

  reasons.forEach((reason) => {
    const match = /^(.+) is (extended|high) risk\.$/.exec(reason);
    if (!match) {
      output.push({ key: reason, summary: reason, details: [] });
      return;
    }

    const [, name, risk] = match;
    const key = `${risk}-ports`;
    grouped.set(key, [...(grouped.get(key) ?? []), name]);
  });

  grouped.forEach((names, key) => {
    const risk = key.startsWith('high') ? 'high' : 'extended';
    const shown = names.slice(0, 6).join(', ');
    const suffix = names.length > 6 ? `, +${names.length - 6} more` : '';
    output.unshift({
      key,
      summary: `${names.length} ${risk}-risk ports: ${shown}${suffix}.`,
      details: names.map((name) => `${name} is ${risk} risk.`),
    });
  });

  return output;
}

interface WorkspaceFlowProps {
  advancedModeEnabled: boolean;
  workspace: WorkspaceFileV2;
  onWorkspaceChange: (workspace: WorkspaceFileV2, options?: WorkspaceChangeOptions) => void;
  invalidEdgeIds: Set<string>;
  heightClassName?: string;
}

function WorkspaceFlow({ advancedModeEnabled, workspace, onWorkspaceChange, invalidEdgeIds, heightClassName = 'h-[720px]' }: WorkspaceFlowProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [regexBuilderNodeId, setRegexBuilderNodeId] = useState<string | null>(null);
  const declaredVariables = useMemo(() => collectDeclaredVariables(workspace), [workspace]);
  const usedVariables = useMemo(() => usedVariableTokens(workspace, declaredVariables), [workspace, declaredVariables]);

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

  const handleCollapseToggle = useCallback(
    (nodeId: string): void => {
      const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        return;
      }

      onWorkspaceChange(updateNodeSettings(workspace, nodeId, { collapsed: !node.settings.collapsed }));
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
            variables: declaredVariables,
            onCollapseToggle: handleCollapseToggle,
            onDeleteNode: handleDeleteNode,
            onLockToggle: handleLockToggle,
            onOpenRegexBuilder: setRegexBuilderNodeId,
            onSettingsChange: handleSettingsChange,
          },
          deletable: definition.flags.canDelete && !node.settings.locked,
          draggable: !node.settings.locked,
        };
      }),
    [workspace, invalidEdgeIds, declaredVariables, handleCollapseToggle, handleDeleteNode, handleLockToggle, handleSettingsChange],
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
  const laneTargets = useMemo(() => buildEventLaneTargets(workspace), [workspace]);
  const collapsedCount = workspace.nodes.filter((node) => node.settings.collapsed).length;

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
    const targetNode = workspace.nodes.find((node) => node.id === nextEdge.target);
    const substitutionMatch = /^value(\d+)$/.exec(nextEdge.targetHandle);
    const nodes = targetNode?.type === 'Substitution' && substitutionMatch
      ? workspace.nodes.map((node) => {
          if (node.id !== targetNode.id) {
            return node;
          }

          const usedIndex = Number.parseInt(substitutionMatch[1], 10);
          const currentCount = Math.max(1, Math.trunc(node.settings.substitutionInputCount ?? 1));
          return {
            ...node,
            settings: {
              ...node.settings,
              substitutionInputCount: Math.max(currentCount, Math.min(24, usedIndex + 1)),
            },
          };
        })
      : workspace.nodes;

    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes,
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

  function setAllBlocksCollapsed(collapsed: boolean): void {
    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: workspace.nodes.map((node) => ({
        ...node,
        settings: {
          ...node.settings,
          collapsed,
        },
      })),
    });
  }

  function focusNodeIds(nodeIds: Set<string>): void {
    if (!flowInstance || nodeIds.size === 0) {
      return;
    }

    void flowInstance.fitView({
      nodes: Array.from(nodeIds).map((id) => ({ id })),
      padding: 0.22,
      duration: 240,
    });
  }

  function tidyEventLanes(): void {
    onWorkspaceChange(tidyWorkspaceByEventLanes(workspace));
  }

  function handleViewportChange(viewport: Viewport): void {
    if (
      Math.abs(workspace.viewport.x - viewport.x) < 0.5 &&
      Math.abs(workspace.viewport.y - viewport.y) < 0.5 &&
      Math.abs(workspace.viewport.zoom - viewport.zoom) < 0.001
    ) {
      return;
    }

    onWorkspaceChange({
      ...workspace,
      viewport,
    }, { viewportOnly: true });
  }

  return (
    <div className={`relative overflow-hidden rounded-lg border border-slate-200 bg-white ${heightClassName}`}>
      <ReactFlow
        key={workspace.metadata.id}
        colorMode="light"
        connectionLineStyle={{ stroke: '#0f766e', strokeWidth: 2 }}
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
        onMoveEnd={(_event, viewport) => handleViewportChange(viewport)}
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
        <Panel className="nodrag nowheel" position="top-left">
          <div className="flex max-w-[min(760px,calc(100vw-56px))] flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white/90 p-2 text-xs shadow-[0_14px_34px_rgba(31,41,55,0.12)] backdrop-blur">
            <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-600">
              {workspace.nodes.length} blocks / {workspace.edges.length} links
            </span>
            <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50" type="button" onClick={() => focusNodeIds(new Set(workspace.nodes.map((node) => node.id)))}>
              Fit
            </button>
            <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50" type="button" onClick={() => setAllBlocksCollapsed(true)}>
              Compact all
            </button>
            <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50" type="button" onClick={() => setAllBlocksCollapsed(false)}>
              Expand all
            </button>
            <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50" type="button" onClick={tidyEventLanes}>
              Tidy lanes
            </button>
            {collapsedCount > 0 ? (
              <span className="rounded-full bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-700">{collapsedCount} compact</span>
            ) : null}
          </div>
        </Panel>
        <Panel className="nodrag nowheel" position="top-right">
          <div className="grid gap-1 rounded-lg border border-slate-200 bg-white/90 p-2 text-xs shadow-[0_14px_34px_rgba(31,41,55,0.12)] backdrop-blur">
            {EVENT_LANE_DEFINITIONS.map((lane) => (
              <button
                key={lane.id}
                className="flex min-w-32 items-center justify-between gap-3 rounded-xl px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
                disabled={laneTargets[lane.id].size === 0}
                type="button"
                onClick={() => focusNodeIds(laneTargets[lane.id])}
              >
                <span>{lane.label}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-500">{laneTargets[lane.id].size}</span>
              </button>
            ))}
            {laneTargets.other.size > 0 ? (
              <button className="flex min-w-32 items-center justify-between gap-3 rounded-xl px-2.5 py-1.5 font-semibold text-slate-700 hover:bg-slate-50" type="button" onClick={() => focusNodeIds(laneTargets.other)}>
                <span>Other</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-500">{laneTargets.other.size}</span>
              </button>
            ) : null}
          </div>
        </Panel>
        {declaredVariables.length > 0 ? (
          <Panel className="nodrag nowheel" position="bottom-right">
            <div className="max-w-72 rounded-lg border border-slate-200 bg-white/92 p-3 text-xs shadow-[0_14px_34px_rgba(31,41,55,0.14)] backdrop-blur">
              <p className="mb-2 font-semibold text-slate-900">Variables</p>
              <div className="flex flex-wrap gap-1.5">
                {declaredVariables.map((variable) => {
                  const used = usedVariables.has(variable.token);
                  return (
                    <button
                      key={`${variable.nodeId}:${variable.token}`}
                      className={`rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold ${used ? 'border-amber-300 bg-amber-50 text-amber-800' : 'border-slate-200 bg-slate-50 text-slate-500'}`}
                      type="button"
                      onClick={() => focusNodeIds(new Set([variable.nodeId]))}
                    >
                      {variable.token}
                    </button>
                  );
                })}
              </div>
            </div>
          </Panel>
        ) : null}
        <Background color="#e2e8f0" gap={22} />
        <Controls showInteractive={false} />
        <MiniMap nodeColor="#0f766e" pannable zoomable />
      </ReactFlow>

      {contextMenu ? (
        <div
          className="absolute z-20 grid max-h-96 w-64 gap-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-[0_20px_60px_rgba(31,41,55,0.22)]"
          style={{ left: contextMenu.x - 24, top: contextMenu.y - 128 }}
        >
          {BLOCK_DEFINITIONS.map((definition) => (
            <button
              key={definition.kind}
              className="rounded-lg px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-teal-50"
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
            <div className="reveal-panel w-full max-w-5xl rounded-xl border border-white/70 bg-white p-5 shadow-[0_32px_90px_rgba(31,41,55,0.26)]">
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

function BlockPicker({ onAddBlock }: { onAddBlock: (kind: BlockKind) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<BlockDefinition['category'] | 'all'>('all');
  const categories = useMemo(
    () => Array.from(new Set(BLOCK_DEFINITIONS.map((definition) => definition.category))).sort(),
    [],
  );
  const matchingBlocks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return BLOCK_DEFINITIONS.filter((definition) => {
      if (category !== 'all' && definition.category !== category) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return (
        definition.label.toLowerCase().includes(normalizedQuery) ||
        definition.kind.toLowerCase().includes(normalizedQuery) ||
        definition.category.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [category, query]);

  return (
    <div className="relative z-20">
      <div className="flex flex-wrap items-center gap-2">
        <button className="secondary-button" type="button" onClick={() => setOpen((current) => !current)}>
          Add Block
        </button>
        <div className="flex flex-wrap gap-1.5">
          {['RegExpression', 'Substitution', 'Logical', 'Math', 'SaveStringToLog', 'Abort', 'SharedState', 'OverlayControl', 'OverlayDraw'].map((kind) => {
            const definition = getBlockDefinition(kind as BlockKind);
            return (
              <button
                key={kind}
                className="ghost-button px-3 py-1.5 text-xs"
                type="button"
                onClick={() => onAddBlock(definition.kind)}
              >
                {definition.label}
              </button>
            );
          })}
        </div>
      </div>
      {open ? (
        <div className="absolute left-0 top-12 z-30 w-[min(760px,calc(100vw-32px))] rounded-lg border border-slate-200 bg-white p-3 shadow-[0_24px_70px_rgba(31,41,55,0.22)]">
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="field-input min-w-64 flex-1 py-2"
                placeholder="Search blocks"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button className="ghost-button px-3 py-2" type="button" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${category === 'all' ? 'border-teal-300 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                type="button"
                onClick={() => setCategory('all')}
              >
                All
              </button>
              {categories.map((entry) => (
                <button
                  key={entry}
                  className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${category === entry ? 'border-teal-300 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                  type="button"
                  onClick={() => setCategory(entry)}
                >
                  {categoryLabel(entry)}
                </button>
              ))}
            </div>
            <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
              {matchingBlocks.map((definition) => (
                <button
                  key={definition.kind}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left transition hover:border-teal-300 hover:bg-teal-50"
                  type="button"
                  onClick={() => {
                    onAddBlock(definition.kind);
                    setOpen(false);
                  }}
                >
                  <span className="block text-sm font-semibold text-slate-900">{definition.label}</span>
                  <span className="mt-1 block text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">{categoryLabel(definition.category)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function WorkspaceEditor({
  advancedModeEnabled,
  allWorkspaces,
  isDirty,
  workspace,
  onWorkspaceChange,
  onNewWorkspace,
  onSwitchWorkspace,
  onBuildActionPack,
  onExportActionPack,
  onExportActionPackVersionFile,
  onExportWorkspace,
  onSaveWorkspace,
}: WorkspaceEditorProps) {
  const [metadataCollapsed, setMetadataCollapsed] = useState(false);
  const [isPopout, setIsPopout] = useState(false);
  const [debugUrl, setDebugUrl] = useState('https://example.com/path?utm_source=newsletter&id=123');
  const [debugSelectedText, setDebugSelectedText] = useState('example selection');
  const [debugPageTitle, setDebugPageTitle] = useState('Example Page Title');
  const [debugClipboard, setDebugClipboard] = useState('clipboard text');
  const [debugHandler, setDebugHandler] = useState<GraphEventHandler>('trigger');
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugOutput, setDebugOutput] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [debugTrace, setDebugTrace] = useState<Array<{ nodeId: string; op: string; message: string; valueType?: string; preview?: string }>>([]);
  const compileResult = useMemo(() => compileWorkspace(workspace), [workspace]);
  const invalidEdgeIds = useMemo(() => new Set(compileResult.validation.invalidEdgeIds), [compileResult.validation.invalidEdgeIds]);
  const riskReasonGroups = useMemo(() => groupedRiskReasons(compileResult.validation.risk.reasons), [compileResult.validation.risk.reasons]);
  const hotkeyError = workspace.trigger.type === 'HOTKEY' ? getHotkeyValidationError(workspace.trigger.hotkey, []) : null;
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

  async function runWorkspaceDebug(): Promise<void> {
    setDebugBusy(true);
    setDebugOutput(null);
    setDebugError(null);
    setDebugTrace([]);

    try {
      const result = compileWorkspace(workspace);
      if (!result.ok || !result.pack) {
        setDebugError(result.validation.errors.join('\n') || 'Workspace did not compile.');
        return;
      }

      const sourceValues: Partial<Record<string, GraphValue>> = {
        selectedText: { type: 'string', value: debugSelectedText },
        pageTitle: { type: 'string', value: debugPageTitle },
        clipboard: { type: 'string', value: debugClipboard },
      };
      const runtime = createSandboxGraphRuntime(
        {
          regex: createPageRegexExecutor(DEFAULT_SETTINGS.hardeningRegexTimeoutMs),
          readClipboard: async () => debugClipboard,
        },
        sourceValues,
      );
      const execution = await executeCompiledActionPackV2(
        debugUrl,
        result.pack,
        runtime,
        DEFAULT_SETTINGS,
        {
          handler: debugHandler,
          event: debugEventForHandler(debugHandler, debugUrl),
        },
      );
      const sideEffects = execution.trace
        .filter((entry) => ['OUTPUT', 'DISPLAY', 'USER_INTERACTION', 'OVERLAY_CONTROL', 'OVERLAY_DRAW', 'SLEEP', 'SAVELOAD', 'SHARED_STATE', 'LOG', 'ABORT'].includes(entry.op))
        .map((entry) => entry.message)
        .filter((message, index, messages) => messages.indexOf(message) === index);

      setDebugOutput([
        `Final URL: ${execution.finalUrl}`,
        `URL changed: ${execution.changed ? 'yes' : 'no'}`,
        `Exit code: ${execution.exitCode}`,
        `Side effects: ${sideEffects.length > 0 ? sideEffects.join('; ') : 'none'}`,
        execution.issues.length > 0 ? `Issues: ${execution.issues.map((entry) => entry.message).join('; ')}` : 'Issues: none',
      ].join('\n'));
      setDebugTrace(execution.trace);
    } catch (error) {
      setDebugError(error instanceof Error ? error.message : 'Debug run failed.');
    } finally {
      setDebugBusy(false);
    }
  }

  useEffect(() => {
    if (!isPopout) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsPopout(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isPopout]);

  const surface = (heightClassName?: string, expanded = false) => (
    <div className={expanded ? 'flex h-full min-h-0 flex-col gap-3' : 'grid gap-4'}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Workspace surface</p>
          <p className="text-xs text-slate-500">{workspace.nodes.length} blocks, {workspace.edges.length} links.</p>
        </div>
        {!expanded ? (
          <button className="ghost-button" title="Expand workspace surface" type="button" onClick={() => setIsPopout(true)}>
            <svg aria-hidden="true" className="mr-2 inline-block h-4 w-4 align-[-2px]" fill="none" viewBox="0 0 24 24">
              <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
            Pop Out
          </button>
        ) : null}
      </div>
      <div className="shrink-0">
        <BlockPicker onAddBlock={addToolbarBlock} />
      </div>
      <ReactFlowProvider>
        <WorkspaceFlow
          advancedModeEnabled={advancedModeEnabled}
          heightClassName={heightClassName}
          invalidEdgeIds={invalidEdgeIds}
          workspace={workspace}
          onWorkspaceChange={onWorkspaceChange}
        />
      </ReactFlowProvider>
    </div>
  );

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Workspace Editor</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Node action builder</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Workspaces can be saved while otherwise invalid. Building a distributable Action Pack is blocked until the graph has at least one terminal effect and every required connection and type check passes.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <select
              className="field-select min-w-72"
              value={allWorkspaces.some((candidate) => candidate.metadata.id === workspace.metadata.id) ? workspace.metadata.id : '__current__'}
              onChange={(event) => {
                if (event.target.value === '__new__') {
                  onNewWorkspace();
                  return;
                }

                if (event.target.value !== '__current__') {
                  onSwitchWorkspace(event.target.value);
                }
              }}
            >
              <option value="__current__">{workspace.metadata.name} (current draft)</option>
              <option value="__new__">New Workspace</option>
              {allWorkspaces.map((savedWorkspace) => (
                <option key={savedWorkspace.metadata.id} value={savedWorkspace.metadata.id}>
                  {savedWorkspace.metadata.name}
                </option>
              ))}
            </select>
            {isDirty ? <span className="risk-badge risk-badge-warn">Unsaved changes</span> : <span className="risk-badge risk-badge-soft">Saved</span>}
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <button className="ghost-button" type="button" onClick={() => setMetadataCollapsed((current) => !current)}>
            {metadataCollapsed ? 'Show Metadata' : 'Hide Metadata'}
          </button>
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
          <button className="ghost-button" disabled={!compileResult.ok} type="button" onClick={onExportActionPackVersionFile}>
            Export Version File
          </button>
        </div>
      </div>

      {!metadataCollapsed ? <div className="mt-6 grid gap-4 lg:grid-cols-4">
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
          <span className="field-label">Run</span>
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
      </div> : (
        <div className="mt-5 rounded-lg border border-slate-200 bg-white/70 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">{workspace.metadata.name}</p>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
              v{workspace.metadata.version} · {formatRunType(workspace.trigger.type)}
            </p>
          </div>
        </div>
      )}

      <div className="mt-5">
        {isPopout ? (
          <div className="rounded-lg border border-slate-200 bg-white/70 px-5 py-6 text-sm text-slate-500">
            Workspace surface is open in the expanded editor.
          </div>
        ) : surface()}
      </div>

      <div className="mt-5 rounded-lg border border-slate-200 bg-white/75 px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Workspace debug run</p>
            <p className="mt-1 text-xs text-slate-500">Runs the current workspace in a sandbox with the source values below and records the VM trace.</p>
          </div>
          <button className="secondary-button" disabled={debugBusy} type="button" onClick={() => void runWorkspaceDebug()}>
            {debugBusy ? 'Running...' : 'Run Debug'}
          </button>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-5">
          <label className="field-shell lg:col-span-2">
            <span className="field-label">Test URL</span>
            <input className="field-input" value={debugUrl} onChange={(event) => setDebugUrl(event.target.value)} />
          </label>
          <label className="field-shell">
            <span className="field-label">Handler</span>
            <select className="field-select" value={debugHandler} onChange={(event) => setDebugHandler(event.target.value as GraphEventHandler)}>
              <option value="trigger">{formatEventHandler('trigger')}</option>
              <option value="keyboard">{formatEventHandler('keyboard')}</option>
              <option value="mouse">{formatEventHandler('mouse')}</option>
              <option value="tick">{formatEventHandler('tick')}</option>
            </select>
          </label>
          <label className="field-shell">
            <span className="field-label">Page Title</span>
            <input className="field-input" value={debugPageTitle} onChange={(event) => setDebugPageTitle(event.target.value)} />
          </label>
          <label className="field-shell">
            <span className="field-label">Clipboard</span>
            <input className="field-input" value={debugClipboard} onChange={(event) => setDebugClipboard(event.target.value)} />
          </label>
          <label className="field-shell lg:col-span-2">
            <span className="field-label">Selected Text</span>
            <input className="field-input" value={debugSelectedText} onChange={(event) => setDebugSelectedText(event.target.value)} />
          </label>
          <label className="field-shell lg:col-span-3">
            <span className="field-label">Result</span>
            <textarea className="field-textarea min-h-24" readOnly value={debugError ?? debugOutput ?? ''} />
          </label>
        </div>
        {debugTrace.length > 0 ? (
          <div className="mt-4 max-h-72 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50/80">
            <ol className="divide-y divide-slate-200 text-xs">
              {debugTrace.map((entry, index) => (
                <li key={`${entry.nodeId}:${index}`} className="grid gap-1 px-4 py-3 md:grid-cols-[12rem_1fr]">
                  <span className="font-mono font-semibold text-slate-600">{entry.op}</span>
                  <span className="text-slate-700">
                    <span className="font-semibold">{entry.message}</span>
                    {entry.preview ? <span className="ml-2 break-all text-slate-500">{entry.preview}</span> : null}
                    <span className="ml-2 font-mono text-slate-400">{entry.nodeId}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className={`rounded-lg border px-5 py-4 ${compileResult.validation.valid ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
          <p className="text-sm font-semibold">{compileResult.validation.valid ? 'Workspace can build.' : 'Build is blocked.'}</p>
          {compileResult.validation.errors.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {compileResult.validation.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p className="font-semibold">
            {compileResult.validation.risk.highest === 'high'
              ? 'Install warning: strong'
              : compileResult.validation.risk.highest === 'extended'
                ? 'Install notice: extended access'
                : 'Install notice: standard'}
          </p>
          {riskReasonGroups.length > 0 ? (
            <div className="mt-2 space-y-2">
              <p>
                {compileResult.validation.risk.highest === 'high'
                  ? 'Users will see a prominent warning and may be discouraged from installing this pack. That warning can be ignored for personal-use packs when you know exactly what the pack does.'
                  : 'Users will be told that this pack touches data outside the safe core and should enable trace after installation.'}
              </p>
              <ul className="list-disc pl-5">
              {riskReasonGroups.map((group) => (
                <li key={group.key}>
                  {group.details.length > 0 ? (
                    <details>
                      <summary className="cursor-pointer font-medium">{group.summary}</summary>
                      <ul className="mt-1 list-disc pl-5 text-xs">
                        {group.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                    </details>
                  ) : group.summary}
                </li>
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
      {isPopout ? createPortal(
        <div className="fixed inset-0 z-40 bg-slate-950/60 p-2 backdrop-blur-sm">
          <div className="flex h-full min-h-0 flex-col rounded-lg border border-white/60 bg-white p-3 shadow-[0_32px_90px_rgba(31,41,55,0.35)]">
            <div className="mb-3 flex shrink-0 flex-wrap items-center justify-between gap-3">
              <div>
                <p className="eyebrow">Workspace Surface</p>
                <h3 className="mt-1 text-xl font-semibold text-slate-900">{workspace.metadata.name}</h3>
              </div>
              <button className="ghost-button" type="button" onClick={() => setIsPopout(false)}>
                <svg aria-hidden="true" className="mr-2 inline-block h-4 w-4 align-[-2px]" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
                </svg>
                Exit
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{surface('min-h-0 flex-1', true)}</div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}
