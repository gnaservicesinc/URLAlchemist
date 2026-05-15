import type { ActionPack, ActionType, MatchMode, WorkspaceTriggerType } from '../types';

export const WORKSPACE_SCHEMA_VERSION = 4;
export const LEGACY_WORKSPACE_SCHEMA_VERSION = 3;
export const ACTION_PACK_SCHEMA_VERSION = 4;
export const LEGACY_ACTION_PACK_SCHEMA_VERSION = 3;
export const INPUT_TRIGGER_HISTORY_LIMIT = 25;
export const INPUT_TRIGGER_BURST_LIMIT = 10;
export const INPUT_TRIGGER_BURST_WINDOW_MS = 1_000;
export const MIN_INTERVAL_TRIGGER_MS = 30_000;
export const DEFAULT_INTERVAL_TRIGGER_MS = 60_000;
export const DEFAULT_REMOTE_TIMEOUT_MS = 5_000;
export const DEFAULT_REMOTE_MAX_BYTES = 128 * 1024;

export type GraphDataType =
  | 'bool'
  | 'number'
  | 'floatingPoint'
  | 'string'
  | 'URL'
  | 'JSON'
  | 'data'
  | 'dict'
  | 'asset'
  | 'Any';

export type AssetKind = 'image' | 'video' | 'audio' | 'unknown';
export type AssetSource = 'remote' | 'embedded' | 'picked-file';

export interface AssetRef {
  source: AssetSource;
  kind: AssetKind;
  mimeType: string;
  url?: string;
  name?: string;
  sha256?: string;
  sizeBytes?: number;
  compression?: 'gzip' | 'none';
  dataBase64?: string;
  cacheKey?: string;
}

export type GraphValue =
  | { type: 'bool'; value: 0 | 1 }
  | { type: 'number'; value: number | number[] }
  | { type: 'floatingPoint'; value: number | number[] }
  | { type: 'string'; value: string }
  | { type: 'URL'; value: string }
  | { type: 'JSON'; value: string }
  | { type: 'data'; value: unknown }
  | { type: 'dict'; value: Record<string, GraphValue> }
  | { type: 'asset'; value: AssetRef }
  | { type: 'Any'; value: unknown };

export const BLOCK_TYPE_IDS = {
  DataFlowIn: 0,
  DataFlowOut: 1,
  Logical: 2,
  Loop: 3,
  RegExpression: 4,
  Math: 5,
  SaveLoad: 6,
  Convert: 7,
  Declarations: 8,
  DataStructure: 9,
  ExtendedDataIn: 10,
  ExtendedDataOut: 11,
  FetchData: 12,
  HttpRequest: 13,
  SystemData: 14,
  PromptText: 15,
  PromptNumber: 16,
  Confirm: 17,
  PickFileOrUrl: 18,
  ShowMessage: 19,
  ShowImage: 20,
  ShowVideo: 21,
  PlaySound: 22,
  GetImage: 23,
  GetVideo: 24,
  GetAudio: 25,
  ArcadeGame: 26,
} as const;

export type BlockKind = keyof typeof BLOCK_TYPE_IDS;
export type BlockTypeId = (typeof BLOCK_TYPE_IDS)[BlockKind];
export type RiskLevel = 'safe' | 'extended' | 'high';

export interface GraphPortDefinition {
  id: string;
  label: string;
  dataType: GraphDataType;
  required?: boolean;
  risk?: RiskLevel;
  description?: string;
}

export interface BlockFlags {
  alwaysProcess: boolean;
  processBeforeRun: boolean;
  canDelete: boolean;
}

export interface BlockDefinition {
  kind: BlockKind;
  typeId: BlockTypeId;
  label: string;
  category: 'flow' | 'logic' | 'regex' | 'math' | 'storage' | 'convert' | 'data' | 'interaction' | 'media';
  inputs: GraphPortDefinition[];
  outputs: GraphPortDefinition[];
  flags: BlockFlags;
  defaultSettings: WorkspaceBlockSettings;
  risk: RiskLevel;
}

export interface WorkspaceMetadata {
  id: string;
  name: string;
  version: number;
  author?: string;
  description?: string;
  compatibility?: WorkspaceCompatibilityMetadata;
  versionFileUrl?: string;
  versionFileSignatureUrl?: string;
  downloadUrl?: string;
  publicKeyLocateValue?: string;
  created_at: number;
  updated_at: number;
}

