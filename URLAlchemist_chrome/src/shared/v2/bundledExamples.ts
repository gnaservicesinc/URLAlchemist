import { BLOCK_REGISTRY } from './blockRegistry';
import { compileWorkspace } from './compiler';
import { BLOCK_TYPE_IDS, WORKSPACE_SCHEMA_VERSION } from './types';
import type { BlockKind, CompiledActionPackV2, WorkspaceBlockSettings, WorkspaceFileV2, WorkspaceNodeV2 } from './types';

export const BUNDLED_EXAMPLE_BUILD_TIME_UTC = 1_778_755_200;
export const BUNDLED_EXAMPLE_BUILDER_UUID = '11111111-1111-4111-8111-111111111111';
export const BUNDLED_EXAMPLE_CREATED_AT = BUNDLED_EXAMPLE_BUILD_TIME_UTC * 1000;
export const BUNDLED_EXAMPLE_CHROME_VERSION = '2.0.0';
export const BUNDLED_EXAMPLE_FIREFOX_VERSION = '0.1.0';

export interface BundledActionPackExample {
  id: string;
  name: string;
  slug: string;
  description: string;
  trigger: string;
  risk: 'safe' | 'extended' | 'high';
  features: string[];
  workspacePath: string;
  actionPackPath: string;
}

export const BUNDLED_ACTION_PACK_EXAMPLES: BundledActionPackExample[] = [
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200001',
    name: 'Clean Campaign Links',
    slug: 'clean-campaign-links',
    description: 'Removes common campaign tracking parameters and tidies query separators.',
    trigger: 'INPUT_DATA',
    risk: 'safe',
    features: ['Input-data trigger', 'Regex cleanup', 'Safe URL output'],
    workspacePath: 'bundled-actionpacks/workspaces/clean-campaign-links.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/clean-campaign-links.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200002',
    name: 'Keep Stable Query',
    slug: 'keep-stable-query',
    description: 'Keeps a stable id query value and removes noisy parameters after it.',
    trigger: 'CONTEXT_MENU',
    risk: 'safe',
    features: ['After-pattern trimming', 'Context menu run', 'Stable share URLs'],
    workspacePath: 'bundled-actionpacks/workspaces/keep-stable-query.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/keep-stable-query.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200003',
    name: 'GitHub PR Files Shortcut',
    slug: 'github-pr-files-shortcut',
    description: 'Turns a GitHub pull request URL into the files view.',
    trigger: 'CONTEXT_MENU',
    risk: 'safe',
    features: ['Before-pattern append', 'GitHub scope', 'Link URL friendly'],
    workspacePath: 'bundled-actionpacks/workspaces/github-pr-files-shortcut.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/github-pr-files-shortcut.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200004',
    name: 'Search Selected Text',
    slug: 'search-selected-text',
    description: 'Opens a search URL for the current selection with a hotkey.',
    trigger: 'HOTKEY',
    risk: 'safe',
    features: ['Selected text input', 'Hotkey trigger', 'String to URL conversion'],
    workspacePath: 'bundled-actionpacks/workspaces/search-selected-text.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/search-selected-text.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200005',
    name: 'Clipboard Search Launcher',
    slug: 'clipboard-search-launcher',
    description: 'Opens a search URL for the current clipboard contents.',
    trigger: 'HOTKEY',
    risk: 'high',
    features: ['Clipboard input', 'High-risk staging warning', 'String to URL conversion'],
    workspacePath: 'bundled-actionpacks/workspaces/clipboard-search-launcher.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/clipboard-search-launcher.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200006',
    name: 'Remember Current Page',
    slug: 'remember-current-page',
    description: 'Stores the current URL in session storage while leaving navigation unchanged.',
    trigger: 'CONTEXT_MENU',
    risk: 'extended',
    features: ['Session SaveLoad', 'No redirect', 'Context menu utility'],
    workspacePath: 'bundled-actionpacks/workspaces/remember-current-page.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/remember-current-page.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200007',
    name: 'Research Note Snapshot',
    slug: 'research-note-snapshot',
    description: 'Copies a small JSON note containing the current URL and page title.',
    trigger: 'CONTEXT_MENU',
    risk: 'high',
    features: ['Dictionary building', 'JSON conversion', 'Clipboard output'],
    workspacePath: 'bundled-actionpacks/workspaces/research-note-snapshot.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/research-note-snapshot.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200008',
    name: 'Uppercase Selection Clipboard',
    slug: 'uppercase-selection-clipboard',
    description: 'Copies a simple uppercase ASCII transform of the selected text.',
    trigger: 'CONTEXT_MENU',
    risk: 'high',
    features: ['Declarations', 'Logic and loop blocks', 'Math conversion to clipboard'],
    workspacePath: 'bundled-actionpacks/workspaces/uppercase-selection-clipboard.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/uppercase-selection-clipboard.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200009',
    name: 'Remote Text Fetch Preview',
    slug: 'remote-text-fetch-preview',
    description: 'Fetches a text file from a fixed HTTPS endpoint and writes it to the page-text output while leaving navigation unchanged.',
    trigger: 'CONTEXT_MENU',
    risk: 'high',
    features: ['Remote GET warning', 'Typed string output', 'No redirect'],
    workspacePath: 'bundled-actionpacks/workspaces/remote-text-fetch-preview.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/remote-text-fetch-preview.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200010',
    name: 'Remote POST Snapshot',
    slug: 'remote-post-snapshot',
    description: 'Builds a small dictionary from the current page and sends it to a fixed HTTPS endpoint.',
    trigger: 'CONTEXT_MENU',
    risk: 'high',
    features: ['Remote POST warning', 'Dictionary body', 'No redirect'],
    workspacePath: 'bundled-actionpacks/workspaces/remote-post-snapshot.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/remote-post-snapshot.actionpack',
  },
];

