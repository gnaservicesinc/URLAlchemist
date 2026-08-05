import {
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  BaseEdge,
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
  getBezierPath,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
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
import { BLOCK_DEFINITIONS, getBlockDefinition, getEffectivePortDefinition, getEffectivePortDefinitions } from '../../shared/v2/blockRegistry';
import { compileWorkspace, getConnectionValidationError } from '../../shared/v2/compiler';
import { formatEventHandler, formatRunType } from '../../shared/v2/labels';
import { createSandboxGraphRuntime } from '../../shared/v2/sandboxRuntime';
import { createWorkspaceBlockClipboard, pasteWorkspaceBlockClipboard, type WorkspaceBlockClipboard } from '../../shared/v2/workspaceClipboard';
import {
  createDefaultContentBlockerWorkspace,
  createEdge,
  createWorkspaceNode,
  synchronizeCustomBlockIdentity,
  synchronizeCustomBlockInvocationMetadata,
  updateCustomBlockPortMetadata,
  updateWorkspaceNodeSettings,
} from '../../shared/v2/workspace';
import type {
  AssetRef,
  BlockDefinition,
  BlockKind,
  CompiledCustomBlockV2,
  ContentBlockerSurfaceId,
  CustomBlockFieldDefinition,
  CustomBlockPortDefinition,
  GraphDataType,
  GraphEventHandler,
  GraphPortDefinition,
  GraphValue,
  RiskLevel,
  WorkspaceBlockSettings,
  WorkspaceFileV2,
  WorkspaceGraphSurface,
  WorkspaceLogicalFlowGroup,
  WorkspaceNodeV2,
  WorkspaceType,
} from '../../shared/v2/types';
import { CUSTOM_BLOCK_CATEGORY_VALUES, isCustomBlockCategory } from '../../shared/v2/types';
import { extractVariableReferences, normalizeVariableName, validateVariableName, variableDrivenInputHandles } from '../../shared/v2/variables';
import { executeCompiledActionPackV2 } from '../../shared/v2/vm';
import { toActivityDraft, updateActivityDraft, type ActivityDraft } from '../drafts';
import { createPageRegexExecutor } from '../../shared/regex/pageRunner';
import { buildRegexFromBuilder, validateEditorRegexPattern } from '../regexBuilder';
import {
  LOGICAL_FLOW_LAYOUT,
  buildLogicalFlowUnit,
  directLogicalFlowGroupForNode,
  layoutLogicalFlowConnection,
  logicalFlowBranchRegions,
  logicalFlowGroupForMember,
  logicalFlowUnitNodeIds,
  normalizeLogicalFlowGroups,
  type NodeMeasurements,
} from '../workspaceFlowLayout';
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
  resourceAssets: AssetRef[];
  onNewWorkspace: (type?: WorkspaceType) => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onWorkspaceChange: (workspace: WorkspaceFileV2, options?: WorkspaceChangeOptions) => void;
  onUploadResource: (file: File) => Promise<AssetRef>;
  onBuildActionPack: () => void;
  canUndo: boolean;
  customBlocks: CompiledCustomBlockV2[];
  onExportActionPack: () => void;
  onExportWorkspace: () => void;
  onSaveWorkspace: () => void;
  onUndo: () => void;
}

interface WorkspaceBlockData {
  [key: string]: unknown;
  advancedModeEnabled: boolean;
  blockedInputs: string[];
  definition: BlockDefinition;
  connectedInputs: string[];
  inputs: GraphPortDefinition[];
  invalidInputs: string[];
  node: WorkspaceNodeV2;
  outputs: GraphPortDefinition[];
  resourceAssets: AssetRef[];
  variables: DeclaredVariable[];
  onCollapseToggle: (nodeId: string) => void;
  onDeleteNode: (nodeId: string) => void;
  onLockToggle: (nodeId: string) => void;
  onOpenRegexBuilder: (nodeId: string) => void;
  onSettingsChange: (nodeId: string, settings: Partial<WorkspaceBlockSettings>) => void;
  onUploadResource: (file: File) => Promise<AssetRef>;
}

interface DeclaredVariable {
  nodeId: string;
  rawName: string;
  token: string;
  dataType: string;
}

type WorkspaceFlowNode = Node<WorkspaceBlockData, 'workspaceBlock'>;

interface FlowContainerData {
  [key: string]: unknown;
  branch: 'true' | 'false';
  count: number;
  depth: number;
  height: number;
  label: string;
  width: number;
}

type LogicalFlowContainerNode = Node<FlowContainerData, 'logicalFlowContainer'>;
type WorkspaceCanvasNode = WorkspaceFlowNode | LogicalFlowContainerNode;

interface WorkspaceEdgeData extends Record<string, unknown> {
  description: string;
  invalid: boolean;
}

type WorkspaceCanvasEdge = Edge<WorkspaceEdgeData, 'workspaceEdge'>;

const DATA_TYPE_COLORS: Record<string, string> = {
  bool: '#2563eb',
  number: '#0f766e',
  floatingPoint: '#0891b2',
  string: '#b45309',
  URL: '#7c3aed',
  JSON: '#16a34a',
  data: '#64748b',
  list: '#475569',
  dict: '#db2777',
  asset: '#ea580c',
  Any: '#334155',
};

const LOGICAL_FLOW_BRANCH_COLORS = [
  { border: '#0f766e', background: 'rgba(15, 118, 110, 0.06)', text: '#0f766e' },
  { border: '#7c3aed', background: 'rgba(124, 58, 237, 0.06)', text: '#6d28d9' },
];

const CATEGORY_LABELS: Record<BlockDefinition['category'], string> = {
  convert: 'Convert',
  data: 'Data',
  debug: 'Debug',
  'content-blocker': 'Content Blocker',
  flow: 'Flow',
  interaction: 'Interaction',
  logic: 'Logic',
  math: 'Math',
  media: 'Media',
  regex: 'Regex',
  storage: 'Storage',
  custom: 'Custom',
};

const DATA_TYPE_OPTIONS: GraphDataType[] = ['bool', 'number', 'floatingPoint', 'string', 'URL', 'JSON', 'data', 'list', 'dict', 'asset', 'Any'];

const EVENT_LANE_DEFINITIONS = [
  { id: 'trigger', label: 'Trigger', sourceTypes: new Set<BlockKind>(['DataFlowIn', 'ContentDataIn', 'ExtendedDataIn', 'OnTriggerEvent']) },
  { id: 'keyboard', label: 'Keyboard', sourceTypes: new Set<BlockKind>(['KeyboardIn']) },
  { id: 'mouse', label: 'Mouse', sourceTypes: new Set<BlockKind>(['MouseIn']) },
  { id: 'tick', label: 'Tick', sourceTypes: new Set<BlockKind>(['OverlayTickIn']) },
] as const;

type EventLaneId = (typeof EVENT_LANE_DEFINITIONS)[number]['id'] | 'other';

function blockTitle(node: WorkspaceNodeV2, definition = getBlockDefinition(node.type)): string {
  return node.settings.label || definition.label;
}

