import { ACTION_TYPES, MATCH_MODES } from '../types';
import {
  BLOCK_DEFINITIONS,
  BLOCK_REGISTRY,
  getEffectivePortDefinition,
  getEffectivePortDefinitions,
  isTypeCompatible,
} from './blockRegistry';
import type {
  BlockKind,
  CustomBlockFieldDefinition,
  CustomBlockPortDefinition,
  GraphDataType,
  WorkspaceBlockSettings,
  WorkspaceCompatibilityMetadata,
  WorkspaceCustomBlockDefinition,
  WorkspaceFileV2,
  WorkspaceLogicalFlowGroup,
  WorkspaceTrigger,
  WorkspaceType,
  WorkspaceViewport,
} from './types';
import { BLOCK_TYPE_IDS, CUSTOM_BLOCK_CATEGORY_VALUES, MIN_INTERVAL_TRIGGER_MS, WORKSPACE_SCHEMA_VERSION, isCustomBlockCategory } from './types';
import { migrateWorkspaceFile, validateWorkspaceFile } from './workspace';

export const WORKSPACE_RECIPE_KIND = 'workspace-recipe.v1' as const;
export const WORKSPACE_RECIPE_MAX_BYTES = 512 * 1024;
export const WORKSPACE_RECIPE_MAX_NODES = 200;
export const WORKSPACE_RECIPE_MAX_CONNECTIONS = 500;

const RECIPE_NODE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RECIPE_PORT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CUSTOM_DEFINITION_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RECIPE_WORKSPACE_TYPES = new Set<WorkspaceType>(['data-modifier', 'custom-block']);
const RECIPE_TRIGGER_TYPES = ['INPUT_DATA', 'HOTKEY', 'CONTEXT_MENU', 'INTERVAL', 'NEVER'] as const;
const CONTENT_BLOCKER_ONLY_RECIPE_BLOCKS = new Set<BlockKind>([
  'ContentDataIn',
  'DecisionOut',
  'ChallengeTimer',
  'ChallengeTyper',
  'ChallengeClicker',
  'ChallengeConfirm',
  'ChallengeReason',
  'ChallengeComplete',
]);
const WORKSPACE_TYPES = ['data-modifier', 'content-blocker', 'custom-block'] as const;
const WORKSPACE_INPUT_SOURCES = [
  'url', 'linkUrl', 'selectedText', 'pageTitle', 'pageMetadata', 'secondsOnPage', 'clipboard',
  'pageText', 'rawHtml', 'mediaData', 'pageLinks', 'jsMetadata', 'consoleOutput',
] as const;
const GRAPH_DATA_TYPES = ['bool', 'number', 'floatingPoint', 'string', 'URL', 'JSON', 'data', 'list', 'dict', 'asset', 'Any'] as const;
const RECIPE_TRIGGER_KEYS = new Set([
  'type',
  'hotkey',
  'inputSources',
  'sourceFilters',
  'intervalMs',
  'conditionalMode',
  'conditionWorkspaceId',
]);
const RECIPE_SETTING_KEYS = new Set<keyof WorkspaceBlockSettings>([
  'label',
  'locked',
  'collapsed',
  'alwaysProcess',
  'processBeforeRun',
  'pattern',
  'action',
  'matchMode',
  'nthOccurrence',
  'payload',
  'remoteUrl',
  'remoteDataType',
  'remoteMethod',
  'remoteTimeoutMs',
  'remoteMaxBytes',
  'assetUrl',
  'assetKind',
  'assetMimeType',
  'assetName',
  'assetCompression',
  'systemDataMode',
  'promptTitle',
  'promptMessage',
  'promptPlaceholder',
  'promptDefaultValue',
  'minValue',
  'maxValue',
  'displayMode',
  'imageStopMode',
  'displayTimeoutMs',
  'requireUserGesture',
  'captureKeyboard',
  'captureMouse',
  'payloadVars',
  'regexBuilder',
  'regexSourceMode',
  'regexHelperInput',
  'operator',
  'compareValue',
  'booleanOutput',
  'mathOperation',
  'convertMode',
  'convertOrd',
  'rounding',
  'variableName',
  'literalValue',
  'literalDataType',
  'literalListType',
  'saveLoadMode',
  'dictKey',
  'listVariableName',
  'loopLimit',
  'outputDestination',
  'sharedStateMode',
  'listOperation',
  'overlayControlAction',
  'overlayWidth',
  'overlayHeight',
  'overlayCellSize',
  'overlayTickMs',
  'overlayBackground',
  'overlayText',
  'sleepMs',
  'logSeverity',
  'abortMessage',
  'substitutionTemplate',
  'substitutionInputCount',
  'randomMin',
  'randomMax',
  'selectTrueValue',
  'selectFalseValue',
  'textTransformMode',
  'splitJoinMode',
  'splitJoinSeparator',
  'urlQueryMode',
  'urlQueryKey',
  'urlQueryValue',
  'urlQueryParams',
  'dictOperationMode',
  'challengeSeconds',
  'challengeText',
  'challengeCount',
  'contentBlockerMatchDecision',
  'customBlockId',
  'customBlockName',
  'customBlockVersion',
  'customBlockInputs',
  'customBlockOutputs',
  'customBlockFields',
  'customPortId',
  'customPortLabel',
  'customPortDataType',
  'customPortTooltip',
  'customFieldValues',
]);
const RECIPE_FORBIDDEN_SETTING_KEYS = new Set<keyof WorkspaceBlockSettings>([
  'assetDataBase64',
  'assetResourceId',
  'logicalFlowGroupId',
  'logicalFlowRole',
]);

const COMMON_RECIPE_SETTING_KEYS: ReadonlyArray<keyof WorkspaceBlockSettings> = [
  'label', 'locked', 'collapsed',
];

const EXTRA_RECIPE_SETTING_KEYS: Partial<Record<BlockKind, ReadonlyArray<keyof WorkspaceBlockSettings>>> = {
  RegExpression: ['regexBuilder', 'regexSourceMode', 'regexHelperInput'],
  Math: ['compareValue'],
  Declarations: ['literalListType'],
  PromptNumber: ['promptPlaceholder', 'minValue', 'maxValue'],
  ShowMessage: ['displayTimeoutMs'],
  GetImage: ['assetMimeType', 'assetName'],
  GetVideo: ['assetMimeType', 'assetName'],
  GetAudio: ['assetMimeType', 'assetName'],
  SaveLoad: ['alwaysProcess'],
  SharedState: ['selectFalseValue', 'literalDataType', 'alwaysProcess'],
  ListOperation: ['selectTrueValue'],
  AddStringToList: ['selectTrueValue'],
  LogicalFlow: ['literalValue', 'literalDataType'],
  CheckListForUrl: ['urlQueryValue'],
  CustomBlock: [
    'customBlockId', 'customBlockName', 'customBlockVersion', 'customBlockInputs',
    'customBlockOutputs', 'customBlockFields', 'customFieldValues',
  ],
  OverlayControl: ['overlayText'],
};

const STRING_SETTING_KEYS = new Set<keyof WorkspaceBlockSettings>([
  'label', 'pattern', 'payload', 'remoteUrl', 'assetUrl', 'assetMimeType', 'assetName',
  'promptTitle', 'promptMessage', 'promptPlaceholder', 'promptDefaultValue', 'regexHelperInput',
  'compareValue', 'variableName', 'literalValue', 'dictKey', 'listVariableName', 'outputDestination',
  'overlayBackground', 'overlayText', 'abortMessage', 'substitutionTemplate', 'selectTrueValue',
  'selectFalseValue', 'splitJoinSeparator', 'urlQueryKey', 'urlQueryValue', 'urlQueryParams',
  'challengeText', 'customBlockId', 'customBlockName', 'customPortId', 'customPortLabel', 'customPortTooltip',
]);

const BOOLEAN_SETTING_KEYS = new Set<keyof WorkspaceBlockSettings>([
  'locked', 'collapsed', 'alwaysProcess', 'processBeforeRun', 'requireUserGesture', 'captureKeyboard',
  'captureMouse', 'payloadVars', 'booleanOutput', 'convertOrd',
]);

