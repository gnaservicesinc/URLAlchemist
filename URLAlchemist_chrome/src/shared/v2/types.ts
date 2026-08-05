import type { ActionPack, ActionPackLogSeverity, ActionType, MatchMode, WorkspaceTriggerType } from '../types';

export const WORKSPACE_SCHEMA_VERSION = 9;
export const PREVIOUS_WORKSPACE_SCHEMA_VERSION = 8;
export const LEGACY_WORKSPACE_SCHEMA_VERSION = 7;
export const OLDER_WORKSPACE_SCHEMA_VERSION = 6;
export const ANCIENT_WORKSPACE_SCHEMA_VERSION = 5;
export const EARLIEST_WORKSPACE_SCHEMA_VERSION = 4;
export const PRE_V2_WORKSPACE_SCHEMA_VERSION = 3;
export const ACTION_PACK_SCHEMA_VERSION = 9;
export const PREVIOUS_ACTION_PACK_SCHEMA_VERSION = 8;
export const LEGACY_ACTION_PACK_SCHEMA_VERSION = 7;
export const OLDER_ACTION_PACK_SCHEMA_VERSION = 6;
export const ANCIENT_ACTION_PACK_SCHEMA_VERSION = 5;
export const EARLIEST_ACTION_PACK_SCHEMA_VERSION = 4;
export const PRE_V2_ACTION_PACK_SCHEMA_VERSION = 3;
export const SUPPORTED_WORKSPACE_SCHEMA_VERSIONS = [
  WORKSPACE_SCHEMA_VERSION,
  PREVIOUS_WORKSPACE_SCHEMA_VERSION,
  LEGACY_WORKSPACE_SCHEMA_VERSION,
  OLDER_WORKSPACE_SCHEMA_VERSION,
  ANCIENT_WORKSPACE_SCHEMA_VERSION,
  EARLIEST_WORKSPACE_SCHEMA_VERSION,
  PRE_V2_WORKSPACE_SCHEMA_VERSION,
] as const;
export const SUPPORTED_ACTION_PACK_SCHEMA_VERSIONS = [
  ACTION_PACK_SCHEMA_VERSION,
  PREVIOUS_ACTION_PACK_SCHEMA_VERSION,
  LEGACY_ACTION_PACK_SCHEMA_VERSION,
  OLDER_ACTION_PACK_SCHEMA_VERSION,
  ANCIENT_ACTION_PACK_SCHEMA_VERSION,
  EARLIEST_ACTION_PACK_SCHEMA_VERSION,
  PRE_V2_ACTION_PACK_SCHEMA_VERSION,
] as const;
export const INPUT_TRIGGER_HISTORY_LIMIT = 25;
export const INPUT_TRIGGER_BURST_LIMIT = 10;
export const INPUT_TRIGGER_BURST_WINDOW_MS = 1_000;
export const MIN_INTERVAL_TRIGGER_MS = 30_000;
export const DEFAULT_INTERVAL_TRIGGER_MS = 60_000;
export const DEFAULT_REMOTE_TIMEOUT_MS = 5_000;
export const DEFAULT_REMOTE_MAX_BYTES = 128 * 1024;
export const DEFAULT_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const MAX_ASSET_MAX_BYTES = 50 * 1024 * 1024;

export type GraphDataType =
  | 'bool'
  | 'number'
  | 'floatingPoint'
  | 'string'
  | 'URL'
  | 'JSON'
  | 'data'
  | 'list'
  | 'dict'
  | 'asset'
  | 'Any';

export type AssetKind = 'image' | 'video' | 'audio' | 'unknown';
export type AssetSource = 'remote' | 'embedded' | 'picked-file' | 'resource';

export interface AssetRef {
  source: AssetSource;
  kind: AssetKind;
  mimeType: string;
  url?: string;
  resourceId?: string;
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
  | { type: 'list'; value: string[] }
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
  OverlayInput: 26,
  OnTriggerEvent: 27,
  KeyboardIn: 28,
  MouseIn: 29,
  OverlayTickIn: 30,
  OverlayControl: 31,
  OverlayDraw: 32,
  Sleep: 33,
  SharedState: 34,
  DictGet: 35,
  ListOperation: 36,
  ConditionSelect: 37,
  RandomNumber: 38,
  Constant: 39,
  SaveStringToLog: 40,
  Abort: 41,
  Substitution: 42,
  TextTransform: 43,
  TextSplitJoin: 44,
  UrlQuery: 45,
  DictOperation: 46,
  ConditionOut: 47,
  ContentDataIn: 48,
  DecisionOut: 49,
  ChallengeTimer: 50,
  ChallengeTyper: 51,
  ChallengeClicker: 52,
  ChallengeConfirm: 53,
  ChallengeReason: 54,
  ChallengeComplete: 55,
  LogicalFlow: 56,
  CustomBlock: 57,
  CustomBlockInput: 58,
  CustomBlockOutput: 59,
  AddStringToList: 60,
  CheckListForUrl: 61,
} as const;

