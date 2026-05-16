import type { BlockDefinition, BlockKind, GraphDataType, GraphPortDefinition, RiskLevel, WorkspaceNodeV2 } from './types';
import { BLOCK_TYPE_IDS } from './types';

function port(
  id: string,
  label: string,
  dataType: GraphDataType,
  options: Pick<GraphPortDefinition, 'required' | 'risk' | 'description'> = {},
): GraphPortDefinition {
  return {
    id,
    label,
    dataType,
    ...options,
  };
}

const defaultFlags = {
  alwaysProcess: false,
  processBeforeRun: false,
  canDelete: true,
};

export const BLOCK_REGISTRY: Record<BlockKind, BlockDefinition> = {
  DataFlowIn: {
    kind: 'DataFlowIn',
    typeId: BLOCK_TYPE_IDS.DataFlowIn,
    label: 'Data In',
    category: 'flow',
    inputs: [],
    outputs: [
      port('url', 'URL', 'URL', { risk: 'safe' }),
      port('linkUrl', 'Link URL', 'URL', { risk: 'safe' }),
      port('selectedText', 'Selection', 'string', { risk: 'safe' }),
      port('pageTitle', 'Title', 'string', { risk: 'safe' }),
      port('pageMetadata', 'Metadata', 'dict', { risk: 'safe' }),
    ],
    flags: defaultFlags,
    defaultSettings: { locked: false },
    risk: 'safe',
  },
  DataFlowOut: {
    kind: 'DataFlowOut',
    typeId: BLOCK_TYPE_IDS.DataFlowOut,
    label: 'Data Out',
    category: 'flow',
    inputs: [port('url', 'URL', 'URL', { risk: 'safe' })],
    outputs: [],
    flags: defaultFlags,
    defaultSettings: { locked: true },
    risk: 'safe',
  },
  Logical: {
    kind: 'Logical',
    typeId: BLOCK_TYPE_IDS.Logical,
    label: 'Logic',
    category: 'logic',
    inputs: [port('input', 'Input', 'number', { required: true })],
    outputs: [port('result', 'Result', 'number')],
    flags: defaultFlags,
    defaultSettings: {
      operator: 'EQ',
      compareValue: '1',
      booleanOutput: true,
    },
    risk: 'safe',
  },
  Loop: {
    kind: 'Loop',
    typeId: BLOCK_TYPE_IDS.Loop,
    label: 'Loop',
    category: 'logic',
    inputs: [port('input', 'Input', 'Any', { required: true }), port('count', 'Count', 'number')],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      loopLimit: 10,
    },
    risk: 'safe',
  },
  RegExpression: {
    kind: 'RegExpression',
    typeId: BLOCK_TYPE_IDS.RegExpression,
    label: 'Regex',
    category: 'regex',
    inputs: [port('input', 'Input', 'Any', { required: true }), port('payload', 'Payload', 'Any')],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      pattern: '',
      action: 'SUBSTITUTE',
      matchMode: 'STANDARD',
      nthOccurrence: 1,
      payload: '',
      payloadVars: false,
    },
    risk: 'safe',
  },
  Math: {
    kind: 'Math',
    typeId: BLOCK_TYPE_IDS.Math,
    label: 'Math',
    category: 'math',
    inputs: [port('left', 'A', 'number'), port('right', 'B', 'number')],
    outputs: [port('result', 'Result', 'number')],
    flags: defaultFlags,
    defaultSettings: {
      mathOperation: 'ADD',
      literalValue: '0',
    },
    risk: 'safe',
  },
  SaveLoad: {
    kind: 'SaveLoad',
    typeId: BLOCK_TYPE_IDS.SaveLoad,
    label: 'Save Load',
    category: 'storage',
    inputs: [port('key', 'Key', 'string'), port('value', 'Value', 'Any')],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      saveLoadMode: 'SAVE',
      literalValue: '',
    },
    risk: 'extended',
  },
  Convert: {
    kind: 'Convert',
    typeId: BLOCK_TYPE_IDS.Convert,
    label: 'Convert',
    category: 'convert',
    inputs: [port('input', 'Input', 'Any', { required: true })],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      convertMode: 'STRING_TO_URL',
      convertOrd: true,
      rounding: 'ROUND',
    },
    risk: 'safe',
  },
  Declarations: {
    kind: 'Declarations',
    typeId: BLOCK_TYPE_IDS.Declarations,
    label: 'Declare',
    category: 'data',
    inputs: [port('value', 'Value', 'Any')],
    outputs: [],
    flags: {
      alwaysProcess: true,
      processBeforeRun: true,
      canDelete: true,
    },
    defaultSettings: {
      variableName: '',
      literalValue: '',
      literalDataType: 'string',
      processBeforeRun: true,
      alwaysProcess: true,
    },
    risk: 'safe',
  },
  DataStructure: {
    kind: 'DataStructure',
    typeId: BLOCK_TYPE_IDS.DataStructure,
    label: 'Dict Set',
    category: 'data',
    inputs: [port('dict', 'Dict', 'dict'), port('key', 'Key', 'string'), port('value', 'Value', 'Any')],
    outputs: [port('result', 'Dict', 'dict')],
    flags: defaultFlags,
    defaultSettings: {
      variableName: '',
      dictKey: '',
    },
    risk: 'safe',
  },
  ExtendedDataIn: {
    kind: 'ExtendedDataIn',
    typeId: BLOCK_TYPE_IDS.ExtendedDataIn,
    label: 'Extended In',
    category: 'flow',
    inputs: [],
    outputs: [
      port('clipboard', 'Clipboard', 'string', { risk: 'high' }),
      port('pageText', 'Page Text', 'string', { risk: 'high' }),
      port('rawHtml', 'Raw HTML', 'string', { risk: 'high' }),
      port('mediaData', 'Media Data', 'dict', { risk: 'extended' }),
      port('pageLinks', 'Page Links', 'data', { risk: 'extended' }),
      port('jsMetadata', 'JS Metadata', 'dict', { risk: 'high' }),
      port('consoleOutput', 'Console', 'data', { risk: 'high' }),
    ],
    flags: defaultFlags,
    defaultSettings: {},
    risk: 'high',
  },
  ExtendedDataOut: {
    kind: 'ExtendedDataOut',
    typeId: BLOCK_TYPE_IDS.ExtendedDataOut,
    label: 'Extended Out',
    category: 'flow',
    inputs: [
      port('clipboard', 'Clipboard', 'string', { risk: 'high' }),
      port('clipboardBinary', 'Clipboard (Binary)', 'asset', { risk: 'high' }),
      port('pageText', 'Page Text', 'string', { risk: 'high' }),
      port('domMutation', 'DOM Mutation', 'data', { risk: 'high' }),
      port('fileBlob', 'File Blob', 'data', { risk: 'high' }),
    ],
    outputs: [],
    flags: defaultFlags,
    defaultSettings: {},
    risk: 'high',
  },
  FetchData: {
    kind: 'FetchData',
    typeId: BLOCK_TYPE_IDS.FetchData,
    label: 'Fetch GET',
    category: 'data',
    inputs: [port('url', 'URL', 'URL')],
    outputs: [port('result', 'Result', 'data', { risk: 'high' })],
    flags: defaultFlags,
    defaultSettings: {
      remoteUrl: '',
      remoteDataType: 'data',
      remoteTimeoutMs: 5000,
      remoteMaxBytes: 128 * 1024,
    },
    risk: 'high',
  },
  HttpRequest: {
    kind: 'HttpRequest',
    typeId: BLOCK_TYPE_IDS.HttpRequest,
    label: 'HTTP Request',
    category: 'data',
    inputs: [port('url', 'URL', 'URL'), port('body', 'Body', 'dict')],
    outputs: [port('result', 'Result', 'data', { risk: 'high' })],
    flags: defaultFlags,
    defaultSettings: {
      remoteUrl: '',
      remoteDataType: 'data',
      remoteMethod: 'GET',
      remoteTimeoutMs: 5000,
      remoteMaxBytes: 128 * 1024,
    },
    risk: 'high',
  },
  SystemData: {
    kind: 'SystemData',
    typeId: BLOCK_TYPE_IDS.SystemData,
    label: 'System Data',
    category: 'data',
    inputs: [],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      systemDataMode: 'NOW_MS',
    },
    risk: 'safe',
  },
  PromptText: {
    kind: 'PromptText',
    typeId: BLOCK_TYPE_IDS.PromptText,
    label: 'Prompt Text',
    category: 'interaction',
    inputs: [port('message', 'Message', 'string')],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      promptMessage: 'Enter text',
      promptPlaceholder: '',
      promptDefaultValue: '',
    },
    risk: 'extended',
  },
  PromptNumber: {
    kind: 'PromptNumber',
    typeId: BLOCK_TYPE_IDS.PromptNumber,
    label: 'Prompt Number',
    category: 'interaction',
    inputs: [port('message', 'Message', 'string')],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      promptMessage: 'Enter a number',
      promptDefaultValue: '',
    },
    risk: 'extended',
  },
  Confirm: {
    kind: 'Confirm',
    typeId: BLOCK_TYPE_IDS.Confirm,
    label: 'Confirm',
    category: 'interaction',
    inputs: [port('message', 'Message', 'string')],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      promptMessage: 'Continue?',
    },
    risk: 'extended',
  },
  PickFileOrUrl: {
    kind: 'PickFileOrUrl',
    typeId: BLOCK_TYPE_IDS.PickFileOrUrl,
    label: 'Pick File or URL',
    category: 'interaction',
    inputs: [port('message', 'Message', 'string')],
    outputs: [port('result', 'Result', 'dict', { risk: 'high' })],
    flags: defaultFlags,
    defaultSettings: {
      promptMessage: 'Choose a file or enter a URL',
    },
    risk: 'high',
  },
  ShowMessage: {
    kind: 'ShowMessage',
    typeId: BLOCK_TYPE_IDS.ShowMessage,
    label: 'Show Message',
    category: 'interaction',
    inputs: [port('title', 'Title', 'string'), port('message', 'Message', 'string')],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      promptTitle: 'URL Alchemist',
      promptMessage: 'Message',
      displayMode: 'OVERLAY',
    },
    risk: 'extended',
  },
  ShowImage: {
    kind: 'ShowImage',
    typeId: BLOCK_TYPE_IDS.ShowImage,
    label: 'Show Image',
    category: 'media',
    inputs: [port('asset', 'Image', 'asset', { required: true }), port('caption', 'Caption', 'string')],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      displayMode: 'OVERLAY',
      imageStopMode: 'CLOSE_BUTTON',
      displayTimeoutMs: 5000,
    },
    risk: 'extended',
  },
  ShowVideo: {
    kind: 'ShowVideo',
    typeId: BLOCK_TYPE_IDS.ShowVideo,
    label: 'Show Video',
    category: 'media',
    inputs: [port('asset', 'Video', 'asset', { required: true }), port('caption', 'Caption', 'string')],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      displayMode: 'OVERLAY',
    },
    risk: 'extended',
  },
  PlaySound: {
    kind: 'PlaySound',
    typeId: BLOCK_TYPE_IDS.PlaySound,
    label: 'Play Sound',
    category: 'media',
    inputs: [port('asset', 'Audio', 'asset', { required: true })],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      displayMode: 'OVERLAY',
    },
    risk: 'extended',
  },
  GetImage: {
    kind: 'GetImage',
    typeId: BLOCK_TYPE_IDS.GetImage,
    label: 'Get Image',
    category: 'media',
    inputs: [port('url', 'URL', 'URL')],
    outputs: [port('result', 'Image', 'asset', { risk: 'high' })],
    flags: defaultFlags,
    defaultSettings: {
      assetKind: 'image',
      assetUrl: '',
      remoteTimeoutMs: 5000,
      remoteMaxBytes: 512 * 1024,
    },
    risk: 'high',
  },
  GetVideo: {
    kind: 'GetVideo',
    typeId: BLOCK_TYPE_IDS.GetVideo,
    label: 'Get Video',
    category: 'media',
    inputs: [port('url', 'URL', 'URL')],
    outputs: [port('result', 'Video', 'asset', { risk: 'high' })],
    flags: defaultFlags,
    defaultSettings: {
      assetKind: 'video',
      assetUrl: '',
      remoteTimeoutMs: 5000,
      remoteMaxBytes: 512 * 1024,
    },
    risk: 'high',
  },
  GetAudio: {
    kind: 'GetAudio',
    typeId: BLOCK_TYPE_IDS.GetAudio,
    label: 'Get Audio',
    category: 'media',
    inputs: [port('url', 'URL', 'URL')],
    outputs: [port('result', 'Audio', 'asset', { risk: 'high' })],
    flags: defaultFlags,
    defaultSettings: {
      assetKind: 'audio',
      assetUrl: '',
      remoteTimeoutMs: 5000,
      remoteMaxBytes: 512 * 1024,
    },
    risk: 'high',
  },
  OverlayInput: {
    kind: 'OverlayInput',
    typeId: BLOCK_TYPE_IDS.OverlayInput,
    label: 'Overlay Input',
    category: 'interaction',
    inputs: [port('message', 'Message', 'string')],
    outputs: [port('result', 'Events', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      promptMessage: 'Use the keyboard or mouse while this overlay is open.',
      displayMode: 'OVERLAY',
      displayTimeoutMs: 10000,
      captureKeyboard: true,
      captureMouse: true,
    },
    risk: 'extended',
  },
  OnTriggerEvent: {
    kind: 'OnTriggerEvent',
    typeId: BLOCK_TYPE_IDS.OnTriggerEvent,
    label: 'On Trigger Event',
    category: 'flow',
    inputs: [],
    outputs: [
      port('triggered', 'Triggered', 'bool', { description: 'True when the pack runs from its official trigger.' }),
      port('event', 'Event', 'dict', { description: 'Trigger details such as URL and hotkey.' }),
    ],
    flags: defaultFlags,
    defaultSettings: {},
    risk: 'safe',
  },
  KeyboardIn: {
    kind: 'KeyboardIn',
    typeId: BLOCK_TYPE_IDS.KeyboardIn,
    label: 'Keyboard In',
    category: 'flow',
    inputs: [],
    outputs: [
      port('keyboardKey', 'Key', 'string', { description: 'The last trusted key captured by the active overlay.' }),
      port('keyboardCode', 'Code', 'string', { description: 'The browser key code for the captured key.' }),
      port('keyboardCodePoint', 'Char Code', 'number', { description: 'The first character code for the captured key, or 0 for named keys.' }),
      port('keyboardEvent', 'Event', 'dict', { description: 'Keyboard event metadata.' }),
    ],
    flags: defaultFlags,
    defaultSettings: {},
    risk: 'extended',
  },
  MouseIn: {
    kind: 'MouseIn',
    typeId: BLOCK_TYPE_IDS.MouseIn,
    label: 'Mouse In',
    category: 'flow',
    inputs: [],
    outputs: [
      port('mouseEvent', 'Event', 'dict', { description: 'Mouse event metadata from the active overlay.' }),
      port('mouseKind', 'Kind', 'string', { description: 'The pointer event type.' }),
      port('mouseButton', 'Button', 'number', { description: 'The changed mouse button.' }),
      port('mouseX', 'X', 'number', { description: 'Overlay-local X coordinate, or -1 outside the overlay.' }),
      port('mouseY', 'Y', 'number', { description: 'Overlay-local Y coordinate, or -1 outside the overlay.' }),
    ],
    flags: defaultFlags,
    defaultSettings: {},
    risk: 'extended',
  },
  OverlayTickIn: {
    kind: 'OverlayTickIn',
    typeId: BLOCK_TYPE_IDS.OverlayTickIn,
    label: 'Overlay Tick In',
    category: 'flow',
    inputs: [],
    outputs: [
      port('tick', 'Tick', 'number', { description: 'A monotonically increasing tick number from the active overlay.' }),
      port('deltaMs', 'Delta ms', 'number', { description: 'Milliseconds since the previous overlay tick.' }),
      port('tickEvent', 'Event', 'dict', { description: 'Tick event metadata.' }),
    ],
    flags: defaultFlags,
    defaultSettings: {},
    risk: 'extended',
  },
  OverlayControl: {
    kind: 'OverlayControl',
    typeId: BLOCK_TYPE_IDS.OverlayControl,
    label: 'Overlay Control',
    category: 'interaction',
    inputs: [port('enabled', 'Enabled', 'bool'), port('message', 'Message', 'string')],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      overlayControlAction: 'START',
      promptMessage: 'URL Alchemist overlay is active.',
      overlayWidth: 24,
      overlayHeight: 18,
      overlayCellSize: 24,
      overlayTickMs: 120,
      overlayBackground: '#ffffff',
    },
    risk: 'extended',
  },
  OverlayDraw: {
    kind: 'OverlayDraw',
    typeId: BLOCK_TYPE_IDS.OverlayDraw,
    label: 'Overlay Draw',
    category: 'interaction',
    inputs: [port('cells', 'Cells', 'data'), port('text', 'Text', 'Any'), port('enabled', 'Enabled', 'bool')],
    outputs: [port('result', 'Result', 'dict', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      overlayWidth: 24,
      overlayHeight: 18,
      overlayCellSize: 24,
      overlayBackground: '#ffffff',
      overlayText: '',
    },
    risk: 'extended',
  },
  Sleep: {
    kind: 'Sleep',
    typeId: BLOCK_TYPE_IDS.Sleep,
    label: 'Sleep',
    category: 'logic',
    inputs: [port('duration', 'Duration', 'number'), port('enabled', 'Enabled', 'bool')],
    outputs: [port('result', 'Result', 'bool')],
    flags: defaultFlags,
    defaultSettings: {
      sleepMs: 100,
    },
    risk: 'safe',
  },
  SharedState: {
    kind: 'SharedState',
    typeId: BLOCK_TYPE_IDS.SharedState,
    label: 'Shared State',
    category: 'storage',
    inputs: [port('key', 'Key', 'string'), port('value', 'Value', 'Any'), port('enabled', 'Enabled', 'bool')],
    outputs: [port('result', 'Result', 'Any', { risk: 'extended' })],
    flags: defaultFlags,
    defaultSettings: {
      sharedStateMode: 'GET',
      literalValue: '',
    },
    risk: 'extended',
  },
  DictGet: {
    kind: 'DictGet',
    typeId: BLOCK_TYPE_IDS.DictGet,
    label: 'Dict Get',
    category: 'data',
    inputs: [port('dict', 'Dict', 'dict'), port('key', 'Key', 'string')],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      dictKey: '',
      literalValue: '',
      literalDataType: 'Any',
    },
    risk: 'safe',
  },
  ListOperation: {
    kind: 'ListOperation',
    typeId: BLOCK_TYPE_IDS.ListOperation,
    label: 'List Operation',
    category: 'data',
    inputs: [port('list', 'List', 'data'), port('item', 'Item', 'Any'), port('index', 'Index', 'number')],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      listOperation: 'APPEND',
      literalValue: '[]',
      literalDataType: 'data',
    },
    risk: 'safe',
  },
  ConditionSelect: {
    kind: 'ConditionSelect',
    typeId: BLOCK_TYPE_IDS.ConditionSelect,
    label: 'Condition Select',
    category: 'logic',
    inputs: [port('condition', 'Condition', 'bool'), port('trueValue', 'True', 'Any'), port('falseValue', 'False', 'Any')],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      selectTrueValue: '1',
      selectFalseValue: '0',
      literalDataType: 'number',
    },
    risk: 'safe',
  },
  RandomNumber: {
    kind: 'RandomNumber',
    typeId: BLOCK_TYPE_IDS.RandomNumber,
    label: 'Random Number',
    category: 'math',
    inputs: [port('min', 'Min', 'number'), port('max', 'Max', 'number')],
    outputs: [port('result', 'Result', 'number')],
    flags: defaultFlags,
    defaultSettings: {
      randomMin: 0,
      randomMax: 10,
    },
    risk: 'safe',
  },
  Constant: {
    kind: 'Constant',
    typeId: BLOCK_TYPE_IDS.Constant,
    label: 'Constant',
    category: 'data',
    inputs: [],
    outputs: [port('value', 'Value', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      literalValue: '',
      literalDataType: 'string',
    },
    risk: 'safe',
  },
};