const NUMBER_SETTING_SCHEMAS: Partial<Record<keyof WorkspaceBlockSettings, { min?: number; max?: number; integer?: boolean }>> = {
  nthOccurrence: { min: 1, integer: true },
  remoteTimeoutMs: { min: 500, max: 30_000, integer: true },
  remoteMaxBytes: { min: 1, max: 50 * 1024 * 1024, integer: true },
  minValue: {},
  maxValue: {},
  displayTimeoutMs: { min: 0, max: 3_600_000, integer: true },
  loopLimit: { min: 1, max: 100, integer: true },
  overlayWidth: { min: 1, max: 200, integer: true },
  overlayHeight: { min: 1, max: 200, integer: true },
  overlayCellSize: { min: 4, max: 96, integer: true },
  overlayTickMs: { min: 16, max: 5_000, integer: true },
  sleepMs: { min: 0, max: 60_000, integer: true },
  substitutionInputCount: { min: 1, max: 24, integer: true },
  randomMin: {},
  randomMax: {},
  challengeSeconds: { min: 1, max: 3_600, integer: true },
  challengeCount: { min: 1, max: 1_000, integer: true },
  customBlockVersion: { min: 1, integer: true },
};

const ENUM_SETTING_VALUES: Partial<Record<keyof WorkspaceBlockSettings, readonly (string | number)[]>> = {
  action: ACTION_TYPES,
  matchMode: MATCH_MODES,
  remoteDataType: ['data', 'string', 'JSON', 'dict'],
  remoteMethod: ['GET', 'POST'],
  assetKind: ['image', 'video', 'audio'],
  assetCompression: ['gzip', 'none'],
  systemDataMode: ['NOW_MS', 'EPOCH_SECONDS', 'ISO_DATE', 'TIMEZONE_OFFSET_MINUTES', 'LOCALE_DATE', 'LOCALE_TIME'],
  displayMode: ['OVERLAY', 'REPLACE_PAGE', 'NEW_TAB'],
  imageStopMode: ['CLOSE_BUTTON', 'CLICK', 'TIMEOUT', 'CONFIRM'],
  regexSourceMode: ['VISUAL', 'MANUAL'],
  operator: ['LT', 'LTE', 'EQ', 'NEQ', 'GT', 'GTE'],
  mathOperation: ['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'MODULO'],
  convertMode: ['FLOAT_TO_NUMBER', 'STRING_TO_URL', 'DICT_TO_JSON', 'JSON_TO_DICT', 'NUMBER_TO_BOOL', 'NUMBER_TO_STRING', 'DATA_TO_STRING'],
  rounding: ['FLOOR', 'CEIL', 'ROUND'],
  literalDataType: GRAPH_DATA_TYPES.filter((value) => value !== 'asset'),
  literalListType: ['string', 'URL'],
  saveLoadMode: ['SAVE', 'EXISTS', 'GET'],
  sharedStateMode: ['GET', 'SET', 'DELETE', 'EXISTS'],
  listOperation: ['APPEND', 'PREPEND', 'DROP_LAST', 'GET', 'LENGTH', 'CONTAINS_POINT'],
  overlayControlAction: ['START', 'STOP', 'TOGGLE', 'STATUS'],
  logSeverity: ['debug', 'info', 'warn', 'error'],
  textTransformMode: ['TRIM', 'COLLAPSE_WHITESPACE', 'NORMALIZE_LINE_ENDINGS', 'STRIP_CONTROL_CHARS', 'UPPERCASE', 'LOWERCASE', 'TITLE_CASE', 'URL_ENCODE', 'URL_DECODE'],
  splitJoinMode: ['SPLIT_LINES', 'SPLIT_WHITESPACE', 'SPLIT_COMMA', 'SPLIT_CUSTOM', 'JOIN_LINES', 'JOIN_SPACE', 'JOIN_COMMA', 'JOIN_CUSTOM'],
  urlQueryMode: ['PARSE', 'GET_PARAM', 'SET_PARAM', 'DELETE_PARAM', 'KEEP_PARAMS', 'SORT_PARAMS', 'REBUILD'],
  dictOperationMode: ['MERGE', 'DELETE_KEY', 'HAS_KEY', 'KEYS', 'VALUES'],
  contentBlockerMatchDecision: [1, 2],
  customPortDataType: GRAPH_DATA_TYPES,
};

const DYNAMIC_PORT_RULES: Partial<Record<BlockKind, string>> = {
  Convert: 'The result type changes with settings.convertMode; use the effective ports described by that mode.',
  Substitution: 'Inputs are value1 through valueN, where N is settings.substitutionInputCount (1-24).',
  FetchData: 'The result type is settings.remoteDataType.',
  HttpRequest: 'The result type is settings.remoteDataType; POST accepts the body input.',
  Constant: 'The value output type is settings.literalDataType.',
  SharedState: 'The result is bool for EXISTS and otherwise Any.',
  ListOperation: 'Inputs and result change with settings.listOperation.',
  TextSplitJoin: 'Inputs and result change with settings.splitJoinMode.',
  UrlQuery: 'Inputs and outputs change with settings.urlQueryMode.',
  DictOperation: 'Inputs and outputs change with settings.dictOperationMode.',
  CustomBlock: 'Invocation ports come from customBlockInputs/customBlockOutputs. AI drafts cannot invoke an installed block unless its exact definition is supplied.',
  CustomBlockInput: 'The value output id and type come from customPortId/customPortDataType.',
  CustomBlockOutput: 'The value input id and type come from customPortId/customPortDataType.',
};

export interface WorkspaceRecipeNodeV1 {
  id: string;
  type: BlockKind;
  position?: { x: number; y: number };
  settings?: WorkspaceBlockSettings;
}

export interface WorkspaceRecipeConnectionV1 {
  from: string;
  to: string;
}

export interface WorkspaceRecipeLogicalFlowV1 {
  id: string;
  conditionNode: string;
  controlNode: string;
  depth?: number;
  locked?: boolean;
}

export interface WorkspaceRecipeV1 {
  kind: typeof WORKSPACE_RECIPE_KIND;
  workspaceType: Extract<WorkspaceType, 'data-modifier' | 'custom-block'>;
  name: string;
  description: string;
  trigger: WorkspaceTrigger;
  nodes: WorkspaceRecipeNodeV1[];
  connections: WorkspaceRecipeConnectionV1[];
  viewport?: WorkspaceViewport;
  logicalFlows?: WorkspaceRecipeLogicalFlowV1[];
  customBlock?: WorkspaceCustomBlockDefinition;
}

export interface MaterializeWorkspaceRecipeOptions {
  id?: string;
  author?: string;
  version?: number;
  createdAt?: number;
  updatedAt?: number;
  compatibility?: WorkspaceCompatibilityMetadata;
  nodeIdPrefix?: string;
}

export interface WorkspaceRecipeContext {
  kind: 'workspace-recipe.context.v1';
  immutableRules: string[];
  recipeShape: Record<string, unknown>;
  blocks: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(record).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported key${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }
}

function assertJsonSafe(value: unknown, label: string, depth = 0): void {
  if (depth > 12) {
    throw new Error(`${label} is nested too deeply.`);
  }
  if (value === null || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || value === undefined) {
    throw new Error(`${label} contains an unsupported value.`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`${label} contains a non-finite number.`);
  }
  if (typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonSafe(entry, `${label}[${index}]`, depth + 1));
    return;
  }
  const record = value as Record<string, unknown>;
  Object.entries(record).forEach(([key, entry]) => {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`${label} contains the unsafe key "${key}".`);
    }
    // JSON.stringify omits undefined object properties. Internal typed recipes
    // can carry optional fields this way before crossing the JSON boundary.
    if (entry === undefined) {
      return;
    }
    assertJsonSafe(entry, `${label}.${key}`, depth + 1);
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parsePosition(value: unknown, label: string): { x: number; y: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, ['x', 'y'], label);
  if (typeof value.x !== 'number' || !Number.isFinite(value.x) || typeof value.y !== 'number' || !Number.isFinite(value.y)) {
    throw new Error(`${label} must contain finite x and y coordinates.`);
  }
  return { x: value.x, y: value.y };
}