export type WorkspaceCompatibilityStatus =
  | 'supported'
  | 'source-only'
  | 'pending-v2-runtime'
  | 'unsupported';

export interface WorkspaceCompatibilityTarget {
  version: string;
  status: WorkspaceCompatibilityStatus;
}

export interface WorkspaceCompatibilityMetadata {
  chrome?: WorkspaceCompatibilityTarget;
  firefox?: WorkspaceCompatibilityTarget;
}

export type WorkspaceInputSource =
  | 'url'
  | 'linkUrl'
  | 'selectedText'
  | 'pageTitle'
  | 'pageMetadata'
  | 'clipboard'
  | 'pageText'
  | 'rawHtml'
  | 'mediaData'
  | 'pageLinks'
  | 'jsMetadata'
  | 'consoleOutput';

export interface WorkspaceSourceFilter {
  source: WorkspaceInputSource;
  pattern: string;
}

export type ConditionalTriggerMode = 'RISING_EDGE' | 'WHILE_TRUE';

export interface WorkspaceTrigger {
  type: WorkspaceTriggerType | 'ALWAYS';
  hotkey?: string;
  scope_regex?: string;
  inputSources?: WorkspaceInputSource[];
  sourceFilters?: WorkspaceSourceFilter[];
  intervalMs?: number;
  conditionalMode?: ConditionalTriggerMode;
  conditionWorkspaceId?: string;
}

export type WorkspaceRegexSourceMode = 'VISUAL' | 'MANUAL';
export type WorkspaceRegexTokenMode = 'EXACT' | 'FLEXIBLE';
export type WorkspaceRegexTokenPatternKind = 'AUTO' | 'NUMBER' | 'LETTERS' | 'WORD' | 'ANY_TEXT';

export interface WorkspaceRegexBuilderToken {
  id: string;
  text: string;
  mode: WorkspaceRegexTokenMode;
  patternKind: WorkspaceRegexTokenPatternKind;
}

export interface WorkspaceRegexBuilderState {
  sampleText: string;
  selectionStart: number;
  selectionEnd: number;
  tokens: WorkspaceRegexBuilderToken[];
  caseSensitive: boolean;
}

export type SystemDataMode = 'NOW_MS' | 'EPOCH_SECONDS' | 'ISO_DATE' | 'TIMEZONE_OFFSET_MINUTES' | 'LOCALE_DATE' | 'LOCALE_TIME';
export type UserInteractionKind = 'PROMPT_TEXT' | 'PROMPT_NUMBER' | 'CONFIRM' | 'PICK_FILE_OR_URL';
export type DisplayMode = 'OVERLAY' | 'REPLACE_PAGE' | 'NEW_TAB';
export type ShowImageStopMode = 'CLOSE_BUTTON' | 'CLICK' | 'TIMEOUT' | 'CONFIRM';
export type AssetFetchKind = 'image' | 'video' | 'audio';
export type ArcadeGamePreset = 'SPACE_DEFENDER';

export interface WorkspaceBlockSettings {
  label?: string;
  locked?: boolean;
  alwaysProcess?: boolean;
  processBeforeRun?: boolean;
  pattern?: string;
  action?: ActionType;
  matchMode?: MatchMode;
  nthOccurrence?: number;
  payload?: string;
  remoteUrl?: string;
  remoteDataType?: GraphDataType;
  remoteMethod?: 'GET' | 'POST';
  remoteTimeoutMs?: number;
  remoteMaxBytes?: number;
  assetUrl?: string;
  assetKind?: AssetFetchKind;
  assetMimeType?: string;
  assetName?: string;
  assetDataBase64?: string;
  assetCompression?: 'gzip' | 'none';
  systemDataMode?: SystemDataMode;
  promptMessage?: string;
  promptPlaceholder?: string;
  promptDefaultValue?: string;
  minValue?: number;
  maxValue?: number;
  displayMode?: DisplayMode;
  imageStopMode?: ShowImageStopMode;
  displayTimeoutMs?: number;
  requireUserGesture?: boolean;
  gamePreset?: ArcadeGamePreset;
  captureKeyboard?: boolean;
  captureMouse?: boolean;
  payloadVars?: boolean;
  regexBuilder?: WorkspaceRegexBuilderState;
  regexSourceMode?: WorkspaceRegexSourceMode;
  regexHelperInput?: string;
  operator?: 'LT' | 'LTE' | 'EQ' | 'GT' | 'GTE';
  compareValue?: string;
  booleanOutput?: boolean;
  mathOperation?: 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'DIVIDE' | 'MODULO';
  convertMode?:
    | 'FLOAT_TO_NUMBER'
    | 'STRING_TO_URL'
    | 'DICT_TO_JSON'
    | 'JSON_TO_DICT'
    | 'NUMBER_TO_STRING'
    | 'DATA_TO_STRING';
  convertOrd?: boolean;
  rounding?: 'FLOOR' | 'CEIL' | 'ROUND';
  variableName?: string;
  literalValue?: string;
  saveLoadMode?: 'SAVE' | 'EXISTS' | 'GET';
  dictKey?: string;
  loopLimit?: number;
  outputDestination?: string;
}

