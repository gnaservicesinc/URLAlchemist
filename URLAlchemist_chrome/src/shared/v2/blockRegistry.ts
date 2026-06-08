import type { BlockDefinition, BlockKind, GraphDataType, GraphPortDefinition, RiskLevel, WorkspaceNodeV2 } from './types';
import { BLOCK_TYPE_IDS, DEFAULT_ASSET_MAX_BYTES } from './types';

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
      port('clipboard', 'Clipboard', 'string', { risk: 'high', description: 'High risk: reads current clipboard text.' }),
      port('pageText', 'Page Text', 'string', { risk: 'high', description: 'High risk: reads visible page text.' }),
      port('rawHtml', 'Raw HTML', 'string', { risk: 'high', description: 'High risk: reads raw page HTML.' }),
      port('mediaData', 'Media Data', 'dict', { risk: 'extended' }),
      port('pageLinks', 'Page Links', 'data', { risk: 'extended' }),
      port('jsMetadata', 'JS Metadata', 'dict', { risk: 'high', description: 'High risk: reads page script metadata.' }),
      port('consoleOutput', 'Console', 'data', { risk: 'high', description: 'High risk: reads captured console output.' }),
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
      port('clipboard', 'Clipboard', 'string', { risk: 'high', description: 'High risk: replaces current clipboard text.' }),
      port('clipboardBinary', 'Clipboard (Binary)', 'asset', { risk: 'high', description: 'High risk: writes image, audio, video, or file-like data to the clipboard.' }),
      port('pageText', 'Page Text', 'string', { risk: 'high', description: 'High risk: mutates page text.' }),
      port('domMutation', 'DOM Mutation', 'data', { risk: 'high', description: 'High risk: applies structured page mutations.' }),
      port('fileBlob', 'File Blob', 'data', { risk: 'high', description: 'High risk: prepares file-like output.' }),
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
      remoteMaxBytes: DEFAULT_ASSET_MAX_BYTES,
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
      remoteMaxBytes: DEFAULT_ASSET_MAX_BYTES,
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
      remoteMaxBytes: DEFAULT_ASSET_MAX_BYTES,
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
    description: 'Chooses between two values from a condition. It does not decide which downstream side-effect blocks run.',
    tips: ['Use Logical Flow when you need if/else branch execution instead of a value choice.'],
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
  SaveStringToLog: {
    kind: 'SaveStringToLog',
    typeId: BLOCK_TYPE_IDS.SaveStringToLog,
    label: 'Save string to log',
    category: 'debug',
    inputs: [port('message', 'Message', 'string')],
    outputs: [port('result', 'Result', 'bool')],
    flags: defaultFlags,
    defaultSettings: {
      literalValue: '',
      logSeverity: 'info',
    },
    risk: 'safe',
  },
  Abort: {
    kind: 'Abort',
    typeId: BLOCK_TYPE_IDS.Abort,
    label: 'Abort',
    category: 'debug',
    inputs: [port('condition', 'Condition', 'bool')],
    outputs: [port('result', 'Result', 'bool')],
    flags: defaultFlags,
    defaultSettings: {
      abortMessage: 'Workflow requested abort.',
    },
    risk: 'safe',
  },
  Substitution: {
    kind: 'Substitution',
    typeId: BLOCK_TYPE_IDS.Substitution,
    label: 'Substitution',
    category: 'data',
    inputs: [port('value1', '$1', 'Any')],
    outputs: [port('result', 'Result', 'string')],
    flags: defaultFlags,
    defaultSettings: {
      substitutionTemplate: '',
      substitutionInputCount: 1,
    },
    risk: 'safe',
  },
  TextTransform: {
    kind: 'TextTransform',
    typeId: BLOCK_TYPE_IDS.TextTransform,
    label: 'Text Transform',
    category: 'convert',
    inputs: [port('input', 'Text', 'Any', { required: true })],
    outputs: [port('result', 'Text', 'string')],
    flags: defaultFlags,
    defaultSettings: {
      textTransformMode: 'TRIM',
    },
    risk: 'safe',
  },
  TextSplitJoin: {
    kind: 'TextSplitJoin',
    typeId: BLOCK_TYPE_IDS.TextSplitJoin,
    label: 'Text Split/Join',
    category: 'convert',
    inputs: [port('input', 'Input', 'Any', { required: true })],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      splitJoinMode: 'SPLIT_LINES',
      splitJoinSeparator: ',',
    },
    risk: 'safe',
  },
  UrlQuery: {
    kind: 'UrlQuery',
    typeId: BLOCK_TYPE_IDS.UrlQuery,
    label: 'URL Query',
    category: 'data',
    inputs: [port('input', 'URL / Parts', 'Any', { required: true }), port('key', 'Key', 'string'), port('value', 'Value', 'string')],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      urlQueryMode: 'PARSE',
      urlQueryKey: '',
      urlQueryValue: '',
      urlQueryParams: '',
    },
    risk: 'safe',
  },
  DictOperation: {
    kind: 'DictOperation',
    typeId: BLOCK_TYPE_IDS.DictOperation,
    label: 'Dict Operation',
    category: 'data',
    inputs: [port('dict', 'Dict', 'dict', { required: true }), port('other', 'Other', 'dict'), port('key', 'Key', 'string')],
    outputs: [port('result', 'Result', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      dictOperationMode: 'KEYS',
      dictKey: '',
    },
    risk: 'safe',
  },
  ConditionOut: {
    kind: 'ConditionOut',
    typeId: BLOCK_TYPE_IDS.ConditionOut,
    label: 'Condition Out',
    category: 'flow',
    inputs: [port('condition', 'Condition', 'bool', { required: true })],
    outputs: [],
    flags: defaultFlags,
    defaultSettings: {},
    risk: 'safe',
  },
  ContentDataIn: {
    kind: 'ContentDataIn',
    typeId: BLOCK_TYPE_IDS.ContentDataIn,
    label: 'Content Data In',
    category: 'content-blocker',
    inputs: [],
    outputs: [
      port('url', 'URL', 'URL', { risk: 'safe' }),
      port('pageTitle', 'Title', 'string', { risk: 'safe' }),
      port('pageMetadata', 'Metadata', 'dict', { risk: 'safe' }),
      port('pageText', 'Page Text', 'string', { risk: 'high', description: 'High risk: reads visible page text.' }),
      port('secondsOnPage', 'Seconds', 'number', { risk: 'safe' }),
    ],
    flags: defaultFlags,
    defaultSettings: { locked: true },
    risk: 'high',
  },
  DecisionOut: {
    kind: 'DecisionOut',
    typeId: BLOCK_TYPE_IDS.DecisionOut,
    label: 'Decision Out',
    category: 'content-blocker',
    inputs: [port('decision', 'Decision', 'number', { required: true })],
    outputs: [],
    flags: defaultFlags,
    defaultSettings: { locked: true },
    risk: 'safe',
  },
  ChallengeTimer: {
    kind: 'ChallengeTimer',
    typeId: BLOCK_TYPE_IDS.ChallengeTimer,
    label: 'Timer',
    category: 'content-blocker',
    inputs: [port('seconds', 'Seconds', 'number')],
    outputs: [port('result', 'Complete', 'bool')],
    flags: defaultFlags,
    defaultSettings: {
      challengeSeconds: 30,
      label: 'Timer',
    },
    risk: 'safe',
  },
  ChallengeTyper: {
    kind: 'ChallengeTyper',
    typeId: BLOCK_TYPE_IDS.ChallengeTyper,
    label: 'Typer',
    category: 'content-blocker',
    inputs: [port('text', 'Text', 'string'), port('count', 'Count', 'number')],
    outputs: [port('result', 'Complete', 'bool')],
    flags: defaultFlags,
    defaultSettings: {
      challengeText: 'I want to continue',
      challengeCount: 1,
      label: 'Typer',
    },
    risk: 'safe',
  },
  ChallengeClicker: {
    kind: 'ChallengeClicker',
    typeId: BLOCK_TYPE_IDS.ChallengeClicker,
    label: 'Clicker',
    category: 'content-blocker',
    inputs: [port('count', 'Count', 'number')],
    outputs: [port('result', 'Complete', 'bool')],
    flags: defaultFlags,
    defaultSettings: {
      challengeCount: 10,
      label: 'Clicker',
    },
    risk: 'safe',
  },
  ChallengeConfirm: {
    kind: 'ChallengeConfirm',
    typeId: BLOCK_TYPE_IDS.ChallengeConfirm,
    label: 'Confirm Choice',
    category: 'content-blocker',
    inputs: [port('text', 'Text', 'string')],
    outputs: [port('result', 'Complete', 'bool')],
    flags: defaultFlags,
    defaultSettings: {
      challengeText: 'Confirm that you want to continue.',
      label: 'Confirm Choice',
    },
    risk: 'safe',
  },
  ChallengeReason: {
    kind: 'ChallengeReason',
    typeId: BLOCK_TYPE_IDS.ChallengeReason,
    label: 'Reason Prompt',
    category: 'content-blocker',
    inputs: [port('text', 'Prompt', 'string')],
    outputs: [port('result', 'Reason', 'string')],
    flags: defaultFlags,
    defaultSettings: {
      challengeText: 'Why do you want to continue?',
      label: 'Reason Prompt',
    },
    risk: 'safe',
  },
  ChallengeComplete: {
    kind: 'ChallengeComplete',
    typeId: BLOCK_TYPE_IDS.ChallengeComplete,
    label: 'Challenge Complete',
    category: 'content-blocker',
    inputs: [port('complete', 'Complete', 'bool')],
    outputs: [],
    flags: defaultFlags,
    defaultSettings: { locked: true },
    risk: 'safe',
  },
  LogicalFlow: {
    kind: 'LogicalFlow',
    typeId: BLOCK_TYPE_IDS.LogicalFlow,
    label: 'Logical Flow',
    category: 'logic',
    description: 'Routes an input through a True or False branch. Instructions guarded by the unselected branch are skipped.',
    tips: ['Connect a Logic block into Condition, then continue work from the True or False outputs. The else side may be left empty.'],
    inputs: [port('input', 'Input', 'Any'), port('condition', 'Condition', 'bool', { required: true })],
    outputs: [port('trueValue', 'True', 'Any'), port('falseValue', 'False', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      logicalFlowRole: 'control',
    },
    risk: 'safe',
  },
  CustomBlock: {
    kind: 'CustomBlock',
    typeId: BLOCK_TYPE_IDS.CustomBlock,
    label: 'Custom Block',
    category: 'custom',
    description: 'Runs a locally installed custom block compiled from a custom-block workspace.',
    tips: ['Custom blocks are compiled from workspace source and run through the same VM safety limits as normal blocks.'],
    inputs: [],
    outputs: [],
    flags: defaultFlags,
    defaultSettings: {},
    risk: 'safe',
  },
  CustomBlockInput: {
    kind: 'CustomBlockInput',
    typeId: BLOCK_TYPE_IDS.CustomBlockInput,
    label: 'Custom Input',
    category: 'custom',
    description: 'Declares one input for a custom-block workspace.',
    inputs: [],
    outputs: [port('value', 'Value', 'Any')],
    flags: defaultFlags,
    defaultSettings: {
      customPortId: 'input',
      customPortLabel: 'Input',
      customPortDataType: 'Any',
    },
    risk: 'safe',
  },
  CustomBlockOutput: {
    kind: 'CustomBlockOutput',
    typeId: BLOCK_TYPE_IDS.CustomBlockOutput,
    label: 'Custom Output',
    category: 'custom',
    description: 'Declares one output from a custom-block workspace.',
    inputs: [port('value', 'Value', 'Any')],
    outputs: [],
    flags: defaultFlags,
    defaultSettings: {
      customPortId: 'result',
      customPortLabel: 'Result',
      customPortDataType: 'Any',
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

function effectiveTextSplitJoinPorts(
  node: Pick<WorkspaceNodeV2, 'settings'>,
  direction: 'input' | 'output',
): GraphPortDefinition[] {
  const mode = node.settings.splitJoinMode ?? 'SPLIT_LINES';
  const joining = mode.startsWith('JOIN_');
  if (direction === 'input') {
    return [port('input', joining ? 'List' : 'Text', joining ? 'data' : 'string', { required: true })];
  }

  return [port('result', joining ? 'Text' : 'List', joining ? 'string' : 'data')];
}

function effectiveUrlQueryPorts(
  node: Pick<WorkspaceNodeV2, 'settings'>,
  direction: 'input' | 'output',
): GraphPortDefinition[] {
  if (direction === 'input') {
    return [port('input', 'URL / Parts', 'Any', { required: true }), port('key', 'Key', 'string'), port('value', 'Value', 'string')];
  }

  const mode = node.settings.urlQueryMode ?? 'PARSE';
  if (mode === 'PARSE') {
    return [port('result', 'Parts', 'dict')];
  }
  if (mode === 'GET_PARAM') {
    return [port('result', 'Value', 'string')];
  }
  return [port('result', 'URL', 'URL')];
}

function effectiveDictOperationPorts(
  node: Pick<WorkspaceNodeV2, 'settings'>,
  direction: 'input' | 'output',
): GraphPortDefinition[] {
  if (direction === 'input') {
    return [port('dict', 'Dict', 'dict', { required: true }), port('other', 'Other', 'dict'), port('key', 'Key', 'string')];
  }

  const mode = node.settings.dictOperationMode ?? 'KEYS';
  if (mode === 'HAS_KEY') {
    return [port('result', 'Exists', 'bool')];
  }
  if (mode === 'KEYS' || mode === 'VALUES') {
    return [port('result', mode === 'KEYS' ? 'Keys' : 'Values', 'data')];
  }
  return [port('result', 'Dict', 'dict')];
}

export function getEffectivePortDefinitions(
  node: Pick<WorkspaceNodeV2, 'type' | 'settings'>,
  direction: 'input' | 'output',
): GraphPortDefinition[] {
  if (node.type === 'Substitution') {
    if (direction === 'output') {
      return [port('result', 'Result', 'string')];
    }

    const count = Math.max(1, Math.min(24, Math.trunc(node.settings.substitutionInputCount ?? 1)));
    return Array.from({ length: count }, (_, index) => port(`value${index + 1}`, `$${index + 1}`, 'Any'));
  }

  if (node.type === 'Convert') {
    return effectiveConvertPorts(node, direction);
  }

  if (node.type === 'TextSplitJoin') {
    return effectiveTextSplitJoinPorts(node, direction);
  }

  if (node.type === 'UrlQuery') {
    return effectiveUrlQueryPorts(node, direction);
  }

  if (node.type === 'DictOperation') {
    return effectiveDictOperationPorts(node, direction);
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

  if (node.type === 'CustomBlock') {
    const definitions = direction === 'input'
      ? node.settings.customBlockInputs ?? []
      : node.settings.customBlockOutputs ?? [];
    return definitions.map((definition) =>
      port(definition.id, definition.label, definition.dataType, { description: definition.tooltip }),
    );
  }

  if (node.type === 'CustomBlockInput' && direction === 'output') {
    return [port('value', node.settings.customPortLabel ?? 'Value', node.settings.customPortDataType ?? 'Any')];
  }

  if (node.type === 'CustomBlockOutput' && direction === 'input') {
    return [port('value', node.settings.customPortLabel ?? 'Value', node.settings.customPortDataType ?? 'Any')];
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