type RecipeSettingSchema =
  | { type: 'string'; maxChars: number }
  | { type: 'boolean' }
  | { type: 'number'; min?: number; max?: number; integer?: boolean }
  | { type: 'enum'; values: readonly (string | number)[] }
  | { type: 'regex-builder' }
  | { type: 'custom-ports' }
  | { type: 'custom-fields' }
  | { type: 'string-record' };

function allowedRecipeSettingKeys(blockType: BlockKind): Set<keyof WorkspaceBlockSettings> {
  return new Set([
    ...COMMON_RECIPE_SETTING_KEYS,
    ...Object.keys(BLOCK_REGISTRY[blockType].defaultSettings) as Array<keyof WorkspaceBlockSettings>,
    ...(EXTRA_RECIPE_SETTING_KEYS[blockType] ?? []),
  ]);
}

function recipeSettingSchema(key: keyof WorkspaceBlockSettings, blockType: BlockKind): RecipeSettingSchema | undefined {
  if (STRING_SETTING_KEYS.has(key)) {
    return { type: 'string', maxChars: key === 'label' ? 200 : 16_384 };
  }
  if (BOOLEAN_SETTING_KEYS.has(key)) {
    return { type: 'boolean' };
  }
  if (key === 'remoteMaxBytes' && (blockType === 'FetchData' || blockType === 'HttpRequest')) {
    return { type: 'number', min: 1_024, max: 512 * 1_024, integer: true };
  }
  const numberSchema = NUMBER_SETTING_SCHEMAS[key];
  if (numberSchema) {
    return { type: 'number', ...numberSchema };
  }
  const enumValues = ENUM_SETTING_VALUES[key];
  if (enumValues) {
    return { type: 'enum', values: enumValues };
  }
  if (key === 'regexBuilder') return { type: 'regex-builder' };
  if (key === 'customBlockInputs' || key === 'customBlockOutputs') return { type: 'custom-ports' };
  if (key === 'customBlockFields') return { type: 'custom-fields' };
  if (key === 'customFieldValues') return { type: 'string-record' };
  return undefined;
}

function parseBoundedString(value: unknown, label: string, maxChars: number, required = false): string | undefined {
  if (value === undefined && !required) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maxChars || (required && !value.trim())) {
    throw new Error(`${label} must be ${required ? 'a non-empty ' : 'a '}string no longer than ${maxChars} characters.`);
  }
  return value;
}

function parseRegexBuilder(value: unknown, label: string): NonNullable<WorkspaceBlockSettings['regexBuilder']> {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, ['sampleText', 'selectionStart', 'selectionEnd', 'tokens', 'caseSensitive'], label);
  if (typeof value.sampleText !== 'string' || value.sampleText.length > 16_384) {
    throw new Error(`${label}.sampleText must be a string no longer than 16384 characters.`);
  }
  const sampleText = value.sampleText;
  if (
    !Number.isInteger(value.selectionStart) || !Number.isInteger(value.selectionEnd) ||
    Number(value.selectionStart) < 0 || Number(value.selectionEnd) < Number(value.selectionStart) ||
    Number(value.selectionEnd) > sampleText.length
  ) {
    throw new Error(`${label} has an invalid selection range.`);
  }
  if (!Array.isArray(value.tokens) || value.tokens.length > 256) {
    throw new Error(`${label}.tokens must be an array with at most 256 entries.`);
  }
  const tokenIds = new Set<string>();
  const tokens = value.tokens.map((entry, index) => {
    const tokenLabel = `${label}.tokens[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${tokenLabel} must be an object.`);
    }
    assertOnlyKeys(entry, ['id', 'text', 'mode', 'patternKind'], tokenLabel);
    const id = parseBoundedString(entry.id, `${tokenLabel}.id`, 128, true)!;
    const text = parseBoundedString(entry.text, `${tokenLabel}.text`, 4_096)!;
    if (tokenIds.has(id)) {
      throw new Error(`${label} contains duplicate token id "${id}".`);
    }
    tokenIds.add(id);
    if (entry.mode !== 'EXACT' && entry.mode !== 'FLEXIBLE') {
      throw new Error(`${tokenLabel}.mode is unsupported.`);
    }
    if (!['AUTO', 'NUMBER', 'LETTERS', 'WORD', 'ANY_TEXT'].includes(String(entry.patternKind))) {
      throw new Error(`${tokenLabel}.patternKind is unsupported.`);
    }
    return {
      id,
      text,
      mode: entry.mode as 'EXACT' | 'FLEXIBLE',
      patternKind: entry.patternKind as 'AUTO' | 'NUMBER' | 'LETTERS' | 'WORD' | 'ANY_TEXT',
    };
  });
  if (typeof value.caseSensitive !== 'boolean') {
    throw new Error(`${label}.caseSensitive must be boolean.`);
  }
  return {
    sampleText,
    selectionStart: Number(value.selectionStart),
    selectionEnd: Number(value.selectionEnd),
    tokens,
    caseSensitive: value.caseSensitive,
  };
}

function parseCustomPort(value: unknown, label: string): CustomBlockPortDefinition {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, ['id', 'label', 'dataType', 'tooltip'], label);
  const id = parseBoundedString(value.id, `${label}.id`, 128, true)!;
  if (!RECIPE_PORT_ID.test(id)) {
    throw new Error(`${label}.id contains unsupported characters.`);
  }
  const portLabel = parseBoundedString(value.label, `${label}.label`, 80, true)!;
  if (typeof value.dataType !== 'string' || !(GRAPH_DATA_TYPES as readonly string[]).includes(value.dataType)) {
    throw new Error(`${label}.dataType is unsupported.`);
  }
  const tooltip = parseBoundedString(value.tooltip, `${label}.tooltip`, 4_096);
  return {
    id,
    label: portLabel,
    dataType: value.dataType as GraphDataType,
    ...(tooltip !== undefined ? { tooltip } : {}),
  };
}

function parseCustomPorts(value: unknown, label: string, minimum = 0): CustomBlockPortDefinition[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 24) {
    throw new Error(`${label} must contain between ${minimum} and 24 ports.`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const port = parseCustomPort(entry, `${label}[${index}]`);
    if (ids.has(port.id)) {
      throw new Error(`${label} contains duplicate id "${port.id}".`);
    }
    ids.add(port.id);
    return port;
  });
}

function parseCustomField(value: unknown, label: string): CustomBlockFieldDefinition {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertOnlyKeys(value, ['id', 'label', 'dataType', 'defaultValue', 'tooltip', 'visibility'], label);
  const id = parseBoundedString(value.id, `${label}.id`, 128, true)!;
  if (!CUSTOM_DEFINITION_ID.test(id)) {
    throw new Error(`${label}.id contains unsupported characters.`);
  }
  const fieldLabel = parseBoundedString(value.label, `${label}.label`, 80, true)!;
  if (typeof value.dataType !== 'string' || !(GRAPH_DATA_TYPES as readonly string[]).includes(value.dataType)) {
    throw new Error(`${label}.dataType is unsupported.`);
  }
  if (value.visibility !== undefined && !['visible', 'advanced', 'hidden'].includes(String(value.visibility))) {
    throw new Error(`${label}.visibility is unsupported.`);
  }
  const defaultValue = parseBoundedString(value.defaultValue, `${label}.defaultValue`, 16_384);
  const tooltip = parseBoundedString(value.tooltip, `${label}.tooltip`, 4_096);
  return {
    id,
    label: fieldLabel,
    dataType: value.dataType as GraphDataType,
    ...(defaultValue !== undefined ? { defaultValue } : {}),
    ...(tooltip !== undefined ? { tooltip } : {}),
    ...(value.visibility !== undefined ? { visibility: value.visibility as CustomBlockFieldDefinition['visibility'] } : {}),
  };
}