function definitionForWorkspaceNode(node: WorkspaceNodeV2, availableBlocks: BlockDefinition[]): BlockDefinition {
  if (node.type === 'CustomBlock' && node.settings.customBlockId) {
    return availableBlocks.find((definition) =>
      definition.kind === 'CustomBlock' && definition.custom?.blockId === node.settings.customBlockId,
    ) ?? getBlockDefinition(node.type);
  }
  return getBlockDefinition(node.type);
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

function graphPortFromCustomPort(portDefinition: CustomBlockPortDefinition): GraphPortDefinition {
  return {
    id: portDefinition.id,
    label: portDefinition.label,
    dataType: portDefinition.dataType,
    description: portDefinition.tooltip,
  };
}

export function customBlockDefinition(block: CompiledCustomBlockV2): BlockDefinition {
  const base = getBlockDefinition('CustomBlock');
  return {
    ...base,
    label: block.label,
    category: block.category,
    description: block.description,
    tips: block.tips,
    custom: {
      blockId: block.blockId,
      version: block.version,
      sourceWorkspaceId: block.sourceWorkspaceId,
    },
    visibleWorkspaceTypes: block.visibleWorkspaceTypes,
    inputs: block.inputs.map(graphPortFromCustomPort),
    outputs: block.outputs.map(graphPortFromCustomPort),
    defaultSettings: {
      ...base.defaultSettings,
      label: block.label,
      customBlockId: block.blockId,
      customBlockName: block.label,
      customBlockVersion: block.version,
      customBlockInputs: block.inputs,
      customBlockOutputs: block.outputs,
      customBlockFields: block.fields,
      customFieldValues: Object.fromEntries(block.fields.map((field) => [field.id, field.defaultValue ?? ''])),
    },
  };
}

export function availableBlockDefinitions(workspaceType: WorkspaceType, customBlocks: CompiledCustomBlockV2[], baseDefinitions: BlockDefinition[] = BLOCK_DEFINITIONS): BlockDefinition[] {
  const staticDefinitions = baseDefinitions.filter((definition) => {
    if (definition.kind === 'CustomBlock') {
      return false;
    }
    if (definition.kind === 'CustomBlockInput' || definition.kind === 'CustomBlockOutput') {
      return false;
    }
    if (definition.visibleWorkspaceTypes && !definition.visibleWorkspaceTypes.includes(workspaceType)) {
      return false;
    }
    return true;
  });
  const generatedDefinitions = customBlocks
    .filter((block) => isCustomBlockCategory(block.category) && block.visibleWorkspaceTypes.includes(workspaceType))
    .map(customBlockDefinition);
  return [...staticDefinitions, ...generatedDefinitions];
}

function blockPickerKey(definition: BlockDefinition): string {
  return definition.custom?.blockId ? `${definition.kind}:${definition.custom.blockId}` : definition.kind;
}

export function settingsForDefinition(definition: BlockDefinition): Partial<WorkspaceBlockSettings> {
  if (definition.kind !== 'CustomBlock' || !definition.custom) {
    return definition.defaultSettings;
  }

  return {
    ...definition.defaultSettings,
    customBlockId: definition.custom.blockId,
    customBlockName: definition.label,
    customBlockVersion: definition.custom.version,
    customBlockInputs: definition.inputs.map((portDefinition) => ({
      id: portDefinition.id,
      label: portDefinition.label,
      dataType: portDefinition.dataType,
      tooltip: portDefinition.description,
    })),
    customBlockOutputs: definition.outputs.map((portDefinition) => ({
      id: portDefinition.id,
      label: portDefinition.label,
      dataType: portDefinition.dataType,
      tooltip: portDefinition.description,
    })),
  };
}

export function visibleCustomBlockFields(
  fields: CustomBlockFieldDefinition[],
  advancedModeEnabled: boolean,
): CustomBlockFieldDefinition[] {
  return fields.filter((field) =>
    field.visibility !== 'hidden' && (field.visibility !== 'advanced' || advancedModeEnabled),
  );
}

const BLOCK_SEARCH_TERMS: Partial<Record<BlockKind, string>> = {
  TextTransform: 'clean text trim whitespace clipboard normalize uppercase lowercase url encode decode control characters',
  TextSplitJoin: 'split join lines comma list data to string string to data clipboard',
  UrlQuery: 'query params url parts parse set delete keep sort rebuild campaign links',
  DictOperation: 'dictionary dict keys values merge delete has key object',
  ConditionOut: 'condition conditional run background alarm trigger',
  ContentDataIn: 'content blocker current url page title metadata text seconds on page',
  DecisionOut: 'content blocker allow challenge block decision output 0 1 2',
  ChallengeTimer: 'content blocker challenge timer countdown wait',
  ChallengeTyper: 'content blocker challenge type text repeat',
  ChallengeClicker: 'content blocker challenge click button count',
  ChallengeConfirm: 'content blocker challenge confirm choice',
  ChallengeReason: 'content blocker challenge reason prompt',
  ChallengeComplete: 'content blocker challenge result complete finished',
  ExtendedDataIn: 'clipboard page raw html high risk input',
  ExtendedDataOut: 'clipboard page mutation high risk output',
  Convert: 'data to string string to url json dict number',
  LogicalFlow: 'if else branch flow true false condition run selected side effects',
  CustomBlock: 'custom reusable installed workspace block',
  CustomBlockInput: 'custom block input interface port',
  CustomBlockOutput: 'custom block output interface port',
};

const DEFAULT_QUICK_BLOCK_KINDS: BlockKind[] = ['TextTransform', 'UrlQuery', 'Substitution', 'Logical', 'LogicalFlow', 'SaveStringToLog'];
const CONTENT_BLOCKER_DECISION_BLOCK_KINDS: BlockKind[] = ['ContentDataIn', 'SystemData', 'Constant', 'Logical', 'LogicalFlow', 'Math', 'Convert', 'TextTransform', 'TextSplitJoin', 'UrlQuery', 'RegExpression', 'DataStructure', 'DictGet', 'DictOperation', 'ListOperation', 'AddStringToList', 'CheckListForUrl', 'ConditionSelect', 'RandomNumber', 'SaveLoad', 'SharedState', 'Declarations', 'Substitution', 'DecisionOut', 'SaveStringToLog'];
const CONTENT_BLOCKER_CHALLENGE_TASK_KINDS = new Set<BlockKind>(['ChallengeTimer', 'ChallengeTyper', 'ChallengeClicker', 'ChallengeConfirm', 'ChallengeReason']);
const CONTENT_BLOCKER_CHALLENGE_BLOCK_KINDS: BlockKind[] = ['ChallengeTimer', 'ChallengeTyper', 'ChallengeClicker', 'ChallengeConfirm', 'ChallengeReason', 'ChallengeComplete', 'Constant', 'Logical', 'LogicalFlow', 'Math', 'Convert', 'TextTransform', 'TextSplitJoin', 'UrlQuery', 'DataStructure', 'DictGet', 'DictOperation', 'ListOperation', 'AddStringToList', 'ConditionSelect', 'RandomNumber', 'SaveLoad', 'SharedState', 'Declarations', 'Substitution'];
const CONTENT_BLOCKER_SURFACE_META: Array<{ id: ContentBlockerSurfaceId; label: string; description: string }> = [
  {
    id: 'page-load',
    label: 'Page Load Decision',
    description: 'Runs once for each eligible http(s) page load. Decision Out returns 0 to allow, 1 to challenge, or 2 to block.',
  },
  {
    id: 'recurring',
    label: 'Recurring Check',
    description: 'Runs every configured interval while an allowed page stays open. Leave this surface empty to disable recurring checks.',
  },
  {
    id: 'challenge',
    label: 'Challenge Page',
    description: 'Challenge task blocks run one at a time from left to right, then top to bottom.',
  },
];

function settingText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function variableToken(rawName: string): string {
  return normalizeVariableName(rawName);
}

function isReservedVariableName(rawName: string): boolean {
  return validateVariableName(rawName)?.includes('reserved for substitution') ?? false;
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

function fieldUsesVariable(value: unknown, variables: DeclaredVariable[]): boolean {
  const text = settingText(value);
  if (!text) {
    return false;
  }

  const tokens = new Set(
    extractVariableReferences(text)
      .filter((reference) => reference.kind === 'named')
      .map((reference) => reference.token),
  );
  return variables.some((variable) => {
    return variable.token ? tokens.has(variable.token) : false;
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

function sameStringSet(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

const blockInputClass = 'nodrag block w-full min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-800 outline-none focus:border-teal-500 focus:ring-1 focus:ring-teal-100';
const blockLabelClass = 'nodrag grid gap-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500';

function BoundsText({ children }: { children: string }) {
  return <span className="normal-case tracking-normal text-slate-500">{children}</span>;
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
    <div className={`${blockLabelClass} min-w-0 ${className}`}>
      <SettingLabel help={help}>{label}</SettingLabel>
      {labelledChildren}
      {hint ? <BoundsText>{hint}</BoundsText> : null}
    </div>
  );
}

function portRiskClass(risk: RiskLevel): string {
  if (risk === 'high') {
    return 'risk-badge-danger';
  }

  if (risk === 'extended') {
    return 'risk-badge-warn';
  }

  return 'risk-badge-soft';
}

function PortRiskBadge({ risk }: { risk?: RiskLevel }) {
  if (!risk || risk === 'safe') {
    return null;
  }

  return (
    <span className={`risk-badge ${portRiskClass(risk)} px-1.5 py-0.5 text-[9px] normal-case tracking-normal`}>
      {risk}
    </span>
  );
}

function mediaBlockAssetKind(nodeType: WorkspaceNodeV2['type'], asset?: AssetRef): WorkspaceBlockSettings['assetKind'] {
  if (asset?.kind === 'image' || asset?.kind === 'video' || asset?.kind === 'audio') {
    return asset.kind;
  }
  if (nodeType === 'GetVideo') {
    return 'video';
  }
  if (nodeType === 'GetAudio') {
    return 'audio';
  }
  return 'image';
}

function renderBlockSettings(
  node: WorkspaceNodeV2,
  advancedModeEnabled: boolean,
  connectedInputs: Set<string>,
  blockedInputs: Set<string>,
  variables: DeclaredVariable[],
  resourceAssets: AssetRef[],
  onSettingsChange: (settings: Partial<WorkspaceBlockSettings>) => void,
  onOpenRegexBuilder: (() => void) | undefined,
  onUploadResource: (file: File) => Promise<AssetRef>,
) {
  const inputClass = blockInputClass;
  const isConnected = (portId: string): boolean => connectedInputs.has(portId) && !blockedInputs.has(portId);
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
    case 'Logical': {
      const compareConnected = connectedInputs.has('compare');
      return (
        <div className="mt-3 grid grid-cols-[1fr_0.8fr] gap-2">
          <SettingField help="Comparison operator. Equality compares values by type; lists compare item-by-item." label="Operator">
            <select className={inputClass} value={node.settings.operator ?? 'EQ'} onChange={(event) => onSettingsChange({ operator: event.target.value as WorkspaceBlockSettings['operator'] })}>
              <option value="LT">Less</option>
              <option value="LTE">Less/Equal</option>
              <option value="EQ">Equal</option>
              <option value="NEQ">Not Equal</option>
              <option value="GT">Greater</option>
              <option value="GTE">Greater/Equal</option>
            </select>
          </SettingField>
          {!compareConnected ? <SettingField help="Fallback value used when Compare value is not connected." label="Compare value">
            <input className={inputClass} value={settingText(node.settings.compareValue ?? '1')} onChange={(event) => onSettingsChange({ compareValue: event.target.value })} />
          </SettingField> : connectedNote('Compare value')}
        </div>
      );
    }
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
              <option value="NUMBER_TO_BOOL">Number to Bool</option>
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
              <option value="list">List</option>
              <option value="dict">Dict</option>
              <option value="Any">Any</option>
            </select>
          </SettingField> : null}
          {!isConnected('value') && node.settings.literalDataType === 'list' ? (
            <SettingField help="List entries use one string per line. URL lists drop invalid URLs." label="List kind">
              <select className={inputClass} value={node.settings.literalListType ?? 'string'} onChange={(event) => onSettingsChange({ literalListType: event.target.value as WorkspaceBlockSettings['literalListType'] })}>
                <option value="string">String List</option>
                <option value="URL">URL List</option>
              </select>
            </SettingField>
          ) : null}
          {!isConnected('value') ? <SettingField help={node.settings.literalDataType === 'list' ? 'One string per line.' : 'Initial value used when the value input is not connected.'} label={node.settings.literalDataType === 'list' ? 'List entries' : 'Initial value'}>
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
              <option value="list">List</option>
              <option value="dict">Dict</option>
              <option value="Any">Any</option>
            </select>
          </SettingField>
          {node.settings.literalDataType === 'list' ? (
            <SettingField help="List entries use one string per line. URL lists drop invalid URLs." label="List kind">
              <select className={inputClass} value={node.settings.literalListType ?? 'string'} onChange={(event) => onSettingsChange({ literalListType: event.target.value as WorkspaceBlockSettings['literalListType'] })}>
                <option value="string">String List</option>
                <option value="URL">URL List</option>
              </select>
            </SettingField>
          ) : null}
          <SettingField help={node.settings.literalDataType === 'list' ? 'One string per line.' : 'Literal value. Data, Dict, and Any can parse JSON.'} label={node.settings.literalDataType === 'list' ? 'List entries' : 'Literal'}>
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
    case 'TextTransform':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Transforms text without regex. Useful before clipboard output, logs, and prompts." label="Mode">
            <select className={inputClass} value={node.settings.textTransformMode ?? 'TRIM'} onChange={(event) => onSettingsChange({ textTransformMode: event.target.value as WorkspaceBlockSettings['textTransformMode'] })}>
              <option value="TRIM">Trim edges</option>
              <option value="COLLAPSE_WHITESPACE">Collapse whitespace</option>
              <option value="NORMALIZE_LINE_ENDINGS">Normalize line endings</option>
              <option value="STRIP_CONTROL_CHARS">Strip control characters</option>
              <option value="UPPERCASE">Uppercase</option>
              <option value="LOWERCASE">Lowercase</option>
              <option value="TITLE_CASE">Title case</option>
              <option value="URL_ENCODE">URL encode</option>
              <option value="URL_DECODE">URL decode</option>
            </select>
          </SettingField>
        </div>
      );
    case 'TextSplitJoin':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Splits text into data lists or joins data lists back into text." label="Mode">
            <select className={inputClass} value={node.settings.splitJoinMode ?? 'SPLIT_LINES'} onChange={(event) => onSettingsChange({ splitJoinMode: event.target.value as WorkspaceBlockSettings['splitJoinMode'] })}>
              <option value="SPLIT_LINES">Split lines</option>
              <option value="SPLIT_WHITESPACE">Split whitespace</option>
              <option value="SPLIT_COMMA">Split comma</option>
              <option value="SPLIT_CUSTOM">Split custom</option>
              <option value="JOIN_LINES">Join lines</option>
              <option value="JOIN_SPACE">Join spaces</option>
              <option value="JOIN_COMMA">Join comma</option>
              <option value="JOIN_CUSTOM">Join custom</option>
            </select>
          </SettingField>
          {['SPLIT_CUSTOM', 'JOIN_CUSTOM'].includes(node.settings.splitJoinMode ?? '') ? (
            <SettingField help="Custom separator used by custom split or join modes." label="Separator">
              <input className={variableAwareClass(node.settings.splitJoinSeparator, variables, inputClass)} value={settingText(node.settings.splitJoinSeparator ?? ',')} onChange={(event) => onSettingsChange({ splitJoinSeparator: event.target.value })} />
            </SettingField>
          ) : null}
        </div>
      );
    case 'UrlQuery':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Parses or updates query parameters without requiring regex." label="Mode">
            <select className={inputClass} value={node.settings.urlQueryMode ?? 'PARSE'} onChange={(event) => onSettingsChange({ urlQueryMode: event.target.value as WorkspaceBlockSettings['urlQueryMode'] })}>
              <option value="PARSE">Parse URL parts</option>
              <option value="GET_PARAM">Get parameter</option>
              <option value="SET_PARAM">Set parameter</option>
              <option value="DELETE_PARAM">Delete parameter</option>
              <option value="KEEP_PARAMS">Keep only parameters</option>
              <option value="SORT_PARAMS">Sort parameters</option>
              <option value="REBUILD">Rebuild URL</option>
            </select>
          </SettingField>
          {['GET_PARAM', 'SET_PARAM', 'DELETE_PARAM'].includes(node.settings.urlQueryMode ?? '') ? (
            !isConnected('key') ? (
              <SettingField help="Parameter name used when Key is not connected." label="Key">
                <input className={variableAwareClass(node.settings.urlQueryKey, variables, inputClass)} value={settingText(node.settings.urlQueryKey)} onChange={(event) => onSettingsChange({ urlQueryKey: event.target.value })} />
              </SettingField>
            ) : connectedNote('Key')
          ) : null}
          {node.settings.urlQueryMode === 'SET_PARAM' ? (
            !isConnected('value') ? (
              <SettingField help="Parameter value used when Value is not connected." label="Value">
                <input className={variableAwareClass(node.settings.urlQueryValue, variables, inputClass)} value={settingText(node.settings.urlQueryValue)} onChange={(event) => onSettingsChange({ urlQueryValue: event.target.value })} />
              </SettingField>
            ) : connectedNote('Value')
          ) : null}
          {node.settings.urlQueryMode === 'KEEP_PARAMS' ? (
            <SettingField help="Comma or space separated parameter names to keep." label="Keep parameters">
              <input className={variableAwareClass(node.settings.urlQueryParams, variables, inputClass)} placeholder="id slug page" value={settingText(node.settings.urlQueryParams)} onChange={(event) => onSettingsChange({ urlQueryParams: event.target.value })} />
            </SettingField>
          ) : null}
        </div>
      );
    case 'DictOperation':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Utility operations for dictionary data." label="Mode">
            <select className={inputClass} value={node.settings.dictOperationMode ?? 'KEYS'} onChange={(event) => onSettingsChange({ dictOperationMode: event.target.value as WorkspaceBlockSettings['dictOperationMode'] })}>
              <option value="KEYS">List keys</option>
              <option value="VALUES">List values</option>
              <option value="HAS_KEY">Has key</option>
              <option value="DELETE_KEY">Delete key</option>
              <option value="MERGE">Merge dictionaries</option>
            </select>
          </SettingField>
          {['HAS_KEY', 'DELETE_KEY'].includes(node.settings.dictOperationMode ?? '') ? (
            !isConnected('key') ? (
              <SettingField help="Dictionary key used when Key is not connected." label="Key">
                <input className={variableAwareClass(node.settings.dictKey, variables, inputClass)} value={settingText(node.settings.dictKey)} onChange={(event) => onSettingsChange({ dictKey: event.target.value })} />
              </SettingField>
            ) : connectedNote('Key')
          ) : null}
        </div>
      );
    case 'DecisionOut':
      return (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
          Output 0 to allow, 1 to show the challenge page, or 2 to block the page.
        </p>
      );
    case 'ContentDataIn':
      return (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
          Reads the current page context for Content Blocker decision surfaces.
        </p>
      );
    case 'ChallengeTimer':
      return (
        <div className="mt-3">
          {!isConnected('seconds') ? <SettingField help="Countdown time before this challenge task is complete." hint="1-3600 seconds" label="Seconds">
            <input className={inputClass} min={1} max={3600} type="number" value={node.settings.challengeSeconds ?? 30} onChange={(event) => onSettingsChange({ challengeSeconds: Math.max(1, Number.parseInt(event.target.value || '30', 10)) })} />
          </SettingField> : connectedNote('Seconds')}
        </div>
      );
    case 'ChallengeTyper':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('text') ? <SettingField help="Text the user must type exactly." label="Text">
            <input className={inputClass} value={settingText(node.settings.challengeText ?? 'I want to continue')} onChange={(event) => onSettingsChange({ challengeText: event.target.value })} />
          </SettingField> : connectedNote('Text')}
          {!isConnected('count') ? <SettingField help="Number of times the exact text must be typed on separate lines." hint="1-25" label="Times">
            <input className={inputClass} min={1} max={25} type="number" value={node.settings.challengeCount ?? 1} onChange={(event) => onSettingsChange({ challengeCount: Math.max(1, Number.parseInt(event.target.value || '1', 10)) })} />
          </SettingField> : connectedNote('Times')}
        </div>
      );
    case 'ChallengeClicker':
      return (
        <div className="mt-3">
          {!isConnected('count') ? <SettingField help="Number of button clicks required." hint="1-1000" label="Clicks">
            <input className={inputClass} min={1} max={1000} type="number" value={node.settings.challengeCount ?? 10} onChange={(event) => onSettingsChange({ challengeCount: Math.max(1, Number.parseInt(event.target.value || '10', 10)) })} />
          </SettingField> : connectedNote('Clicks')}
        </div>
      );
    case 'ChallengeConfirm':
    case 'ChallengeReason':
      return (
        <div className="mt-3">
          {!isConnected('text') ? <SettingField help={node.type === 'ChallengeReason' ? 'Prompt shown above the reason text area.' : 'Text shown above the confirmation button.'} label={node.type === 'ChallengeReason' ? 'Prompt' : 'Message'}>
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.challengeText ?? (node.type === 'ChallengeReason' ? 'Why do you want to continue?' : 'Confirm that you want to continue.'))} onChange={(event) => onSettingsChange({ challengeText: event.target.value })} />
          </SettingField> : connectedNote('Text')}
        </div>
      );
    case 'ChallengeComplete':
      return (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
          Connect the final task or success branch to Finished. The challenge page grants Continue only after the ordered task list is complete.
        </div>
      );
    case 'ConditionOut':
      return (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
          Use this terminal block in a conditional Run check. When Condition is true, the selected Action Pack can run from the background alarm.
        </p>
      );
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
    case 'AddStringToList':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('list') ? <SettingField help="Optional variable to read and update when the List input is not connected." label="List variable">
            <input className={inputClass} placeholder="blockedUrls" value={settingText(node.settings.listVariableName)} onChange={(event) => onSettingsChange({ listVariableName: event.target.value })} />
          </SettingField> : connectedNote('List')}
          {!isConnected('list') ? <SettingField help="Fallback list, one string per line." label="Starting list">
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value, literalDataType: 'list' })} />
          </SettingField> : null}
          {!isConnected('item') ? <SettingField help="String appended when the String input is not connected." label="String">
            <input className={inputClass} value={settingText(node.settings.selectTrueValue)} onChange={(event) => onSettingsChange({ selectTrueValue: event.target.value })} />
          </SettingField> : connectedNote('String')}
        </div>
      );
    case 'ConditionSelect':
      return (
        <div className="mt-3 grid gap-2">
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] leading-5 text-amber-800">
            Condition Select chooses between values. It does not control which downstream side-effect blocks run. Use Logical Flow for if/else branch execution.
          </p>
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
    case 'LogicalFlow':
      return (
        <div className="mt-3 grid gap-2">
          {!isConnected('input') ? (
            <SettingField help="Fallback value passed into the selected branch when Input is not connected." label="Fallback input">
              <input className={inputClass} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value })} />
            </SettingField>
          ) : connectedNote('Input')}
          <SettingField help="Parser for the fallback input value." label="Fallback type">
            <select className={inputClass} value={node.settings.literalDataType ?? 'Any'} onChange={(event) => onSettingsChange({ literalDataType: event.target.value as WorkspaceBlockSettings['literalDataType'] })}>
              {DATA_TYPE_OPTIONS.filter((type) => type !== 'asset').map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </SettingField>
        </div>
      );
    case 'CheckListForUrl':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Decision emitted when the URL is found in the list." label="When found">
            <select className={inputClass} value={node.settings.contentBlockerMatchDecision ?? 2} onChange={(event) => onSettingsChange({ contentBlockerMatchDecision: Number.parseInt(event.target.value, 10) as WorkspaceBlockSettings['contentBlockerMatchDecision'] })}>
              <option value={1}>Challenge (1)</option>
              <option value={2}>Block (2)</option>
            </select>
          </SettingField>
          {!isConnected('url') ? <SettingField help="Fallback URL checked when the URL input is not connected." label="URL">
            <input className={inputClass} placeholder="https://example.com/" value={settingText(node.settings.urlQueryValue)} onChange={(event) => onSettingsChange({ urlQueryValue: event.target.value })} />
          </SettingField> : connectedNote('URL')}
          {!isConnected('list') ? <SettingField help="Fallback URL list, one URL per line. Invalid URLs are ignored." label="URL list">
            <textarea className={`${inputClass} min-h-14`} value={settingText(node.settings.literalValue)} onChange={(event) => onSettingsChange({ literalValue: event.target.value, literalDataType: 'list', literalListType: 'URL' })} />
          </SettingField> : connectedNote('List')}
        </div>
      );
    case 'CustomBlock':
      return (
        <div className="mt-3 grid gap-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] leading-5 text-slate-600">
            <span className="font-semibold text-slate-800">Custom</span>
            {node.settings.customBlockName ? ` · ${node.settings.customBlockName}` : ''}
            {node.settings.customBlockVersion ? ` v${node.settings.customBlockVersion}` : ''}
          </div>
          {visibleCustomBlockFields(node.settings.customBlockFields ?? [], advancedModeEnabled).map((field) => (
            <SettingField key={field.id} help={field.tooltip} label={field.label}>
              <input
                className={inputClass}
                value={settingText(node.settings.customFieldValues?.[field.id] ?? field.defaultValue)}
                onChange={(event) => onSettingsChange({
                  customFieldValues: {
                    ...(node.settings.customFieldValues ?? {}),
                    [field.id]: event.target.value,
                  },
                })}
              />
            </SettingField>
          ))}
        </div>
      );
    case 'CustomBlockInput':
    case 'CustomBlockOutput':
      return (
        <div className="mt-3 grid gap-2">
          <SettingField help="Stable interface port id used by Custom Block callers." label="Port id">
            <input className={inputClass} value={settingText(node.settings.customPortId)} onChange={(event) => onSettingsChange({ customPortId: event.target.value })} />
          </SettingField>
          <SettingField help="User-facing interface port label." label="Port label">
            <input className={inputClass} value={settingText(node.settings.customPortLabel)} onChange={(event) => onSettingsChange({ customPortLabel: event.target.value })} />
          </SettingField>
          <SettingField help="The value type for this Custom Block interface port." label="Port type">
            <select className={inputClass} value={node.settings.customPortDataType ?? 'Any'} onChange={(event) => onSettingsChange({ customPortDataType: event.target.value as GraphDataType })}>
              {DATA_TYPE_OPTIONS.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </SettingField>
          <SettingField help="Help text shown for this port wherever the Custom Block is used." label="Tooltip">
            <input className={inputClass} value={settingText(node.settings.customPortTooltip)} onChange={(event) => onSettingsChange({ customPortTooltip: event.target.value })} />
          </SettingField>
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
    case 'GetAudio': {
      const selectedResourceId = node.settings.assetResourceId;
      const selectedResource = resourceAssets.find((asset) => (asset.resourceId ?? asset.sha256) === selectedResourceId);
      const accept = node.type === 'GetVideo' ? 'video/*' : node.type === 'GetAudio' ? 'audio/*' : 'image/*';
      return (
        <div className="mt-3 grid gap-2">
          {resourceAssets.length > 0 ? (
            <SettingField help="Local resources are stored once in IndexedDB and bundled only when exporting a workspace or Action Pack." label="Local resource">
              <select
                className={inputClass}
                value={selectedResourceId ?? ''}
                onChange={(event) => {
                  const resourceId = event.target.value;
                  const asset = resourceAssets.find((candidate) => (candidate.resourceId ?? candidate.sha256) === resourceId);
	                  onSettingsChange(resourceId && asset ? {
	                    assetResourceId: resourceId,
	                    assetMimeType: asset.mimeType,
	                    assetName: asset.name,
	                    assetKind: mediaBlockAssetKind(node.type, asset),
	                    assetUrl: '',
                  } : {
                    assetResourceId: undefined,
                  });
                }}
              >
                <option value="">Remote URL</option>
                {resourceAssets
                  .filter((asset) => asset.kind === 'unknown' || asset.kind === (node.type === 'GetVideo' ? 'video' : node.type === 'GetAudio' ? 'audio' : 'image'))
                  .map((asset) => {
                    const id = asset.resourceId ?? asset.sha256 ?? asset.name ?? '';
                    return (
                      <option key={id} value={id}>
                        {asset.name ?? id.slice(0, 12)}{asset.sizeBytes ? ` (${Math.round(asset.sizeBytes / 1024)} KB)` : ''}
                      </option>
                    );
                  })}
              </select>
            </SettingField>
          ) : null}
          {selectedResource ? (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-800">
              {selectedResource.name ?? 'Local resource'} is referenced by SHA-256 and will be bundled on export.
            </div>
          ) : null}
          <SettingField help="Stores this file once locally and references it from the block. Resources are not synced." label="Upload resource">
            <input
              className={inputClass}
              type="file"
              accept={accept}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void onUploadResource(file).then((asset) => {
                    const resourceId = asset.resourceId ?? asset.sha256;
                    if (!resourceId) {
                      return;
                    }
	                    onSettingsChange({
	                      assetResourceId: resourceId,
	                      assetMimeType: asset.mimeType,
	                      assetName: asset.name,
	                      assetKind: mediaBlockAssetKind(node.type, asset),
	                      assetUrl: '',
                    });
                  });
                }
                event.currentTarget.value = '';
              }}
            />
          </SettingField>
          {!isConnected('url') ? (
            <SettingField help="HTTPS-only media URL used when the URL input is not connected." label="Media URL">
              <input className={inputClass} disabled={Boolean(selectedResourceId)} placeholder={`https://example.com/file.${node.type === 'GetVideo' ? 'mp4' : node.type === 'GetAudio' ? 'mp3' : 'png'}`} value={settingText(node.settings.assetUrl)} onChange={(event) => onSettingsChange({ assetUrl: event.target.value, assetResourceId: undefined })} />
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
    }
    default:
      return null;
  }
}

