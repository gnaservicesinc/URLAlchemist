import { ACTION_TYPES, MATCH_MODES, WORKSPACE_TRIGGER_TYPES } from '../types';
import { assertSafeRegexPattern } from '../regex/executeRegexJob';
import { BLOCK_REGISTRY, getRiskRank } from './blockRegistry';
import { validateRemoteUrl } from './remoteUrl';
import type {
  CompiledActionPackV2,
  CompiledTriggerPlan,
  CompiledRiskSummary,
  GraphDataType,
  GraphEventHandler,
  GraphValue,
  GraphVmInstruction,
  GraphVmSafetyPolicy,
  RiskLevel,
  WorkspaceInputSource,
} from './types';
import {
  ACTION_PACK_SCHEMA_VERSION,
  DEFAULT_REMOTE_MAX_BYTES,
  DEFAULT_REMOTE_TIMEOUT_MS,
  INPUT_TRIGGER_BURST_LIMIT,
  INPUT_TRIGGER_BURST_WINDOW_MS,
  INPUT_TRIGGER_HISTORY_LIMIT,
  MAX_ASSET_MAX_BYTES,
  MIN_INTERVAL_TRIGGER_MS,
  SUPPORTED_ACTION_PACK_SCHEMA_VERSIONS,
} from './types';

const GRAPH_DATA_TYPES = ['bool', 'number', 'floatingPoint', 'string', 'URL', 'JSON', 'data', 'dict', 'asset', 'Any'] as const;
const RISK_LEVELS = ['safe', 'extended', 'high'] as const;
const COMPARE_OPERATORS = ['LT', 'LTE', 'EQ', 'GT', 'GTE'] as const;
const MATH_OPERATIONS = ['ADD', 'SUBTRACT', 'MULTIPLY', 'DIVIDE', 'MODULO'] as const;
const CONVERT_MODES = [
  'FLOAT_TO_NUMBER',
  'STRING_TO_URL',
  'DICT_TO_JSON',
  'JSON_TO_DICT',
  'NUMBER_TO_STRING',
  'DATA_TO_STRING',
] as const;
const ROUNDING_MODES = ['FLOOR', 'CEIL', 'ROUND'] as const;
const SAVELOAD_MODES = ['SAVE', 'EXISTS', 'GET'] as const;
const REMOTE_METHODS = ['GET', 'POST'] as const;
const SYSTEM_DATA_MODES = ['NOW_MS', 'EPOCH_SECONDS', 'ISO_DATE', 'TIMEZONE_OFFSET_MINUTES', 'LOCALE_DATE', 'LOCALE_TIME'] as const;
const USER_INTERACTIONS = ['PROMPT_TEXT', 'PROMPT_NUMBER', 'CONFIRM', 'PICK_FILE_OR_URL'] as const;
const DISPLAY_TYPES = ['message', 'image', 'video', 'sound', 'input-capture'] as const;
const DISPLAY_MODES = ['OVERLAY', 'REPLACE_PAGE', 'NEW_TAB'] as const;
const SHOW_IMAGE_STOP_MODES = ['CLOSE_BUTTON', 'CLICK', 'TIMEOUT', 'CONFIRM'] as const;
const GRAPH_EVENT_HANDLERS = ['trigger', 'keyboard', 'mouse', 'tick'] as const;
const OVERLAY_CONTROL_ACTIONS = ['START', 'STOP', 'TOGGLE', 'STATUS'] as const;
const SHARED_STATE_MODES = ['GET', 'SET', 'DELETE', 'EXISTS'] as const;
const LIST_OPERATIONS = ['APPEND', 'PREPEND', 'DROP_LAST', 'GET', 'LENGTH', 'CONTAINS_POINT'] as const;
const LOG_SEVERITIES = ['debug', 'info', 'warn', 'error'] as const;
const ASSET_KINDS = ['image', 'video', 'audio', 'unknown'] as const;
const ASSET_SOURCES = ['remote', 'embedded', 'picked-file'] as const;
const ASSET_COMPRESSION = ['gzip', 'none'] as const;
const WORKSPACE_INPUT_SOURCES = [
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
] as const;
const CONDITIONAL_MODES = ['RISING_EDGE', 'WHILE_TRUE'] as const;

const MAX_VM_STEP_BUDGET = 300;
const MAX_VM_LOOP_BUDGET = 500;
const MAX_VM_VALUE_BYTE_LIMIT = 256 * 1024;
const MAX_VM_INSTRUCTIONS = MAX_VM_STEP_BUDGET;
const MAX_GRAPH_VALUE_DEPTH = 4;
const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type ValidationResult =
  | { ok: true; pack: CompiledActionPackV2 }
  | { ok: false; errors: string[] };

type SourcePort = {
  dataType: GraphDataType;
  risk: RiskLevel;
};

type DestinationPort = SourcePort;

const SOURCE_PORTS: ReadonlyMap<string, SourcePort> = new Map(
  [
    BLOCK_REGISTRY.DataFlowIn,
    BLOCK_REGISTRY.ExtendedDataIn,
    BLOCK_REGISTRY.OnTriggerEvent,
    BLOCK_REGISTRY.KeyboardIn,
    BLOCK_REGISTRY.MouseIn,
    BLOCK_REGISTRY.OverlayTickIn,
  ].flatMap((definition) =>
    definition.outputs.map((port) => [
      port.id,
      {
        dataType: port.dataType,
        risk: port.risk ?? definition.risk,
      },
    ] as const),
  ),
);

const DESTINATION_PORTS: ReadonlyMap<string, DestinationPort> = new Map(
  [...BLOCK_REGISTRY.DataFlowOut.inputs, ...BLOCK_REGISTRY.ExtendedDataOut.inputs].map((port) => [
    port.id,
    {
      dataType: port.dataType,
      risk: port.risk ?? 'safe',
    },
  ]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, requiredKeys: string[], optionalKeys: string[] = []): boolean {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(record);
  return keys.every((key) => allowed.has(key)) && requiredKeys.every((key) => Object.prototype.hasOwnProperty.call(record, key));
}

function hasNoDangerousKeys(record: Record<string, unknown>): boolean {
  return Object.keys(record).every((key) => !DANGEROUS_RECORD_KEYS.has(key));
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isEnumValue<T extends readonly string[]>(values: T, value: unknown): value is T[number] {
  return typeof value === 'string' && values.includes(value);
}

function addError(errors: string[], prefix: string, message: string): void {
  errors.push(`${prefix}: ${message}`);
}

function assertReference(
  errors: string[],
  symbolTable: Record<string, GraphDataType>,
  value: unknown,
  prefix: string,
  required = false,
): value is string | undefined {
  if (value === undefined) {
    if (required) {
      addError(errors, prefix, 'reference is required');
      return false;
    }

    return true;
  }

  if (typeof value !== 'string' || !value.trim()) {
    addError(errors, prefix, 'reference must be a non-empty string');
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(symbolTable, value)) {
    addError(errors, prefix, `reference "${value}" is not declared in the symbol table`);
    return false;
  }

  return true;
}

function validateGraphValue(value: unknown, prefix: string, errors: string[], depth = 0): value is GraphValue {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'value']) || !hasNoDangerousKeys(value)) {
    addError(errors, prefix, 'graph value must be an exact object');
    return false;
  }

  if (!isEnumValue(GRAPH_DATA_TYPES, value.type)) {
    addError(errors, prefix, 'graph value type is invalid');
    return false;
  }

  if (depth > MAX_GRAPH_VALUE_DEPTH) {
    addError(errors, prefix, 'graph value nesting is too deep');
    return false;
  }

  switch (value.type) {
    case 'bool':
      if (value.value !== 0 && value.value !== 1) {
        addError(errors, prefix, 'bool graph value must be 0 or 1');
        return false;
      }
      return true;
    case 'number':
    case 'floatingPoint':
      if (isFiniteNumber(value.value)) {
        return true;
      }

      if (Array.isArray(value.value) && value.value.every(isFiniteNumber)) {
        return true;
      }

      addError(errors, prefix, `${value.type} graph value must be finite numeric data`);
      return false;
    case 'string':
    case 'URL':
    case 'JSON':
      if (!isString(value.value)) {
        addError(errors, prefix, `${value.type} graph value must be a string`);
        return false;
      }
      return true;
    case 'dict':
      if (!isRecord(value.value) || !hasNoDangerousKeys(value.value)) {
        addError(errors, prefix, 'dict graph value must be a plain object');
        return false;
      }

      Object.entries(value.value).forEach(([key, entry]) => {
        validateGraphValue(entry, `${prefix}.${key}`, errors, depth + 1);
      });
      return true;
    case 'asset':
      return validateAssetRef(value.value, `${prefix}.value`, errors);
    case 'data':
    case 'Any':
    default:
      return true;
  }
}