function parseCustomFields(value: unknown, label: string): CustomBlockFieldDefinition[] {
  if (!Array.isArray(value) || value.length > 48) {
    throw new Error(`${label} must be an array with at most 48 fields.`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const field = parseCustomField(entry, `${label}[${index}]`);
    if (ids.has(field.id)) {
      throw new Error(`${label} contains duplicate id "${field.id}".`);
    }
    ids.add(field.id);
    return field;
  });
}

function parseStringRecord(value: unknown, label: string): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > 48) {
    throw new Error(`${label} must be an object with at most 48 entries.`);
  }
  const result: Record<string, string> = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (DANGEROUS_KEYS.has(key) || !CUSTOM_DEFINITION_ID.test(key) || typeof entry !== 'string' || entry.length > 16_384) {
      throw new Error(`${label}.${key} is invalid.`);
    }
    result[key] = entry;
  });
  return result;
}

function parseSettingValue(blockType: BlockKind, key: keyof WorkspaceBlockSettings, value: unknown, label: string): unknown {
  const schema = recipeSettingSchema(key, blockType);
  if (!schema) {
    throw new Error(`${label} has no supported value schema.`);
  }
  if (schema.type === 'string') {
    const parsed = parseBoundedString(value, label, schema.maxChars, false);
    if (key === 'customPortId' && (parsed === undefined || !RECIPE_PORT_ID.test(parsed))) {
      throw new Error(`${label} is not a recipe-safe port id.`);
    }
    return parsed;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
    return value;
  }
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.integer && !Number.isInteger(value))) {
      throw new Error(`${label} must be ${schema.integer ? 'a finite integer' : 'a finite number'}.`);
    }
    if (schema.min !== undefined && value < schema.min || schema.max !== undefined && value > schema.max) {
      throw new Error(`${label} is outside the supported range.`);
    }
    return value;
  }
  if (schema.type === 'enum') {
    if (!schema.values.includes(value as string | number)) throw new Error(`${label} is unsupported.`);
    return value;
  }
  if (schema.type === 'regex-builder') return parseRegexBuilder(value, label);
  if (schema.type === 'custom-ports') return parseCustomPorts(value, label);
  if (schema.type === 'custom-fields') return parseCustomFields(value, label);
  return parseStringRecord(value, label);
}

function parseSettings(value: unknown, label: string, blockType: BlockKind): WorkspaceBlockSettings | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const allowedKeys = allowedRecipeSettingKeys(blockType);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`${label} contains the unsafe key "${key}".`);
    }
    if (RECIPE_FORBIDDEN_SETTING_KEYS.has(key as keyof WorkspaceBlockSettings)) {
      throw new Error(`${label}.${key} is generated by URL Alchemist and cannot appear in a recipe.`);
    }
    if (!RECIPE_SETTING_KEYS.has(key as keyof WorkspaceBlockSettings)) {
      throw new Error(`${label} contains unsupported setting "${key}".`);
    }
    if (!allowedKeys.has(key as keyof WorkspaceBlockSettings)) {
      throw new Error(`${label}.${key} is not supported by ${blockType}.`);
    }
    result[key] = parseSettingValue(blockType, key as keyof WorkspaceBlockSettings, value[key], `${label}.${key}`);
  }
  assertJsonSafe(result, label);
  if (jsonBytes(value) > 64 * 1024) {
    throw new Error(`${label} is too large.`);
  }
  return result as WorkspaceBlockSettings;
}

function parseTrigger(value: unknown): WorkspaceTrigger {
  if (!isRecord(value)) {
    throw new Error('Recipe trigger must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (!RECIPE_TRIGGER_KEYS.has(key)) {
      throw new Error(`Recipe trigger contains unsupported key "${key}".`);
    }
  }
  if (typeof value.type !== 'string' || !(RECIPE_TRIGGER_TYPES as readonly string[]).includes(value.type)) {
    throw new Error('Recipe trigger type is unsupported.');
  }
  const trigger: WorkspaceTrigger = { type: value.type as WorkspaceTrigger['type'] };
  if (value.hotkey !== undefined) {
    trigger.hotkey = parseBoundedString(value.hotkey, 'Recipe trigger.hotkey', 128);
  }
  if (value.inputSources !== undefined) {
    if (!Array.isArray(value.inputSources) || value.inputSources.length > WORKSPACE_INPUT_SOURCES.length) {
      throw new Error('Recipe trigger.inputSources has an invalid shape.');
    }
    const sources = value.inputSources.map((source) => {
      if (typeof source !== 'string' || !(WORKSPACE_INPUT_SOURCES as readonly string[]).includes(source)) {
        throw new Error('Recipe trigger.inputSources contains an unsupported source.');
      }
      return source as NonNullable<WorkspaceTrigger['inputSources']>[number];
    });
    if (new Set(sources).size !== sources.length) {
      throw new Error('Recipe trigger.inputSources contains a duplicate source.');
    }
    trigger.inputSources = sources;
  }
  if (value.sourceFilters !== undefined) {
    if (!Array.isArray(value.sourceFilters) || value.sourceFilters.length > 32) {
      throw new Error('Recipe trigger.sourceFilters has an invalid shape.');
    }
    const seenFilters = new Set<string>();
    trigger.sourceFilters = value.sourceFilters.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new Error(`Recipe trigger.sourceFilters[${index}] must be an object.`);
      }
      assertOnlyKeys(entry, ['source', 'pattern'], `Recipe trigger.sourceFilters[${index}]`);
      if (typeof entry.source !== 'string' || !(WORKSPACE_INPUT_SOURCES as readonly string[]).includes(entry.source)) {
        throw new Error(`Recipe trigger.sourceFilters[${index}].source is unsupported.`);
      }
      if (typeof entry.pattern !== 'string' || entry.pattern.length > 16_384) {
        throw new Error(`Recipe trigger.sourceFilters[${index}].pattern must be a string no longer than 16384 characters.`);
      }
      const pattern = entry.pattern;
      const key = `${entry.source}\0${pattern}`;
      if (seenFilters.has(key)) {
        throw new Error('Recipe trigger.sourceFilters contains a duplicate filter.');
      }
      seenFilters.add(key);
      return { source: entry.source as NonNullable<WorkspaceTrigger['sourceFilters']>[number]['source'], pattern };
    });
  }
  if (value.intervalMs !== undefined) {
    if (!Number.isInteger(value.intervalMs) || Number(value.intervalMs) < 0) {
      throw new Error('Recipe trigger.intervalMs must be a non-negative integer.');
    }
    trigger.intervalMs = Number(value.intervalMs);
  }
  if (value.conditionalMode !== undefined) {
    if (value.conditionalMode !== 'RISING_EDGE' && value.conditionalMode !== 'WHILE_TRUE') {
      throw new Error('Recipe trigger.conditionalMode is unsupported.');
    }
    trigger.conditionalMode = value.conditionalMode;
  }
  if (value.conditionWorkspaceId !== undefined) {
    trigger.conditionWorkspaceId = parseBoundedString(value.conditionWorkspaceId, 'Recipe trigger.conditionWorkspaceId', 128);
  }
  if (trigger.type === 'HOTKEY' && !trigger.hotkey?.trim()) {
    throw new Error('HOTKEY recipe triggers require a recorded hotkey.');
  }
  if (trigger.type === 'INTERVAL') {
    if (!Number.isInteger(trigger.intervalMs) || Number(trigger.intervalMs) < MIN_INTERVAL_TRIGGER_MS) {
      throw new Error(`INTERVAL recipe triggers require intervalMs of at least ${MIN_INTERVAL_TRIGGER_MS}.`);
    }
  } else if (trigger.intervalMs !== undefined) {
    throw new Error('Only INTERVAL recipe triggers may include intervalMs.');
  }
  if (trigger.conditionalMode !== undefined || trigger.conditionWorkspaceId !== undefined) {
    throw new Error('CONDITIONAL recipe triggers are unavailable until runtime support is implemented.');
  }
  assertJsonSafe(trigger, 'Recipe trigger');
  return trigger;
}