const WorkspaceBlockNode = memo(function WorkspaceBlockNode({ data, selected }: NodeProps<WorkspaceFlowNode>) {
  const { advancedModeEnabled, blockedInputs, connectedInputs, definition, inputs, invalidInputs, node, outputs, resourceAssets, variables, onCollapseToggle, onDeleteNode, onLockToggle, onOpenRegexBuilder, onSettingsChange, onUploadResource } = data;
  const locked = Boolean(node.settings.locked);
  const collapsed = Boolean(node.settings.collapsed);
  const title = blockTitle(node, definition);

  const compactPortRows = (ports: GraphPortDefinition[], direction: 'input' | 'output') => (
    <div className="grid gap-1">
      {ports.length === 0 ? (
        <div className="rounded-md border border-dashed border-slate-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-300">
          No {direction === 'input' ? 'inputs' : 'outputs'}
        </div>
      ) : ports.map((port) => (
        <div key={port.id} className={`relative flex min-h-6 items-center rounded-md bg-slate-50 px-2 py-1 text-[10px] text-slate-600 ${direction === 'input' ? 'pl-3' : 'pr-3'}`}>
          {direction === 'input' ? (
            <Handle
              aria-label={`${port.label} ${direction === 'input' ? 'input' : 'output'} port`}
              className={`workspace-port-handle workspace-port-handle-target workspace-port-handle-compact ${blockedInputs.includes(port.id) ? 'opacity-35' : ''}`}
              id={port.id}
              isConnectable={!blockedInputs.includes(port.id)}
              position={Position.Left}
              style={handleStyle(invalidInputs.includes(port.id) ? '#dc2626' : DATA_TYPE_COLORS[port.dataType])}
              type="target"
            />
          ) : null}
          <span className="truncate">{port.label}</span>
          <PortRiskBadge risk={port.risk} />
          <span className={`${direction === 'input' ? 'ml-auto' : 'ml-1 mr-auto'} font-mono text-[10px] text-slate-500`}>{shortDataType(port.dataType)}</span>
          {direction === 'output' ? (
            <Handle
              aria-label={`${port.label} output port`}
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
    <div className={`workspace-block-node ${collapsed ? 'w-[216px]' : 'w-[272px]'} rounded-lg border bg-white shadow-[0_6px_18px_rgba(31,41,55,0.09)] transition-[border-color,box-shadow] duration-150 ${selected ? 'border-teal-600 shadow-[0_8px_24px_rgba(15,118,110,0.16)] ring-2 ring-teal-100' : 'border-slate-200'}`}>
      <div className="workspace-block-header flex items-start justify-between gap-2 border-b border-slate-100 px-3 py-2">
        <span className="workspace-block-grip mt-0.5 shrink-0 cursor-grab rounded px-1 py-0.5 text-[8px] font-bold uppercase tracking-[0.08em] text-slate-400" title="Drag block">
          Drag
        </span>
        <div className="min-w-0 flex-1">
          <input
            aria-label={`Rename ${definition.label} block`}
            className="nodrag block w-full min-w-0 truncate rounded-sm bg-transparent text-[13px] font-semibold text-slate-900 outline-none placeholder:text-slate-900 focus:bg-teal-50 focus:px-1 focus:ring-1 focus:ring-teal-200"
            placeholder={definition.label}
            title="Rename block"
            value={node.settings.label ?? ''}
            onChange={(event) => onSettingsChange(node.id, { label: event.target.value })}
          />
          {collapsed ? (
            <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-slate-500">
              {definition.category !== 'custom' ? <span>{categoryLabel(definition.category)}</span> : null}
              <span>{inputs.length} in</span>
              <span>{outputs.length} out</span>
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`}
            className="nodrag flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-[11px] font-bold text-slate-500 transition hover:border-teal-300 hover:bg-teal-50 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-200"
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
            aria-label={`${locked ? 'Unlock' : 'Lock'} ${title}`}
            aria-pressed={locked}
            className={`nodrag inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[9px] font-bold uppercase tracking-[0.1em] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-200 ${locked ? 'bg-slate-100 text-slate-600 hover:bg-slate-200' : 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}
            title={locked ? 'Unlock block' : 'Lock block'}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onLockToggle(node.id);
            }}
          >
            <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${locked ? 'bg-slate-400' : 'bg-emerald-500'}`} />
            {locked ? 'Locked' : 'Free'}
          </button>
          <button
            aria-label={`Delete ${node.settings.label || definition.label}`}
            className="nodrag flex h-6 w-6 items-center justify-center rounded-md border border-slate-200 bg-white text-[11px] font-bold text-slate-500 transition hover:border-rose-300 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-200 disabled:cursor-not-allowed disabled:opacity-35"
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
        <div className="grid grid-cols-2 gap-1.5 px-2.5 py-2.5">
          {compactPortRows(inputs, 'input')}
          {compactPortRows(outputs, 'output')}
        </div>
      ) : (
      <div className="workspace-block-body px-3 py-2">
        {renderBlockSettings(
          node,
          advancedModeEnabled,
          new Set(connectedInputs),
          new Set(blockedInputs),
          data.variables,
          resourceAssets,
          (settings) => onSettingsChange(node.id, settings),
          node.type === 'RegExpression' ? () => onOpenRegexBuilder(node.id) : undefined,
          onUploadResource,
        )}

        <div className="mt-2 grid gap-1">
          {inputs.map((input) => (
            <div key={input.id} className="relative flex min-h-6 items-center rounded-md bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
              <Handle
                aria-label={`${input.label} input port`}
                className={`workspace-port-handle workspace-port-handle-target ${blockedInputs.includes(input.id) ? 'opacity-35' : ''}`}
                id={input.id}
                isConnectable={!blockedInputs.includes(input.id)}
                position={Position.Left}
                style={handleStyle(invalidInputs.includes(input.id) ? '#dc2626' : DATA_TYPE_COLORS[input.dataType])}
                type="target"
              />
              <span className="ml-2 flex items-center gap-1.5">
                {input.label}
                {input.description ? <HelpTooltip label={`${input.label} input`} text={input.description} /> : null}
                <PortRiskBadge risk={input.risk} />
              </span>
              <span className="ml-auto font-mono text-[10px]">{input.dataType}</span>
            </div>
          ))}
          {outputs.map((output) => (
            <div key={output.id} className="relative flex min-h-6 items-center rounded-md bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
              <span className="flex items-center gap-1.5">
                {output.label}
                {output.description ? <HelpTooltip label={`${output.label} output`} text={output.description} /> : null}
                <PortRiskBadge risk={output.risk} />
              </span>
              <span className="ml-auto mr-2 font-mono text-[10px]">{output.dataType}</span>
              <Handle
                aria-label={`${output.label} output port`}
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

const LogicalFlowContainerNode = memo(function LogicalFlowContainerNode({ data }: NodeProps<LogicalFlowContainerNode>) {
  const branchName = data.branch === 'true' ? 'True' : 'False';

  return (
    <div
      aria-label={`${branchName} branch, ${data.count} connected ${data.count === 1 ? 'block' : 'blocks'}`}
      className={`workspace-branch-region rounded-xl border px-4 py-3 text-xs font-semibold ${data.count === 0 ? 'workspace-branch-region-empty border-dashed' : ''}`}
      role="group"
      style={{ height: data.height, width: data.width }}
    >
      <div className="flex items-center justify-between gap-3">
        <span>{data.label}</span>
        <span className="rounded-full bg-white/80 px-2 py-0.5 font-mono text-[10px] shadow-sm">
          {data.count} {data.count === 1 ? 'block' : 'blocks'}
        </span>
      </div>
      {data.count === 0 ? (
        <div className="mt-4 flex min-h-14 flex-col items-center justify-center rounded-lg border border-dashed border-current bg-white/35 px-4 text-center">
          <span className="text-[11px] font-semibold">Connect from {branchName} to start this branch</span>
          <span className="mt-1 text-[10px] font-medium opacity-70">Connected blocks are grouped automatically.</span>
        </div>
      ) : null}
    </div>
  );
});

const WorkspaceEdge = memo(function WorkspaceEdge({
  data,
  id,
  markerEnd,
  selected,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<WorkspaceCanvasEdge>) {
  const [edgePath] = getBezierPath({
    curvature: 0.32,
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY,
  });

  return (
    <g className={`workspace-edge ${selected ? 'is-selected' : ''} ${data?.invalid ? 'is-invalid' : ''}`}>
      <title>{data?.description ?? 'Workspace connection'}</title>
      <path aria-hidden="true" className="workspace-edge-underlay" d={edgePath} />
      <BaseEdge
        className="workspace-edge-foreground"
        id={id}
        interactionWidth={24}
        markerEnd={markerEnd}
        path={edgePath}
        style={style}
      />
    </g>
  );
});

const nodeTypes = {
  workspaceBlock: WorkspaceBlockNode,
  logicalFlowContainer: LogicalFlowContainerNode,
};

const edgeTypes = {
  workspaceEdge: WorkspaceEdge,
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

function isLogicalFlowConditionEdge(workspace: WorkspaceFileV2, edge: { target: string; targetHandle: string | null | undefined }): boolean {
  return edge.targetHandle === 'condition' && (workspace.logicalFlows ?? []).some((group) => group.controlNodeId === edge.target);
}

function expandLogicalFlowDeletion(workspace: WorkspaceFileV2, requestedNodeIds: Set<string>): Set<string> {
  const expanded = new Set(requestedNodeIds);
  requestedNodeIds.forEach((nodeId) => {
    const group = directLogicalFlowGroupForNode(workspace, nodeId);
    if (!group) {
      return;
    }
    logicalFlowUnitNodeIds(workspace, group).forEach((id) => expanded.add(id));
  });
  return expanded;
}

function pruneLogicalFlowGroups(workspace: WorkspaceFileV2, removedIds: Set<string>): WorkspaceLogicalFlowGroup[] | undefined {
  const groups = (workspace.logicalFlows ?? []).filter((group) => !removedIds.has(group.conditionNodeId) && !removedIds.has(group.controlNodeId));
  return groups.length > 0 ? groups : undefined;
}

function createLogicalFlowContainerNodes(workspace: WorkspaceFileV2, measurements: NodeMeasurements): LogicalFlowContainerNode[] {
  return logicalFlowBranchRegions(workspace, measurements).map((region) => {
      const paletteIndex = region.branch === 'true' ? 0 : 1;
      const color = LOGICAL_FLOW_BRANCH_COLORS[paletteIndex];

      return {
        id: region.id,
        type: 'logicalFlowContainer',
        position: { x: region.x, y: region.y },
        initialHeight: region.height,
        initialWidth: region.width,
        selectable: false,
        draggable: false,
        focusable: false,
        zIndex: 0,
        data: {
          branch: region.branch,
          count: region.nodeIds.size,
          depth: region.depth,
          height: region.height,
          label: region.branch === 'true' ? 'True branch' : 'False branch',
          width: region.width,
        },
        style: {
          borderColor: color.border,
          backgroundColor: color.background,
          color: color.text,
          height: region.height,
          pointerEvents: 'none',
          width: region.width,
        },
      } satisfies LogicalFlowContainerNode;
  });
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

function nodeIdsForValidationMessage(workspace: WorkspaceFileV2, message: string): string[] {
  const normalized = message.toLowerCase();
  return workspace.nodes
    .filter((node) => {
      const title = blockTitle(node).toLowerCase();
      const definition = getBlockDefinition(node.type).label.toLowerCase();
      return normalized.includes(title) || normalized.includes(definition);
    })
    .map((node) => node.id);
}

interface ConnectionQuickFix {
  edgeId: string;
  label: string;
  nodeKind: BlockKind;
  settings: Partial<WorkspaceBlockSettings>;
}

function connectionQuickFix(workspace: WorkspaceFileV2, edgeId: string): ConnectionQuickFix | null {
  const edge = workspace.edges.find((candidate) => candidate.id === edgeId);
  if (!edge) {
    return null;
  }

  const sourceNode = workspace.nodes.find((node) => node.id === edge.source);
  const targetNode = workspace.nodes.find((node) => node.id === edge.target);
  const sourcePort = sourceNode ? getEffectivePortDefinition(sourceNode, 'output', edge.sourceHandle) : null;
  const targetPort = targetNode ? getEffectivePortDefinition(targetNode, 'input', edge.targetHandle) : null;
  if (!sourceNode || !targetNode || !sourcePort || !targetPort) {
    return null;
  }

  if (targetPort.dataType === 'string') {
    return {
      edgeId,
      label: `Insert Text Transform before ${targetPort.label}`,
      nodeKind: 'TextTransform',
      settings: { textTransformMode: 'TRIM' },
    };
  }

  if (targetPort.dataType === 'URL' && sourcePort.dataType === 'string') {
    return {
      edgeId,
      label: `Insert String to URL before ${targetPort.label}`,
      nodeKind: 'Convert',
      settings: { convertMode: 'STRING_TO_URL' },
    };
  }

  if (targetPort.dataType === 'data' && sourcePort.dataType === 'string') {
    return {
      edgeId,
      label: `Split text before ${targetPort.label}`,
      nodeKind: 'TextSplitJoin',
      settings: { splitJoinMode: 'SPLIT_LINES' },
    };
  }

  if (targetPort.dataType === 'dict' && sourcePort.dataType === 'JSON') {
    return {
      edgeId,
      label: `Convert JSON to Dict before ${targetPort.label}`,
      nodeKind: 'Convert',
      settings: { convertMode: 'JSON_TO_DICT' },
    };
  }

  if (targetPort.dataType === 'JSON' && sourcePort.dataType === 'dict') {
    return {
      edgeId,
      label: `Convert Dict to JSON before ${targetPort.label}`,
      nodeKind: 'Convert',
      settings: { convertMode: 'DICT_TO_JSON' },
    };
  }

  if (targetPort.dataType === 'number' && sourcePort.dataType === 'floatingPoint') {
    return {
      edgeId,
      label: `Convert Float to Number before ${targetPort.label}`,
      nodeKind: 'Convert',
      settings: { convertMode: 'FLOAT_TO_NUMBER' },
    };
  }

  return null;
}

function applyConnectionQuickFix(workspace: WorkspaceFileV2, fix: ConnectionQuickFix): WorkspaceFileV2 {
  const edge = workspace.edges.find((candidate) => candidate.id === fix.edgeId);
  const sourceNode = edge ? workspace.nodes.find((node) => node.id === edge.source) : null;
  const targetNode = edge ? workspace.nodes.find((node) => node.id === edge.target) : null;
  if (!edge || !sourceNode || !targetNode) {
    return workspace;
  }

  const inserted = createWorkspaceNode(fix.nodeKind, {
    x: Math.round((sourceNode.position.x + targetNode.position.x) / 2),
    y: Math.round((sourceNode.position.y + targetNode.position.y) / 2) + 80,
  }, fix.settings);

  return {
    ...workspace,
    metadata: { ...workspace.metadata, updated_at: Date.now() },
    nodes: [...workspace.nodes, inserted],
    edges: [
      ...workspace.edges.filter((candidate) => candidate.id !== fix.edgeId),
      createEdge(edge.source, edge.sourceHandle, inserted.id, 'input'),
      createEdge(inserted.id, 'result', edge.target, edge.targetHandle),
    ],
  };
}

interface WorkspaceFlowProps {
  advancedModeEnabled: boolean;
  availableBlocks?: BlockDefinition[];
  canUndo?: boolean;
  workspace: WorkspaceFileV2;
  resourceAssets: AssetRef[];
  onUndo?: () => void;
  onUploadResource: (file: File) => Promise<AssetRef>;
  onWorkspaceChange: (workspace: WorkspaceFileV2, options?: WorkspaceChangeOptions) => void;
  invalidEdgeIds: Set<string>;
  copiedBlocks: WorkspaceBlockClipboard | null;
  onCopiedBlocksChange: (clipboard: WorkspaceBlockClipboard | null) => void;
  focusRequest?: { requestId: number; nodeIds: string[] } | null;
  heightClassName?: string;
}

interface LogicalFlowDragSession {
  anchorId: string;
  anchorStart: { x: number; y: number };
  groupId: string;
  memberNodeIds: Set<string>;
  startPositions: Map<string, { x: number; y: number }>;
}

function WorkspaceFlow({ advancedModeEnabled, availableBlocks = BLOCK_DEFINITIONS, canUndo = false, workspace, resourceAssets, onUndo, onUploadResource, onWorkspaceChange, invalidEdgeIds, copiedBlocks, onCopiedBlocksChange, focusRequest, heightClassName = 'h-[720px]' }: WorkspaceFlowProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const pendingSelectionRef = useRef<Set<string> | null>(null);
  const logicalFlowDragRef = useRef<LogicalFlowDragSession | null>(null);
  const normalizedLayoutKeyRef = useRef<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; flowX: number; flowY: number } | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [nodeMeasurements, setNodeMeasurements] = useState<Map<string, { width?: number; height?: number }>>(new Map());
  const [regexBuilderNodeId, setRegexBuilderNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
  const reducedMotion = useMemo(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );
  const declaredVariables = useMemo(() => collectDeclaredVariables(workspace), [workspace]);
  const usedVariables = useMemo(() => usedVariableTokens(workspace, declaredVariables), [workspace, declaredVariables]);

  const updateSelectedNodeIds = useCallback((nodeIds: Set<string>): void => {
    setSelectedNodeIds((current) => sameStringSet(current, nodeIds) ? current : new Set(nodeIds));
  }, []);

  const handleSettingsChange = useCallback(
    (nodeId: string, settings: Partial<WorkspaceBlockSettings>): void => {
      onWorkspaceChange(updateWorkspaceNodeSettings(workspace, nodeId, settings));
    },
    [onWorkspaceChange, workspace],
  );

  const handleLockToggle = useCallback(
    (nodeId: string): void => {
      const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        return;
      }

      const group = directLogicalFlowGroupForNode(workspace, nodeId);
      if (group) {
        const unitNodeIds = logicalFlowUnitNodeIds(workspace, group);
        const nextLocked = !node.settings.locked;
        onWorkspaceChange({
          ...workspace,
          metadata: { ...workspace.metadata, updated_at: Date.now() },
          logicalFlows: (workspace.logicalFlows ?? []).map((candidate) => candidate.id === group.id ? { ...candidate, locked: nextLocked } : candidate),
          nodes: workspace.nodes.map((candidate) => unitNodeIds.has(candidate.id) ? {
            ...candidate,
            settings: {
              ...candidate.settings,
              locked: nextLocked,
            },
          } : candidate),
        });
        return;
      }

      onWorkspaceChange(updateWorkspaceNodeSettings(workspace, nodeId, { locked: !node.settings.locked }));
    },
    [onWorkspaceChange, workspace],
  );

  const handleCollapseToggle = useCallback(
    (nodeId: string): void => {
      const node = workspace.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) {
        return;
      }

      onWorkspaceChange(updateWorkspaceNodeSettings(workspace, nodeId, { collapsed: !node.settings.collapsed }));
    },
    [onWorkspaceChange, workspace],
  );

  const handleDeleteNodes = useCallback(
    (nodeIds: string[]): void => {
      const requestedIds = expandLogicalFlowDeletion(workspace, new Set(nodeIds));
      const removedIds = new Set(
        Array.from(requestedIds).filter((nodeId) => {
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
        logicalFlows: pruneLogicalFlowGroups(workspace, removedIds),
      });
    },
    [onWorkspaceChange, workspace],
  );

  const handleDeleteNode = useCallback((nodeId: string): void => {
    handleDeleteNodes([nodeId]);
  }, [handleDeleteNodes]);

  const workspaceNodes = useMemo<WorkspaceCanvasNode[]>(
    () =>
      [
      ...createLogicalFlowContainerNodes(workspace, nodeMeasurements),
      ...workspace.nodes.map((node) => {
        const definition = definitionForWorkspaceNode(node, availableBlocks);
        const inputs = getEffectivePortDefinitions(node, 'input');
        const outputs = getEffectivePortDefinitions(node, 'output');
        const invalidInputs = workspace.edges
          .filter((edge) => edge.target === node.id && invalidEdgeIds.has(edge.id))
          .map((edge) => edge.targetHandle);
        const blockedInputs = Array.from(variableDrivenInputHandles(node));
        const connectedInputs = workspace.edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => edge.targetHandle);

        return {
          id: node.id,
          type: 'workspaceBlock',
          position: node.position,
          initialHeight: nodeMeasurements.get(node.id)?.height ?? (node.settings.collapsed
            ? LOGICAL_FLOW_LAYOUT.collapsedNodeHeight
            : LOGICAL_FLOW_LAYOUT.expandedNodeHeight),
          initialWidth: nodeMeasurements.get(node.id)?.width ?? (node.settings.collapsed
            ? LOGICAL_FLOW_LAYOUT.collapsedNodeWidth
            : LOGICAL_FLOW_LAYOUT.expandedNodeWidth),
          ariaLabel: `${blockTitle(node, definition)} block${node.settings.locked ? ', locked' : ''}`,
          data: {
            advancedModeEnabled,
            blockedInputs,
            connectedInputs,
            definition,
            inputs,
            invalidInputs: Array.from(new Set([...invalidInputs, ...blockedInputs])),
            node,
            outputs,
            resourceAssets,
            variables: declaredVariables,
            onCollapseToggle: handleCollapseToggle,
            onDeleteNode: handleDeleteNode,
            onLockToggle: handleLockToggle,
            onOpenRegexBuilder: setRegexBuilderNodeId,
            onSettingsChange: handleSettingsChange,
            onUploadResource,
          },
          deletable: definition.flags.canDelete && !node.settings.locked,
          draggable: !node.settings.locked,
          zIndex: 10,
        } satisfies WorkspaceFlowNode;
      }),
      ],
    [workspace, availableBlocks, advancedModeEnabled, invalidEdgeIds, resourceAssets, declaredVariables, handleCollapseToggle, handleDeleteNode, handleLockToggle, handleSettingsChange, nodeMeasurements, onUploadResource],
  );

  const workspaceEdges = useMemo<WorkspaceCanvasEdge[]>(
    () =>
      workspace.edges.filter((edge) => !isLogicalFlowConditionEdge(workspace, edge)).map((edge) => {
        const sourceNode = workspace.nodes.find((node) => node.id === edge.source);
        const targetNode = workspace.nodes.find((node) => node.id === edge.target);
        const invalid = invalidEdgeIds.has(edge.id);
        const description = `${sourceNode ? blockTitle(sourceNode) : 'Block'} ${edge.sourceHandle} to ${targetNode ? blockTitle(targetNode) : 'block'} ${edge.targetHandle}`;
        const branchStroke = sourceNode?.type === 'LogicalFlow'
          ? edge.sourceHandle === 'trueValue'
            ? '#0f766e'
            : edge.sourceHandle === 'falseValue'
              ? '#7c3aed'
              : null
          : null;

        return {
          id: edge.id,
          type: 'workspaceEdge',
          source: edge.source,
          sourceHandle: edge.sourceHandle,
          target: edge.target,
          targetHandle: edge.targetHandle,
          animated: invalid && !reducedMotion,
          ariaLabel: description,
          zIndex: 5,
          data: {
            description,
            invalid,
          },
          style: {
            stroke: invalid ? '#dc2626' : branchStroke ?? '#475569',
            strokeWidth: 2.25,
          },
        } satisfies WorkspaceCanvasEdge;
      }),
    [workspace, invalidEdgeIds, reducedMotion],
  );
  const laneTargets = useMemo(() => buildEventLaneTargets(workspace), [workspace]);
  const collapsedCount = workspace.nodes.filter((node) => node.settings.collapsed).length;
  const logicalFlowLayoutKey = useMemo(
    () => `${workspace.metadata.id}:${(workspace.logicalFlows ?? []).map((group) => `${group.id}:${group.conditionNodeId}:${group.controlNodeId}`).join('|')}`,
    [workspace.logicalFlows, workspace.metadata.id],
  );

  const [flowNodes, setFlowNodes] = useState<WorkspaceCanvasNode[]>(workspaceNodes);
  const [flowEdges, setFlowEdges] = useState<Edge[]>(workspaceEdges);

  useEffect(() => {
    const pendingSelection = pendingSelectionRef.current;
    pendingSelectionRef.current = null;
    setFlowNodes(
      pendingSelection
        ? workspaceNodes.map((node) => ({ ...node, selected: pendingSelection.has(node.id) }))
        : workspaceNodes,
    );
  }, [workspaceNodes]);

  useEffect(() => {
    setFlowEdges(workspaceEdges);
  }, [workspaceEdges]);

  useEffect(() => {
    if (normalizedLayoutKeyRef.current === logicalFlowLayoutKey) {
      return;
    }
    normalizedLayoutKeyRef.current = logicalFlowLayoutKey;
    if ((workspace.logicalFlows ?? []).length === 0) {
      return;
    }

    const normalized = normalizeLogicalFlowGroups(workspace, nodeMeasurements);
    if (normalized !== workspace) {
      onWorkspaceChange(normalized);
    }
  }, [logicalFlowLayoutKey, nodeMeasurements, onWorkspaceChange, workspace]);

  useEffect(() => {
    if (nodeMeasurements.size === 0 || (workspace.logicalFlows ?? []).length === 0) {
      return;
    }

    const normalized = normalizeLogicalFlowGroups(workspace, nodeMeasurements);
    if (normalized !== workspace) {
      onWorkspaceChange(normalized);
    }
  }, [nodeMeasurements]);

  useEffect(() => {
    const currentIds = new Set(workspace.nodes.map((node) => node.id));
    setSelectedNodeIds((current) => {
      const next = new Set(Array.from(current).filter((nodeId) => currentIds.has(nodeId)));
      return sameStringSet(current, next) ? current : next;
    });
  }, [workspace.nodes]);

  function copySelectedBlocks(): void {
    if (selectedNodeIds.size === 0) {
      return;
    }

    const clipboard = createWorkspaceBlockClipboard(workspace, selectedNodeIds);
    if (clipboard.nodes.length > 0) {
      onCopiedBlocksChange(clipboard);
    }
  }

  function pasteCopiedBlocks(): void {
    if (!copiedBlocks || copiedBlocks.nodes.length === 0) {
      return;
    }

    const result = pasteWorkspaceBlockClipboard(workspace, copiedBlocks);
    if (result.pastedNodeIds.length === 0) {
      return;
    }

    pendingSelectionRef.current = new Set(result.pastedNodeIds);
    updateSelectedNodeIds(new Set(result.pastedNodeIds));
    onWorkspaceChange(result.workspace);
  }

  function deleteSelectedBlocks(): void {
    if (selectedNodeIds.size === 0) {
      return;
    }

    handleDeleteNodes(Array.from(selectedNodeIds));
    updateSelectedNodeIds(new Set());
  }

  function isTypingShortcutTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
      return false;
    }

    return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (isTypingShortcutTarget(event.target)) {
        return;
      }

      const command = event.metaKey || event.ctrlKey;
      if (!command) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === 'z') {
        if (!canUndo || !onUndo) {
          return;
        }
        event.preventDefault();
        onUndo();
      }

      if (key === 'c') {
        if (selectedNodeIds.size === 0) {
          return;
        }
        event.preventDefault();
        copySelectedBlocks();
      }

      if (key === 'v') {
        if (!copiedBlocks || copiedBlocks.nodes.length === 0) {
          return;
        }
        event.preventDefault();
        pasteCopiedBlocks();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canUndo, copiedBlocks, onUndo, selectedNodeIds, workspace]);

  const handleNodeChanges = useCallback((changes: NodeChange[]): void => {
    const activeLogicalFlowDrag = logicalFlowDragRef.current;
    const workNodeChanges = changes.filter((change) => {
      if ('id' in change && String(change.id).startsWith('logical-flow-')) {
        return false;
      }
      if (
        activeLogicalFlowDrag
        && change.type === 'position'
        && 'id' in change
        && activeLogicalFlowDrag.memberNodeIds.has(change.id)
      ) {
        return false;
      }
      return true;
    });
    const dimensionChanges = workNodeChanges.filter((change) => change.type === 'dimensions');
    if (dimensionChanges.length > 0) {
      setNodeMeasurements((current) => {
        let next: Map<string, { width?: number; height?: number }> | null = null;
        dimensionChanges.forEach((change) => {
          if (change.type !== 'dimensions' || !change.dimensions) {
            return;
          }
          const previous = (next ?? current).get(change.id);
          const measurement = {
            width: change.dimensions.width,
            height: change.dimensions.height,
          };
          if (previous?.width === measurement.width && previous?.height === measurement.height) {
            return;
          }
          if (!next) {
            next = new Map(current);
          }
          next.set(change.id, measurement);
        });
        return next ?? current;
      });
    }
    const allowedChanges = workNodeChanges.filter((change) => {
      if (change.type !== 'remove') {
        return true;
      }

      if (!('id' in change)) {
        return false;
      }
      const node = workspace.nodes.find((candidate) => candidate.id === change.id);
      return Boolean(node && getBlockDefinition(node.type).flags.canDelete && !node.settings.locked);
    });
    const removedIds = new Set(
      allowedChanges
        .filter((change): change is Extract<NodeChange, { type: 'remove' }> => change.type === 'remove')
        .map((change) => change.id)
    );

    if (removedIds.size === 0) {
      setFlowNodes((currentNodes) => {
        const appliedNodes = applyReactFlowNodeChanges(allowedChanges, currentNodes as Node[]) as WorkspaceCanvasNode[];
        const workspaceBlockNodes = appliedNodes.filter((candidate): candidate is WorkspaceFlowNode => candidate.type === 'workspaceBlock');
        const positionById = new Map(workspaceBlockNodes.map((candidate) => [candidate.id, candidate.position]));
        const previewWorkspace = {
          ...workspace,
          nodes: workspace.nodes.map((candidate) => ({
            ...candidate,
            position: positionById.get(candidate.id) ?? candidate.position,
          })),
        };
        return [
          ...createLogicalFlowContainerNodes(previewWorkspace, nodeMeasurements),
          ...workspaceBlockNodes,
        ];
      });
      return;
    }

    handleDeleteNodes(Array.from(removedIds));
  }, [handleDeleteNodes, nodeMeasurements, workspace]);

  const handleNodeDragStart = useCallback((_event: MouseEvent | TouchEvent, node: Node): void => {
    const group = logicalFlowGroupForMember(workspace, node.id);
    if (!group) {
      logicalFlowDragRef.current = null;
      return;
    }

    const memberNodeIds = logicalFlowUnitNodeIds(workspace, group);
    const containerPrefixes = (workspace.logicalFlows ?? [])
      .filter((candidate) => memberNodeIds.has(candidate.conditionNodeId) && memberNodeIds.has(candidate.controlNodeId))
      .map((candidate) => `logical-flow-${candidate.id}-`);
    const startPositions = new Map<string, { x: number; y: number }>();
    flowNodes.forEach((candidate) => {
      if (memberNodeIds.has(candidate.id) || containerPrefixes.some((prefix) => candidate.id.startsWith(prefix))) {
        startPositions.set(candidate.id, { ...candidate.position });
      }
    });
    const anchorStart = startPositions.get(node.id) ?? { ...node.position };
    logicalFlowDragRef.current = {
      anchorId: node.id,
      anchorStart,
      groupId: group.id,
      memberNodeIds,
      startPositions,
    };
  }, [flowNodes, workspace]);

  const handleNodeDrag = useCallback((_event: MouseEvent | TouchEvent, node: Node): void => {
    const session = logicalFlowDragRef.current;
    if (!session || session.anchorId !== node.id) {
      return;
    }

    const deltaX = node.position.x - session.anchorStart.x;
    const deltaY = node.position.y - session.anchorStart.y;
    setFlowNodes((currentNodes) => currentNodes.map((candidate) => {
      const start = session.startPositions.get(candidate.id);
      if (!start) {
        return candidate;
      }
      return {
        ...candidate,
        position: {
          x: start.x + deltaX,
          y: start.y + deltaY,
        },
      };
    }));
  }, []);

  const handleNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: Node, draggedNodes: Node[]): void => {
    const session = logicalFlowDragRef.current;
    if (session?.anchorId === node.id) {
      logicalFlowDragRef.current = null;
      const deltaX = node.position.x - session.anchorStart.x;
      const deltaY = node.position.y - session.anchorStart.y;
      if (deltaX === 0 && deltaY === 0) {
        return;
      }
      const outsideDraggedPositions = new Map(
        draggedNodes
          .filter((candidate) => !session.memberNodeIds.has(candidate.id))
          .map((candidate) => [candidate.id, candidate.position]),
      );
      onWorkspaceChange({
        ...workspace,
        metadata: { ...workspace.metadata, updated_at: Date.now() },
        nodes: workspace.nodes.map((candidate) => {
          if (!session.memberNodeIds.has(candidate.id)) {
            const draggedPosition = outsideDraggedPositions.get(candidate.id);
            return draggedPosition && !candidate.settings.locked
              ? { ...candidate, position: draggedPosition }
              : candidate;
          }
          const start = session.startPositions.get(candidate.id) ?? candidate.position;
          return {
            ...candidate,
            position: {
              x: start.x + deltaX,
              y: start.y + deltaY,
            },
          };
        }),
      });
      return;
    }

    logicalFlowDragRef.current = null;
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

    const targetNode = workspace.nodes.find((node) => node.id === connection.target);
    if (targetNode && variableDrivenInputHandles(targetNode).has(connection.targetHandle)) {
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

    const targetNode = workspace.nodes.find((node) => node.id === connection.target);
    if (targetNode && variableDrivenInputHandles(targetNode).has(connection.targetHandle)) {
      return;
    }

    const nextEdge = createEdge(connection.source, connection.sourceHandle, connection.target, connection.targetHandle);
    const nextEdges = workspace.edges.filter(
      (edge) => !(edge.target === nextEdge.target && edge.targetHandle === nextEdge.targetHandle),
    );
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

    const connectedWorkspace = {
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes,
      edges: [...nextEdges, nextEdge],
    };
    onWorkspaceChange(layoutLogicalFlowConnection(workspace, connectedWorkspace, nextEdge, nodeMeasurements));
  }

  function addBlock(definition: BlockDefinition, x = 360, y = 220): void {
    setContextMenu(null);
    if (definition.kind === 'LogicalFlow') {
      onWorkspaceChange(buildLogicalFlowUnit(workspace, x, y));
      return;
    }

    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: [...workspace.nodes, createWorkspaceNode(definition.kind, { x, y }, settingsForDefinition(definition))],
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

  function focusNodeIds(nodeIds: Set<string>, selectNodes = true): void {
    if (!flowInstance || nodeIds.size === 0) {
      return;
    }

    if (selectNodes) {
      pendingSelectionRef.current = new Set(nodeIds);
      updateSelectedNodeIds(new Set(nodeIds));
    }
    void flowInstance.fitView({
      nodes: Array.from(nodeIds).map((id) => ({ id })),
      padding: 0.22,
      duration: reducedMotion ? 0 : 240,
    });
  }

  useEffect(() => {
    if (!focusRequest || !flowInstance || focusRequest.nodeIds.length === 0) {
      return;
    }

    focusNodeIds(new Set(focusRequest.nodeIds));
  }, [flowInstance, focusRequest]);

  function tidyEventLanes(): void {
    onWorkspaceChange(normalizeLogicalFlowGroups(tidyWorkspaceByEventLanes(workspace), nodeMeasurements));
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
    <div ref={wrapperRef} className={`relative overflow-hidden rounded-lg border border-slate-200 bg-white ${heightClassName}`}>
      <ReactFlow
        key={workspace.metadata.id}
        colorMode="light"
        connectionLineStyle={{ stroke: '#0f766e', strokeWidth: 2.25 }}
        defaultViewport={workspace.viewport}
        deleteKeyCode={['Backspace', 'Delete']}
        edgeTypes={edgeTypes}
        edges={flowEdges}
        isValidConnection={canConnect}
        multiSelectionKeyCode="Shift"
        nodeTypes={nodeTypes}
        nodes={flowNodes as Node[]}
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
        onNodeDrag={handleNodeDrag}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onNodesChange={handleNodeChanges}
        onMoveEnd={(_event, viewport) => handleViewportChange(viewport)}
        onPaneClick={() => setContextMenu(null)}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          const flowPosition = flowInstance?.screenToFlowPosition({ x: event.clientX, y: event.clientY }) ?? { x: 360, y: 220 };
          const bounds = wrapperRef.current?.getBoundingClientRect();
          const relativeX = bounds ? event.clientX - bounds.left : 24;
          const relativeY = bounds ? event.clientY - bounds.top : 24;
          const maxX = Math.max(8, (bounds?.width ?? 280) - 264);
          const maxY = Math.max(8, (bounds?.height ?? 416) - 392);
          setContextMenu({
            x: Math.max(8, Math.min(relativeX, maxX)),
            y: Math.max(8, Math.min(relativeY, maxY)),
            flowX: flowPosition.x,
            flowY: flowPosition.y,
          });
        }}
        onSelectionChange={({ nodes }) => updateSelectedNodeIds(new Set(nodes.map((node) => node.id).filter((id) => workspace.nodes.some((workspaceNode) => workspaceNode.id === id))))}
        selectionKeyCode="Shift"
        selectionOnDrag
        selectNodesOnDrag={false}
        snapGrid={[12, 12]}
        snapToGrid
      >
        <Panel className="nodrag nowheel" position="top-left">
          <div className="flex max-w-[min(620px,calc(100vw-260px))] flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-white/92 p-1.5 text-xs shadow-[0_10px_28px_rgba(31,41,55,0.1)] backdrop-blur">
            <span className="rounded-md bg-slate-100 px-2 py-1 font-semibold text-slate-600">
              {workspace.nodes.length} blocks / {workspace.edges.length} links
            </span>
            <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50" type="button" onClick={() => focusNodeIds(new Set(flowNodes.map((node) => node.id)), false)}>
              Fit
            </button>
            <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-45" disabled={!canUndo} title="Undo (Ctrl+Z / Cmd+Z)" type="button" onClick={onUndo}>
              Undo
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
            {selectedNodeIds.size > 0 ? (
              <>
                <span className="rounded-full bg-teal-50 px-2.5 py-1 font-semibold text-teal-700">{selectedNodeIds.size} selected</span>
                <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50" type="button" onClick={copySelectedBlocks}>
                  Copy selected
                </button>
                <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-rose-700 hover:border-rose-300 hover:bg-rose-50" type="button" onClick={deleteSelectedBlocks}>
                  Delete selected
                </button>
              </>
            ) : null}
            <button className="rounded-md border border-slate-200 px-2.5 py-1 font-semibold text-slate-700 hover:border-teal-300 hover:bg-teal-50 disabled:cursor-not-allowed disabled:opacity-45" disabled={!copiedBlocks || copiedBlocks.nodes.length === 0} type="button" onClick={pasteCopiedBlocks}>
              Paste
            </button>
          </div>
        </Panel>
        <Panel className="nodrag nowheel" position="top-right">
          <div className="grid gap-0.5 rounded-lg border border-slate-200 bg-white/92 p-1.5 text-xs shadow-[0_10px_28px_rgba(31,41,55,0.1)] backdrop-blur">
            {EVENT_LANE_DEFINITIONS.filter((lane) => laneTargets[lane.id].size > 0).map((lane) => (
              <button
                key={lane.id}
                className="flex min-w-28 items-center justify-between gap-3 rounded-md px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50"
                type="button"
                onClick={() => focusNodeIds(laneTargets[lane.id])}
              >
                <span>{lane.label}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-500">{laneTargets[lane.id].size}</span>
              </button>
            ))}
            {laneTargets.other.size > 0 ? (
              <button className="flex min-w-28 items-center justify-between gap-3 rounded-md px-2 py-1 font-semibold text-slate-700 hover:bg-slate-50" type="button" onClick={() => focusNodeIds(laneTargets.other)}>
                <span>Other</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] text-slate-500">{laneTargets.other.size}</span>
              </button>
            ) : null}
          </div>
        </Panel>
        {declaredVariables.length > 0 ? (
          <Panel className="nodrag nowheel" position="bottom-center">
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
        <Background color="#dbe4ee" gap={20} size={1.2} />
        <Controls showInteractive={false} />
        <MiniMap
          className="workspace-minimap"
          maskColor="rgba(248, 250, 252, 0.62)"
          nodeColor={(node) => node.type === 'logicalFlowContainer' ? 'transparent' : '#0f766e'}
          nodeStrokeColor={(node) => node.type === 'logicalFlowContainer' ? 'transparent' : '#0f766e'}
          nodeStrokeWidth={2}
          pannable
          zoomable
        />
      </ReactFlow>

      {contextMenu ? (
        <div
          className="absolute z-20 grid max-h-96 w-64 gap-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-2 shadow-[0_20px_60px_rgba(31,41,55,0.22)]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {availableBlocks.map((definition) => (
            <button
              key={blockPickerKey(definition)}
              className="rounded-lg px-3 py-2 text-left text-sm font-semibold text-slate-700 hover:bg-teal-50"
              type="button"
              onClick={() => addBlock(definition, contextMenu.flowX, contextMenu.flowY)}
            >
              <span className="block">{definition.label}</span>
              {definition.description ? <span className="mt-1 block text-xs font-normal leading-5 text-slate-500">{definition.description}</span> : null}
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

function BlockPicker({ definitions = BLOCK_DEFINITIONS, onAddBlock, quickBlockKinds = DEFAULT_QUICK_BLOCK_KINDS }: { definitions?: BlockDefinition[]; onAddBlock: (definition: BlockDefinition) => void; quickBlockKinds?: BlockKind[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<BlockDefinition['category'] | 'all'>('all');
  const toggleButtonRef = useRef<HTMLButtonElement | null>(null);
  const closeLibrary = useCallback(() => {
    setOpen(false);
    window.requestAnimationFrame(() => toggleButtonRef.current?.focus());
  }, []);
  const uniqueDefinitions = useMemo(
    () => Array.from(new Map(definitions.map((definition) => [blockPickerKey(definition), definition])).values()),
    [definitions],
  );
  const availableKinds = useMemo(() => new Set(uniqueDefinitions.map((definition) => definition.kind)), [uniqueDefinitions]);
  const categories = useMemo(
    () => Array.from(new Set(uniqueDefinitions.map((definition) => definition.category))).sort(),
    [uniqueDefinitions],
  );
  const matchingBlocks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return uniqueDefinitions.filter((definition) => {
      if (category !== 'all' && definition.category !== category) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return (
        definition.label.toLowerCase().includes(normalizedQuery) ||
        definition.kind.toLowerCase().includes(normalizedQuery) ||
        definition.category.toLowerCase().includes(normalizedQuery) ||
        (definition.description?.toLowerCase().includes(normalizedQuery) ?? false) ||
        (definition.tips?.some((tip) => tip.toLowerCase().includes(normalizedQuery)) ?? false) ||
        (BLOCK_SEARCH_TERMS[definition.kind]?.includes(normalizedQuery) ?? false)
      );
    });
  }, [category, query, uniqueDefinitions]);
  const quickDefinitions = useMemo(
    () => quickBlockKinds
      .filter((kind) => availableKinds.has(kind))
      .map((kind) => getBlockDefinition(kind)),
    [availableKinds, quickBlockKinds],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLibrary();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [closeLibrary, open]);

  return (
    <div className="relative z-20">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          ref={toggleButtonRef}
          aria-controls="workspace-block-library"
          aria-expanded={open}
          className="secondary-button"
          type="button"
          onClick={() => open ? closeLibrary() : setOpen(true)}
        >
          {open ? 'Close Library' : 'Add Block'}
        </button>
        {!open ? <div aria-label="Quick add blocks" className="tab-scroll flex min-w-0 max-w-full gap-1.5 overflow-x-auto pb-0.5" role="group">
          {quickDefinitions.map((definition) => (
            <button
              key={blockPickerKey(definition)}
              className="ghost-button px-3 py-1.5 text-xs"
              title={definition.description}
              type="button"
              onClick={() => onAddBlock(definition)}
            >
              {definition.label}
            </button>
          ))}
        </div> : null}
      </div>
      {open ? (
        <div id="workspace-block-library" aria-label="Block Library" className="absolute left-0 top-11 z-30 w-[min(700px,calc(100vw-32px))] rounded-xl border border-slate-200 bg-white/98 p-2.5 shadow-[0_24px_70px_rgba(31,41,55,0.22)] backdrop-blur" role="dialog">
          <div className="grid gap-2.5">
            <div>
              <input
                autoFocus
                aria-label="Search Block Library"
                className="field-input w-full min-w-0 py-2"
                placeholder="Search blocks by name or purpose"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <button
                aria-pressed={category === 'all'}
                className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${category === 'all' ? 'border-teal-300 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                type="button"
                onClick={() => setCategory('all')}
              >
                All
              </button>
              {categories.map((entry) => (
                <button
                  key={entry}
                  aria-pressed={category === entry}
                  className={`rounded-md border px-3 py-1.5 text-xs font-semibold ${category === entry ? 'border-teal-300 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
                  type="button"
                  onClick={() => setCategory(entry)}
                >
                  {categoryLabel(entry)}
                </button>
              ))}
            </div>
            <div className="grid max-h-[min(28rem,60vh)] gap-1.5 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
              {matchingBlocks.map((definition) => (
                <button
                  key={blockPickerKey(definition)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-left transition hover:border-teal-300 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-200"
                  type="button"
                  onClick={() => {
                    onAddBlock(definition);
                    closeLibrary();
                  }}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    {definition.label}
                    {definition.custom ? <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] text-slate-600">Custom</span> : null}
                  </span>
                  <span className="mt-1 block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{categoryLabel(definition.category)}</span>
                  {definition.description ? <span className="mt-2 block text-xs font-normal leading-5 text-slate-600">{definition.description}</span> : null}
                  {definition.tips?.map((tip, index) => (
                    <span key={`${index}:${tip}`} className="mt-1 block text-[11px] font-normal leading-5 text-slate-500">{tip}</span>
                  ))}
                </button>
              ))}
              {matchingBlocks.length === 0 ? (
                <div aria-live="polite" className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm font-medium text-slate-600 sm:col-span-2 lg:col-span-3">
                  No blocks match this search and category.
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function workspaceTypeLabel(workspaceType: WorkspaceType): string {
  if (workspaceType === 'content-blocker') {
    return 'Content Blocker';
  }
  if (workspaceType === 'custom-block') {
    return 'Custom Block';
  }
  return 'Data Modifier';
}

function contentBlockerSurfaceFor(workspace: WorkspaceFileV2, surfaceId: ContentBlockerSurfaceId): WorkspaceGraphSurface {
  const surface = workspace.surfaces?.find((candidate) => candidate.id === surfaceId);
  if (surface) {
    return surface;
  }

  const fallback = createDefaultContentBlockerWorkspace().surfaces?.find((candidate) => candidate.id === surfaceId);
  if (fallback) {
    return fallback;
  }

  return {
    id: surfaceId,
    label: CONTENT_BLOCKER_SURFACE_META.find((candidate) => candidate.id === surfaceId)?.label ?? surfaceId,
    nodes: [],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

function surfaceWorkspace(workspace: WorkspaceFileV2, surface: WorkspaceGraphSurface): WorkspaceFileV2 {
  return {
    ...workspace,
    metadata: {
      ...workspace.metadata,
      id: `${workspace.metadata.id}:${surface.id}`,
      name: `${workspace.metadata.name} - ${surface.label}`,
    },
    nodes: surface.nodes,
    edges: surface.edges,
    viewport: surface.viewport,
  };
}

function updateContentBlockerSurface(workspace: WorkspaceFileV2, surfaceId: ContentBlockerSurfaceId, nextSurface: WorkspaceGraphSurface): WorkspaceFileV2 {
  const existingSurfaces = CONTENT_BLOCKER_SURFACE_META.map((meta) => contentBlockerSurfaceFor(workspace, meta.id));
  return {
    ...workspace,
    metadata: {
      ...workspace.metadata,
      updated_at: Date.now(),
    },
    surfaces: existingSurfaces.map((surface) => surface.id === surfaceId ? {
      ...surface,
      label: nextSurface.label,
      nodes: nextSurface.nodes,
      edges: nextSurface.edges,
      viewport: nextSurface.viewport,
    } : surface),
  };
}

function contentBlockerDefinitions(surfaceId: ContentBlockerSurfaceId): BlockDefinition[] {
  const kinds = surfaceId === 'challenge' ? CONTENT_BLOCKER_CHALLENGE_BLOCK_KINDS : CONTENT_BLOCKER_DECISION_BLOCK_KINDS;
  return kinds.map((kind) => getBlockDefinition(kind));
}

function contentBlockerQuickKinds(surfaceId: ContentBlockerSurfaceId): BlockKind[] {
  return surfaceId === 'challenge'
    ? ['ChallengeTimer', 'ChallengeTyper', 'ChallengeClicker', 'ChallengeConfirm', 'ChallengeReason', 'ChallengeComplete']
    : ['ContentDataIn', 'Constant', 'CheckListForUrl', 'Logical', 'LogicalFlow', 'RegExpression', 'DecisionOut', 'SaveStringToLog'];
}

function contentBlockerChallengeTaskNodes(surface: WorkspaceGraphSurface): WorkspaceNodeV2[] {
  return surface.nodes
    .filter((node) => CONTENT_BLOCKER_CHALLENGE_TASK_KINDS.has(node.type))
    .slice()
    .sort((left, right) => left.position.x - right.position.x || left.position.y - right.position.y);
}

export function WorkspaceEditor({
  advancedModeEnabled,
  allWorkspaces,
  isDirty,
  workspace: sourceWorkspace,
  resourceAssets,
  canUndo,
  customBlocks,
  onWorkspaceChange,
  onNewWorkspace,
  onSwitchWorkspace,
  onUploadResource,
  onBuildActionPack,
  onExportActionPack,
  onExportWorkspace,
  onSaveWorkspace,
  onUndo,
}: WorkspaceEditorProps) {
  const [metadataCollapsed, setMetadataCollapsed] = useState(false);
  const [isPopout, setIsPopout] = useState(false);
  const [selectedContentSurface, setSelectedContentSurface] = useState<ContentBlockerSurfaceId>('page-load');
  const [copiedBlocks, setCopiedBlocks] = useState<WorkspaceBlockClipboard | null>(null);
  const [debugUrl, setDebugUrl] = useState('https://example.com/path?utm_source=newsletter&id=123');
  const [debugSelectedText, setDebugSelectedText] = useState('example selection');
  const [debugPageTitle, setDebugPageTitle] = useState('Example Page Title');
  const [debugClipboard, setDebugClipboard] = useState('clipboard text');
  const [debugHandler, setDebugHandler] = useState<GraphEventHandler>('trigger');
  const [debugBusy, setDebugBusy] = useState(false);
  const [debugOutput, setDebugOutput] = useState<string | null>(null);
  const [debugError, setDebugError] = useState<string | null>(null);
  const [debugTrace, setDebugTrace] = useState<Array<{ nodeId: string; op: string; message: string; valueType?: string; preview?: string }>>([]);
  const [focusRequest, setFocusRequest] = useState<{ requestId: number; nodeIds: string[] } | null>(null);
  const workspace = useMemo(
    () => synchronizeCustomBlockInvocationMetadata(sourceWorkspace, customBlocks),
    [customBlocks, sourceWorkspace],
  );
  const conditionWorkspaces = useMemo(() => {
    const byId = new Map(allWorkspaces.map((candidate) => [candidate.metadata.id, candidate]));
    byId.set(workspace.metadata.id, workspace);
    return Array.from(byId.values());
  }, [allWorkspaces, workspace]);
  const conditionWorkspaceOptions = useMemo(
    () => conditionWorkspaces
      .slice()
      .sort((left, right) => left.metadata.name.localeCompare(right.metadata.name)),
    [conditionWorkspaces],
  );
  const compileResult = useMemo(() => compileWorkspace(workspace, { conditionWorkspaces, customBlocks }), [conditionWorkspaces, customBlocks, workspace]);
  const invalidEdgeIds = useMemo(() => new Set(compileResult.validation.invalidEdgeIds), [compileResult.validation.invalidEdgeIds]);
  const connectionQuickFixes = useMemo(
    () => Array.from(invalidEdgeIds)
      .map((edgeId) => connectionQuickFix(workspace, edgeId))
      .filter((fix): fix is ConnectionQuickFix => Boolean(fix)),
    [invalidEdgeIds, workspace],
  );
  const riskReasonGroups = useMemo(() => groupedRiskReasons(compileResult.validation.risk.reasons), [compileResult.validation.risk.reasons]);
  const isContentBlocker = workspace.workspaceType === 'content-blocker';
  const isCustomBlock = workspace.workspaceType === 'custom-block';
  const typeLabel = workspaceTypeLabel(workspace.workspaceType);
  const hotkeyError = workspace.trigger.type === 'HOTKEY' ? getHotkeyValidationError(workspace.trigger.hotkey, []) : null;
  const urlFilter = workspace.trigger.sourceFilters?.find((filter) => filter.source === 'url')?.pattern ?? '';
  const contentBlockerConfig = workspace.contentBlocker ?? createDefaultContentBlockerWorkspace().contentBlocker!;
  const activeContentSurface = contentBlockerSurfaceFor(workspace, selectedContentSurface);
  const activeContentSurfaceMeta = CONTENT_BLOCKER_SURFACE_META.find((surface) => surface.id === selectedContentSurface) ?? CONTENT_BLOCKER_SURFACE_META[0];
  const activeContentSurfaceWorkspace = surfaceWorkspace(workspace, activeContentSurface);
  const workspaceDefinitions = useMemo(() => availableBlockDefinitions(workspace.workspaceType, customBlocks), [customBlocks, workspace.workspaceType]);
  const activeContentDefinitions = useMemo(() => [
    ...contentBlockerDefinitions(selectedContentSurface),
    ...customBlocks
      .filter((block) => isCustomBlockCategory(block.category) && block.visibleWorkspaceTypes.includes('content-blocker'))
      .map(customBlockDefinition),
  ], [customBlocks, selectedContentSurface]);
  const activeContentQuickKinds = contentBlockerQuickKinds(selectedContentSurface);
  const customBlockConfig = workspace.customBlock ?? {
    blockId: `custom-${workspace.metadata.id}`,
    label: workspace.metadata.name,
    version: workspace.metadata.version,
    category: '' as const,
    visibleWorkspaceTypes: ['data-modifier'] as WorkspaceType[],
    description: workspace.metadata.description,
    tips: [] as string[],
    inputs: [{ id: 'input', label: 'Input', dataType: 'Any' as GraphDataType }],
    outputs: [{ id: 'result', label: 'Result', dataType: 'Any' as GraphDataType }],
    fields: [],
  };

  function updateWorkspace(updates: Partial<WorkspaceFileV2>): void {
    onWorkspaceChange(synchronizeCustomBlockIdentity({
      ...workspace,
      ...updates,
      metadata: {
        ...workspace.metadata,
        ...(updates.metadata ?? {}),
        updated_at: Date.now(),
      },
    }));
  }

  function addToolbarBlock(definition: BlockDefinition): void {
    if (isContentBlocker) {
      const surface = contentBlockerSurfaceFor(workspace, selectedContentSurface);
      if (definition.kind === 'LogicalFlow') {
        const surfaceUnit = buildLogicalFlowUnit(surfaceWorkspace(workspace, surface), 320 + surface.nodes.length * 24, 260 + surface.nodes.length * 18);
        onWorkspaceChange(updateContentBlockerSurface({
          ...workspace,
          logicalFlows: surfaceUnit.logicalFlows,
        }, selectedContentSurface, {
          ...surface,
          nodes: surfaceUnit.nodes,
          edges: surfaceUnit.edges,
          viewport: surfaceUnit.viewport,
        }));
        return;
      }
      const nextNode = createWorkspaceNode(definition.kind, { x: 320 + surface.nodes.length * 24, y: 260 + surface.nodes.length * 18 }, settingsForDefinition(definition));
      onWorkspaceChange(updateContentBlockerSurface(workspace, selectedContentSurface, {
        ...surface,
        nodes: [...surface.nodes, nextNode],
      }));
      return;
    }

    if (definition.kind === 'LogicalFlow') {
      onWorkspaceChange(buildLogicalFlowUnit(workspace, 320 + workspace.nodes.length * 24, 260 + workspace.nodes.length * 18));
      return;
    }

    onWorkspaceChange({
      ...workspace,
      metadata: { ...workspace.metadata, updated_at: Date.now() },
      nodes: [...workspace.nodes, createWorkspaceNode(definition.kind, { x: 320 + workspace.nodes.length * 24, y: 260 + workspace.nodes.length * 18 }, settingsForDefinition(definition))],
    });
  }

  function updateContentBlockerConfig(updates: Partial<NonNullable<WorkspaceFileV2['contentBlocker']>>): void {
    updateWorkspace({
      contentBlocker: {
        ...contentBlockerConfig,
        ...updates,
      },
    });
  }

  function updateCustomBlockConfig(updates: Partial<NonNullable<WorkspaceFileV2['customBlock']>>): void {
    updateWorkspace({
      customBlock: {
        ...customBlockConfig,
        ...updates,
      },
    });
  }

  function updateCustomBlockPort(direction: 'input' | 'output', index: number, updates: Partial<CustomBlockPortDefinition>): void {
    onWorkspaceChange(updateCustomBlockPortMetadata(workspace, direction, index, updates));
  }

  function addCustomBlockPort(direction: 'input' | 'output'): void {
    const key = direction === 'input' ? 'inputs' : 'outputs';
    const nodeType = direction === 'input' ? 'CustomBlockInput' : 'CustomBlockOutput';
    const ports = customBlockConfig[key];
    const id = `${direction}${ports.length + 1}`;
    const label = direction === 'input' ? `Input ${ports.length + 1}` : `Output ${ports.length + 1}`;
    const port = { id, label, dataType: 'Any' as GraphDataType, tooltip: '' };
    updateWorkspace({
      customBlock: {
        ...customBlockConfig,
        [key]: [...ports, port],
      },
      nodes: [
        ...workspace.nodes,
        createWorkspaceNode(nodeType, { x: direction === 'input' ? 0 : 760, y: 120 + ports.length * 150 }, {
          customPortId: id,
          customPortLabel: label,
          customPortDataType: 'Any',
          customPortTooltip: '',
          label,
          locked: true,
        }),
      ],
    });
  }

  function removeCustomBlockPort(direction: 'input' | 'output', index: number): void {
    const key = direction === 'input' ? 'inputs' : 'outputs';
    const ports = customBlockConfig[key];
    if (ports.length <= 1) {
      return;
    }
    const removed = ports[index];
    if (!removed) {
      return;
    }
    const nodeType = direction === 'input' ? 'CustomBlockInput' : 'CustomBlockOutput';
    const boundaryNodes = workspace.nodes.filter((node) => node.type === nodeType);
    const matchingBoundaryNodes = boundaryNodes.filter((node) => node.settings.customPortId === removed.id);
    const removedBoundaryNode = matchingBoundaryNodes.length === 1
      ? matchingBoundaryNodes[0]
      : boundaryNodes[index];
    const removedNodeIds = new Set(removedBoundaryNode ? [removedBoundaryNode.id] : []);
    updateWorkspace({
      customBlock: {
        ...customBlockConfig,
        [key]: ports.filter((_, portIndex) => portIndex !== index),
      },
      nodes: workspace.nodes.filter((node) => !removedNodeIds.has(node.id)),
      edges: workspace.edges.filter((edge) => !removedNodeIds.has(edge.source) && !removedNodeIds.has(edge.target)),
    });
  }

  function updateCustomBlockField(index: number, updates: Partial<CustomBlockFieldDefinition>): void {
    const field = customBlockConfig.fields[index];
    if (!field) {
      return;
    }
    const nextField = { ...field, ...updates };
    updateCustomBlockConfig({
      fields: customBlockConfig.fields.map((candidate, fieldIndex) => fieldIndex === index ? nextField : candidate),
    });
  }

  function addCustomBlockField(): void {
    const id = `field${customBlockConfig.fields.length + 1}`;
    updateCustomBlockConfig({
      fields: [
        ...customBlockConfig.fields,
        {
          id,
          label: `Field ${customBlockConfig.fields.length + 1}`,
          dataType: 'string',
          defaultValue: '',
          visibility: 'visible',
        },
      ],
    });
  }

  function removeCustomBlockField(index: number): void {
    updateCustomBlockConfig({
      fields: customBlockConfig.fields.filter((_, fieldIndex) => fieldIndex !== index),
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

  function focusValidationMessage(message: string): void {
    const nodeIds = nodeIdsForValidationMessage(workspace, message);
    if (nodeIds.length > 0) {
      setFocusRequest({ requestId: Date.now(), nodeIds });
    }
  }

  function applyQuickFix(fix: ConnectionQuickFix): void {
    onWorkspaceChange(applyConnectionQuickFix(workspace, fix));
  }

  async function copyDebugTrace(): Promise<void> {
    if (debugTrace.length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(JSON.stringify(debugTrace, null, 2));
    } catch (error) {
      setDebugError(error instanceof Error ? error.message : 'Could not copy the debug trace.');
    }
  }

  async function runWorkspaceDebug(): Promise<void> {
    setDebugBusy(true);
    setDebugOutput(null);
    setDebugError(null);
    setDebugTrace([]);

    try {
      const result = compileWorkspace(workspace, { conditionWorkspaces, customBlocks });
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

  function renderCustomBlockMetadata(): ReactNode {
    const renderPortRows = (direction: 'input' | 'output') => {
      const ports = direction === 'input' ? customBlockConfig.inputs : customBlockConfig.outputs;
      return (
        <div className="rounded-lg border border-slate-200 bg-white/75 px-4 py-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">{direction === 'input' ? 'Inputs' : 'Outputs'}</p>
            <button className="ghost-button px-3 py-1.5 text-xs" type="button" onClick={() => addCustomBlockPort(direction)}>
              Add {direction === 'input' ? 'Input' : 'Output'}
            </button>
          </div>
          <div className="grid gap-3">
            {ports.map((port, index) => (
              <div key={`${direction}:${port.id}:${index}`} className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 md:grid-cols-[1fr_1fr_0.8fr_auto]">
                <label className="field-shell">
                  <span className="field-label">ID</span>
                  <input className="field-input" value={port.id} onChange={(event) => updateCustomBlockPort(direction, index, { id: event.target.value })} />
                </label>
                <label className="field-shell">
                  <span className="field-label">Label</span>
                  <input className="field-input" value={port.label} onChange={(event) => updateCustomBlockPort(direction, index, { label: event.target.value })} />
                </label>
                <label className="field-shell">
                  <span className="field-label">Type</span>
                  <select className="field-select" value={port.dataType} onChange={(event) => updateCustomBlockPort(direction, index, { dataType: event.target.value as GraphDataType })}>
                    {DATA_TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <button className="ghost-button self-end px-3 py-2 text-xs" disabled={ports.length <= 1} type="button" onClick={() => removeCustomBlockPort(direction, index)}>
                  Remove
                </button>
                <label className="field-shell md:col-span-4">
                  <span className="field-label">Tooltip</span>
                  <input className="field-input" value={port.tooltip ?? ''} onChange={(event) => updateCustomBlockPort(direction, index, { tooltip: event.target.value })} />
                </label>
              </div>
            ))}
          </div>
        </div>
      );
    };

    return (
      <div className="mt-5 grid gap-4">
        <div className="grid gap-4 rounded-lg border border-slate-200 bg-white/75 px-5 py-4 lg:grid-cols-2">
          <label className="field-shell">
            <span className="field-label">Block ID</span>
            <input className="field-input" value={customBlockConfig.blockId} onChange={(event) => updateCustomBlockConfig({ blockId: event.target.value })} />
          </label>
          <label className="field-shell">
            <span className="field-label">Category</span>
            <select className="field-select" value={isCustomBlockCategory(customBlockConfig.category) ? customBlockConfig.category : ''} onChange={(event) => updateCustomBlockConfig({ category: event.target.value as BlockDefinition['category'] })}>
              <option disabled value="">Select a category</option>
              {CUSTOM_BLOCK_CATEGORY_VALUES.map((category) => (
                <option key={category} value={category}>{categoryLabel(category as BlockDefinition['category'])}</option>
              ))}
            </select>
          </label>
          <label className="field-shell">
            <span className="field-label">Description</span>
            <input className="field-input" value={customBlockConfig.description ?? ''} onChange={(event) => updateCustomBlockConfig({ description: event.target.value })} />
          </label>
          <label className="field-shell">
            <span className="field-label">Tips</span>
            <input className="field-input" placeholder="Separate tips with |" value={(customBlockConfig.tips ?? []).join(' | ')} onChange={(event) => updateCustomBlockConfig({ tips: event.target.value.split('|').map((tip) => tip.trim()).filter(Boolean) })} />
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
            <input checked={customBlockConfig.visibleWorkspaceTypes.includes('data-modifier')} type="checkbox" onChange={(event) => updateCustomBlockConfig({ visibleWorkspaceTypes: event.target.checked ? Array.from(new Set([...customBlockConfig.visibleWorkspaceTypes, 'data-modifier'])) : customBlockConfig.visibleWorkspaceTypes.filter((type) => type !== 'data-modifier') })} />
            Data Modifier
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-700">
            <input checked={customBlockConfig.visibleWorkspaceTypes.includes('content-blocker')} type="checkbox" onChange={(event) => updateCustomBlockConfig({ visibleWorkspaceTypes: event.target.checked ? Array.from(new Set([...customBlockConfig.visibleWorkspaceTypes, 'content-blocker'])) : customBlockConfig.visibleWorkspaceTypes.filter((type) => type !== 'content-blocker') })} />
            Content Blocker
          </label>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {renderPortRows('input')}
          {renderPortRows('output')}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white/75 px-4 py-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">Configurable Fields</p>
            <button className="ghost-button px-3 py-1.5 text-xs" type="button" onClick={addCustomBlockField}>
              Add Field
            </button>
          </div>
          <div className="grid gap-3">
            {customBlockConfig.fields.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">No caller-configurable fields.</p>
            ) : customBlockConfig.fields.map((field, index) => (
              <div key={`${field.id}:${index}`} className="grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 md:grid-cols-[1fr_1fr_0.8fr_0.8fr_auto]">
                <label className="field-shell">
                  <span className="field-label">ID</span>
                  <input className="field-input" value={field.id} onChange={(event) => updateCustomBlockField(index, { id: event.target.value })} />
                </label>
                <label className="field-shell">
                  <span className="field-label">Label</span>
                  <input className="field-input" value={field.label} onChange={(event) => updateCustomBlockField(index, { label: event.target.value })} />
                </label>
                <label className="field-shell">
                  <span className="field-label">Type</span>
                  <select className="field-select" value={field.dataType} onChange={(event) => updateCustomBlockField(index, { dataType: event.target.value as GraphDataType })}>
                    {DATA_TYPE_OPTIONS.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                </label>
                <label className="field-shell">
                  <span className="field-label">Visibility</span>
                  <select className="field-select" value={field.visibility ?? 'visible'} onChange={(event) => updateCustomBlockField(index, { visibility: event.target.value as CustomBlockFieldDefinition['visibility'] })}>
                    <option value="visible">Visible</option>
                    <option value="advanced">Advanced</option>
                    <option value="hidden">Hidden</option>
                  </select>
                </label>
                <button className="ghost-button self-end px-3 py-2 text-xs" type="button" onClick={() => removeCustomBlockField(index)}>
                  Remove
                </button>
                <label className="field-shell md:col-span-2">
                  <span className="field-label">Default</span>
                  <input className="field-input" value={field.defaultValue ?? ''} onChange={(event) => updateCustomBlockField(index, { defaultValue: event.target.value })} />
                </label>
                <label className="field-shell md:col-span-3">
                  <span className="field-label">Tooltip</span>
                  <input className="field-input" value={field.tooltip ?? ''} onChange={(event) => updateCustomBlockField(index, { tooltip: event.target.value })} />
                </label>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function renderDataModifierSurface(heightClassName?: string, expanded = false): ReactNode {
    return (
      <div className={expanded ? 'flex h-full min-h-0 flex-col gap-2' : 'grid gap-4'}>
        {!expanded ? <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Workspace surface</p>
            <p className="text-xs text-slate-500">{workspace.nodes.length} blocks, {workspace.edges.length} links.</p>
          </div>
          <button className="ghost-button" title="Expand workspace surface" type="button" onClick={() => setIsPopout(true)}>
            <svg aria-hidden="true" className="mr-2 inline-block h-4 w-4 align-[-2px]" fill="none" viewBox="0 0 24 24">
              <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
            </svg>
            Pop Out
          </button>
        </div> : null}
        <div className="shrink-0">
          <BlockPicker definitions={workspaceDefinitions} onAddBlock={addToolbarBlock} />
        </div>
        <ReactFlowProvider>
          <WorkspaceFlow
            advancedModeEnabled={advancedModeEnabled}
            availableBlocks={workspaceDefinitions}
            canUndo={canUndo}
            focusRequest={focusRequest}
            heightClassName={heightClassName}
            invalidEdgeIds={invalidEdgeIds}
            copiedBlocks={copiedBlocks}
            onCopiedBlocksChange={setCopiedBlocks}
            resourceAssets={resourceAssets}
            workspace={workspace}
            onUndo={onUndo}
            onUploadResource={onUploadResource}
            onWorkspaceChange={onWorkspaceChange}
          />
        </ReactFlowProvider>
      </div>
    );
  }

  function renderContentBlockerSurface(heightClassName?: string, expanded = false): ReactNode {
    const challengeTaskNodes = selectedContentSurface === 'challenge' ? contentBlockerChallengeTaskNodes(activeContentSurface) : [];
    const updateSurfaceWorkspace = (nextSurfaceWorkspace: WorkspaceFileV2, options: WorkspaceChangeOptions = {}): void => {
      onWorkspaceChange(updateContentBlockerSurface({
        ...workspace,
        logicalFlows: nextSurfaceWorkspace.logicalFlows,
      }, selectedContentSurface, {
        ...activeContentSurface,
        nodes: nextSurfaceWorkspace.nodes,
        edges: nextSurfaceWorkspace.edges,
        viewport: nextSurfaceWorkspace.viewport,
      }), options);
    };

    return (
      <div className={expanded ? 'flex h-full min-h-0 flex-col gap-3' : 'grid gap-4'}>
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">{activeContentSurfaceMeta.label}</p>
            <p className="mt-1 max-w-3xl text-xs text-slate-500">{activeContentSurfaceMeta.description}</p>
            <p className="mt-1 text-xs text-slate-500">{activeContentSurface.nodes.length} blocks, {activeContentSurface.edges.length} links.</p>
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
        <div className="flex shrink-0 flex-wrap gap-2">
          {CONTENT_BLOCKER_SURFACE_META.map((surface) => (
            <button
              key={surface.id}
              className={`rounded-md border px-3 py-2 text-sm font-semibold ${selectedContentSurface === surface.id ? 'border-teal-300 bg-teal-50 text-teal-800' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'}`}
              type="button"
              onClick={() => setSelectedContentSurface(surface.id)}
            >
              {surface.label}
            </button>
          ))}
        </div>
        <div className="shrink-0">
          <BlockPicker definitions={activeContentDefinitions} quickBlockKinds={activeContentQuickKinds} onAddBlock={addToolbarBlock} />
        </div>
        {selectedContentSurface === 'challenge' ? (
          <div className="shrink-0 rounded-lg border border-slate-200 bg-white px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span className="font-semibold uppercase tracking-[0.16em] text-slate-400">Task order</span>
              {challengeTaskNodes.length > 0 ? challengeTaskNodes.map((node, index) => (
                <span key={node.id} className="rounded-md border border-slate-200 bg-slate-50 px-2 py-1 font-semibold text-slate-700">
                  {index + 1}. {node.settings.label || getBlockDefinition(node.type).label}
                </span>
              )) : (
                <span className="text-slate-400">Add Timer, Clicker, Typer, Confirm, or Reason blocks.</span>
              )}
            </div>
          </div>
        ) : null}
        <ReactFlowProvider>
          <WorkspaceFlow
            key={activeContentSurface.id}
            advancedModeEnabled={advancedModeEnabled}
            availableBlocks={activeContentDefinitions}
            canUndo={canUndo}
            focusRequest={focusRequest}
            heightClassName={heightClassName}
            invalidEdgeIds={invalidEdgeIds}
            copiedBlocks={copiedBlocks}
            onCopiedBlocksChange={setCopiedBlocks}
            resourceAssets={resourceAssets}
            workspace={activeContentSurfaceWorkspace}
            onUndo={onUndo}
            onUploadResource={onUploadResource}
            onWorkspaceChange={updateSurfaceWorkspace}
          />
        </ReactFlowProvider>
      </div>
    );
  }

  function renderSurface(heightClassName?: string, expanded = false): ReactNode {
    return isContentBlocker
      ? renderContentBlockerSurface(heightClassName, expanded)
      : renderDataModifierSurface(heightClassName, expanded);
  }

  function renderEmbeddedCustomBlocks(): ReactNode {
    const embedded = workspace.embeddedCustomBlocks ?? [];
    if (embedded.length === 0) {
      return null;
    }

    return (
      <div className="mt-5 rounded-lg border border-slate-200 bg-white/75 px-5 py-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Embedded Custom Blocks</p>
            <p className="mt-1 text-xs text-slate-500">Imported workspaces keep embedded custom-block source snapshots for version conflicts and rollback review.</p>
          </div>
          <span className="risk-badge risk-badge-soft">{embedded.length} embedded</span>
        </div>
        <div className="grid gap-2">
          {embedded.map((entry) => {
            const status = entry.useEmbedded
              ? `Using embedded v${entry.version}${entry.installedVersion ? `; installed v${entry.installedVersion} unchanged` : ''}`
              : entry.installedVersion
                ? `Installed v${entry.installedVersion}`
                : 'Install required';
            return (
              <div key={`${entry.blockId}:${entry.version}:${entry.checksumHex ?? 'no-checksum'}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <div>
                  <p className="font-semibold text-slate-900">{entry.workspace.customBlock?.label || entry.blockId}</p>
                  <p className="mt-1 text-xs text-slate-500">{entry.blockId} · embedded v{entry.version}</p>
                </div>
                <span className={`risk-badge ${entry.useEmbedded ? 'risk-badge-warn' : 'risk-badge-soft'}`}>{status}</span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Workspace Editor</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Node action builder</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Workspaces can be saved while otherwise invalid. Building an Action Pack is blocked until the graph passes its required connections and type checks.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <select
              className="field-select min-w-72"
              value={allWorkspaces.some((candidate) => candidate.metadata.id === workspace.metadata.id) ? workspace.metadata.id : '__current__'}
              onChange={(event) => {
                if (event.target.value === '__new_data_modifier__') {
                  onNewWorkspace('data-modifier');
                  return;
                }

                if (event.target.value === '__new_content_blocker__') {
                  onNewWorkspace('content-blocker');
                  return;
                }

                if (event.target.value === '__new_custom_block__') {
                  onNewWorkspace('custom-block');
                  return;
                }

                if (event.target.value !== '__current__') {
                  onSwitchWorkspace(event.target.value);
                }
              }}
            >
              <option value="__current__">{workspace.metadata.name} (current draft)</option>
              <option value="__new_data_modifier__">New Data Modifier Workspace</option>
              <option value="__new_content_blocker__">New Content Blocker Workspace</option>
              <option value="__new_custom_block__">New Custom Block Workspace</option>
              {allWorkspaces.map((savedWorkspace) => (
                <option key={savedWorkspace.metadata.id} value={savedWorkspace.metadata.id}>
                  {savedWorkspace.metadata.name} ({workspaceTypeLabel(savedWorkspace.workspaceType)})
                </option>
              ))}
            </select>
            <span className="risk-badge risk-badge-soft">{typeLabel}</span>
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
          <button className="ghost-button" disabled={!canUndo} title="Undo (Ctrl+Z / Cmd+Z)" type="button" onClick={onUndo}>
            Undo
          </button>
          <button className="ghost-button" type="button" onClick={onExportWorkspace}>
            Export Workspace
          </button>
          <button className="secondary-button" disabled={!compileResult.ok} type="button" onClick={onBuildActionPack}>
            {isContentBlocker ? 'Compile & Install' : isCustomBlock ? 'Install Custom Block' : 'Build Action Pack'}
          </button>
          {!isContentBlocker && !isCustomBlock ? (
            <button className="primary-button" disabled={!compileResult.ok} type="button" onClick={onExportActionPack}>
              Export .actionpack
            </button>
          ) : null}
        </div>
      </div>

      {!metadataCollapsed ? <div className="mt-6 grid gap-4 lg:grid-cols-4">
        <label className="field-shell">
          <span className="field-label">Workspace Type</span>
          <input className="field-input" readOnly value={typeLabel} />
        </label>
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
        {!isContentBlocker && !isCustomBlock ? (
          <>
            <label className="field-shell">
              <span className="field-label">Run</span>
              <select className="field-select" value={workspace.trigger.type} onChange={(event) => updateWorkspace({ trigger: { ...workspace.trigger, type: event.target.value as WorkspaceFileV2['trigger']['type'] } })}>
                <option value="INPUT_DATA">Run on input data</option>
                <option value="HOTKEY">Hotkey</option>
                <option value="CONTEXT_MENU">Context Menu</option>
                <option value="INTERVAL">Recurring interval</option>
                <option value="CONDITIONAL">Conditional</option>
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
              <span className="field-label">Condition Workspace</span>
              <select className="field-select" value={workspace.trigger.conditionWorkspaceId ?? workspace.metadata.id} onChange={(event) => updateWorkspace({ trigger: { ...workspace.trigger, conditionWorkspaceId: event.target.value } })}>
                {conditionWorkspaceOptions.map((conditionWorkspace) => (
                  <option key={conditionWorkspace.metadata.id} value={conditionWorkspace.metadata.id}>
                    {conditionWorkspace.metadata.name}
                    {conditionWorkspace.metadata.id === workspace.metadata.id ? ' (this workspace)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-shell">
              <span className="field-label">Check Interval Seconds</span>
              <input className="field-input" min={30} type="number" value={Math.max(30, Math.round((workspace.trigger.intervalMs ?? 60000) / 1000))} onChange={(event) => updateWorkspace({ trigger: { ...workspace.trigger, intervalMs: Math.max(30, Number.parseInt(event.target.value || '30', 10)) * 1000 } })} />
            </label>
          </>
        ) : null}
        {workspace.trigger.type === 'HOTKEY' ? (
          <div className="lg:col-span-2">
            <HotkeyRecorder
              validationError={hotkeyError}
              value={workspace.trigger.hotkey}
              onChange={(hotkey) => updateWorkspace({ trigger: { ...workspace.trigger, hotkey } })}
            />
          </div>
        ) : null}
          </>
        ) : isContentBlocker ? (
          <>
            <label className="field-shell">
              <span className="field-label">Lock</span>
              <select className="field-select" value={contentBlockerConfig.lockLevel} onChange={(event) => updateContentBlockerConfig({ lockLevel: Number.parseInt(event.target.value, 10) as NonNullable<WorkspaceFileV2['contentBlocker']>['lockLevel'] })}>
                <option value={0}>0 - Off</option>
                <option value={1}>1 - Challenge</option>
                <option value={2}>2 - Password</option>
                <option value={3}>3 - No in-app overwrite</option>
              </select>
            </label>
            <label className="field-shell">
              <span className="field-label">Recurring Seconds</span>
              <input className="field-input" min={5} type="number" value={contentBlockerConfig.recurringIntervalSeconds} onChange={(event) => updateContentBlockerConfig({ recurringIntervalSeconds: Math.max(5, Number.parseInt(event.target.value || '30', 10)) })} />
            </label>
            <label className="field-shell">
              <span className="field-label">Allow Lock Increase</span>
              <select className="field-select" value={contentBlockerConfig.allowLockIncrease ? 'yes' : 'no'} onChange={(event) => updateContentBlockerConfig({ allowLockIncrease: event.target.value === 'yes' })}>
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </label>
            <label className="field-shell lg:col-span-2">
              <span className="field-label">Block Page Title</span>
              <input className="field-input" value={contentBlockerConfig.blockPageTitle} onChange={(event) => updateContentBlockerConfig({ blockPageTitle: event.target.value })} />
            </label>
            <label className="field-shell lg:col-span-2">
              <span className="field-label">Block Page Message</span>
              <input className="field-input" value={contentBlockerConfig.blockPageMessage} onChange={(event) => updateContentBlockerConfig({ blockPageMessage: event.target.value })} />
            </label>
            <label className="field-shell lg:col-span-2">
              <span className="field-label">Challenge Page Title</span>
              <input className="field-input" value={contentBlockerConfig.challengePageTitle} onChange={(event) => updateContentBlockerConfig({ challengePageTitle: event.target.value })} />
            </label>
            <label className="field-shell lg:col-span-2">
              <span className="field-label">Challenge Page Message</span>
              <input className="field-input" value={contentBlockerConfig.challengePageMessage} onChange={(event) => updateContentBlockerConfig({ challengePageMessage: event.target.value })} />
            </label>
          </>
        ) : null}
      </div> : (
        <div className="mt-5 rounded-lg border border-slate-200 bg-white/70 px-5 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">{workspace.metadata.name}</p>
            <p className="text-xs uppercase tracking-[0.18em] text-slate-500">
              v{workspace.metadata.version} · {isContentBlocker || isCustomBlock ? typeLabel : formatRunType(workspace.trigger.type)}
            </p>
          </div>
        </div>
      )}

      {!metadataCollapsed && isCustomBlock ? renderCustomBlockMetadata() : null}
      {!metadataCollapsed ? renderEmbeddedCustomBlocks() : null}

      <div className="mt-5">
        {isPopout ? (
          <div className="rounded-lg border border-slate-200 bg-white/70 px-5 py-6 text-sm text-slate-500">
            Workspace surface is open in the expanded editor.
          </div>
        ) : renderSurface()}
      </div>

      {!isContentBlocker && !isCustomBlock ? <div className="mt-5 rounded-lg border border-slate-200 bg-white/75 px-5 py-4">
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
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50/80">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2">
              <p className="text-xs font-semibold text-slate-700">Trace ({debugTrace.length})</p>
              <button className="ghost-button px-3 py-1.5 text-xs" type="button" onClick={() => void copyDebugTrace()}>
                Copy Trace
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto">
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
          </div>
        ) : null}
      </div> : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className={`rounded-lg border px-5 py-4 ${compileResult.validation.valid ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
          <p className="text-sm font-semibold">{compileResult.validation.valid ? 'Workspace can build.' : 'Build is blocked.'}</p>
          {compileResult.validation.errors.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {compileResult.validation.errors.map((error, index) => {
                const nodeIds = nodeIdsForValidationMessage(workspace, error);
                return (
                  <li key={`${error}:${index}`}>
                    <span>{error}</span>
                    {nodeIds.length > 0 ? (
                      <button className="ml-2 rounded-md border border-rose-200 bg-white px-2 py-0.5 text-xs font-semibold text-rose-700 hover:bg-rose-50" type="button" onClick={() => focusValidationMessage(error)}>
                        Focus
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {connectionQuickFixes.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {connectionQuickFixes.map((fix) => (
                <button key={fix.edgeId} className="rounded-md border border-rose-200 bg-white px-2.5 py-1 text-xs font-semibold text-rose-700 hover:bg-rose-50" type="button" onClick={() => applyQuickFix(fix)}>
                  {fix.label}
                </button>
              ))}
            </div>
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
          <div className="flex h-full min-h-0 flex-col rounded-xl border border-white/60 bg-white p-2.5 shadow-[0_32px_90px_rgba(31,41,55,0.35)]">
            <div className="mb-2 flex shrink-0 flex-wrap items-center justify-between gap-3 px-1">
              <div className="flex min-w-0 items-end gap-3">
                <div className="min-w-0">
                <p className="eyebrow">Workspace Surface</p>
                  <h3 className="mt-0.5 truncate text-lg font-semibold text-slate-900">{workspace.metadata.name}</h3>
                </div>
                <span className="mb-0.5 rounded-md bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                  {workspace.nodes.length} blocks · {workspace.edges.length} links
                </span>
              </div>
              <button className="ghost-button min-h-8 px-3 py-1.5 text-xs" type="button" onClick={() => setIsPopout(false)}>
                <svg aria-hidden="true" className="mr-2 inline-block h-4 w-4 align-[-2px]" fill="none" viewBox="0 0 24 24">
                  <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
                </svg>
                Exit
              </button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{renderSurface('min-h-0 flex-1', true)}</div>
          </div>
        </div>,
        document.body,
      ) : null}
    </section>
  );
}
