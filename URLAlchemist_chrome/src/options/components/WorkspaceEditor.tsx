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

import { getHotkeyValidationError } from '../../shared/hotkeys';
import type { Activity } from '../../shared/types';
import { BLOCK_DEFINITIONS, getBlockDefinition, getEffectivePortDefinitions } from '../../shared/v2/blockRegistry';
import { compileWorkspace, getConnectionValidationError } from '../../shared/v2/compiler';
import { createEdge, createWorkspaceNode } from '../../shared/v2/workspace';
import type { BlockDefinition, BlockKind, GraphPortDefinition, WorkspaceBlockSettings, WorkspaceFileV2, WorkspaceNodeV2 } from '../../shared/v2/types';
import { toActivityDraft, updateActivityDraft, type ActivityDraft } from '../drafts';
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
  asset: '#ea580c',
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

const blockInputClass = 'nodrag rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-800 outline-none focus:border-amber-400';
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
  onSettingsChange: (settings: Partial<WorkspaceBlockSettings>) => void,
  onOpenRegexBuilder: (() => void) | undefined,
) {
  const inputClass = blockInputClass;

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
            <button aria-label="Open regex builder" className="nodrag self-end rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-700 hover:border-amber-300 hover:bg-amber-50" type="button" onClick={onOpenRegexBuilder}>
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
            <textarea className={`${inputClass} min-h-14 disabled:bg-slate-100 disabled:text-slate-400`} disabled={payloadConnected} placeholder={payloadConnected ? 'Connected payload input' : 'Replacement text'} value={payloadConnected ? '' : settingText(node.settings.payload)} onChange={(event) => onSettingsChange({ payload: event.target.value })} />
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
          <SettingField help="Used for input A when the A port is not connected." label="Fallback A">
            <input className={inputClass} value={settingText(node.settings.literalValue ?? '0')} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField>
          <SettingField help="Used for input B when the B port is not connected." label="Fallback B">
            <input className={inputClass} value={settingText(node.settings.compareValue ?? '0')} onChange={(event) => onSettingsChange({ compareValue: event.target.value })} />
          </SettingField>
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
          <SettingField help="Initial value used when the value input is not connected." label="Initial value">
            <input className={inputClass} value={settingText(node.settings.literalValue ?? '0')} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField>
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
          <SettingField help="Used when the Key input is not connected. Empty keys are skipped at runtime." label="Fallback key">
            <input className={inputClass} placeholder="session-key" value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField>
        </div>
      );
    case 'DataStructure':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Optional global dictionary to read or update when the Dict input is not connected." label="Global dict name">
            <input className={inputClass} placeholder="notes" value={settingText(node.settings.variableName)} onChange={(event) => onSettingsChange({ variableName: event.target.value })} />
          </SettingField>
          <SettingField help="Used when the Key input is not connected." label="Fallback key">
            <input className={inputClass} placeholder="title" value={settingText(node.settings.dictKey)} onChange={(event) => onSettingsChange({ dictKey: event.target.value })} />
          </SettingField>
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
          <SettingField help="HTTPS-only fallback URL used when the URL input is not connected." label="Remote URL">
            <input className={inputClass} disabled={connectedInputs.has('url')} placeholder="https://example.com/data.json" value={connectedInputs.has('url') ? '' : settingText(node.settings.remoteUrl)} onChange={(event) => onSettingsChange({ remoteUrl: event.target.value })} />
          </SettingField>
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
          <SettingField help="HTTPS-only fallback URL used when the URL input is not connected." label="Remote URL">
            <input className={inputClass} disabled={connectedInputs.has('url')} placeholder="https://example.com/api" value={connectedInputs.has('url') ? '' : settingText(node.settings.remoteUrl)} onChange={(event) => onSettingsChange({ remoteUrl: event.target.value })} />
          </SettingField>
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
          <SettingField help="Text shown to the user in the page overlay prompt." label="Prompt message">
            <input className={inputClass} placeholder="Prompt message" value={settingText(node.settings.promptMessage)} onChange={(event) => onSettingsChange({ promptMessage: event.target.value })} />
          </SettingField>
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
          <SettingField help="Message text used when the Message input is not connected." label="Message">
            <textarea className={`${inputClass} min-h-14`} disabled={connectedInputs.has('message')} placeholder={connectedInputs.has('message') ? 'Connected message input' : 'Message'} value={connectedInputs.has('message') ? '' : settingText(node.settings.promptMessage)} onChange={(event) => onSettingsChange({ promptMessage: event.target.value })} />
          </SettingField>
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
          <SettingField help="Overlay text shown while keyboard or mouse capture is active." label="Overlay message">
            <textarea className={`${inputClass} min-h-14`} disabled={connectedInputs.has('message')} placeholder={connectedInputs.has('message') ? 'Connected message input' : 'Overlay message'} value={connectedInputs.has('message') ? '' : settingText(node.settings.promptMessage)} onChange={(event) => onSettingsChange({ promptMessage: event.target.value })} />
          </SettingField>
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
    case 'Sleep':
      return (
        <div className="mt-3">
          <SettingField help="Delay used when the Duration input is not connected." hint="0-60000 ms" label="Fallback delay">
            <input className={inputClass} min={0} max={60000} type="number" value={node.settings.sleepMs ?? 100} onChange={(event) => onSettingsChange({ sleepMs: Number.parseInt(event.target.value || '0', 10) })} />
          </SettingField>
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
          <SettingField help="Used when the Key input is not connected." label="Fallback key">
            <input className={inputClass} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField>
          <SettingField help="Fallback value for Get, or Set value when the Value input is not connected." label="Fallback value">
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.selectFalseValue)} onChange={(event) => onSettingsChange({ selectFalseValue: event.target.value })} />
          </SettingField>
          <SettingField help="Fallback value type parser." label="Fallback type">
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
          <SettingField help="Used when the Key input is not connected." label="Fallback key">
            <input className={inputClass} value={settingText(node.settings.dictKey)} onChange={(event) => onSettingsChange({ dictKey: event.target.value })} />
          </SettingField>
          <SettingField help="Returned when the key is not present." label="Fallback value">
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
          <SettingField help="JSON fallback list used when the List input is not connected." label="Fallback list">
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.literalValue ?? '[]')} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
          </SettingField>
          <SettingField help="Fallback item literal used when the Item input is not connected." label="Fallback item">
            <input className={inputClass} value={settingText(node.settings.selectTrueValue)} onChange={(event) => onSettingsChange({ selectTrueValue: event.target.value })} />
          </SettingField>
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
          <SettingField help="Used when the True input is not connected." label="True fallback">
            <input className={inputClass} value={settingText(node.settings.selectTrueValue)} onChange={(event) => onSettingsChange({ selectTrueValue: event.target.value })} />
          </SettingField>
          <SettingField help="Used when the False input is not connected." label="False fallback">
            <input className={inputClass} value={settingText(node.settings.selectFalseValue)} onChange={(event) => onSettingsChange({ selectFalseValue: event.target.value })} />
          </SettingField>
        </div>
      );
    case 'RandomNumber':
      return (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <SettingField help="Inclusive fallback lower bound." label="Min">
            <input className={inputClass} type="number" value={node.settings.randomMin ?? 0} onChange={(event) => onSettingsChange({ randomMin: Number.parseInt(event.target.value || '0', 10) })} />
          </SettingField>
          <SettingField help="Inclusive fallback upper bound." label="Max">
            <input className={inputClass} type="number" value={node.settings.randomMax ?? 10} onChange={(event) => onSettingsChange({ randomMax: Number.parseInt(event.target.value || '10', 10) })} />
          </SettingField>
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
          <SettingField help="Text shown in the visible overlay header." label="Overlay text">
            <input className={inputClass} value={settingText(node.settings.overlayText ?? node.settings.promptMessage)} onChange={(event) => onSettingsChange({ overlayText: event.target.value, promptMessage: event.target.value })} />
          </SettingField>
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
          <SettingField help="HTTPS-only fallback asset URL used when the URL input is not connected." label="Asset URL">
            <input className={inputClass} disabled={connectedInputs.has('url')} placeholder={`https://example.com/file.${node.type === 'GetVideo' ? 'mp4' : node.type === 'GetAudio' ? 'mp3' : 'png'}`} value={connectedInputs.has('url') ? '' : settingText(node.settings.assetUrl)} onChange={(event) => onSettingsChange({ assetUrl: event.target.value })} />
          </SettingField>
          <SettingField help="Optional MIME type hint for embedded or fetched media." label="MIME type">
            <input className={inputClass} placeholder={node.type === 'GetVideo' ? 'video/mp4' : node.type === 'GetAudio' ? 'audio/mpeg' : 'image/png'} value={settingText(node.settings.assetMimeType)} onChange={(event) => onSettingsChange({ assetMimeType: event.target.value })} />
          </SettingField>
          <SettingField help="Aborts the media request when this time budget expires." hint="500-30000 ms" label="Timeout (ms)">
            <input className={inputClass} min={500} max={30000} type="number" value={node.settings.remoteTimeoutMs ?? 5000} onChange={(event) => onSettingsChange({ remoteTimeoutMs: Number.parseInt(event.target.value || '5000', 10) })} />
          </SettingField>
          <SettingField help="Stops reading the media response after this many bytes." hint="1024-524288 bytes" label="Max response bytes">
            <input className={inputClass} min={1024} max={524288} type="number" value={node.settings.remoteMaxBytes ?? 524288} onChange={(event) => onSettingsChange({ remoteMaxBytes: Number.parseInt(event.target.value || '524288', 10) })} />
          </SettingField>
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
        <SettingField help="Optional display name for this block. Leaving it empty uses the block type name." label="Block label">
          <input
            className="nodrag w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-semibold text-slate-800 outline-none focus:border-amber-400"
            value={node.settings.label ?? ''}
            placeholder={definition.label}
            onChange={(event) => onSettingsChange(node.id, { label: event.target.value })}
          />
        </SettingField>

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
  onWorkspaceChange: (workspace: WorkspaceFileV2, options?: WorkspaceChangeOptions) => void;
  invalidEdgeIds: Set<string>;
  heightClassName?: string;
}