function parseViewport(value: unknown): WorkspaceViewport | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Recipe viewport must be an object.');
  }
  assertOnlyKeys(value, ['x', 'y', 'zoom'], 'Recipe viewport');
  if (
    typeof value.x !== 'number' || !Number.isFinite(value.x) ||
    typeof value.y !== 'number' || !Number.isFinite(value.y) ||
    typeof value.zoom !== 'number' || !Number.isFinite(value.zoom) ||
    value.zoom <= 0 || value.zoom > 4
  ) {
    throw new Error('Recipe viewport must contain finite x/y coordinates and a zoom greater than 0 and no more than 4.');
  }
  return { x: value.x, y: value.y, zoom: value.zoom };
}

function parseCustomBlock(value: unknown): WorkspaceCustomBlockDefinition | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error('Recipe customBlock must be an object.');
  }
  assertOnlyKeys(value, [
    'blockId',
    'label',
    'version',
    'category',
    'visibleWorkspaceTypes',
    'description',
    'tips',
    'inputs',
    'outputs',
    'fields',
  ], 'Recipe customBlock');
  const blockId = parseBoundedString(value.blockId, 'Recipe customBlock.blockId', 128, true)!;
  if (!CUSTOM_DEFINITION_ID.test(blockId)) {
    throw new Error('Recipe customBlock.blockId contains unsupported characters.');
  }
  const label = parseBoundedString(value.label, 'Recipe customBlock.label', 200, true)!;
  if (!Number.isInteger(value.version) || Number(value.version) < 1) {
    throw new Error('Recipe customBlock.version must be a positive integer.');
  }
  if (!isCustomBlockCategory(value.category)) {
    throw new Error('Recipe customBlock.category is unsupported.');
  }
  if (!Array.isArray(value.visibleWorkspaceTypes) || value.visibleWorkspaceTypes.length === 0) {
    throw new Error('Recipe customBlock.visibleWorkspaceTypes must be a non-empty array.');
  }
  const visibleWorkspaceTypes = value.visibleWorkspaceTypes.map((entry) => {
    if (typeof entry !== 'string' || !(WORKSPACE_TYPES as readonly string[]).includes(entry)) {
      throw new Error('Recipe customBlock.visibleWorkspaceTypes contains an unsupported workspace type.');
    }
    return entry as WorkspaceType;
  });
  if (new Set(visibleWorkspaceTypes).size !== visibleWorkspaceTypes.length) {
    throw new Error('Recipe customBlock.visibleWorkspaceTypes contains a duplicate workspace type.');
  }
  if (value.tips !== undefined && (!Array.isArray(value.tips) || value.tips.length > 24)) {
    throw new Error('Recipe customBlock.tips must be an array with at most 24 entries.');
  }
  const tips = (value.tips ?? []).map((tip, index) => parseBoundedString(tip, `Recipe customBlock.tips[${index}]`, 2_048, true)!);
  const description = parseBoundedString(value.description, 'Recipe customBlock.description', 4_096);
  const customBlock: WorkspaceCustomBlockDefinition = {
    blockId,
    label,
    version: Number(value.version),
    category: value.category as WorkspaceCustomBlockDefinition['category'],
    visibleWorkspaceTypes,
    ...(description !== undefined ? { description } : {}),
    tips,
    inputs: parseCustomPorts(value.inputs, 'Recipe customBlock.inputs', 1),
    outputs: parseCustomPorts(value.outputs, 'Recipe customBlock.outputs', 1),
    fields: parseCustomFields(value.fields, 'Recipe customBlock.fields'),
  };
  assertJsonSafe(customBlock, 'Recipe customBlock');
  return customBlock;
}

function validateRecipeBlockAvailability(nodes: WorkspaceRecipeNodeV1[], workspaceType: WorkspaceRecipeV1['workspaceType']): void {
  nodes.forEach((node) => {
    if (CONTENT_BLOCKER_ONLY_RECIPE_BLOCKS.has(node.type)) {
      throw new Error(`Recipe block "${node.type}" is available only in Content Blocker workspaces, which AI recipes do not support.`);
    }
    if (node.type === 'CustomBlock') {
      throw new Error('Recipes cannot invoke installed Custom Blocks because their external definitions are not part of the recipe.');
    }
    if (workspaceType !== 'custom-block' && (node.type === 'CustomBlockInput' || node.type === 'CustomBlockOutput')) {
      throw new Error(`${node.type} is available only in custom-block recipes.`);
    }
  });
}

function validateCustomBlockBoundary(
  nodes: WorkspaceRecipeNodeV1[],
  customBlock: WorkspaceCustomBlockDefinition,
): void {
  const validateDirection = (
    nodeType: Extract<BlockKind, 'CustomBlockInput' | 'CustomBlockOutput'>,
    ports: CustomBlockPortDefinition[],
    label: string,
  ): void => {
    const boundaryNodes = nodes.filter((node) => node.type === nodeType);
    if (boundaryNodes.length !== ports.length) {
      throw new Error(`Custom-block recipe ${label} metadata must have exactly one matching ${nodeType} node per port.`);
    }
    const portsById = new Map(ports.map((port) => [port.id, port]));
    const seen = new Set<string>();
    boundaryNodes.forEach((node) => {
      const settings = {
        ...BLOCK_REGISTRY[node.type].defaultSettings,
        ...(node.settings ?? {}),
      };
      const id = settings.customPortId?.trim() ?? '';
      const port = portsById.get(id);
      if (!port || seen.has(id)) {
        throw new Error(`Custom-block recipe ${label} node "${node.id}" has an unknown or duplicate port id.`);
      }
      seen.add(id);
      if (settings.customPortDataType !== port.dataType) {
        throw new Error(`Custom-block recipe ${label} port "${id}" has mismatched metadata and node data types.`);
      }
      if ((settings.customPortLabel ?? '') !== port.label) {
        throw new Error(`Custom-block recipe ${label} port "${id}" has mismatched metadata and node labels.`);
      }
      if ((settings.customPortTooltip ?? '') !== (port.tooltip ?? '')) {
        throw new Error(`Custom-block recipe ${label} port "${id}" has mismatched metadata and node tooltips.`);
      }
    });
  };

  validateDirection('CustomBlockInput', customBlock.inputs, 'input');
  validateDirection('CustomBlockOutput', customBlock.outputs, 'output');
}