export interface WorkspaceNodeV2 {
  id: string;
  type: BlockKind;
  typeId: BlockTypeId;
  position: {
    x: number;
    y: number;
  };
  settings: WorkspaceBlockSettings;
}

export interface WorkspaceEdgeV2 {
  id: string;
  source: string;
  sourceHandle: string;
  target: string;
  targetHandle: string;
}

export interface WorkspaceViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkspaceValidationState {
  valid: boolean;
  errors: string[];
  warnings: string[];
  invalidEdgeIds: string[];
  risk: CompiledRiskSummary;
}

export interface WorkspaceFileV2 {
  kind: 'workspace.v2';
  schemaVersion: typeof WORKSPACE_SCHEMA_VERSION;
  metadata: WorkspaceMetadata;
  trigger: WorkspaceTrigger;
  nodes: WorkspaceNodeV2[];
  edges: WorkspaceEdgeV2[];
  assets?: AssetRef[];
  viewport: WorkspaceViewport;
  validationState?: WorkspaceValidationState;
}

export interface CompiledRiskSummary {
  highest: RiskLevel;
  usesExtendedInput: boolean;
  usesExtendedOutput: boolean;
  usesHighRiskInput: boolean;
  usesHighRiskOutput: boolean;
  reasons: string[];
}

export interface CompiledTriggerSafety {
  timestampHistoryLimit: number;
  burstLimit: number;
  burstWindowMs: number;
}

export interface CompiledTriggerPlan {
  type: WorkspaceTriggerType;
  inputSources: WorkspaceInputSource[];
  sourceFilters: WorkspaceSourceFilter[];
  intervalMs?: number;
  conditionalMode?: ConditionalTriggerMode;
  conditionWorkspaceId?: string;
  safety: CompiledTriggerSafety;
}

export interface CompiledManifestV2 {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  metadata: {
    author?: string;
    description?: string;
    versionFileUrl?: string;
    versionFileSignatureUrl?: string;
    downloadUrl?: string;
    publicKeyLocateValue?: string;
    created_at: number;
  };
  trigger: WorkspaceTrigger;
}

export interface CompiledBuilderMetadataV2 {
  urlAlchemistVersion: string;
  buildTimeUtc: number;
  builderUuid: string;
}