function WorkspaceFlow({ advancedModeEnabled, workspace, onWorkspaceChange, invalidEdgeIds, heightClassName = 'h-[720px]' }: WorkspaceFlowProps) {
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
    <div className={`relative overflow-hidden rounded-[1.25rem] border border-slate-200 bg-white ${heightClassName}`}>
      <ReactFlow
        key={workspace.metadata.id}
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

  const blockToolbar = (
    <div className="flex flex-wrap gap-2">
      {BLOCK_DEFINITIONS.map((definition) => (
        <button key={definition.kind} className="ghost-button" type="button" onClick={() => addToolbarBlock(definition.kind)}>
          {definition.label}
        </button>
      ))}
    </div>
  );

  const surface = (heightClassName?: string, expanded = false) => (
    <div className={expanded ? 'flex h-full min-h-0 flex-col gap-3' : 'grid gap-4'}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">Workspace surface</p>
          <p className="text-xs text-slate-500">Right-click the canvas or use the block generator to add blocks.</p>
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
      <div className="shrink-0">{blockToolbar}</div>
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
            Workspaces can be saved while otherwise invalid, but at least one Data Out block is required. Building a distributable Action Pack is blocked until every required connection and type check passes.
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
      </div> : (
        <div className="mt-5 rounded-[1.25rem] border border-slate-200 bg-white/70 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">{workspace.metadata.name}</p>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
              v{workspace.metadata.version} · {workspace.trigger.type}
            </p>
          </div>
        </div>
      )}

      <div className="mt-5">
        {isPopout ? (
          <div className="rounded-[1.25rem] border border-slate-200 bg-white/70 px-5 py-6 text-sm text-slate-500">
            Workspace surface is open in the expanded editor.
          </div>
        ) : surface()}
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
      {isPopout ? createPortal(
        <div className="fixed inset-0 z-40 bg-slate-950/60 p-2 backdrop-blur-sm">
          <div className="flex h-full min-h-0 flex-col rounded-[1.25rem] border border-white/60 bg-[rgba(255,252,246,0.98)] p-3 shadow-[0_32px_90px_rgba(15,23,42,0.35)]">
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