export function parseWorkspaceRecipe(value: unknown): WorkspaceRecipeV1 {
  if (!isRecord(value)) {
    throw new Error('Workspace recipe must be an object.');
  }
  assertJsonSafe(value, 'Workspace recipe');
  if (jsonBytes(value) > WORKSPACE_RECIPE_MAX_BYTES) {
    throw new Error('Workspace recipe is too large.');
  }
  assertOnlyKeys(value, [
    'kind',
    'workspaceType',
    'name',
    'description',
    'trigger',
    'nodes',
    'connections',
    'viewport',
    'logicalFlows',
    'customBlock',
  ], 'Workspace recipe');
  if (value.kind !== WORKSPACE_RECIPE_KIND) {
    throw new Error(`Workspace recipe kind must be "${WORKSPACE_RECIPE_KIND}".`);
  }
  if (typeof value.workspaceType !== 'string' || !RECIPE_WORKSPACE_TYPES.has(value.workspaceType as WorkspaceType)) {
    throw new Error('Workspace recipe type must be data-modifier or custom-block.');
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) {
    throw new Error('Workspace recipe name must be between 1 and 200 characters.');
  }
  if (typeof value.description !== 'string' || value.description.length > 4096) {
    throw new Error('Workspace recipe description must be a string no longer than 4096 characters.');
  }
  const trigger = parseTrigger(value.trigger);
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > WORKSPACE_RECIPE_MAX_NODES) {
    throw new Error(`Workspace recipe must contain between 1 and ${WORKSPACE_RECIPE_MAX_NODES} nodes.`);
  }
  const seenNodeIds = new Set<string>();
  const nodes = value.nodes.map((entry, index): WorkspaceRecipeNodeV1 => {
    if (!isRecord(entry)) {
      throw new Error(`Recipe node ${index + 1} must be an object.`);
    }
    assertOnlyKeys(entry, ['id', 'type', 'position', 'settings'], `Recipe node ${index + 1}`);
    if (typeof entry.id !== 'string' || !RECIPE_NODE_ID.test(entry.id)) {
      throw new Error(`Recipe node ${index + 1} has an invalid id.`);
    }
    if (seenNodeIds.has(entry.id)) {
      throw new Error(`Recipe node id "${entry.id}" is duplicated.`);
    }
    seenNodeIds.add(entry.id);
    if (typeof entry.type !== 'string' || !(entry.type in BLOCK_REGISTRY)) {
      throw new Error(`Recipe node "${entry.id}" uses an unknown block type.`);
    }
    const blockType = entry.type as BlockKind;
    return {
      id: entry.id,
      type: blockType,
      position: parsePosition(entry.position, `Recipe node "${entry.id}" position`),
      settings: parseSettings(entry.settings, `Recipe node "${entry.id}" settings`, blockType),
    };
  });

  if (!Array.isArray(value.connections) || value.connections.length > WORKSPACE_RECIPE_MAX_CONNECTIONS) {
    throw new Error(`Workspace recipe connections must be an array with at most ${WORKSPACE_RECIPE_MAX_CONNECTIONS} entries.`);
  }
  const connections = value.connections.map((entry, index): WorkspaceRecipeConnectionV1 => {
    if (!isRecord(entry)) {
      throw new Error(`Recipe connection ${index + 1} must be an object.`);
    }
    assertOnlyKeys(entry, ['from', 'to'], `Recipe connection ${index + 1}`);
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      throw new Error(`Recipe connection ${index + 1} endpoints must use "node.port" strings.`);
    }
    return { from: entry.from, to: entry.to };
  });

  let logicalFlows: WorkspaceRecipeLogicalFlowV1[] | undefined;
  if (value.logicalFlows !== undefined) {
    if (!Array.isArray(value.logicalFlows) || value.logicalFlows.length > value.nodes.length) {
      throw new Error('Recipe logicalFlows must be a bounded array.');
    }
    const seenFlowIds = new Set<string>();
    const usedConditionNodes = new Set<string>();
    const usedControlNodes = new Set<string>();
    logicalFlows = value.logicalFlows.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new Error(`Recipe logical flow ${index + 1} must be an object.`);
      }
      assertOnlyKeys(entry, ['id', 'conditionNode', 'controlNode', 'depth', 'locked'], `Recipe logical flow ${index + 1}`);
      if (typeof entry.id !== 'string' || !RECIPE_NODE_ID.test(entry.id) || seenFlowIds.has(entry.id)) {
        throw new Error(`Recipe logical flow ${index + 1} has an invalid or duplicate id.`);
      }
      seenFlowIds.add(entry.id);
      if (typeof entry.conditionNode !== 'string' || typeof entry.controlNode !== 'string') {
        throw new Error(`Recipe logical flow "${entry.id}" must reference condition and control nodes.`);
      }
      if (!RECIPE_NODE_ID.test(entry.conditionNode) || !RECIPE_NODE_ID.test(entry.controlNode)) {
        throw new Error(`Recipe logical flow "${entry.id}" contains an invalid node reference.`);
      }
      if (usedConditionNodes.has(entry.conditionNode) || usedControlNodes.has(entry.controlNode)) {
        throw new Error(`Recipe logical flow "${entry.id}" reuses a condition or control node.`);
      }
      usedConditionNodes.add(entry.conditionNode);
      usedControlNodes.add(entry.controlNode);
      if (entry.depth !== undefined && (!Number.isInteger(entry.depth) || Number(entry.depth) < 0 || Number(entry.depth) > 24)) {
        throw new Error(`Recipe logical flow "${entry.id}" has an invalid depth.`);
      }
      if (entry.locked !== undefined && typeof entry.locked !== 'boolean') {
        throw new Error(`Recipe logical flow "${entry.id}" has an invalid locked value.`);
      }
      return {
        id: entry.id,
        conditionNode: entry.conditionNode,
        controlNode: entry.controlNode,
        depth: entry.depth as number | undefined,
        locked: entry.locked as boolean | undefined,
      };
    });
  }

  const viewport = parseViewport(value.viewport);

  const customBlock = parseCustomBlock(value.customBlock);
  if (value.workspaceType === 'custom-block' && !customBlock) {
    throw new Error('Custom-block recipes must include customBlock metadata.');
  }
  if (value.workspaceType !== 'custom-block' && customBlock) {
    throw new Error('Only custom-block recipes may include customBlock metadata.');
  }
  if (customBlock && customBlock.label !== value.name.trim()) {
    throw new Error('Custom-block recipe name and customBlock.label must match.');
  }
  validateRecipeBlockAvailability(nodes, value.workspaceType as WorkspaceRecipeV1['workspaceType']);
  if (customBlock) {
    validateCustomBlockBoundary(nodes, customBlock);
  }

  return {
    kind: WORKSPACE_RECIPE_KIND,
    workspaceType: value.workspaceType as WorkspaceRecipeV1['workspaceType'],
    name: value.name.trim(),
    description: value.description,
    trigger,
    nodes,
    connections,
    viewport,
    logicalFlows,
    customBlock,
  };
}

function splitEndpoint(endpoint: string, label: string): { node: string; port: string } {
  const separator = endpoint.lastIndexOf('.');
  if (separator <= 0 || separator === endpoint.length - 1) {
    throw new Error(`${label} must use the form "node.port".`);
  }
  const node = endpoint.slice(0, separator);
  const port = endpoint.slice(separator + 1);
  if (!RECIPE_NODE_ID.test(node) || !RECIPE_PORT_ID.test(port)) {
    throw new Error(`${label} contains an invalid node or port id.`);
  }
  return { node, port };
}

function defaultPosition(index: number): { x: number; y: number } {
  return {
    x: (index % 6) * 320,
    y: Math.floor(index / 6) * 200,
  };
}

function safePrefix(raw: string): string {
  const normalized = raw.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 48);
  return normalized || 'recipe';
}