export type GraphVmInstruction =
  | {
      op: 'SOURCE';
      nodeId: string;
      source: string;
      output: string;
      dataType: GraphDataType;
      risk: RiskLevel;
    }
  | {
      op: 'REGEX_TRANSFORM';
      nodeId: string;
      input?: string;
      output: string;
      pattern: string;
      action: ActionType;
      matchMode: MatchMode;
      nthOccurrence?: number;
      payload: string;
      payloadInput?: string;
      payloadVars: boolean;
    }
  | {
      op: 'FETCH_GET';
      nodeId: string;
      url?: string;
      output: string;
      fallbackUrl: string;
      outputDataType: GraphDataType;
      timeoutMs: number;
      maxBytes: number;
    }
  | {
      op: 'HTTP_REQUEST';
      nodeId: string;
      url?: string;
      body?: string;
      output: string;
      method: 'GET' | 'POST';
      fallbackUrl: string;
      outputDataType: GraphDataType;
      timeoutMs: number;
      maxBytes: number;
    }
  | {
      op: 'SYSTEM_DATA';
      nodeId: string;
      output: string;
      mode: SystemDataMode;
    }
  | {
      op: 'USER_INTERACTION';
      nodeId: string;
      output: string;
      interaction: UserInteractionKind;
      message: string;
      placeholder?: string;
      defaultValue?: string;
      minValue?: number;
      maxValue?: number;
    }
  | {
      op: 'GET_ASSET';
      nodeId: string;
      url?: string;
      output: string;
      fallbackUrl: string;
      kind: AssetFetchKind;
      embedded?: AssetRef;
      timeoutMs: number;
      maxBytes: number;
    }
  | {
      op: 'DISPLAY';
      nodeId: string;
      input?: string;
      asset?: string;
      output?: string;
      displayType: 'message' | 'image' | 'video' | 'sound' | 'arcade-game';
      message: string;
      mode: DisplayMode;
      stopMode?: ShowImageStopMode;
      timeoutMs?: number;
      gamePreset?: ArcadeGamePreset;
      captureKeyboard?: boolean;
      captureMouse?: boolean;
    }
  | {
      op: 'COMPARE';
      nodeId: string;
      input?: string;
      output: string;
      operator: NonNullable<WorkspaceBlockSettings['operator']>;
      compareValue: string;
      booleanOutput: boolean;
    }
  | {
      op: 'MATH';
      nodeId: string;
      left?: string;
      right?: string;
      output: string;
      operation: NonNullable<WorkspaceBlockSettings['mathOperation']>;
      fallbackLeft: string;
      fallbackRight: string;
    }
  | {
      op: 'CONVERT';
      nodeId: string;
      input?: string;
      output: string;
      mode: NonNullable<WorkspaceBlockSettings['convertMode']>;
      rounding?: WorkspaceBlockSettings['rounding'];
      ord?: boolean;
    }
  | {
      op: 'DECLARE';
      nodeId: string;
      name: string;
      value?: string;
      fallbackValue: string;
    }
  | {
      op: 'SAVELOAD';
      nodeId: string;
      key?: string;
      value?: string;
      output?: string;
      mode: NonNullable<WorkspaceBlockSettings['saveLoadMode']>;
      fallbackKey: string;
    }
  | {
      op: 'DICT_SET';
      nodeId: string;
      dict?: string;
      key?: string;
      value?: string;
      output: string;
      fallbackDictName: string;
      fallbackKey: string;
    }
  | {
      op: 'LOOP';
      nodeId: string;
      input?: string;
      count?: string;
      output: string;
      loopLimit: number;
    }
  | {
      op: 'OUTPUT';
      nodeId: string;
      input?: string;
      destination: string;
      dataType: GraphDataType;
      risk: RiskLevel;
    };

export interface GraphVmSafetyRule {
  nodeId: string;
  op: GraphVmInstruction['op'];
  requiresWatchdog: boolean;
  maxRuntimeMs?: number;
  maxBytes?: number;
  rangeCheck?: string;
}

export interface GraphVmSafetyPolicy {
  abortOnFailure: boolean;
  regexTimeoutMs: number;
  remoteTimeoutMs: number;
  remoteMaxBytes: number;
  rules: GraphVmSafetyRule[];
}

export interface GraphVmProgram {
  instructions: GraphVmInstruction[];
  constants: Record<string, GraphValue>;
  symbolTable: Record<string, GraphDataType>;
  stepBudget: number;
  loopBudget: number;
  valueByteLimit: number;
  safety: GraphVmSafetyPolicy;
}

export interface CompiledActionPackV2 {
  kind: 'action-pack.v2';
  schemaVersion: typeof ACTION_PACK_SCHEMA_VERSION;
  manifest: CompiledManifestV2;
  sourceWorkspaceId?: string;
  builder: CompiledBuilderMetadataV2;
  risk: CompiledRiskSummary;
  triggerPlan: CompiledTriggerPlan;
  requiredPermissions: string[];
  vm: GraphVmProgram;
  checksumHex?: string;
  traceEnabledUntil?: number;
}

export interface GraphCompileResult {
  ok: boolean;
  workspace: WorkspaceFileV2;
  validation: WorkspaceValidationState;
  pack?: CompiledActionPackV2;
}

export type ImportedV2Artifact =
  | { kind: 'workspace'; workspace: WorkspaceFileV2; checksumHex: string; schemaVersion: number }
  | { kind: 'action-pack'; pack: CompiledActionPackV2; checksumHex: string; schemaVersion: number }
  | { kind: 'legacy-urlpack'; pack: ActionPack; checksumHex: string; schemaVersion: number };