function validateAssetRef(value: unknown, prefix: string, errors: string[]): boolean {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    addError(errors, prefix, 'asset must be a plain object');
    return false;
  }

  if (!hasExactKeys(value, ['source', 'kind', 'mimeType'], ['url', 'name', 'sha256', 'sizeBytes', 'compression', 'dataBase64', 'cacheKey'])) {
    addError(errors, prefix, 'asset has invalid keys');
    return false;
  }

  let ok = true;
  if (!isEnumValue(ASSET_SOURCES, value.source)) {
    addError(errors, prefix, 'asset source is invalid');
    ok = false;
  }

  if (!isEnumValue(ASSET_KINDS, value.kind)) {
    addError(errors, prefix, 'asset kind is invalid');
    ok = false;
  }

  if (!isString(value.mimeType) || value.mimeType.length > 128 || !/^[a-z0-9.+-]+\/[a-z0-9.+*-]+$/i.test(value.mimeType)) {
    addError(errors, prefix, 'asset MIME type is invalid');
    ok = false;
  }

  if (value.url !== undefined) {
    if (!isString(value.url)) {
      addError(errors, prefix, 'asset URL must be a string');
      ok = false;
    } else {
      try {
        validateRemoteUrl(value.url);
      } catch (error) {
        addError(errors, prefix, error instanceof Error ? error.message : 'asset URL is invalid');
        ok = false;
      }
    }
  }

  if (value.name !== undefined && (!isString(value.name) || value.name.length > 180)) {
    addError(errors, prefix, 'asset name is invalid');
    ok = false;
  }

  if (value.sha256 !== undefined && (!isString(value.sha256) || !/^[a-f0-9]{64}$/i.test(value.sha256))) {
    addError(errors, prefix, 'asset sha256 is invalid');
    ok = false;
  }

  if (value.sizeBytes !== undefined && (!isNonNegativeInteger(value.sizeBytes) || value.sizeBytes > MAX_ASSET_MAX_BYTES)) {
    addError(errors, prefix, `asset size must be between 0 and ${MAX_ASSET_MAX_BYTES} bytes`);
    ok = false;
  }

  if (value.compression !== undefined && !isEnumValue(ASSET_COMPRESSION, value.compression)) {
    addError(errors, prefix, 'asset compression is invalid');
    ok = false;
  }

  if (value.dataBase64 !== undefined && (!isString(value.dataBase64) || value.dataBase64.length > Math.ceil((MAX_ASSET_MAX_BYTES * 4) / 3) + 8)) {
    addError(errors, prefix, 'asset data is too large');
    ok = false;
  }

  if (value.cacheKey !== undefined && (!isString(value.cacheKey) || value.cacheKey.length > 512)) {
    addError(errors, prefix, 'asset cache key is invalid');
    ok = false;
  }

  return ok;
}

function validateSymbolTable(value: unknown, errors: string[]): Record<string, GraphDataType> | null {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push('vm.symbolTable must be a plain object');
    return null;
  }

  const symbolTable: Record<string, GraphDataType> = {};
  Object.entries(value).forEach(([key, dataType]) => {
    if (!key.trim()) {
      errors.push('vm.symbolTable contains an empty symbol');
      return;
    }

    if (!isEnumValue(GRAPH_DATA_TYPES, dataType)) {
      errors.push(`vm.symbolTable.${key} has an invalid data type`);
      return;
    }

    symbolTable[key] = dataType;
  });

  return symbolTable;
}

function validateConstants(value: unknown, errors: string[]): Record<string, GraphValue> | null {
  if (!isRecord(value) || !hasNoDangerousKeys(value)) {
    errors.push('vm.constants must be a plain object');
    return null;
  }

  const constants: Record<string, GraphValue> = {};
  Object.entries(value).forEach(([key, constant]) => {
    if (!key.trim()) {
      errors.push('vm.constants contains an empty key');
      return;
    }

    if (validateGraphValue(constant, `vm.constants.${key}`, errors)) {
      constants[key] = constant;
    }
  });

  return constants;
}

function emptyRisk(): CompiledRiskSummary {
  return {
    highest: 'safe',
    usesExtendedInput: false,
    usesExtendedOutput: false,
    usesHighRiskInput: false,
    usesHighRiskOutput: false,
    reasons: [],
  };
}

function combineRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return getRiskRank(right) > getRiskRank(left) ? right : left;
}

function addRisk(risk: CompiledRiskSummary, level: RiskLevel, reason: string, direction: 'input' | 'output'): void {
  risk.highest = combineRisk(risk.highest, level);

  if (level !== 'safe' && !risk.reasons.includes(reason)) {
    risk.reasons.push(reason);
  }

  if (level === 'extended') {
    if (direction === 'input') {
      risk.usesExtendedInput = true;
    } else {
      risk.usesExtendedOutput = true;
    }
  }

  if (level === 'high') {
    if (direction === 'input') {
      risk.usesHighRiskInput = true;
    } else {
      risk.usesHighRiskOutput = true;
    }
  }
}

function deriveRequiredPermissions(instructions: GraphVmInstruction[]): string[] {
  const permissions = new Set<string>();
  instructions.forEach((instruction) => {
    if (
      (instruction.op === 'SOURCE' && instruction.source === 'clipboard') ||
      (instruction.op === 'REGEX_TRANSFORM' && instruction.payloadVars && instruction.payload.includes('{clipboard}'))
    ) {
      permissions.add('clipboardRead');
    }

    if (instruction.op === 'OUTPUT' && ['clipboard', 'clipboardBinary'].includes(instruction.destination)) {
      permissions.add('clipboardWrite');
    }
  });

  return Array.from(permissions);
}

function validateRiskSummary(value: unknown, derivedRisk: CompiledRiskSummary, errors: string[]): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'highest',
      'usesExtendedInput',
      'usesExtendedOutput',
      'usesHighRiskInput',
      'usesHighRiskOutput',
      'reasons',
    ])
  ) {
    errors.push('risk must be an exact risk summary object');
    return;
  }

  if (!isEnumValue(RISK_LEVELS, value.highest)) {
    errors.push('risk.highest is invalid');
  } else if (getRiskRank(value.highest) < getRiskRank(derivedRisk.highest)) {
    errors.push('risk.highest understates the imported pack risk');
  }

  (
    [
      ['usesExtendedInput', derivedRisk.usesExtendedInput],
      ['usesExtendedOutput', derivedRisk.usesExtendedOutput],
      ['usesHighRiskInput', derivedRisk.usesHighRiskInput],
      ['usesHighRiskOutput', derivedRisk.usesHighRiskOutput],
    ] as const
  ).forEach(([key, required]) => {
    if (!isBoolean(value[key])) {
      errors.push(`risk.${key} must be a boolean`);
      return;
    }

    if (required && value[key] !== true) {
      errors.push(`risk.${key} understates the imported pack risk`);
    }
  });

  if (!Array.isArray(value.reasons) || !value.reasons.every(isString)) {
    errors.push('risk.reasons must be an array of strings');
  }
}

function validateRequiredPermissions(value: unknown, derivedPermissions: string[], errors: string[]): void {
  if (!Array.isArray(value) || !value.every(isString)) {
    errors.push('requiredPermissions must be an array of strings');
    return;
  }

  const allowed = new Set(['clipboardRead', 'clipboardWrite']);
  value.forEach((permission) => {
    if (!allowed.has(permission)) {
      errors.push(`requiredPermissions contains unsupported permission "${permission}"`);
    }
  });

  derivedPermissions.forEach((permission) => {
    if (!value.includes(permission)) {
      errors.push(`requiredPermissions is missing "${permission}"`);
    }
  });
}