export function materializeWorkspaceRecipe(
  value: WorkspaceRecipeV1 | unknown,
  options: MaterializeWorkspaceRecipeOptions = {},
): WorkspaceFileV2 {
  const recipe = parseWorkspaceRecipe(value);
  const now = Date.now();
  const prefix = safePrefix(options.nodeIdPrefix ?? 'recipe');
  const nodesByAlias = new Map<string, WorkspaceFileV2['nodes'][number]>();
  const nodes = recipe.nodes.map((entry, index) => {
    const created = {
      id: `${prefix}:${entry.id}`,
      type: entry.type,
      typeId: BLOCK_TYPE_IDS[entry.type],
      position: entry.position ?? defaultPosition(index),
      settings: {
        ...BLOCK_REGISTRY[entry.type].defaultSettings,
        ...(entry.settings ?? {}),
      },
    };
    nodesByAlias.set(entry.id, created);
    return created;
  });

  const logicalFlows: WorkspaceLogicalFlowGroup[] | undefined = recipe.logicalFlows?.map((entry) => {
    const condition = nodesByAlias.get(entry.conditionNode);
    const control = nodesByAlias.get(entry.controlNode);
    if (!condition || condition.type !== 'Logical') {
      throw new Error(`Logical flow "${entry.id}" must reference a Logical condition node.`);
    }
    if (!control || control.type !== 'LogicalFlow') {
      throw new Error(`Logical flow "${entry.id}" must reference a LogicalFlow control node.`);
    }
    const id = `${prefix}:flow:${entry.id}`;
    condition.settings = {
      ...condition.settings,
      locked: entry.locked ?? true,
      logicalFlowGroupId: id,
      logicalFlowRole: 'condition',
    };
    control.settings = {
      ...control.settings,
      locked: entry.locked ?? true,
      logicalFlowGroupId: id,
      logicalFlowRole: 'control',
    };
    return {
      id,
      conditionNodeId: condition.id,
      controlNodeId: control.id,
      depth: entry.depth ?? 0,
      locked: entry.locked ?? true,
    };
  });

  const seenTargets = new Set<string>();
  const seenConnections = new Set<string>();
  const edges = recipe.connections.map((connection, index) => {
    const sourceEndpoint = splitEndpoint(connection.from, `Recipe connection ${index + 1} source`);
    const targetEndpoint = splitEndpoint(connection.to, `Recipe connection ${index + 1} target`);
    const source = nodesByAlias.get(sourceEndpoint.node);
    const target = nodesByAlias.get(targetEndpoint.node);
    if (!source || !target) {
      throw new Error(`Recipe connection ${index + 1} references an unknown node.`);
    }
    const sourcePort = getEffectivePortDefinition(source, 'output', sourceEndpoint.port);
    const logicalConditionPort = target.type === 'LogicalFlow' && targetEndpoint.port === 'condition';
    const targetPort = logicalConditionPort
      ? { id: 'condition', dataType: 'bool' as const }
      : getEffectivePortDefinition(target, 'input', targetEndpoint.port);
    if (!sourcePort) {
      throw new Error(`Recipe connection ${index + 1} references unknown output "${connection.from}".`);
    }
    if (!targetPort) {
      throw new Error(`Recipe connection ${index + 1} references unknown input "${connection.to}".`);
    }
    if (!isTypeCompatible(sourcePort.dataType, targetPort.dataType)) {
      throw new Error(`Recipe connection ${index + 1} connects incompatible ${sourcePort.dataType} and ${targetPort.dataType} ports.`);
    }
    const targetKey = `${target.id}:${targetEndpoint.port}`;
    if (seenTargets.has(targetKey)) {
      throw new Error(`Recipe input "${connection.to}" has more than one connection.`);
    }
    seenTargets.add(targetKey);
    const connectionKey = `${source.id}:${sourceEndpoint.port}->${targetKey}`;
    if (seenConnections.has(connectionKey)) {
      throw new Error(`Recipe connection ${index + 1} is duplicated.`);
    }
    seenConnections.add(connectionKey);
    return {
      id: `${prefix}:edge:${index + 1}`,
      source: source.id,
      sourceHandle: sourceEndpoint.port,
      target: target.id,
      targetHandle: targetEndpoint.port,
    };
  });

  const workspace: WorkspaceFileV2 = {
    kind: 'workspace.v2',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceType: recipe.workspaceType,
    metadata: {
      id: options.id ?? crypto.randomUUID(),
      name: recipe.name,
      version: recipe.workspaceType === 'custom-block' && recipe.customBlock
        ? recipe.customBlock.version
        : options.version ?? 1,
      author: options.author ?? '',
      description: recipe.description,
      compatibility: options.compatibility,
      created_at: options.createdAt ?? now,
      updated_at: options.updatedAt ?? now,
    },
    trigger: recipe.trigger,
    nodes,
    edges,
    viewport: recipe.viewport ?? { x: 0, y: 0, zoom: 0.82 },
    logicalFlows,
    customBlock: recipe.customBlock,
  };
  const validation = validateWorkspaceFile(workspace);
  if (!validation.ok) {
    throw new Error(`Workspace recipe materialized an invalid workspace: ${validation.errors.join('; ')}`);
  }
  return validation.value;
}

function compactSettings(node: WorkspaceFileV2['nodes'][number]): WorkspaceBlockSettings | undefined {
  const defaults = BLOCK_REGISTRY[node.type].defaultSettings as Record<string, unknown>;
  const allowedKeys = allowedRecipeSettingKeys(node.type);
  const result: Record<string, unknown> = {};
  Object.entries(node.settings).forEach(([key, value]) => {
    if (RECIPE_FORBIDDEN_SETTING_KEYS.has(key as keyof WorkspaceBlockSettings)) {
      return;
    }
    if (!RECIPE_SETTING_KEYS.has(key as keyof WorkspaceBlockSettings) || !allowedKeys.has(key as keyof WorkspaceBlockSettings)) {
      if (value !== undefined) {
        throw new Error(`Workspace node "${node.id}" uses setting "${key}", which cannot be represented safely in a recipe.`);
      }
      return;
    }
    if (JSON.stringify(value) === JSON.stringify(defaults[key])) {
      return;
    }
    result[key] = cloneJson(value);
  });
  return Object.keys(result).length > 0
    ? parseSettings(result, `Workspace node "${node.id}" settings`, node.type)
    : undefined;
}

function recipeAlias(rawId: string, index: number, used: Set<string>): string {
  const tail = rawId.split(':').at(-1) ?? '';
  let candidate = tail.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+/, '').slice(0, 64);
  if (!RECIPE_NODE_ID.test(candidate) || used.has(candidate)) {
    candidate = `node-${index + 1}`;
  }
  while (used.has(candidate)) {
    candidate = `${candidate.slice(0, 58)}-${used.size + 1}`;
  }
  used.add(candidate);
  return candidate;
}

function canonicalRecipeTrigger(trigger: WorkspaceTrigger): WorkspaceTrigger {
  const canonical = cloneJson(trigger);
  if (canonical.type !== 'INTERVAL') {
    delete canonical.intervalMs;
  }
  delete canonical.conditionalMode;
  delete canonical.conditionWorkspaceId;
  return canonical;
}

export function workspaceToRecipe(workspace: WorkspaceFileV2): WorkspaceRecipeV1 {
  const validation = validateWorkspaceFile(workspace);
  if (!validation.ok) {
    throw new Error(`Cannot create a workspace recipe from an invalid workspace: ${validation.errors.join('; ')}`);
  }
  const canonical = migrateWorkspaceFile(validation.value);
  if (!RECIPE_WORKSPACE_TYPES.has(canonical.workspaceType)) {
    throw new Error('Internal recipes currently support data-modifier and custom-block workspaces only.');
  }
  if (
    canonical.assets?.length || canonical.embeddedCustomBlocks?.length ||
    canonical.nodes.some((node) => node.type === 'CustomBlock' || node.settings.assetDataBase64 || node.settings.assetResourceId)
  ) {
    throw new Error('Workspace recipes cannot safely replace workspaces that depend on embedded assets, local resources, or installed Custom Blocks.');
  }
  const usedAliases = new Set<string>();
  const aliasById = new Map<string, string>();
  const nodes = canonical.nodes.map((node, index) => {
    const id = recipeAlias(node.id, index, usedAliases);
    aliasById.set(node.id, id);
    return {
      id,
      type: node.type,
      position: { ...node.position },
      settings: compactSettings(node),
    };
  });
  const connections = canonical.edges.flatMap((edge) => {
    const source = aliasById.get(edge.source);
    const target = aliasById.get(edge.target);
    if (!RECIPE_PORT_ID.test(edge.sourceHandle) || !RECIPE_PORT_ID.test(edge.targetHandle)) {
      throw new Error(`Workspace edge "${edge.id}" uses a port id that cannot be represented safely in a recipe.`);
    }
    return source && target ? [{ from: `${source}.${edge.sourceHandle}`, to: `${target}.${edge.targetHandle}` }] : [];
  });
  const usedFlowAliases = new Set<string>();
  const logicalFlows = canonical.logicalFlows?.flatMap((flow, index) => {
    const conditionNode = aliasById.get(flow.conditionNodeId);
    const controlNode = aliasById.get(flow.controlNodeId);
    if (!conditionNode || !controlNode) {
      return [];
    }
    const id = recipeAlias(flow.id, index, usedFlowAliases);
    return [{ id, conditionNode, controlNode, depth: flow.depth, locked: flow.locked }];
  });
  return parseWorkspaceRecipe({
    kind: WORKSPACE_RECIPE_KIND,
    workspaceType: canonical.workspaceType as WorkspaceRecipeV1['workspaceType'],
    name: canonical.metadata.name,
    description: canonical.metadata.description ?? '',
    trigger: canonicalRecipeTrigger(canonical.trigger),
    nodes,
    connections,
    viewport: { ...canonical.viewport },
    logicalFlows: logicalFlows?.length ? logicalFlows : undefined,
    customBlock: canonical.workspaceType === 'custom-block' && canonical.customBlock
      ? cloneJson(canonical.customBlock)
      : undefined,
  });
}