export const BLOCK_DEFINITIONS = Object.values(BLOCK_REGISTRY);

export function getBlockDefinition(kind: BlockKind): BlockDefinition {
  return BLOCK_REGISTRY[kind];
}

export function getPortDefinition(kind: BlockKind, direction: 'input' | 'output', portId: string): GraphPortDefinition | null {
  const definition = getBlockDefinition(kind);
  const ports = direction === 'input' ? definition.inputs : definition.outputs;
  return ports.find((portDefinition) => portDefinition.id === portId) ?? null;
}

function effectiveConvertPorts(
  node: Pick<WorkspaceNodeV2, 'settings'>,
  direction: 'input' | 'output',
): GraphPortDefinition[] {
  const mode = node.settings.convertMode ?? 'STRING_TO_URL';

  switch (mode) {
    case 'FLOAT_TO_NUMBER':
      return direction === 'input'
        ? [port('input', 'Input', 'floatingPoint', { required: true })]
        : [port('result', 'Result', 'number')];
    case 'DICT_TO_JSON':
      return direction === 'input'
        ? [port('input', 'Input', 'dict', { required: true })]
        : [port('result', 'Result', 'JSON')];
    case 'JSON_TO_DICT':
      return direction === 'input'
        ? [port('input', 'Input', 'JSON', { required: true })]
        : [port('result', 'Result', 'dict')];
    case 'NUMBER_TO_STRING':
      return direction === 'input'
        ? [port('input', 'Input', 'number', { required: true })]
        : [port('result', 'Result', 'string')];
    case 'DATA_TO_STRING':
      return direction === 'input'
        ? [port('input', 'Input', 'data', { required: true })]
        : [port('result', 'Result', 'string')];
    case 'STRING_TO_URL':
    default:
      return direction === 'input'
        ? [port('input', 'Input', 'string', { required: true })]
        : [port('result', 'Result', 'URL')];
  }
}