function validateSourceFilters(value: unknown, prefix: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${prefix} must be an array`);
    return;
  }

  value.forEach((filter, index) => {
    const filterPrefix = `${prefix}[${index}]`;
    if (!isRecord(filter) || !hasExactKeys(filter, ['source', 'pattern'])) {
      errors.push(`${filterPrefix} must be an exact source filter`);
      return;
    }

    if (!isEnumValue(WORKSPACE_INPUT_SOURCES, filter.source)) {
      errors.push(`${filterPrefix}.source is invalid`);
    }

    if (!isString(filter.pattern)) {
      errors.push(`${filterPrefix}.pattern must be a string`);
      return;
    }

    if (filter.pattern.trim()) {
      try {
        assertSafeRegexPattern(filter.pattern);
      } catch (error) {
        errors.push(error instanceof Error ? `${filterPrefix}.pattern: ${error.message}` : `${filterPrefix}.pattern is unsafe`);
      }
    }
  });
}

function validateInstruction(
  instruction: unknown,
  index: number,
  symbolTable: Record<string, GraphDataType>,
  derivedRisk: CompiledRiskSummary,
  errors: string[],
  listPrefix = 'vm.instructions',
): GraphVmInstruction | null {
  const prefix = `${listPrefix}[${index}]`;
  if (!isRecord(instruction) || !isString(instruction.op)) {
    addError(errors, prefix, 'instruction must be an object with an op');
    return null;
  }

  if (!isString(instruction.nodeId) || !instruction.nodeId.trim()) {
    addError(errors, prefix, 'nodeId must be a non-empty string');
    return null;
  }

  switch (instruction.op) {
    case 'SOURCE': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'source', 'output', 'dataType', 'risk'])) {
        addError(errors, prefix, 'SOURCE instruction has invalid keys');
        return null;
      }

      const port = isString(instruction.source) ? SOURCE_PORTS.get(instruction.source) : undefined;
      if (!port) {
        addError(errors, prefix, 'SOURCE instruction uses an unknown source');
        return null;
      }

      if (instruction.dataType !== port.dataType || instruction.risk !== port.risk) {
        addError(errors, prefix, 'SOURCE instruction metadata does not match its source');
        return null;
      }

      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);
      if (symbolTable[instruction.output as string] !== port.dataType) {
        addError(errors, prefix, 'SOURCE output type does not match the symbol table');
      }

      addRisk(derivedRisk, port.risk, `${instruction.source} is ${port.risk} risk.`, 'input');
      return instruction as GraphVmInstruction;
    }
    case 'CONSTANT': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'value'])) {
        addError(errors, prefix, 'CONSTANT instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);
      validateGraphValue(instruction.value, `${prefix}.value`, errors);
      return instruction as GraphVmInstruction;
    }
    case 'REGEX_TRANSFORM': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'pattern', 'action', 'matchMode', 'payload', 'payloadVars'], ['input', 'payloadInput', 'nthOccurrence'])) {
        addError(errors, prefix, 'REGEX_TRANSFORM instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.input, `${prefix}.input`);
      assertReference(errors, symbolTable, instruction.payloadInput, `${prefix}.payloadInput`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isString(instruction.pattern)) {
        addError(errors, prefix, 'pattern must be a string');
      } else {
        try {
          assertSafeRegexPattern(instruction.pattern);
        } catch (error) {
          addError(errors, prefix, error instanceof Error ? error.message : 'pattern is unsafe');
        }
      }

      if (!isEnumValue(ACTION_TYPES, instruction.action)) {
        addError(errors, prefix, 'action is invalid');
      }

      if (!isEnumValue(MATCH_MODES, instruction.matchMode)) {
        addError(errors, prefix, 'matchMode is invalid');
      }

      if (instruction.nthOccurrence !== undefined && !isPositiveInteger(instruction.nthOccurrence)) {
        addError(errors, prefix, 'nthOccurrence must be a positive integer when provided');
      }

      if (!isString(instruction.payload)) {
        addError(errors, prefix, 'payload must be a string');
      }

      if (!isBoolean(instruction.payloadVars)) {
        addError(errors, prefix, 'payloadVars must be a boolean');
      }

      if (instruction.payloadVars === true && isString(instruction.payload) && instruction.payload.includes('{clipboard}')) {
        addRisk(derivedRisk, 'high', 'Clipboard payload interpolation is high risk.', 'input');
      }

      return instruction as GraphVmInstruction;
    }
    case 'FETCH_GET': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'fallbackUrl', 'outputDataType', 'timeoutMs', 'maxBytes'], ['url'])) {
        addError(errors, prefix, 'FETCH_GET instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.url, `${prefix}.url`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isString(instruction.fallbackUrl)) {
        addError(errors, prefix, 'fallbackUrl must be a string');
      }

      if (!isEnumValue(GRAPH_DATA_TYPES, instruction.outputDataType)) {
        addError(errors, prefix, 'outputDataType is invalid');
      }

      if (!isPositiveInteger(instruction.timeoutMs) || instruction.timeoutMs < 500 || instruction.timeoutMs > 30_000) {
        addError(errors, prefix, 'timeoutMs must be between 500 and 30000');
      }

      if (!isPositiveInteger(instruction.maxBytes) || instruction.maxBytes < 1024 || instruction.maxBytes > 512 * 1024) {
        addError(errors, prefix, 'maxBytes must be between 1024 and 524288');
      }

      addRisk(derivedRisk, 'high', 'Remote data access is high risk.', 'input');
      return instruction as GraphVmInstruction;
    }
    case 'HTTP_REQUEST': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'method', 'fallbackUrl', 'outputDataType', 'timeoutMs', 'maxBytes'], ['url', 'body'])) {
        addError(errors, prefix, 'HTTP_REQUEST instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.url, `${prefix}.url`);
      assertReference(errors, symbolTable, instruction.body, `${prefix}.body`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isEnumValue(REMOTE_METHODS, instruction.method)) {
        addError(errors, prefix, 'method must be GET or POST');
      }

      if (!isString(instruction.fallbackUrl)) {
        addError(errors, prefix, 'fallbackUrl must be a string');
      }

      if (!isEnumValue(GRAPH_DATA_TYPES, instruction.outputDataType)) {
        addError(errors, prefix, 'outputDataType is invalid');
      }

      if (!isPositiveInteger(instruction.timeoutMs) || instruction.timeoutMs < 500 || instruction.timeoutMs > 30_000) {
        addError(errors, prefix, 'timeoutMs must be between 500 and 30000');
      }

      if (!isPositiveInteger(instruction.maxBytes) || instruction.maxBytes < 1024 || instruction.maxBytes > 512 * 1024) {
        addError(errors, prefix, 'maxBytes must be between 1024 and 524288');
      }

      addRisk(derivedRisk, 'high', 'Remote request access is high risk.', 'input');
      return instruction as GraphVmInstruction;
    }
    case 'SYSTEM_DATA': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'mode'])) {
        addError(errors, prefix, 'SYSTEM_DATA instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);
      if (!isEnumValue(SYSTEM_DATA_MODES, instruction.mode)) {
        addError(errors, prefix, 'mode is invalid');
      }

      return instruction as GraphVmInstruction;
    }
    case 'USER_INTERACTION': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'interaction', 'message'], ['messageInput', 'placeholder', 'defaultValue', 'minValue', 'maxValue'])) {
        addError(errors, prefix, 'USER_INTERACTION instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);
      assertReference(errors, symbolTable, instruction.messageInput, `${prefix}.messageInput`);
      if (!isEnumValue(USER_INTERACTIONS, instruction.interaction)) {
        addError(errors, prefix, 'interaction is invalid');
      }

      if (!isString(instruction.message) || instruction.message.length > 2000) {
        addError(errors, prefix, 'message must be a string of 2000 characters or less');
      }

      if (!isOptionalString(instruction.placeholder) || !isOptionalString(instruction.defaultValue)) {
        addError(errors, prefix, 'placeholder/defaultValue must be strings when provided');
      }

      if (instruction.minValue !== undefined && !isFiniteNumber(instruction.minValue)) {
        addError(errors, prefix, 'minValue must be finite when provided');
      }

      if (instruction.maxValue !== undefined && !isFiniteNumber(instruction.maxValue)) {
        addError(errors, prefix, 'maxValue must be finite when provided');
      }

      addRisk(
        derivedRisk,
        instruction.interaction === 'PICK_FILE_OR_URL' ? 'high' : 'extended',
        instruction.interaction === 'PICK_FILE_OR_URL' ? 'File selection or user-provided URL is high risk.' : 'User interaction is extended risk.',
        'input',
      );
      return instruction as GraphVmInstruction;
    }
    case 'GET_ASSET': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'fallbackUrl', 'kind', 'timeoutMs', 'maxBytes'], ['url', 'embedded'])) {
        addError(errors, prefix, 'GET_ASSET instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.url, `${prefix}.url`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isEnumValue(ASSET_KINDS, instruction.kind) || instruction.kind === 'unknown') {
        addError(errors, prefix, 'kind must be image, video, or audio');
      }

      if (!isString(instruction.fallbackUrl)) {
        addError(errors, prefix, 'fallbackUrl must be a string');
      } else if (instruction.fallbackUrl.trim()) {
        try {
          validateRemoteUrl(instruction.fallbackUrl);
        } catch (error) {
          addError(errors, prefix, error instanceof Error ? error.message : 'fallbackUrl is invalid');
        }
      }

      if (instruction.embedded !== undefined) {
        validateAssetRef(instruction.embedded, `${prefix}.embedded`, errors);
      }

      if (!instruction.url && !String(instruction.fallbackUrl ?? '').trim() && instruction.embedded === undefined) {
        addError(errors, prefix, 'GET_ASSET requires a URL reference, fallbackUrl, or embedded asset');
      }

      if (!isPositiveInteger(instruction.timeoutMs) || instruction.timeoutMs < 500 || instruction.timeoutMs > 30_000) {
        addError(errors, prefix, 'timeoutMs must be between 500 and 30000');
      }

      if (!isPositiveInteger(instruction.maxBytes) || instruction.maxBytes < 1 || instruction.maxBytes > MAX_ASSET_MAX_BYTES) {
        addError(errors, prefix, `maxBytes must be between 1 and ${MAX_ASSET_MAX_BYTES}`);
      }

      addRisk(derivedRisk, 'high', instruction.embedded === undefined ? 'Remote media access is high risk.' : 'Embedded media access is high risk.', 'input');
      return instruction as GraphVmInstruction;
    }
    case 'DISPLAY': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'displayType', 'message', 'mode'], ['input', 'titleInput', 'asset', 'output', 'title', 'stopMode', 'timeoutMs', 'captureKeyboard', 'captureMouse'])) {
        addError(errors, prefix, 'DISPLAY instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.input, `${prefix}.input`);
      assertReference(errors, symbolTable, instruction.titleInput, `${prefix}.titleInput`);
      assertReference(errors, symbolTable, instruction.asset, `${prefix}.asset`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`);

      if (!isEnumValue(DISPLAY_TYPES, instruction.displayType)) {
        addError(errors, prefix, 'displayType is invalid');
      }

      if (!isString(instruction.message) || instruction.message.length > 2000) {
        addError(errors, prefix, 'message must be a string of 2000 characters or less');
      }

      if (instruction.title !== undefined && (!isString(instruction.title) || instruction.title.length > 200)) {
        addError(errors, prefix, 'title must be a string of 200 characters or less when provided');
      }

      if (!isEnumValue(DISPLAY_MODES, instruction.mode)) {
        addError(errors, prefix, 'mode is invalid');
      }

      if (instruction.stopMode !== undefined && !isEnumValue(SHOW_IMAGE_STOP_MODES, instruction.stopMode)) {
        addError(errors, prefix, 'stopMode is invalid');
      }

      if (instruction.timeoutMs !== undefined && (!isNonNegativeInteger(instruction.timeoutMs) || instruction.timeoutMs > 3_600_000)) {
        addError(errors, prefix, 'timeoutMs must be between 0 and 3600000');
      }

      if (instruction.captureKeyboard !== undefined && !isBoolean(instruction.captureKeyboard)) {
        addError(errors, prefix, 'captureKeyboard must be boolean when provided');
      }

      if (instruction.captureMouse !== undefined && !isBoolean(instruction.captureMouse)) {
        addError(errors, prefix, 'captureMouse must be boolean when provided');
      }

      addRisk(
        derivedRisk,
        'extended',
        instruction.displayType === 'input-capture'
          ? 'Overlay input can capture keyboard or mouse while it is open.'
          : 'Page overlay display is extended risk.',
        'output',
      );
      return instruction as GraphVmInstruction;
    }
    case 'COMPARE': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'operator', 'compareValue', 'booleanOutput'], ['input'])) {
        addError(errors, prefix, 'COMPARE instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.input, `${prefix}.input`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isEnumValue(COMPARE_OPERATORS, instruction.operator)) {
        addError(errors, prefix, 'operator is invalid');
      }

      if (!isString(instruction.compareValue)) {
        addError(errors, prefix, 'compareValue must be a string');
      }

      if (!isBoolean(instruction.booleanOutput)) {
        addError(errors, prefix, 'booleanOutput must be a boolean');
      }

      return instruction as GraphVmInstruction;
    }
    case 'MATH': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'operation', 'fallbackLeft', 'fallbackRight'], ['left', 'right'])) {
        addError(errors, prefix, 'MATH instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.left, `${prefix}.left`);
      assertReference(errors, symbolTable, instruction.right, `${prefix}.right`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isEnumValue(MATH_OPERATIONS, instruction.operation)) {
        addError(errors, prefix, 'operation is invalid');
      }

      if (!isString(instruction.fallbackLeft) || !isString(instruction.fallbackRight)) {
        addError(errors, prefix, 'fallback values must be strings');
      }

      return instruction as GraphVmInstruction;
    }
    case 'CONVERT': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'mode'], ['input', 'rounding', 'ord'])) {
        addError(errors, prefix, 'CONVERT instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.input, `${prefix}.input`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isEnumValue(CONVERT_MODES, instruction.mode)) {
        addError(errors, prefix, 'mode is invalid');
      }

      if (instruction.rounding !== undefined && !isEnumValue(ROUNDING_MODES, instruction.rounding)) {
        addError(errors, prefix, 'rounding is invalid');
      }

      if (instruction.ord !== undefined && !isBoolean(instruction.ord)) {
        addError(errors, prefix, 'ord must be a boolean when provided');
      }

      return instruction as GraphVmInstruction;
    }
    case 'DECLARE': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'name', 'fallbackValue'], ['value'])) {
        addError(errors, prefix, 'DECLARE instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.value, `${prefix}.value`);

      if (!isString(instruction.name) || !instruction.name.trim()) {
        addError(errors, prefix, 'name must be a non-empty string');
      }

      validateGraphValue(instruction.fallbackValue, `${prefix}.fallbackValue`, errors);

      return instruction as GraphVmInstruction;
    }
    case 'SAVELOAD': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'mode', 'fallbackKey'], ['key', 'value', 'output'])) {
        addError(errors, prefix, 'SAVELOAD instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.key, `${prefix}.key`);
      assertReference(errors, symbolTable, instruction.value, `${prefix}.value`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`);

      if (!isEnumValue(SAVELOAD_MODES, instruction.mode)) {
        addError(errors, prefix, 'mode is invalid');
      }

      if (!isString(instruction.fallbackKey)) {
        addError(errors, prefix, 'fallbackKey must be a string');
      }

      addRisk(derivedRisk, 'extended', 'Session storage access is extended risk.', 'output');
      return instruction as GraphVmInstruction;
    }
    case 'DICT_SET': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'fallbackDictName', 'fallbackKey'], ['dict', 'key', 'value'])) {
        addError(errors, prefix, 'DICT_SET instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.dict, `${prefix}.dict`);
      assertReference(errors, symbolTable, instruction.key, `${prefix}.key`);
      assertReference(errors, symbolTable, instruction.value, `${prefix}.value`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isString(instruction.fallbackDictName) || !isString(instruction.fallbackKey)) {
        addError(errors, prefix, 'fallback dictionary fields must be strings');
      }

      return instruction as GraphVmInstruction;
    }
    case 'LOOP': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'loopLimit'], ['input', 'count'])) {
        addError(errors, prefix, 'LOOP instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.input, `${prefix}.input`);
      assertReference(errors, symbolTable, instruction.count, `${prefix}.count`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isPositiveInteger(instruction.loopLimit) || instruction.loopLimit > 100) {
        addError(errors, prefix, 'loopLimit must be between 1 and 100');
      }

      return instruction as GraphVmInstruction;
    }
    case 'SLEEP': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'fallbackMs'], ['duration', 'enabled', 'output'])) {
        addError(errors, prefix, 'SLEEP instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.duration, `${prefix}.duration`);
      assertReference(errors, symbolTable, instruction.enabled, `${prefix}.enabled`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`);

      if (!isNonNegativeInteger(instruction.fallbackMs) || instruction.fallbackMs > 60_000) {
        addError(errors, prefix, 'fallbackMs must be between 0 and 60000');
      }

      return instruction as GraphVmInstruction;
    }
    case 'SHARED_STATE': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'mode', 'fallbackKey', 'fallbackValue'], ['key', 'value', 'enabled', 'output'])) {
        addError(errors, prefix, 'SHARED_STATE instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.key, `${prefix}.key`);
      assertReference(errors, symbolTable, instruction.value, `${prefix}.value`);
      assertReference(errors, symbolTable, instruction.enabled, `${prefix}.enabled`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`);

      if (!isEnumValue(SHARED_STATE_MODES, instruction.mode)) {
        addError(errors, prefix, 'mode is invalid');
      }

      if (!isString(instruction.fallbackKey) || instruction.fallbackKey.length > 256) {
        addError(errors, prefix, 'fallbackKey must be a string of 256 characters or less');
      }

      validateGraphValue(instruction.fallbackValue, `${prefix}.fallbackValue`, errors);
      addRisk(derivedRisk, 'extended', 'Session-scoped shared state is extended risk.', 'output');
      return instruction as GraphVmInstruction;
    }
    case 'DICT_GET': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'fallbackKey', 'fallbackValue'], ['dict', 'key'])) {
        addError(errors, prefix, 'DICT_GET instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.dict, `${prefix}.dict`);
      assertReference(errors, symbolTable, instruction.key, `${prefix}.key`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isString(instruction.fallbackKey) || instruction.fallbackKey.length > 256) {
        addError(errors, prefix, 'fallbackKey must be a string of 256 characters or less');
      }

      validateGraphValue(instruction.fallbackValue, `${prefix}.fallbackValue`, errors);
      return instruction as GraphVmInstruction;
    }
    case 'LIST_OP': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'operation', 'fallbackList', 'fallbackItem'], ['list', 'item', 'index'])) {
        addError(errors, prefix, 'LIST_OP instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.list, `${prefix}.list`);
      assertReference(errors, symbolTable, instruction.item, `${prefix}.item`);
      assertReference(errors, symbolTable, instruction.index, `${prefix}.index`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!isEnumValue(LIST_OPERATIONS, instruction.operation)) {
        addError(errors, prefix, 'operation is invalid');
      }

      validateGraphValue(instruction.fallbackList, `${prefix}.fallbackList`, errors);
      validateGraphValue(instruction.fallbackItem, `${prefix}.fallbackItem`, errors);
      return instruction as GraphVmInstruction;
    }
    case 'SELECT': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'fallbackTrue', 'fallbackFalse'], ['condition', 'trueValue', 'falseValue'])) {
        addError(errors, prefix, 'SELECT instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.condition, `${prefix}.condition`);
      assertReference(errors, symbolTable, instruction.trueValue, `${prefix}.trueValue`);
      assertReference(errors, symbolTable, instruction.falseValue, `${prefix}.falseValue`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);
      validateGraphValue(instruction.fallbackTrue, `${prefix}.fallbackTrue`, errors);
      validateGraphValue(instruction.fallbackFalse, `${prefix}.fallbackFalse`, errors);
      return instruction as GraphVmInstruction;
    }
    case 'RANDOM_INT': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'fallbackMin', 'fallbackMax'], ['min', 'max'])) {
        addError(errors, prefix, 'RANDOM_INT instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.min, `${prefix}.min`);
      assertReference(errors, symbolTable, instruction.max, `${prefix}.max`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);

      if (!Number.isInteger(instruction.fallbackMin) || !Number.isInteger(instruction.fallbackMax)) {
        addError(errors, prefix, 'fallback bounds must be integers');
      }

      return instruction as GraphVmInstruction;
    }
    case 'SUBSTITUTE': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'output', 'template', 'values'])) {
        addError(errors, prefix, 'SUBSTITUTE instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`, true);
      if (!isString(instruction.template) || instruction.template.length > 4_000) {
        addError(errors, prefix, 'template must be a string of 4000 characters or less');
      }

      if (!Array.isArray(instruction.values) || instruction.values.length > 24) {
        addError(errors, prefix, 'values must contain 24 or fewer references');
      } else {
        instruction.values.forEach((value, valueIndex) => {
          if (value !== '') {
            assertReference(errors, symbolTable, value, `${prefix}.values[${valueIndex}]`);
          }
        });
      }

      return instruction as GraphVmInstruction;
    }
    case 'LOG': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'severity', 'fallbackMessage'], ['message', 'output'])) {
        addError(errors, prefix, 'LOG instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.message, `${prefix}.message`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`);
      if (!isEnumValue(LOG_SEVERITIES, instruction.severity)) {
        addError(errors, prefix, 'severity is invalid');
      }

      if (!isString(instruction.fallbackMessage) || instruction.fallbackMessage.length > 4_000) {
        addError(errors, prefix, 'fallbackMessage must be a string of 4000 characters or less');
      }

      addRisk(derivedRisk, 'extended', 'Action Pack logging stores local run data.', 'output');
      return instruction as GraphVmInstruction;
    }
    case 'ABORT': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'message'], ['condition', 'output'])) {
        addError(errors, prefix, 'ABORT instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.condition, `${prefix}.condition`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`);
      if (!isString(instruction.message) || instruction.message.length > 1_000) {
        addError(errors, prefix, 'message must be a string of 1000 characters or less');
      }

      return instruction as GraphVmInstruction;
    }
    case 'OVERLAY_CONTROL': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'action', 'message', 'width', 'height', 'cellSize', 'tickMs', 'background'], ['enabled', 'messageInput', 'output'])) {
        addError(errors, prefix, 'OVERLAY_CONTROL instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.enabled, `${prefix}.enabled`);
      assertReference(errors, symbolTable, instruction.messageInput, `${prefix}.messageInput`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`);

      if (!isEnumValue(OVERLAY_CONTROL_ACTIONS, instruction.action)) {
        addError(errors, prefix, 'action is invalid');
      }

      if (!isString(instruction.message) || instruction.message.length > 2000 || !isString(instruction.background) || instruction.background.length > 128) {
        addError(errors, prefix, 'message/background fields are invalid');
      }

      if (!isPositiveInteger(instruction.width) || instruction.width > 200 || !isPositiveInteger(instruction.height) || instruction.height > 200) {
        addError(errors, prefix, 'overlay dimensions must be between 1 and 200');
      }

      if (!isPositiveInteger(instruction.cellSize) || instruction.cellSize < 4 || instruction.cellSize > 96) {
        addError(errors, prefix, 'cellSize must be between 4 and 96');
      }

      if (!isPositiveInteger(instruction.tickMs) || instruction.tickMs < 16 || instruction.tickMs > 5_000) {
        addError(errors, prefix, 'tickMs must be between 16 and 5000');
      }

      addRisk(derivedRisk, 'extended', 'Interactive overlay display is extended risk.', 'output');
      return instruction as GraphVmInstruction;
    }
    case 'OVERLAY_DRAW': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'width', 'height', 'cellSize', 'background'], ['enabled', 'cells', 'text', 'output'])) {
        addError(errors, prefix, 'OVERLAY_DRAW instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.enabled, `${prefix}.enabled`);
      assertReference(errors, symbolTable, instruction.cells, `${prefix}.cells`);
      assertReference(errors, symbolTable, instruction.text, `${prefix}.text`);
      assertReference(errors, symbolTable, instruction.output, `${prefix}.output`);

      if (!isString(instruction.background) || instruction.background.length > 128) {
        addError(errors, prefix, 'background is invalid');
      }

      if (!isPositiveInteger(instruction.width) || instruction.width > 200 || !isPositiveInteger(instruction.height) || instruction.height > 200) {
        addError(errors, prefix, 'overlay dimensions must be between 1 and 200');
      }

      if (!isPositiveInteger(instruction.cellSize) || instruction.cellSize < 4 || instruction.cellSize > 96) {
        addError(errors, prefix, 'cellSize must be between 4 and 96');
      }

      addRisk(derivedRisk, 'extended', 'Interactive overlay display is extended risk.', 'output');
      return instruction as GraphVmInstruction;
    }
    case 'OUTPUT': {
      if (!hasExactKeys(instruction, ['op', 'nodeId', 'input', 'destination', 'dataType', 'risk'])) {
        addError(errors, prefix, 'OUTPUT instruction has invalid keys');
        return null;
      }

      assertReference(errors, symbolTable, instruction.input, `${prefix}.input`, true);

      const port = isString(instruction.destination) ? DESTINATION_PORTS.get(instruction.destination) : undefined;
      if (!port) {
        addError(errors, prefix, 'OUTPUT instruction uses an unknown destination');
        return null;
      }

      if (instruction.dataType !== port.dataType || instruction.risk !== port.risk) {
        addError(errors, prefix, 'OUTPUT instruction metadata does not match its destination');
        return null;
      }

      addRisk(derivedRisk, port.risk, `${instruction.destination} is ${port.risk} risk.`, 'output');
      return instruction as GraphVmInstruction;
    }
    default:
      addError(errors, prefix, `unknown instruction op "${instruction.op}"`);
      return null;
  }
}

function validateManifest(value: unknown, errors: string[]): CompiledActionPackV2['manifest'] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'name', 'version', 'enabled', 'metadata', 'trigger'])) {
    errors.push('manifest must be an exact manifest object');
    return null;
  }

  if (!isString(value.id) || !value.id.trim()) {
    errors.push('manifest.id must be a non-empty string');
  }

  if (!isString(value.name) || !value.name.trim()) {
    errors.push('manifest.name must be a non-empty string');
  }

  if (!isPositiveInteger(value.version)) {
    errors.push('manifest.version must be a positive integer');
  }

  if (!isBoolean(value.enabled)) {
    errors.push('manifest.enabled must be a boolean');
  }

  if (!isRecord(value.metadata) || !hasExactKeys(value.metadata, ['created_at'], ['author', 'description', 'versionFileUrl', 'versionFileSignatureUrl', 'downloadUrl', 'publicKeyLocateValue'])) {
    errors.push('manifest.metadata must be exact');
  } else {
    const metadata = value.metadata;
    ['author', 'description', 'versionFileUrl', 'versionFileSignatureUrl', 'downloadUrl', 'publicKeyLocateValue'].forEach((key) => {
      if (!isOptionalString(metadata[key])) {
        errors.push(`manifest.metadata.${key} must be a string when provided`);
      }
    });

    if (!isNonNegativeInteger(metadata.created_at)) {
      errors.push('manifest.metadata.created_at must be a non-negative integer');
    }
  }

  if (!isRecord(value.trigger) || !hasExactKeys(value.trigger, ['type'], ['hotkey', 'inputSources', 'sourceFilters', 'intervalMs', 'conditionalMode', 'conditionWorkspaceId'])) {
    errors.push('manifest.trigger must be exact');
  } else {
    if (!isEnumValue(WORKSPACE_TRIGGER_TYPES, value.trigger.type)) {
      errors.push('manifest.trigger.type is invalid');
    }

    if (!isOptionalString(value.trigger.hotkey) || !isOptionalString(value.trigger.conditionWorkspaceId)) {
      errors.push('manifest.trigger optional fields must be strings');
    }

    if (value.trigger.inputSources !== undefined && (!Array.isArray(value.trigger.inputSources) || !value.trigger.inputSources.every((source) => isEnumValue(WORKSPACE_INPUT_SOURCES, source)))) {
      errors.push('manifest.trigger.inputSources is invalid');
    }

    if (value.trigger.sourceFilters !== undefined) {
      validateSourceFilters(value.trigger.sourceFilters, 'manifest.trigger.sourceFilters', errors);
    }

    if (value.trigger.intervalMs !== undefined && (!isPositiveInteger(value.trigger.intervalMs) || value.trigger.intervalMs < MIN_INTERVAL_TRIGGER_MS)) {
      errors.push('manifest.trigger.intervalMs is below the supported minimum');
    }

    if (value.trigger.conditionalMode !== undefined && !isEnumValue(CONDITIONAL_MODES, value.trigger.conditionalMode)) {
      errors.push('manifest.trigger.conditionalMode is invalid');
    }
  }

  return errors.length === 0 ? (value as unknown as CompiledActionPackV2['manifest']) : null;
}

function validateBuilder(value: unknown, errors: string[]): CompiledActionPackV2['builder'] | null {
  if (!isRecord(value) || !hasExactKeys(value, ['urlAlchemistVersion', 'buildTimeUtc', 'builderUuid'])) {
    errors.push('builder must be an exact builder metadata object');
    return null;
  }

  if (!isString(value.urlAlchemistVersion) || !value.urlAlchemistVersion.trim()) {
    errors.push('builder.urlAlchemistVersion must be a non-empty string');
  }

  if (!isNonNegativeInteger(value.buildTimeUtc)) {
    errors.push('builder.buildTimeUtc must be a non-negative integer');
  }

  if (!isString(value.builderUuid) || !value.builderUuid.trim()) {
    errors.push('builder.builderUuid must be a non-empty string');
  }

  return errors.length === 0 ? (value as unknown as CompiledActionPackV2['builder']) : null;
}

function validateTriggerPlan(value: unknown, errors: string[]): CompiledTriggerPlan | null {
  if (!isRecord(value) || !hasExactKeys(value, ['type', 'inputSources', 'sourceFilters', 'safety'], ['intervalMs', 'conditionalMode', 'conditionWorkspaceId'])) {
    errors.push('triggerPlan must be an exact trigger plan object');
    return null;
  }

  if (!isEnumValue(WORKSPACE_TRIGGER_TYPES, value.type)) {
    errors.push('triggerPlan.type is invalid');
  } else if (value.type === 'CONDITIONAL') {
    errors.push('triggerPlan.type CONDITIONAL is not supported by the Chrome runtime yet');
  }

  if (!Array.isArray(value.inputSources) || !value.inputSources.every((source) => isEnumValue(WORKSPACE_INPUT_SOURCES, source))) {
    errors.push('triggerPlan.inputSources is invalid');
  }

  validateSourceFilters(value.sourceFilters, 'triggerPlan.sourceFilters', errors);

  if (value.intervalMs !== undefined && (!isPositiveInteger(value.intervalMs) || value.intervalMs < MIN_INTERVAL_TRIGGER_MS)) {
    errors.push('triggerPlan.intervalMs is below the supported minimum');
  }

  if (value.conditionalMode !== undefined && !isEnumValue(CONDITIONAL_MODES, value.conditionalMode)) {
    errors.push('triggerPlan.conditionalMode is invalid');
  }

  if (!isRecord(value.safety) || !hasExactKeys(value.safety, ['timestampHistoryLimit', 'burstLimit', 'burstWindowMs'])) {
    errors.push('triggerPlan.safety must be exact');
  } else {
    if (!isPositiveInteger(value.safety.timestampHistoryLimit) || value.safety.timestampHistoryLimit > INPUT_TRIGGER_HISTORY_LIMIT) {
      errors.push('triggerPlan.safety.timestampHistoryLimit is invalid');
    }

    if (!isPositiveInteger(value.safety.burstLimit) || value.safety.burstLimit > INPUT_TRIGGER_BURST_LIMIT) {
      errors.push('triggerPlan.safety.burstLimit is invalid');
    }

    if (!isPositiveInteger(value.safety.burstWindowMs) || value.safety.burstWindowMs > INPUT_TRIGGER_BURST_WINDOW_MS) {
      errors.push('triggerPlan.safety.burstWindowMs is invalid');
    }
  }

  return errors.length === 0 ? value as unknown as CompiledTriggerPlan : null;
}

function validateSafetyPolicy(value: unknown, errors: string[]): GraphVmSafetyPolicy | null {
  if (!isRecord(value) || !hasExactKeys(value, ['abortOnFailure', 'regexTimeoutMs', 'remoteTimeoutMs', 'remoteMaxBytes', 'rules'])) {
    errors.push('vm.safety must be an exact safety policy');
    return null;
  }

  if (!isBoolean(value.abortOnFailure)) {
    errors.push('vm.safety.abortOnFailure must be a boolean');
  }

  if (!isPositiveInteger(value.regexTimeoutMs) || value.regexTimeoutMs > 1_000) {
    errors.push('vm.safety.regexTimeoutMs is invalid');
  }

  if (!isPositiveInteger(value.remoteTimeoutMs) || value.remoteTimeoutMs > 30_000) {
    errors.push('vm.safety.remoteTimeoutMs is invalid');
  }

  if (!isPositiveInteger(value.remoteMaxBytes) || value.remoteMaxBytes > MAX_ASSET_MAX_BYTES) {
    errors.push('vm.safety.remoteMaxBytes is invalid');
  }

  if (!Array.isArray(value.rules)) {
    errors.push('vm.safety.rules must be an array');
  } else {
    value.rules.forEach((rule, index) => {
      if (!isRecord(rule) || !hasExactKeys(rule, ['nodeId', 'op', 'requiresWatchdog'], ['maxRuntimeMs', 'maxBytes', 'rangeCheck'])) {
        errors.push(`vm.safety.rules[${index}] must be exact`);
        return;
      }

      if (!isString(rule.nodeId) || !isString(rule.op) || !isBoolean(rule.requiresWatchdog)) {
        errors.push(`vm.safety.rules[${index}] has invalid fields`);
      }

      if (rule.maxRuntimeMs !== undefined && !isPositiveInteger(rule.maxRuntimeMs)) {
        errors.push(`vm.safety.rules[${index}].maxRuntimeMs is invalid`);
      }

      if (rule.maxBytes !== undefined && !isPositiveInteger(rule.maxBytes)) {
        errors.push(`vm.safety.rules[${index}].maxBytes is invalid`);
      }

      if (!isOptionalString(rule.rangeCheck)) {
        errors.push(`vm.safety.rules[${index}].rangeCheck is invalid`);
      }
    });
  }

  return errors.length === 0 ? value as unknown as GraphVmSafetyPolicy : null;
}

function validateVm(value: unknown, errors: string[]): { vm: CompiledActionPackV2['vm']; risk: CompiledRiskSummary; allInstructions: GraphVmInstruction[] } | null {
  if (!isRecord(value) || !hasExactKeys(value, ['instructions', 'constants', 'symbolTable', 'stepBudget', 'loopBudget', 'valueByteLimit', 'safety'], ['eventHandlers'])) {
    errors.push('vm must be an exact VM program object');
    return null;
  }

  const constants = validateConstants(value.constants, errors);
  const symbolTable = validateSymbolTable(value.symbolTable, errors);
  const safety = validateSafetyPolicy(value.safety, errors);

  if (!isPositiveInteger(value.stepBudget) || value.stepBudget > MAX_VM_STEP_BUDGET) {
    errors.push(`vm.stepBudget must be between 1 and ${MAX_VM_STEP_BUDGET}`);
  }

  if (!isPositiveInteger(value.loopBudget) || value.loopBudget > MAX_VM_LOOP_BUDGET) {
    errors.push(`vm.loopBudget must be between 1 and ${MAX_VM_LOOP_BUDGET}`);
  }

  if (!isPositiveInteger(value.valueByteLimit) || value.valueByteLimit > MAX_VM_VALUE_BYTE_LIMIT) {
    errors.push(`vm.valueByteLimit must be between 1 and ${MAX_VM_VALUE_BYTE_LIMIT}`);
  }

  if (!Array.isArray(value.instructions)) {
    errors.push('vm.instructions must be an array');
    return null;
  }

  if (value.instructions.length > MAX_VM_INSTRUCTIONS) {
    errors.push(`vm.instructions cannot contain more than ${MAX_VM_INSTRUCTIONS} instructions`);
  }

  if (!symbolTable || !constants || !safety) {
    return null;
  }

  const derivedRisk = emptyRisk();
  const instructions = value.instructions
    .map((instruction, index) => validateInstruction(instruction, index, symbolTable, derivedRisk, errors))
    .filter((instruction): instruction is GraphVmInstruction => Boolean(instruction));

  if (instructions.length !== value.instructions.length) {
    return null;
  }

  const eventHandlers: Partial<Record<GraphEventHandler, GraphVmInstruction[]>> = {};
  if (value.eventHandlers !== undefined) {
    const eventHandlerCandidate = value.eventHandlers;
    if (!isRecord(eventHandlerCandidate) || !hasNoDangerousKeys(eventHandlerCandidate)) {
      errors.push('vm.eventHandlers must be a plain object');
      return null;
    }

    Object.keys(eventHandlerCandidate).forEach((handler) => {
      if (!isEnumValue(GRAPH_EVENT_HANDLERS, handler)) {
        errors.push(`vm.eventHandlers contains unsupported handler "${handler}"`);
      }
    });

    GRAPH_EVENT_HANDLERS.forEach((handler) => {
      const handlerValue = eventHandlerCandidate[handler];
      if (handlerValue === undefined) {
        return;
      }

      if (!Array.isArray(handlerValue)) {
        errors.push(`vm.eventHandlers.${handler} must be an array`);
        return;
      }

      if (handlerValue.length > MAX_VM_INSTRUCTIONS) {
        errors.push(`vm.eventHandlers.${handler} cannot contain more than ${MAX_VM_INSTRUCTIONS} instructions`);
      }

      const validated = handlerValue
        .map((instruction, index) => validateInstruction(instruction, index, symbolTable, derivedRisk, errors, `vm.eventHandlers.${handler}`))
        .filter((instruction): instruction is GraphVmInstruction => Boolean(instruction));
      if (validated.length === handlerValue.length) {
        eventHandlers[handler] = validated;
      }
    });
  }

  if (errors.length > 0) {
    return null;
  }

  const allInstructions = [
    ...instructions,
    ...GRAPH_EVENT_HANDLERS.flatMap((handler) => eventHandlers[handler] ?? []),
  ];

  return {
    vm: {
      instructions,
      eventHandlers,
      constants,
      symbolTable,
      stepBudget: value.stepBudget as number,
      loopBudget: value.loopBudget as number,
      valueByteLimit: value.valueByteLimit as number,
      safety,
    },
    risk: derivedRisk,
    allInstructions,
  };
}

function deriveInputSourcesFromCandidate(candidate: Record<string, unknown>): WorkspaceInputSource[] {
  const vm = isRecord(candidate.vm) ? candidate.vm : {};
  const instructions = Array.isArray(vm.instructions) ? vm.instructions : [];
  const sources = new Set<WorkspaceInputSource>();
  instructions.forEach((instruction) => {
    if (isRecord(instruction) && instruction.op === 'SOURCE' && isEnumValue(WORKSPACE_INPUT_SOURCES, instruction.source)) {
      sources.add(instruction.source);
    }
  });

  if (sources.size === 0) {
    sources.add('url');
  }

  return Array.from(sources).sort();
}

function defaultSafetyForCandidate(candidate: Record<string, unknown>): GraphVmSafetyPolicy {
  const vm = isRecord(candidate.vm) ? candidate.vm : {};
  const instructions = Array.isArray(vm.instructions) ? vm.instructions : [];
  return {
    abortOnFailure: true,
    regexTimeoutMs: 50,
    remoteTimeoutMs: DEFAULT_REMOTE_TIMEOUT_MS,
    remoteMaxBytes: DEFAULT_REMOTE_MAX_BYTES,
    rules: instructions
      .filter(isRecord)
      .map((instruction) => ({
        nodeId: isString(instruction.nodeId) ? instruction.nodeId : 'unknown',
        op: isString(instruction.op) ? instruction.op as GraphVmInstruction['op'] : 'SOURCE',
        requiresWatchdog: instruction.op === 'REGEX_TRANSFORM' || instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST' || instruction.op === 'GET_ASSET',
        maxRuntimeMs: instruction.op === 'REGEX_TRANSFORM'
          ? 50
          : instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST' || instruction.op === 'GET_ASSET'
            ? isPositiveInteger(instruction.timeoutMs) ? instruction.timeoutMs : DEFAULT_REMOTE_TIMEOUT_MS
            : undefined,
        maxBytes: instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST' || instruction.op === 'GET_ASSET'
          ? isPositiveInteger(instruction.maxBytes) ? instruction.maxBytes : DEFAULT_REMOTE_MAX_BYTES
          : undefined,
      })),
  };
}

function migrateDeclareFallback(value: string): GraphValue {
  const trimmed = value.trim();
  const parsedNumber = Number.parseFloat(trimmed);
  if (trimmed && Number.isFinite(parsedNumber) && String(parsedNumber) === trimmed) {
    return {
      type: Number.isInteger(parsedNumber) ? 'number' : 'floatingPoint',
      value: parsedNumber,
    } as GraphValue;
  }

  return { type: 'string', value };
}

function migrateVmInstructionCandidate(instruction: unknown): unknown {
  if (!isRecord(instruction)) {
    return instruction;
  }

  if (instruction.op === 'DECLARE' && isString(instruction.fallbackValue)) {
    return {
      ...instruction,
      fallbackValue: migrateDeclareFallback(instruction.fallbackValue),
    };
  }

  return instruction;
}

function migrateVmInstructionListCandidate(instructions: unknown): unknown {
  return Array.isArray(instructions) ? instructions.map(migrateVmInstructionCandidate) : instructions;
}

function migrateEventHandlersCandidate(eventHandlers: unknown): unknown {
  if (!isRecord(eventHandlers)) {
    return eventHandlers;
  }

  return Object.fromEntries(
    Object.entries(eventHandlers).map(([handler, instructions]) => [
      handler,
      migrateVmInstructionListCandidate(instructions),
    ]),
  );
}

export function migrateCompiledActionPackV2Candidate(candidate: unknown): unknown {
  if (!isRecord(candidate) || candidate.kind !== 'action-pack.v2') {
    return candidate;
  }

  if (!(SUPPORTED_ACTION_PACK_SCHEMA_VERSIONS as readonly number[]).includes(Number(candidate.schemaVersion))) {
    return candidate;
  }

  const manifest = isRecord(candidate.manifest) ? candidate.manifest : {};
  const vm = isRecord(candidate.vm) ? candidate.vm : {};
  const trigger = isRecord(manifest.trigger) ? manifest.trigger : {};
  const triggerType = trigger.type === 'ALWAYS' ? 'INPUT_DATA' : trigger.type;
  const inputSources = Array.isArray(trigger.inputSources) && trigger.inputSources.length > 0
    ? trigger.inputSources.filter((source): source is WorkspaceInputSource => isEnumValue(WORKSPACE_INPUT_SOURCES, source))
    : deriveInputSourcesFromCandidate(candidate);
  const sourceFilters = Array.isArray(trigger.sourceFilters) ? [...trigger.sourceFilters] : [];
  if (isString(trigger.scope_regex) && trigger.scope_regex.trim()) {
    sourceFilters.push({
      source: 'url',
      pattern: trigger.scope_regex.trim(),
    });
  }

  const triggerPlan: CompiledTriggerPlan = {
    type: isEnumValue(WORKSPACE_TRIGGER_TYPES, triggerType) ? triggerType : 'INPUT_DATA',
    inputSources: inputSources.length > 0 ? inputSources : ['url'],
    sourceFilters: sourceFilters as CompiledTriggerPlan['sourceFilters'],
    intervalMs: isPositiveInteger(trigger.intervalMs) ? Math.max(MIN_INTERVAL_TRIGGER_MS, trigger.intervalMs) : undefined,
    conditionalMode: isEnumValue(CONDITIONAL_MODES, trigger.conditionalMode) ? trigger.conditionalMode : undefined,
    conditionWorkspaceId: isString(trigger.conditionWorkspaceId) ? trigger.conditionWorkspaceId : undefined,
    safety: {
      timestampHistoryLimit: INPUT_TRIGGER_HISTORY_LIMIT,
      burstLimit: INPUT_TRIGGER_BURST_LIMIT,
      burstWindowMs: INPUT_TRIGGER_BURST_WINDOW_MS,
    },
  };

  return {
    ...candidate,
    schemaVersion: ACTION_PACK_SCHEMA_VERSION,
    manifest: {
      ...manifest,
      trigger: {
        type: triggerPlan.type,
        hotkey: isString(trigger.hotkey) ? trigger.hotkey : undefined,
        inputSources: triggerPlan.inputSources,
        sourceFilters: triggerPlan.sourceFilters,
        intervalMs: triggerPlan.intervalMs,
        conditionalMode: triggerPlan.conditionalMode,
        conditionWorkspaceId: triggerPlan.conditionWorkspaceId,
      },
    },
    triggerPlan: isRecord(candidate.triggerPlan) ? candidate.triggerPlan : triggerPlan,
    vm: {
      ...vm,
      instructions: migrateVmInstructionListCandidate(vm.instructions),
      eventHandlers: isRecord(vm.eventHandlers)
        ? migrateEventHandlersCandidate(vm.eventHandlers)
        : {
            trigger: Array.isArray(vm.instructions)
              ? migrateVmInstructionListCandidate(vm.instructions)
              : [],
            keyboard: [],
            mouse: [],
            tick: [],
          },
      safety: isRecord(vm.safety)
        ? vm.safety
        : defaultSafetyForCandidate(candidate),
    },
  };
}

export function validateCompiledActionPackV2(candidate: unknown): ValidationResult {
  const errors: string[] = [];
  candidate = migrateCompiledActionPackV2Candidate(candidate);

  if (!isRecord(candidate) || !hasExactKeys(candidate, ['kind', 'schemaVersion', 'manifest', 'builder', 'risk', 'triggerPlan', 'requiredPermissions', 'vm'], ['sourceWorkspaceId', 'checksumHex', 'traceEnabledUntil'])) {
    return { ok: false, errors: ['The file is not a valid Action Pack'] };
  }

  if (candidate.kind !== 'action-pack.v2') {
    errors.push('kind must be action-pack.v2');
  }

  if (candidate.schemaVersion !== ACTION_PACK_SCHEMA_VERSION) {
    errors.push(`Unsupported Action Pack schema version: ${String(candidate.schemaVersion)}`);
  }

  if (candidate.sourceWorkspaceId !== undefined && !isString(candidate.sourceWorkspaceId)) {
    errors.push('sourceWorkspaceId must be a string when provided');
  }

  const manifest = validateManifest(candidate.manifest, errors);
  const builder = validateBuilder(candidate.builder, errors);
  const triggerPlan = validateTriggerPlan(candidate.triggerPlan, errors);
  const vmValidation = validateVm(candidate.vm, errors);

  if (vmValidation) {
    const requiredPermissions = deriveRequiredPermissions(vmValidation.allInstructions);
    validateRiskSummary(candidate.risk, vmValidation.risk, errors);
    validateRequiredPermissions(candidate.requiredPermissions, requiredPermissions, errors);

    if (errors.length === 0 && manifest && builder && triggerPlan) {
      return {
        ok: true,
        pack: {
          kind: 'action-pack.v2',
          schemaVersion: ACTION_PACK_SCHEMA_VERSION,
          manifest,
          sourceWorkspaceId: candidate.sourceWorkspaceId as string | undefined,
          builder,
          risk: vmValidation.risk,
          triggerPlan,
          requiredPermissions,
          vm: vmValidation.vm,
          traceEnabledUntil: isNonNegativeInteger(candidate.traceEnabledUntil) ? candidate.traceEnabledUntil : undefined,
        },
      };
    }
  }

  return {
    ok: false,
    errors,
  };
}