export type BlockKind = keyof typeof BLOCK_TYPE_IDS;
export type BlockTypeId = (typeof BLOCK_TYPE_IDS)[BlockKind];
export type RiskLevel = 'safe' | 'extended' | 'high';

export const CUSTOM_BLOCK_CATEGORY_VALUES = [
  'flow',
  'logic',
  'regex',
  'math',
  'storage',
  'convert',
  'data',
  'interaction',
  'media',
  'debug',
  'content-blocker',
] as const;

export type CustomBlockCategory = (typeof CUSTOM_BLOCK_CATEGORY_VALUES)[number];

export function isCustomBlockCategory(value: unknown): value is CustomBlockCategory {
  return typeof value === 'string' && (CUSTOM_BLOCK_CATEGORY_VALUES as readonly string[]).includes(value);
}

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
  category: 'flow' | 'logic' | 'regex' | 'math' | 'storage' | 'convert' | 'data' | 'interaction' | 'media' | 'debug' | 'content-blocker' | 'custom';
  description?: string;
  tips?: string[];
  custom?: {
    blockId: string;
    version: number;
    sourceWorkspaceId?: string;
  };
  visibleWorkspaceTypes?: WorkspaceType[];
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
  profile?: 'standard' | 'content-blocker';
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
  firefoxAndroid?: WorkspaceCompatibilityTarget;
}

export type WorkspaceInputSource =
  | 'url'
  | 'linkUrl'
  | 'selectedText'
  | 'pageTitle'
  | 'pageMetadata'
  | 'secondsOnPage'
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
export type GraphEventHandler = 'trigger' | 'keyboard' | 'mouse' | 'tick';
export type OverlayControlAction = 'START' | 'STOP' | 'TOGGLE' | 'STATUS';
export type SharedStateMode = 'GET' | 'SET' | 'DELETE' | 'EXISTS';
export type ListOperationMode = 'APPEND' | 'PREPEND' | 'DROP_LAST' | 'GET' | 'LENGTH' | 'CONTAINS_POINT';
export type ListValueType = 'string' | 'URL';
export type TextTransformMode =
  | 'TRIM'
  | 'COLLAPSE_WHITESPACE'
  | 'NORMALIZE_LINE_ENDINGS'
  | 'STRIP_CONTROL_CHARS'
  | 'UPPERCASE'
  | 'LOWERCASE'
  | 'TITLE_CASE'
  | 'URL_ENCODE'
  | 'URL_DECODE';
export type TextSplitJoinMode =
  | 'SPLIT_LINES'
  | 'SPLIT_WHITESPACE'
  | 'SPLIT_COMMA'
  | 'SPLIT_CUSTOM'
  | 'JOIN_LINES'
  | 'JOIN_SPACE'
  | 'JOIN_COMMA'
  | 'JOIN_CUSTOM';
export type UrlQueryMode =
  | 'PARSE'
  | 'GET_PARAM'
  | 'SET_PARAM'
  | 'DELETE_PARAM'
  | 'KEEP_PARAMS'
  | 'SORT_PARAMS'
  | 'REBUILD';
export type DictOperationMode = 'MERGE' | 'DELETE_KEY' | 'HAS_KEY' | 'KEYS' | 'VALUES';
export type WorkspaceType = 'data-modifier' | 'content-blocker' | 'custom-block';
export type ContentBlockerSurfaceId = 'page-load' | 'recurring' | 'challenge';
export type ContentBlockerChallengeTaskKind = 'timer' | 'typer' | 'clicker' | 'confirm' | 'reason';