export function getEffectivePortDefinitions(
  node: Pick<WorkspaceNodeV2, 'type' | 'settings'>,
  direction: 'input' | 'output',
): GraphPortDefinition[] {
  if (node.type === 'Convert') {
    return effectiveConvertPorts(node, direction);
  }

  if ((node.type === 'FetchData' || node.type === 'HttpRequest') && direction === 'output') {
    return [port('result', 'Result', node.settings.remoteDataType ?? 'data', { risk: 'high' })];
  }

  if (node.type === 'Constant' && direction === 'output') {
    return [port('value', 'Value', node.settings.literalDataType ?? 'string')];
  }

  if (node.type === 'SharedState' && direction === 'output') {
    return [port('result', 'Result', node.settings.sharedStateMode === 'EXISTS' ? 'bool' : 'Any', { risk: 'extended' })];
  }

  if (node.type === 'ListOperation' && direction === 'output') {
    const operation = node.settings.listOperation ?? 'APPEND';
    if (operation === 'LENGTH') {
      return [port('result', 'Result', 'number')];
    }
    if (operation === 'CONTAINS_POINT') {
      return [port('result', 'Result', 'bool')];
    }
    return [port('result', 'Result', operation === 'GET' ? 'Any' : 'data')];
  }

  if (node.type === 'Logical' && direction === 'output' && node.settings.booleanOutput !== false) {
    return [port('result', 'Result', 'bool')];
  }

  const definition = getBlockDefinition(node.type);
  return direction === 'input' ? definition.inputs : definition.outputs;
}