function safeCatalogSettings(blockType: BlockKind, settings: WorkspaceBlockSettings): WorkspaceBlockSettings {
  const safe: Record<string, unknown> = {};
  const allowedKeys = allowedRecipeSettingKeys(blockType);
  Object.entries(settings).forEach(([key, value]) => {
    if (
      !RECIPE_FORBIDDEN_SETTING_KEYS.has(key as keyof WorkspaceBlockSettings) &&
      allowedKeys.has(key as keyof WorkspaceBlockSettings)
    ) {
      safe[key] = cloneJson(value);
    }
  });
  return safe as WorkspaceBlockSettings;
}

function settingSchemaForBlock(blockType: BlockKind): Record<string, RecipeSettingSchema> {
  const result: Record<string, RecipeSettingSchema> = {};
  allowedRecipeSettingKeys(blockType).forEach((key) => {
    if (RECIPE_FORBIDDEN_SETTING_KEYS.has(key)) {
      return;
    }
    const schema = recipeSettingSchema(key, blockType);
    if (schema) {
      result[key] = schema;
    }
  });
  return result;
}

const DYNAMIC_PORT_SETTING_VALUES: Partial<Record<BlockKind, { key: keyof WorkspaceBlockSettings; values: readonly (string | number)[] }>> = {
  Convert: { key: 'convertMode', values: ENUM_SETTING_VALUES.convertMode! },
  Substitution: { key: 'substitutionInputCount', values: [1, 2, 3, 24] },
  FetchData: { key: 'remoteDataType', values: ['data', 'string', 'JSON', 'dict'] },
  HttpRequest: { key: 'remoteDataType', values: ['data', 'string', 'JSON', 'dict'] },
  Constant: { key: 'literalDataType', values: GRAPH_DATA_TYPES.filter((value) => value !== 'asset') },
  SharedState: { key: 'sharedStateMode', values: ENUM_SETTING_VALUES.sharedStateMode! },
  ListOperation: { key: 'listOperation', values: ENUM_SETTING_VALUES.listOperation! },
  TextSplitJoin: { key: 'splitJoinMode', values: ENUM_SETTING_VALUES.splitJoinMode! },
  UrlQuery: { key: 'urlQueryMode', values: ENUM_SETTING_VALUES.urlQueryMode! },
  DictOperation: { key: 'dictOperationMode', values: ENUM_SETTING_VALUES.dictOperationMode! },
};

function contextPorts(node: { type: BlockKind; settings: WorkspaceBlockSettings }, direction: 'input' | 'output'): Array<Record<string, unknown>> {
  return getEffectivePortDefinitions(node, direction).map(({ id, label, dataType, required, risk, description }) => ({
    id,
    label,
    dataType,
    ...(direction === 'input' ? { required: Boolean(required) } : {}),
    risk,
    description,
  }));
}

function dynamicPortVariants(blockType: BlockKind): Array<Record<string, unknown>> | undefined {
  const variant = DYNAMIC_PORT_SETTING_VALUES[blockType];
  if (!variant) {
    return undefined;
  }
  return variant.values.map((value) => {
    const settings = {
      ...BLOCK_REGISTRY[blockType].defaultSettings,
      [variant.key]: value,
    } as WorkspaceBlockSettings;
    const node = { type: blockType, settings };
    return {
      when: { [variant.key]: value },
      inputs: contextPorts(node, 'input'),
      outputs: contextPorts(node, 'output'),
    };
  });
}

export function buildWorkspaceRecipeContext(): WorkspaceRecipeContext {
  return {
    kind: 'workspace-recipe.context.v1',
    immutableRules: [
      'Return exactly one workspace-recipe.v1 JSON object and no prose or markdown.',
      'Use node aliases and node.port connection endpoints; never supply raw type IDs or VM instructions.',
      'URL Alchemist derives schema versions, permissions, risk metadata, compiled instructions, and artifact bytes.',
      'Recipes cannot embed files, binary asset bytes, local resource IDs, JavaScript, HTML, or executable code.',
      'The proposed workspace must pass port, workspace, compiler, and risk validation before it can be applied.',
      'For custom-block recipes, customBlock.label must equal name, category must use a listed specific category, and every input/output ID, label, type, and tooltip must match its boundary node.',
    ],
    recipeShape: {
      required: ['kind', 'workspaceType', 'name', 'description', 'trigger', 'nodes', 'connections'],
      kind: WORKSPACE_RECIPE_KIND,
      workspaceTypes: ['data-modifier', 'custom-block'],
      limits: { maxBytes: WORKSPACE_RECIPE_MAX_BYTES, maxNodes: WORKSPACE_RECIPE_MAX_NODES, maxConnections: WORKSPACE_RECIPE_MAX_CONNECTIONS },
      trigger: {
        required: ['type'],
        type: RECIPE_TRIGGER_TYPES,
        inputSources: WORKSPACE_INPUT_SOURCES,
        sourceFilter: { required: ['source', 'pattern'], exactKeys: true },
        variants: {
          INPUT_DATA: { optional: ['hotkey', 'inputSources', 'sourceFilters'] },
          HOTKEY: { required: ['hotkey'], optional: ['inputSources', 'sourceFilters'] },
          CONTEXT_MENU: { optional: ['hotkey', 'inputSources', 'sourceFilters'] },
          INTERVAL: { required: ['intervalMs'], intervalMs: { integer: true, min: MIN_INTERVAL_TRIGGER_MS }, optional: ['hotkey', 'inputSources', 'sourceFilters'] },
          NEVER: { optional: ['hotkey', 'inputSources', 'sourceFilters'] },
        },
        unavailable: {
          ALWAYS: 'Legacy trigger; use INPUT_DATA.',
          CONDITIONAL: 'Blocked until conditional runtime support is implemented.',
        },
      },
      node: {
        required: ['id', 'type'],
        optional: ['position', 'settings'],
        id: 'Letter-first alias using only letters, numbers, underscore, and hyphen; maximum 64 characters.',
        settings: 'Use only the settingsSchema listed for the selected block.',
      },
      connection: { from: 'nodeAlias.outputPort', to: 'nodeAlias.inputPort' },
      logicalFlow: {
        required: ['id', 'conditionNode', 'controlNode'],
        optional: ['depth', 'locked'],
        rule: 'Each Logical condition and LogicalFlow control node may belong to exactly one logical flow.',
      },
      customBlock: {
        required: ['blockId', 'label', 'version', 'category', 'visibleWorkspaceTypes', 'inputs', 'outputs', 'fields'],
        optional: ['description', 'tips'],
        categories: CUSTOM_BLOCK_CATEGORY_VALUES,
        port: { required: ['id', 'label', 'dataType'], optional: ['tooltip'], dataTypes: GRAPH_DATA_TYPES },
        field: { required: ['id', 'label', 'dataType'], optional: ['defaultValue', 'tooltip', 'visibility'], visibility: ['visible', 'advanced', 'hidden'] },
      },
      optional: ['viewport', 'logicalFlows', 'customBlock'],
    },
    blocks: BLOCK_DEFINITIONS.map((definition) => {
      const node = { type: definition.kind, settings: definition.defaultSettings };
      const availability = CONTENT_BLOCKER_ONLY_RECIPE_BLOCKS.has(definition.kind)
        ? 'unavailable: Content Blocker only'
        : definition.kind === 'CustomBlock'
          ? 'unavailable: requires an installed definition outside the recipe'
          : definition.kind === 'CustomBlockInput' || definition.kind === 'CustomBlockOutput'
            ? 'custom-block recipes only'
            : 'available in data-modifier and custom-block recipes';
      return {
        type: definition.kind,
        label: definition.label,
        category: definition.category,
        description: definition.description,
        tips: definition.tips,
        risk: definition.risk,
        availability,
        defaultSettings: safeCatalogSettings(definition.kind, definition.defaultSettings),
        settingsSchema: settingSchemaForBlock(definition.kind),
        inputs: contextPorts(node, 'input'),
        outputs: contextPorts(node, 'output'),
        dynamicPortRule: DYNAMIC_PORT_RULES[definition.kind],
        portVariants: dynamicPortVariants(definition.kind),
      };
    }),
  };
}
