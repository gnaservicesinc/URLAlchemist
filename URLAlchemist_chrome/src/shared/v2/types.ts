import type { ActionPack, ActionType, MatchMode, TriggerType } from '../types';

export const WORKSPACE_SCHEMA_VERSION = 2;
export const ACTION_PACK_SCHEMA_VERSION = 2;

export type GraphDataType =
  | 'bool'
  | 'number'
  | 'floatingPoint'
  | 'string'
  | 'URL'
  | 'JSON'
  | 'data'
  | 'dict'
  | 'Any';

export type GraphValue =
  | { type: 'bool'; value: 0 | 1 }
  | { type: 'number'; value: number | number[] }
  | { type: 'floatingPoint'; value: number | number[] }
  | { type: 'string'; value: string }
  | { type: 'URL'; value: string }
  | { type: 'JSON'; value: string }
  | { type: 'data'; value: unknown }
  | { type: 'dict'; value: Record<string, GraphValue> }
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
  category: 'flow' | 'logic' | 'regex' | 'math' | 'storage' | 'convert' | 'data';
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
  created_at: number;
  updated_at: number;
}

export interface WorkspaceTrigger {
  type: TriggerType;
  hotkey?: string;
  scope_regex?: string;
}

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
  payloadVars?: boolean;
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

export interface CompiledManifestV2 {
  id: string;
  name: string;
  version: number;
  enabled: boolean;
  metadata: {
    author?: string;
    description?: string;
    created_at: number;
  };
  trigger: WorkspaceTrigger;
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
      payloadVars: boolean;
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

export interface GraphVmProgram {
  instructions: GraphVmInstruction[];
  constants: Record<string, GraphValue>;
  symbolTable: Record<string, GraphDataType>;
  stepBudget: number;
  loopBudget: number;
  valueByteLimit: number;
}

export interface CompiledActionPackV2 {
  kind: 'action-pack.v2';
  schemaVersion: typeof ACTION_PACK_SCHEMA_VERSION;
  manifest: CompiledManifestV2;
  sourceWorkspaceId?: string;
  risk: CompiledRiskSummary;
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