export function getEffectivePortDefinition(
  node: Pick<WorkspaceNodeV2, 'type' | 'settings'>,
  direction: 'input' | 'output',
  portId: string,
): GraphPortDefinition | null {
  return getEffectivePortDefinitions(node, direction).find((portDefinition) => portDefinition.id === portId) ?? null;
}

export function getRiskRank(risk: RiskLevel): number {
  switch (risk) {
    case 'high':
      return 2;
    case 'extended':
      return 1;
    default:
      return 0;
  }
}

export function combineRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  return getRiskRank(left) >= getRiskRank(right) ? left : right;
}

export function isTypeCompatible(source: GraphDataType, target: GraphDataType): boolean {
  if (source === target || target === 'Any' || source === 'Any') {
    return true;
  }

  if (target === 'data') {
    return true;
  }

  if (target === 'string') {
    return ['URL', 'JSON', 'dict', 'data'].includes(source);
  }

  if (source === 'bool') {
    return ['number', 'floatingPoint'].includes(target);
  }

  if (source === 'number') {
    return target === 'floatingPoint';
  }

  if (source === 'floatingPoint') {
    return false;
  }

  if (source === 'string') {
    return ['number', 'floatingPoint'].includes(target);
  }

  if (source === 'dict') {
    return target === 'JSON';
  }

  if (source === 'JSON') {
    return target === 'dict';
  }

  return false;
}