export type OverlayRuntimeEvent =
  | {
      kind: 'trigger';
      hotkey?: string;
      url?: string;
    }
  | {
      kind: 'keyboard';
      eventType: 'keydown' | 'keyup';
      key: string;
      code: string;
      keyCode: number;
      repeat?: boolean;
    }
  | {
      kind: 'mouse';
      eventType: 'pointermove' | 'pointerdown' | 'pointerup' | 'pointerleave';
      button: number;
      buttons: number;
      x: number;
      y: number;
    }
  | {
      kind: 'tick';
      tick: number;
      deltaMs: number;
    }
  | {
      kind: 'close';
      reason: string;
    };

export interface WorkspaceBlockSettings {
  label?: string;
  locked?: boolean;
  collapsed?: boolean;
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
  assetResourceId?: string;
  assetDataBase64?: string;
  assetCompression?: 'gzip' | 'none';
  systemDataMode?: SystemDataMode;
  promptTitle?: string;
  promptMessage?: string;
  promptPlaceholder?: string;
  promptDefaultValue?: string;
  minValue?: number;
  maxValue?: number;
  displayMode?: DisplayMode;
  imageStopMode?: ShowImageStopMode;
  displayTimeoutMs?: number;
  requireUserGesture?: boolean;
  captureKeyboard?: boolean;
  captureMouse?: boolean;
  payloadVars?: boolean;
  regexBuilder?: WorkspaceRegexBuilderState;
  regexSourceMode?: WorkspaceRegexSourceMode;
  regexHelperInput?: string;
  operator?: 'LT' | 'LTE' | 'EQ' | 'NEQ' | 'GT' | 'GTE';
  compareValue?: string;
  booleanOutput?: boolean;
  mathOperation?: 'ADD' | 'SUBTRACT' | 'MULTIPLY' | 'DIVIDE' | 'MODULO';
  convertMode?:
    | 'FLOAT_TO_NUMBER'
    | 'STRING_TO_URL'
    | 'DICT_TO_JSON'
    | 'JSON_TO_DICT'
    | 'NUMBER_TO_BOOL'
    | 'NUMBER_TO_STRING'
    | 'DATA_TO_STRING';
  convertOrd?: boolean;
  rounding?: 'FLOOR' | 'CEIL' | 'ROUND';
  variableName?: string;
  literalValue?: string;
  literalDataType?: GraphDataType;
  literalListType?: ListValueType;
  saveLoadMode?: 'SAVE' | 'EXISTS' | 'GET';
  dictKey?: string;
  listVariableName?: string;
  loopLimit?: number;
  outputDestination?: string;
  sharedStateMode?: SharedStateMode;
  listOperation?: ListOperationMode;
  overlayControlAction?: OverlayControlAction;
  overlayWidth?: number;
  overlayHeight?: number;
  overlayCellSize?: number;
  overlayTickMs?: number;
  overlayBackground?: string;
  overlayText?: string;
  sleepMs?: number;
  logSeverity?: ActionPackLogSeverity;
  abortMessage?: string;
  substitutionTemplate?: string;
  substitutionInputCount?: number;
  randomMin?: number;
  randomMax?: number;
  selectTrueValue?: string;
  selectFalseValue?: string;
  textTransformMode?: TextTransformMode;
  splitJoinMode?: TextSplitJoinMode;
  splitJoinSeparator?: string;
  urlQueryMode?: UrlQueryMode;
  urlQueryKey?: string;
  urlQueryValue?: string;
  urlQueryParams?: string;
  dictOperationMode?: DictOperationMode;
  challengeSeconds?: number;
  challengeText?: string;
  challengeCount?: number;
  contentBlockerMatchDecision?: 1 | 2;
  logicalFlowGroupId?: string;
  logicalFlowRole?: 'condition' | 'control';
  customBlockId?: string;
  customBlockName?: string;
  customBlockVersion?: number;
  customBlockInputs?: CustomBlockPortDefinition[];
  customBlockOutputs?: CustomBlockPortDefinition[];
  customBlockFields?: CustomBlockFieldDefinition[];
  customPortId?: string;
  customPortLabel?: string;
  customPortDataType?: GraphDataType;
  customPortTooltip?: string;
  customFieldValues?: Record<string, string>;
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

export interface WorkspaceGraphSurface {
  id: ContentBlockerSurfaceId;
  label: string;
  nodes: WorkspaceNodeV2[];
  edges: WorkspaceEdgeV2[];
  viewport: WorkspaceViewport;
}

export interface ContentBlockerWorkspaceConfig {
  lockLevel: ActionPackLockLevel;
  allowLockIncrease: boolean;
  recurringIntervalSeconds: number;
  blockPageTitle: string;
  blockPageMessage: string;
  challengePageTitle: string;
  challengePageMessage: string;
}

export type CustomBlockFieldVisibility = 'visible' | 'advanced' | 'hidden';

export interface CustomBlockFieldDefinition {
  id: string;
  label: string;
  dataType: GraphDataType;
  defaultValue?: string;
  tooltip?: string;
  visibility?: CustomBlockFieldVisibility;
}

export interface CustomBlockPortDefinition {
  id: string;
  label: string;
  dataType: GraphDataType;
  tooltip?: string;
}

export interface WorkspaceCustomBlockDefinition {
  blockId: string;
  label: string;
  version: number;
  category: BlockDefinition['category'] | '';
  visibleWorkspaceTypes: WorkspaceType[];
  description?: string;
  tips?: string[];
  inputs: CustomBlockPortDefinition[];
  outputs: CustomBlockPortDefinition[];
  fields: CustomBlockFieldDefinition[];
}

export interface WorkspaceEmbeddedCustomBlock {
  blockId: string;
  version: number;
  checksumHex?: string;
  workspace: WorkspaceFileV2;
  installedVersion?: number;
  useEmbedded?: boolean;
}

export interface WorkspaceLogicalFlowGroup {
  id: string;
  conditionNodeId: string;
  controlNodeId: string;
  depth: number;
  locked?: boolean;
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
  workspaceType: WorkspaceType;
  metadata: WorkspaceMetadata;
  trigger: WorkspaceTrigger;
  nodes: WorkspaceNodeV2[];
  edges: WorkspaceEdgeV2[];
  surfaces?: WorkspaceGraphSurface[];
  contentBlocker?: ContentBlockerWorkspaceConfig;
  assets?: AssetRef[];
  viewport: WorkspaceViewport;
  logicalFlows?: WorkspaceLogicalFlowGroup[];
  customBlock?: WorkspaceCustomBlockDefinition;
  embeddedCustomBlocks?: WorkspaceEmbeddedCustomBlock[];
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
  conditionVm?: GraphVmProgram;
  conditionOutput?: string;
  conditionStateKey?: string;
  safety: CompiledTriggerSafety;
}

export interface ContentBlockerDecisionProgram {
  surfaceId: Extract<ContentBlockerSurfaceId, 'page-load' | 'recurring'>;
  vm: GraphVmProgram;
  output: string;
}

export interface ContentBlockerChallengeTask {
  id: string;
  kind: ContentBlockerChallengeTaskKind;
  label: string;
  seconds?: number;
  text?: string;
  count?: number;
}

export interface ContentBlockerInstallConfig {
  pageLoad: ContentBlockerDecisionProgram;
  recurring?: ContentBlockerDecisionProgram;
  recurringIntervalSeconds: number;
  challengeTitle: string;
  challengeMessage: string;
  blockTitle: string;
  blockMessage: string;
  challengeTasks: ContentBlockerChallengeTask[];
  allowLockIncrease: boolean;
  blockCount?: number;
  challengeCount?: number;
  lastBlockedAt?: number;
  lastChallengedAt?: number;
}

export interface CompiledManifestV2 {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  metadata: {
    author?: string;
    description?: string;
    created_at: number;
    workspaceType?: WorkspaceType;
  };
  trigger: WorkspaceTrigger;
}

export interface CompiledBuilderMetadataV2 {
  urlAlchemistVersion: string;
  buildTimeUtc: number;
  builderUuid: string;
}

export type GraphVmInstruction = (
  {
      op: 'SOURCE';
      nodeId: string;
      source: string;
      output: string;
      dataType: GraphDataType;
      risk: RiskLevel;
    }
	  | {
	      op: 'CONSTANT';
	      nodeId: string;
	      output: string;
	      value: GraphValue;
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
      messageInput?: string;
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
      titleInput?: string;
      asset?: string;
      output?: string;
      displayType: 'message' | 'image' | 'video' | 'sound' | 'input-capture';
      title?: string;
      message: string;
      mode: DisplayMode;
      stopMode?: ShowImageStopMode;
      timeoutMs?: number;
      captureKeyboard?: boolean;
      captureMouse?: boolean;
    }
  | {
      op: 'COMPARE';
      nodeId: string;
      input?: string;
      output: string;
      operator: NonNullable<WorkspaceBlockSettings['operator']>;
      compareInput?: string;
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
      fallbackValue: GraphValue;
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
	      op: 'SLEEP';
	      nodeId: string;
	      duration?: string;
	      enabled?: string;
	      output?: string;
	      fallbackMs: number;
	    }
	  | {
	      op: 'SHARED_STATE';
	      nodeId: string;
	      key?: string;
	      value?: string;
	      enabled?: string;
	      output?: string;
	      mode: SharedStateMode;
	      fallbackKey: string;
	      fallbackValue: GraphValue;
	      fallbackRaw?: string;
	    }
	  | {
	      op: 'DICT_GET';
	      nodeId: string;
	      dict?: string;
	      key?: string;
	      output: string;
	      fallbackKey: string;
	      fallbackValue: GraphValue;
	    }
	  | {
	      op: 'LIST_OP';
	      nodeId: string;
	      list?: string;
	      item?: string;
	      index?: string;
	      output: string;
	      operation: ListOperationMode;
	      fallbackList: GraphValue;
	      fallbackItem: GraphValue;
	    }
	  | {
	      op: 'ADD_STRING_TO_LIST';
	      nodeId: string;
	      list?: string;
	      item?: string;
	      output: string;
	      fallbackList: GraphValue;
	      fallbackItem: GraphValue;
	      variableName: string;
	    }
	  | {
	      op: 'CHECK_LIST_FOR_URL';
	      nodeId: string;
	      url?: string;
	      list?: string;
	      output: string;
	      fallbackUrl: string;
	      fallbackList: GraphValue;
	      matchDecision: 1 | 2;
	    }
	  | {
	      op: 'SELECT';
	      nodeId: string;
	      condition?: string;
	      trueValue?: string;
	      falseValue?: string;
	      output: string;
	      fallbackTrue: GraphValue;
	      fallbackFalse: GraphValue;
	    }
  | {
      op: 'BRANCH';
      nodeId: string;
      condition?: string;
      input?: string;
      trueOutput: string;
      falseOutput: string;
      fallbackInput: GraphValue;
    }
	  | {
	      op: 'RANDOM_INT';
	      nodeId: string;
	      min?: string;
	      max?: string;
	      output: string;
	      fallbackMin: number;
	      fallbackMax: number;
	    }
	  | {
	      op: 'SUBSTITUTE';
	      nodeId: string;
	      output: string;
	      template: string;
	      values: string[];
	    }
	  | {
	      op: 'TEXT_TRANSFORM';
	      nodeId: string;
	      input?: string;
	      output: string;
	      mode: TextTransformMode;
	    }
	  | {
	      op: 'TEXT_SPLIT_JOIN';
	      nodeId: string;
	      input?: string;
	      output: string;
	      mode: TextSplitJoinMode;
	      separator: string;
	    }
	  | {
	      op: 'URL_QUERY';
	      nodeId: string;
	      input?: string;
	      key?: string;
	      value?: string;
	      output: string;
	      mode: UrlQueryMode;
	      fallbackKey: string;
	      fallbackValue: string;
	      fallbackParams: string;
	    }
	  | {
	      op: 'DICT_OP';
	      nodeId: string;
	      dict?: string;
	      other?: string;
	      key?: string;
	      output: string;
	      mode: DictOperationMode;
	      fallbackKey: string;
	    }
	  | {
      op: 'CONDITION_OUT';
      nodeId: string;
      condition?: string;
      output: string;
    }
  | {
      op: 'DECISION_OUT';
      nodeId: string;
      decision?: string;
      output: string;
    }
	  | {
	      op: 'LOG';
	      nodeId: string;
	      message?: string;
	      output?: string;
	      severity: ActionPackLogSeverity;
	      fallbackMessage: string;
	    }
	  | {
	      op: 'ABORT';
	      nodeId: string;
	      condition?: string;
	      output?: string;
	      message: string;
	    }
	  | {
	      op: 'OVERLAY_CONTROL';
	      nodeId: string;
	      enabled?: string;
	      messageInput?: string;
	      output?: string;
	      action: OverlayControlAction;
	      message: string;
	      width: number;
	      height: number;
	      cellSize: number;
	      tickMs: number;
	      background: string;
	    }
	  | {
	      op: 'OVERLAY_DRAW';
	      nodeId: string;
	      enabled?: string;
	      cells?: string;
	      text?: string;
	      output?: string;
	      width: number;
	      height: number;
	      cellSize: number;
	      background: string;
	    }
  | {
      op: 'CUSTOM_INPUT';
      nodeId: string;
      inputId: string;
      output: string;
      fallback: GraphValue;
    }
  | {
      op: 'CUSTOM_OUTPUT';
      nodeId: string;
      outputId: string;
      value?: string;
      fallback: GraphValue;
    }
  | {
      op: 'CUSTOM_BLOCK';
      nodeId: string;
      blockId: string;
      version: number;
      inputSymbols: Record<string, string | undefined>;
      outputSymbols: Record<string, string>;
      program: GraphVmProgram;
      inputDefaults: Record<string, GraphValue>;
      outputIds: string[];
    }
	  | {
	      op: 'OUTPUT';
	      nodeId: string;
      input?: string;
      destination: string;
      dataType: GraphDataType;
      risk: RiskLevel;
    }
) & {
  guard?: string;
  guardExpected?: 0 | 1;
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
  eventHandlers?: Partial<Record<GraphEventHandler, GraphVmInstruction[]>>;
  constants: Record<string, GraphValue>;
  symbolTable: Record<string, GraphDataType>;
  stepBudget: number;
  loopBudget: number;
  valueByteLimit: number;
  safety: GraphVmSafetyPolicy;
}

export interface CompiledCustomBlockV2 {
  kind: 'custom-block.v2';
  schemaVersion: typeof ACTION_PACK_SCHEMA_VERSION;
  blockId: string;
  label: string;
  version: number;
  category: BlockDefinition['category'];
  description?: string;
  tips?: string[];
  visibleWorkspaceTypes: WorkspaceType[];
  inputs: CustomBlockPortDefinition[];
  outputs: CustomBlockPortDefinition[];
  fields: CustomBlockFieldDefinition[];
  sourceWorkspaceId: string;
  sourceWorkspace?: WorkspaceFileV2;
  sourceChecksumHex?: string;
  vm: GraphVmProgram;
  risk: CompiledRiskSummary;
  installedAt: number;
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
  embeddedCustomBlocks?: WorkspaceEmbeddedCustomBlock[];
  checksumHex?: string;
  traceEnabledUntil?: number;
  install?: ActionPackInstallMetadata;
}

export type ActionPackSource = 'user-created' | 'bundled' | 'imported' | 'legacy-converted' | 'content-blocker' | 'focus-guard';
export type TrustStatus = 'trusted' | 'review' | 'modified' | 'blocked' | 'user-reviewed';
export type ActionPackLockLevel = 0 | 1 | 2 | 3;

export interface ActionPackLockState {
  locked: boolean;
  level: ActionPackLockLevel;
  createdAt: number;
  updatedAt: number;
  challengeText?: string;
  passwordSaltBase64?: string;
  passwordHashBase64?: string;
  note?: string;
}

export interface FocusGuardConfig {
  blockedPatterns: string[];
  allowPatterns: string[];
  pageTitle: string;
  pageMessage: string;
  resourceIds?: string[];
  blockCount?: number;
  lastBlockedAt?: number;
}

export interface ActionPackInstallMetadata {
  source: ActionPackSource;
  trustStatus: TrustStatus;
  loggingEnabled: boolean;
  installedAt: number;
  artifactChecksumHex?: string;
  bundledHashVerified?: boolean;
  userReview?: {
    reviewedAt: number;
    trustStatus: TrustStatus;
    note?: string;
  };
  lockState?: ActionPackLockState;
  focusGuard?: FocusGuardConfig;
  contentBlocker?: ContentBlockerInstallConfig;
}

export interface GraphCompileResult {
  ok: boolean;
  workspace: WorkspaceFileV2;
  validation: WorkspaceValidationState;
  pack?: CompiledActionPackV2;
  customBlock?: CompiledCustomBlockV2;
}

export type ImportedV2Artifact =
  | { kind: 'workspace'; workspace: WorkspaceFileV2; checksumHex: string; schemaVersion: number }
  | { kind: 'action-pack'; pack: CompiledActionPackV2; checksumHex: string; schemaVersion: number }
  | { kind: 'legacy-urlpack'; pack: ActionPack; checksumHex: string; schemaVersion: number };