function node(
  workspaceSlug: string,
  key: string,
  type: BlockKind,
  position: WorkspaceNodeV2['position'],
  settings: WorkspaceBlockSettings = {},
): WorkspaceNodeV2 {
  return {
    id: `${workspaceSlug}:${key}`,
    type,
    typeId: BLOCK_TYPE_IDS[type],
    position,
    settings: {
      ...BLOCK_REGISTRY[type].defaultSettings,
      ...settings,
    },
  };
}

function edge(source: WorkspaceNodeV2, sourceHandle: string, target: WorkspaceNodeV2, targetHandle: string) {
  return {
    id: `${source.id}:${sourceHandle}->${target.id}:${targetHandle}`,
    source: source.id,
    sourceHandle,
    target: target.id,
    targetHandle,
  };
}

function baseWorkspace(example: BundledActionPackExample, nodes: WorkspaceNodeV2[], edges: ReturnType<typeof edge>[], trigger: WorkspaceFileV2['trigger']): WorkspaceFileV2 {
  return {
    kind: 'workspace.v2',
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    metadata: {
      id: example.id,
      name: example.name,
      version: 1,
      author: 'URL Alchemist',
      description: example.description,
      compatibility: {
        chrome: {
          version: BUNDLED_EXAMPLE_CHROME_VERSION,
          status: 'supported',
        },
        firefox: {
          version: BUNDLED_EXAMPLE_FIREFOX_VERSION,
          status: 'pending-v2-runtime',
        },
      },
      created_at: BUNDLED_EXAMPLE_CREATED_AT,
      updated_at: BUNDLED_EXAMPLE_CREATED_AT,
    },
    trigger,
    nodes,
    edges,
    viewport: {
      x: 0,
      y: 0,
      zoom: 0.78,
    },
  };
}

function getExample(slug: string): BundledActionPackExample {
  const example = BUNDLED_ACTION_PACK_EXAMPLES.find((candidate) => candidate.slug === slug);
  if (!example) {
    throw new Error(`Missing bundled example ${slug}`);
  }

  return example;
}

function cleanCampaignLinks(): WorkspaceFileV2 {
  const slug = 'clean-campaign-links';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 120 }, { locked: true });
  const removeCampaign = node(slug, 'remove-campaign', 'RegExpression', { x: 280, y: 60 }, {
    label: 'Remove campaign params',
    pattern: '([?&])(?:utm_[^=&#?]+|fbclid|gclid)=[^&#]*&?',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '$1',
    payloadVars: true,
  });
  const removeFirstRef = node(slug, 'remove-first-ref', 'RegExpression', { x: 560, y: 60 }, {
    label: 'Remove first ref param',
    pattern: '([?&])ref=[^&#]*&?',
    action: 'SUBSTITUTE',
    matchMode: 'NTH_OCCURRENCE',
    nthOccurrence: 1,
    payload: '$1',
    payloadVars: true,
  });
  const tidyGlue = node(slug, 'tidy-glue', 'RegExpression', { x: 840, y: 60 }, {
    label: 'Tidy ?&',
    pattern: '\\?&',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '?',
  });
  const trimTail = node(slug, 'trim-tail', 'RegExpression', { x: 1120, y: 60 }, {
    label: 'Trim empty query tail',
    pattern: '[?&]$',
    action: 'REMOVE',
    matchMode: 'STANDARD',
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 1400, y: 120 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, removeCampaign, removeFirstRef, tidyGlue, trimTail, output],
    [
      edge(input, 'url', removeCampaign, 'input'),
      edge(removeCampaign, 'result', removeFirstRef, 'input'),
      edge(removeFirstRef, 'result', tidyGlue, 'input'),
      edge(tidyGlue, 'result', trimTail, 'input'),
      edge(trimTail, 'result', output, 'url'),
    ],
    {
      type: 'INPUT_DATA',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['url'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function keepStableQuery(): WorkspaceFileV2 {
  const slug = 'keep-stable-query';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 120 }, { locked: true });
  const trimAfterId = node(slug, 'trim-after-id', 'RegExpression', { x: 300, y: 90 }, {
    label: 'Keep through id',
    pattern: '([?&]id=[^&#]*)',
    action: 'REMOVE',
    matchMode: 'AFTER_PATTERN',
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 620, y: 120 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, trimAfterId, output],
    [edge(input, 'url', trimAfterId, 'input'), edge(trimAfterId, 'result', output, 'url')],
    {
      type: 'CONTEXT_MENU',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['url'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function githubPrFilesShortcut(): WorkspaceFileV2 {
  const slug = 'github-pr-files-shortcut';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 120 }, { locked: true });
  const appendFiles = node(slug, 'append-files', 'RegExpression', { x: 300, y: 90 }, {
    label: 'Append before query',
    pattern: '(?:[?#]|$)',
    action: 'APPEND',
    matchMode: 'BEFORE_PATTERN',
    payload: '/files',
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 620, y: 120 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, appendFiles, output],
    [edge(input, 'linkUrl', appendFiles, 'input'), edge(appendFiles, 'result', output, 'url')],
    {
      type: 'CONTEXT_MENU',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['linkUrl'],
      sourceFilters: [{ source: 'url', pattern: '^https://github\\.com/[^/]+/[^/]+/pull/\\d+($|[?#])' }],
    },
  );
}

function searchSelectedText(): WorkspaceFileV2 {
  const slug = 'search-selected-text';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 140 }, { locked: true });
  const spaces = node(slug, 'spaces', 'RegExpression', { x: 280, y: 90 }, {
    label: 'Spaces to plus',
    pattern: '\\s+',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '+',
  });
  const prepend = node(slug, 'prepend', 'RegExpression', { x: 560, y: 90 }, {
    label: 'Add search URL',
    pattern: '^',
    action: 'PREPEND',
    matchMode: 'STANDARD',
    payload: 'https://www.google.com/search?q=',
  });
  const convert = node(slug, 'convert', 'Convert', { x: 840, y: 95 }, {
    label: 'String to URL',
    convertMode: 'STRING_TO_URL',
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 1120, y: 140 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, spaces, prepend, convert, output],
    [
      edge(input, 'selectedText', spaces, 'input'),
      edge(spaces, 'result', prepend, 'input'),
      edge(prepend, 'result', convert, 'input'),
      edge(convert, 'result', output, 'url'),
    ],
    {
      type: 'HOTKEY',
      hotkey: 'Ctrl+Shift+S',
      inputSources: ['selectedText'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function clipboardSearchLauncher(): WorkspaceFileV2 {
  const slug = 'clipboard-search-launcher';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 260 }, { locked: true });
  const extendedInput = node(slug, 'extended-input', 'ExtendedDataIn', { x: 0, y: 40 });
  const spaces = node(slug, 'spaces', 'RegExpression', { x: 300, y: 40 }, {
    label: 'Spaces to plus',
    pattern: '\\s+',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '+',
  });
  const prepend = node(slug, 'prepend', 'RegExpression', { x: 580, y: 40 }, {
    label: 'Add search URL',
    pattern: '^',
    action: 'PREPEND',
    matchMode: 'STANDARD',
    payload: 'https://www.google.com/search?q=',
  });
  const convert = node(slug, 'convert', 'Convert', { x: 860, y: 45 }, {
    label: 'String to URL',
    convertMode: 'STRING_TO_URL',
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 1140, y: 80 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, extendedInput, spaces, prepend, convert, output],
    [
      edge(extendedInput, 'clipboard', spaces, 'input'),
      edge(spaces, 'result', prepend, 'input'),
      edge(prepend, 'result', convert, 'input'),
      edge(convert, 'result', output, 'url'),
    ],
    {
      type: 'HOTKEY',
      hotkey: 'Ctrl+Shift+Y',
      inputSources: ['clipboard'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function rememberCurrentPage(): WorkspaceFileV2 {
  const slug = 'remember-current-page';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 120 }, { locked: true });
  const save = node(slug, 'save', 'SaveLoad', { x: 300, y: 40 }, {
    label: 'Save last URL',
    saveLoadMode: 'SAVE',
    literalValue: 'last-url',
    alwaysProcess: true,
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 620, y: 160 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, save, output],
    [edge(input, 'url', save, 'value'), edge(input, 'url', output, 'url')],
    {
      type: 'CONTEXT_MENU',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['url'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function researchNoteSnapshot(): WorkspaceFileV2 {
  const slug = 'research-note-snapshot';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 120 }, { locked: true });
  const noteUrl = node(slug, 'note-url', 'DataStructure', { x: 300, y: 20 }, {
    label: 'Set URL field',
    variableName: 'researchNote',
    dictKey: 'url',
  });
  const noteTitle = node(slug, 'note-title', 'DataStructure', { x: 580, y: 20 }, {
    label: 'Set title field',
    variableName: 'researchNote',
    dictKey: 'title',
  });
  const convert = node(slug, 'convert', 'Convert', { x: 860, y: 30 }, {
    label: 'Dict to JSON',
    convertMode: 'DICT_TO_JSON',
  });
  const asText = node(slug, 'as-text', 'RegExpression', { x: 1140, y: 30 }, {
    label: 'JSON text',
    pattern: '^',
    action: 'PREPEND',
    matchMode: 'STANDARD',
    payload: '',
  });
  const extendedOutput = node(slug, 'extended-output', 'ExtendedDataOut', { x: 1420, y: 20 });
  const output = node(slug, 'output', 'DataFlowOut', { x: 1420, y: 240 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, noteUrl, noteTitle, convert, asText, extendedOutput, output],
    [
      edge(input, 'url', noteUrl, 'value'),
      edge(noteUrl, 'result', noteTitle, 'dict'),
      edge(input, 'pageTitle', noteTitle, 'value'),
      edge(noteTitle, 'result', convert, 'input'),
      edge(convert, 'result', asText, 'input'),
      edge(asText, 'result', extendedOutput, 'clipboard'),
      edge(input, 'url', output, 'url'),
    ],
    {
      type: 'CONTEXT_MENU',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['url', 'pageTitle'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function uppercaseSelectionClipboard(): WorkspaceFileV2 {
  const slug = 'uppercase-selection-clipboard';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 120 }, { locked: true });
  const declaration = node(slug, 'declaration', 'Declarations', { x: 260, y: 0 }, {
    label: 'Declare ASCII offset',
    variableName: 'uppercaseOffset',
    literalValue: '32',
  });
  const logic = node(slug, 'logic', 'Logical', { x: 260, y: 240 }, {
    label: 'Selection exists',
    operator: 'GT',
    compareValue: '0',
    booleanOutput: true,
    alwaysProcess: true,
  });
  const math = node(slug, 'math', 'Math', { x: 560, y: 90 }, {
    label: 'Subtract ASCII offset',
    mathOperation: 'SUBTRACT',
    compareValue: 'uppercaseOffset',
  });
  const loop = node(slug, 'loop', 'Loop', { x: 840, y: 90 }, {
    label: 'Budgeted pass',
    loopLimit: 8,
  });
  const convert = node(slug, 'convert', 'Convert', { x: 1120, y: 90 }, {
    label: 'Codes to string',
    convertMode: 'NUMBER_TO_STRING',
    convertOrd: false,
  });
  const trimNull = node(slug, 'trim-null', 'RegExpression', { x: 1400, y: 90 }, {
    label: 'Trim null terminator',
    pattern: '\\0',
    action: 'REMOVE',
    matchMode: 'STANDARD',
  });
  const extendedOutput = node(slug, 'extended-output', 'ExtendedDataOut', { x: 1680, y: 80 });
  const output = node(slug, 'output', 'DataFlowOut', { x: 1680, y: 300 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, declaration, logic, math, loop, convert, trimNull, extendedOutput, output],
    [
      edge(input, 'selectedText', logic, 'input'),
      edge(input, 'selectedText', math, 'left'),
      edge(math, 'result', loop, 'input'),
      edge(logic, 'result', loop, 'count'),
      edge(loop, 'result', convert, 'input'),
      edge(convert, 'result', trimNull, 'input'),
      edge(trimNull, 'result', extendedOutput, 'clipboard'),
      edge(input, 'url', output, 'url'),
    ],
    {
      type: 'CONTEXT_MENU',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['selectedText'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function remoteTextFetchPreview(): WorkspaceFileV2 {
  const slug = 'remote-text-fetch-preview';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 160 }, { locked: true });
  const fetchText = node(slug, 'fetch-text', 'FetchData', { x: 300, y: 40 }, {
    label: 'Fetch remote text',
    remoteUrl: 'https://example.com/data.txt',
    remoteDataType: 'string',
    remoteTimeoutMs: 5000,
    remoteMaxBytes: 32768,
  });
  const extendedOutput = node(slug, 'extended-output', 'ExtendedDataOut', { x: 620, y: 40 });
  const output = node(slug, 'output', 'DataFlowOut', { x: 620, y: 220 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, fetchText, extendedOutput, output],
    [
      edge(fetchText, 'result', extendedOutput, 'pageText'),
      edge(input, 'url', output, 'url'),
    ],
    {
      type: 'CONTEXT_MENU',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['url'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function remotePostSnapshot(): WorkspaceFileV2 {
  const slug = 'remote-post-snapshot';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 160 }, { locked: true });
  const bodyUrl = node(slug, 'body-url', 'DataStructure', { x: 300, y: 40 }, {
    label: 'Set URL body',
    variableName: 'snapshotBody',
    dictKey: 'url',
  });
  const request = node(slug, 'request', 'HttpRequest', { x: 620, y: 40 }, {
    label: 'POST snapshot',
    remoteMethod: 'POST',
    remoteUrl: 'https://example.com/api/snapshot',
    remoteDataType: 'string',
    remoteTimeoutMs: 5000,
    remoteMaxBytes: 32768,
  });
  const extendedOutput = node(slug, 'extended-output', 'ExtendedDataOut', { x: 940, y: 40 });
  const output = node(slug, 'output', 'DataFlowOut', { x: 940, y: 240 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, bodyUrl, request, extendedOutput, output],
    [
      edge(input, 'url', bodyUrl, 'value'),
      edge(bodyUrl, 'result', request, 'body'),
      edge(request, 'result', extendedOutput, 'pageText'),
      edge(input, 'url', output, 'url'),
    ],
    {
      type: 'CONTEXT_MENU',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['url'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

export function createBundledExampleWorkspaces(): WorkspaceFileV2[] {
  return [
    cleanCampaignLinks(),
    keepStableQuery(),
    githubPrFilesShortcut(),
    searchSelectedText(),
    clipboardSearchLauncher(),
    rememberCurrentPage(),
    researchNoteSnapshot(),
    uppercaseSelectionClipboard(),
    remoteTextFetchPreview(),
    remotePostSnapshot(),
  ];
}

export function createBundledExampleActionPacks(): CompiledActionPackV2[] {
  return createBundledExampleWorkspaces().map((workspace) => {
    const compiled = compileWorkspace(workspace, {
      builderUuid: BUNDLED_EXAMPLE_BUILDER_UUID,
      buildTimeUtc: BUNDLED_EXAMPLE_BUILD_TIME_UTC,
    });

    if (!compiled.ok || !compiled.pack) {
      throw new Error(`${workspace.metadata.name} did not compile: ${compiled.validation.errors.join('; ')}`);
    }

    return compiled.pack;
  });
}
