import { BLOCK_REGISTRY } from './blockRegistry';
import { compileWorkspace } from './compiler';
import { BLOCK_TYPE_IDS, WORKSPACE_SCHEMA_VERSION } from './types';
import type { BlockKind, CompiledActionPackV2, WorkspaceBlockSettings, WorkspaceFileV2, WorkspaceNodeV2 } from './types';

export const BUNDLED_EXAMPLE_BUILD_TIME_UTC = 1_778_755_200;
export const BUNDLED_EXAMPLE_BUILDER_UUID = '11111111-1111-4111-8111-111111111111';
export const BUNDLED_EXAMPLE_CREATED_AT = BUNDLED_EXAMPLE_BUILD_TIME_UTC * 1000;
export const BUNDLED_EXAMPLE_CHROME_VERSION = '2.0.0';
export const BUNDLED_EXAMPLE_FIREFOX_VERSION = '0.1.0';
const EMBEDDED_BREAK_IMAGE_BASE64 = 'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxNjAgOTAiPjxyZWN0IHdpZHRoPSIxNjAiIGhlaWdodD0iOTAiIGZpbGw9IiNmZWYzYzciLz48Y2lyY2xlIGN4PSI4MCIgY3k9IjQ1IiByPSIzMCIgZmlsbD0iI2ZmZiIgc3Ryb2tlPSIjMGY3NjZlIiBzdHJva2Utd2lkdGg9IjYiLz48cGF0aCBkPSJNODAgMjV2MjJsMTYgMTAiIGZpbGw9Im5vbmUiIHN0cm9rZT0iI2M3NmExYSIgc3Ryb2tlLXdpZHRoPSI2IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48dGV4dCB4PSI4MCIgeT0iODIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIxMCIgZmlsbD0iIzE3MjAzMyI+UXVpY2sgYnJlYWs8L3RleHQ+PC9zdmc+';
const EMBEDDED_BREAK_TONE_BASE64 = 'UklGRgYEAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgATElTVBoAAABJTkZPSVNGVA4AAABMYXZmNjIuMTUuMTAwAGRhdGHAAwAAgomPjYV6cnB1fomPjoZ8c3B0fYiPjod9c3BzfYeOj4h+dHBzfIaOj4l+dXBye4WOj4qAdXBxeoSNj4qBdnBxeYOMj4uCd3BxeIKMj4yCeHFwd4KLj4yDeXFwdoGKj42EenFwdYCKj46Fe3JwdX6Jj46GfHNwdH2Ij46HfXNwc3yHjo+IfXRwc3yGjo+JfnVwcnuFjo+KgHVwcXqEjY+KgXZwcXmDjI+LgndwcXiCjJCMg3hxcHeCi4+Mg3lxcHaBio+NhHpxcHWAio+OhXtycHV+iY+OhnxzcHR9iI+Oh31zcHN9h46PiH10cHN8ho6PiX51cHJ7hY6PioB1cHF6hI2PioF2cHF5g4yPi4J3cHF4g4yPjIN4cXB3gouPjIN5cXB2gYqPjYR6cXB1f4qPjoV7cnB1fomPjoZ8c3B0fYiPjod9c3BzfYeOj4h9dHBzfIaOj4l/dXBye4WOj4qAdXBxeoSNj4qBdnBxeYOMj4uCd3BxeIKMj4yDeHFwd4KLj4yDeXFwdoGKj42EenFwdYCKj46Fe3JwdX6Jj46GfHNwdH2Ij46HfXNwc32Hjo+IfnRwc3yGjo+JfnVwcnuFjo+KgHVwcXqEjY+KgXZwcXmDjI+LgndwcXiCjI+MgnhxcHeCi4+Mg3lxcHaBio+NhHpxcHWAio+OhXtycHV+iY+OhnxzcHR9iI+Oh31zcHN8h46PiH10cHN8ho6PiX51cHJ7hY6PioB1cHF6hI2PioF2cHF5g4yPi4J3cHF4goyQjIN4cXB3gouPjIN5cXB2gYqPjYR6cXB1gIqPjoV7cnB1fomPjoZ8c3B0fYiPjod9c3BzfYeOj4h9dHBzfIaOj4l+dXBye4WOj4qAdXBxeoSNj4qBdnBxeYOMj4uCd3BxeIOMj4yDeHFwd4KLj4yDeXFwdoGKj42EenFwdX+Kj46Fe3JwdX6Jj46GfHNwdH2Ij46HfXNwc32Hjo+IfXRwc3yGjo+Jf3VwcnuFjo+KgHVwcXqEjY+KgXZwcXmDjI+LgndwcXiCjI+Mg3hxcHeCi4+Mg3lxcHaBio+NhHpxcHWAio+OhXtycHV+iY+OhnxzcHR9iI+Oh31zcHN9h46PiH50cHN8ho6PiX51cHJ7hY6PioB1cHF6hI2PioF2cHF5g4yPi4J3cHF4goyPjIJ4cXB3gouPjIN5cXB2gYqPjYR6cXB1gIqPjoV7cnB1fomPjoZ8c3B0fYiPjod9c3BzfIeOj4h9dHBzfIaOj4l+dXBye4WOj4qAdXBxeoSNj4uA';
const EMBEDDED_SAMPLE_VIDEO_BASE64 = 'AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAABbG1kYXQAAAGzABAHAAABthYozhfHyv4iQZgOBwpZy3ttJzN3k4TiipVG2c2omu0Cd4oDKvY0haLmDX8gD4fAVAkDBOxhwFjYFF8gBZHwFQJAwTsGgr8IsQIyUHQMhQGEqn/Cz//I1G7nTfKeBp2cvScGNMzftFlBkCKkmoBlwMCBAAClDSF8Ngz+X/xBgvCW1K5ATU39RcGomXJ/Lo1+IDQJrSLBaajdFQ1BT/NYLwlBgbHzMDgGGo4kLmcU9UL8EUUtIcBYQ8qzUOi4JCAGs4j0XBICj8dpgVIMNAraBllJaSIlydrFoZE4MHasGDVsHKX08Wg3PVe63bUd7AYJA0HONjbo0B1Y2MKVJIiXJ38AAMUM4Xx0rgedNAmPMgWoyDNyCJ8UDQPCf+JcCvBgkY8LWwcvkAyPgKgSBgnYw4CxsCh+QAsj4CoEgYJ2VNPV5CQ+PqTjeBoGL2DhQ7+JgwwHApkhQ2DBSwAAA0Ftb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACa3RyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAQAAAACQAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAeNtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAABAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAGObWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABTnN0YmwAAADqc3RzZAAAAAAAAAABAAAA2m1wNHYAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAQAAkAEgAAABIAAAAAAAAAAETTGF2YzYyLjMyLjEwMCBtcGVnNAAAAAAAAAAAAAAAAAAY//8AAABgZXNkcwAAAAADgICATwABAASAgIBBIBEAAAAAAw1AAAALIAWAgIAvAAABsAEAAAG1iRMAAAEAAAABIADEjYgADQIEBJRDAAABskxhdmM2Mi4zMi4xMDAGgICAAQIAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAMNQAAACyAAAAAYc3R0cwAAAAAAAAABAAAAAQAAQAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAAEAAAABAAAAFHN0c3oAAAAAAAABZAAAAAEAAAAUc3RjbwAAAAAAAAABAAAALAAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjIuMTUuMTAw';

export interface BundledActionPackExample {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: 'URL cleanup' | 'Search' | 'Storage' | 'Remote data' | 'Page tools' | 'Media' | 'Interactive';
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
    category: 'URL cleanup',
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
    category: 'URL cleanup',
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
    category: 'URL cleanup',
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
    category: 'Search',
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
    category: 'Search',
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
    category: 'Storage',
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
    category: 'Page tools',
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
    category: 'Page tools',
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
    description: 'Fetches the stable Example Domain page and previews the returned text on the current page while leaving navigation unchanged.',
    category: 'Remote data',
    trigger: 'CONTEXT_MENU',
    risk: 'high',
    features: ['Remote GET warning', 'Real HTTPS endpoint', 'No redirect'],
    workspacePath: 'bundled-actionpacks/workspaces/remote-text-fetch-preview.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/remote-text-fetch-preview.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200010',
    name: 'Remote POST Snapshot',
    slug: 'remote-post-snapshot',
    description: 'Builds a small page dictionary, sends it to a public echo endpoint, and previews the echoed response.',
    category: 'Remote data',
    trigger: 'CONTEXT_MENU',
    risk: 'high',
    features: ['Remote POST warning', 'Dictionary body', 'Echo response'],
    workspacePath: 'bundled-actionpacks/workspaces/remote-post-snapshot.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/remote-post-snapshot.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200011',
    name: 'Clean Words',
    slug: 'clean-words',
    description: 'Masks a small built-in word list in page text and shows a review message before leaving navigation unchanged.',
    category: 'Page tools',
    trigger: 'CONTEXT_MENU',
    risk: 'high',
    features: ['Built-in word list', 'Page text mutation', 'Overlay message'],
    workspacePath: 'bundled-actionpacks/workspaces/clean-words.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/clean-words.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200012',
    name: 'Break Reminder',
    slug: 'break-reminder',
    description: 'Opens a manual break reminder from a hotkey, shows bundled media, plays a short local tone, and records the run time.',
    category: 'Media',
    trigger: 'HOTKEY',
    risk: 'high',
    features: ['Embedded media', 'Hotkey trigger', 'SaveLoad timestamp'],
    workspacePath: 'bundled-actionpacks/workspaces/break-reminder.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/break-reminder.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200013',
    name: 'Playback Resume',
    slug: 'playback-resume',
    description: 'Plays a tiny bundled video sample and stores playback result details for later runs.',
    category: 'Media',
    trigger: 'HOTKEY',
    risk: 'high',
    features: ['Embedded video', 'Playback result dictionary', 'SaveLoad'],
    workspacePath: 'bundled-actionpacks/workspaces/playback-resume.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/playback-resume.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200014',
    name: 'Overlay Input Capture',
    slug: 'overlay-input-capture',
    description: 'Opens an overlay from a hotkey, captures keyboard and mouse events while it is open, and stores the bounded event summary.',
    category: 'Page tools',
    trigger: 'HOTKEY',
    risk: 'extended',
    features: ['Hotkey launch', 'Overlay input', 'Keyboard capture', 'Mouse capture'],
    workspacePath: 'bundled-actionpacks/workspaces/overlay-input-capture.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/overlay-input-capture.actionpack',
  },
  {
    id: '0f6b6d50-9d44-4a86-9d0f-80a9e8200015',
    name: 'Snake Overlay Arcade',
    slug: 'snake-overlay-arcade',
    description: 'Runs a playable Snake-style overlay game from generic event, state, list, random, and draw blocks.',
    category: 'Interactive',
    trigger: 'HOTKEY',
    risk: 'extended',
    features: ['Overlay session', 'Keyboard events', 'Mouse events', 'Tick loop', 'Shared state', 'Grid drawing'],
    workspacePath: 'bundled-actionpacks/workspaces/snake-overlay-arcade.workspace',
    actionPackPath: 'bundled-actionpacks/action-packs/snake-overlay-arcade.actionpack',
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
  const percent = node(slug, 'percent', 'RegExpression', { x: 260, y: 60 }, {
    label: 'Encode percent',
    pattern: '%',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '%25',
  });
  const ampersand = node(slug, 'ampersand', 'RegExpression', { x: 520, y: 60 }, {
    label: 'Encode ampersand',
    pattern: '&',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '%26',
  });
  const hash = node(slug, 'hash', 'RegExpression', { x: 780, y: 60 }, {
    label: 'Encode hash',
    pattern: '#',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '%23',
  });
  const question = node(slug, 'question', 'RegExpression', { x: 1040, y: 60 }, {
    label: 'Encode question',
    pattern: '\\?',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '%3F',
  });
  const spaces = node(slug, 'spaces', 'RegExpression', { x: 1300, y: 90 }, {
    label: 'Spaces to plus',
    pattern: '\\s+',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '+',
  });
  const prepend = node(slug, 'prepend', 'RegExpression', { x: 1560, y: 90 }, {
    label: 'Add search URL',
    pattern: '^',
    action: 'PREPEND',
    matchMode: 'STANDARD',
    payload: 'https://www.google.com/search?q=',
  });
  const convert = node(slug, 'convert', 'Convert', { x: 1840, y: 95 }, {
    label: 'String to URL',
    convertMode: 'STRING_TO_URL',
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 2120, y: 140 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, percent, ampersand, hash, question, spaces, prepend, convert, output],
    [
      edge(input, 'selectedText', percent, 'input'),
      edge(percent, 'result', ampersand, 'input'),
      edge(ampersand, 'result', hash, 'input'),
      edge(hash, 'result', question, 'input'),
      edge(question, 'result', spaces, 'input'),
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
  const percent = node(slug, 'percent', 'RegExpression', { x: 260, y: 40 }, {
    label: 'Encode percent',
    pattern: '%',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '%25',
  });
  const ampersand = node(slug, 'ampersand', 'RegExpression', { x: 520, y: 40 }, {
    label: 'Encode ampersand',
    pattern: '&',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '%26',
  });
  const hash = node(slug, 'hash', 'RegExpression', { x: 780, y: 40 }, {
    label: 'Encode hash',
    pattern: '#',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '%23',
  });
  const question = node(slug, 'question', 'RegExpression', { x: 1040, y: 40 }, {
    label: 'Encode question',
    pattern: '\\?',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '%3F',
  });
  const spaces = node(slug, 'spaces', 'RegExpression', { x: 1300, y: 40 }, {
    label: 'Spaces to plus',
    pattern: '\\s+',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '+',
  });
  const prepend = node(slug, 'prepend', 'RegExpression', { x: 1560, y: 40 }, {
    label: 'Add search URL',
    pattern: '^',
    action: 'PREPEND',
    matchMode: 'STANDARD',
    payload: 'https://www.google.com/search?q=',
  });
  const convert = node(slug, 'convert', 'Convert', { x: 1840, y: 45 }, {
    label: 'String to URL',
    convertMode: 'STRING_TO_URL',
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 2120, y: 80 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, extendedInput, percent, ampersand, hash, question, spaces, prepend, convert, output],
    [
      edge(extendedInput, 'clipboard', percent, 'input'),
      edge(percent, 'result', ampersand, 'input'),
      edge(ampersand, 'result', hash, 'input'),
      edge(hash, 'result', question, 'input'),
      edge(question, 'result', spaces, 'input'),
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
    loopLimit: 64,
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
    remoteUrl: 'https://example.com/',
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
    remoteUrl: 'https://httpbin.org/post',
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

function cleanWords(): WorkspaceFileV2 {
  const slug = 'clean-words';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 180 }, { locked: true });
  const extendedInput = node(slug, 'extended-input', 'ExtendedDataIn', { x: 0, y: 20 });
  const maskText = node(slug, 'mask-text', 'RegExpression', { x: 300, y: 120 }, {
    label: 'Mask page words',
    pattern: '\\b(?:[Ff]uck|[Ss]hit|[Dd]amn|[Cc]rap|[Bb]itch|[Bb]astard)\\b',
    action: 'SUBSTITUTE',
    matchMode: 'STANDARD',
    payload: '[masked]',
  });
  const message = node(slug, 'message', 'ShowMessage', { x: 620, y: 20 }, {
    promptMessage: 'Clean Words scanned this page and masked matching terms from its built-in list.',
    displayMode: 'OVERLAY',
  });
  const extendedOutput = node(slug, 'extended-output', 'ExtendedDataOut', { x: 940, y: 80 });
  const output = node(slug, 'output', 'DataFlowOut', { x: 940, y: 260 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, extendedInput, maskText, message, extendedOutput, output],
    [
      edge(extendedInput, 'pageText', maskText, 'input'),
      edge(maskText, 'result', extendedOutput, 'pageText'),
      edge(message, 'result', extendedOutput, 'domMutation'),
      edge(input, 'url', output, 'url'),
    ],
    {
      type: 'CONTEXT_MENU',
      hotkey: 'Ctrl+Shift+U',
      inputSources: ['pageText'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function breakReminder(): WorkspaceFileV2 {
  const slug = 'break-reminder';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 260 }, { locked: true });
  const now = node(slug, 'now', 'SystemData', { x: 0, y: 40 }, {
    label: 'Current time',
    systemDataMode: 'NOW_MS',
  });
  const image = node(slug, 'image', 'GetImage', { x: 280, y: 40 }, {
    label: 'Bundled break image',
    assetKind: 'image',
    assetMimeType: 'image/svg+xml',
    assetName: 'break-reminder.svg',
    assetDataBase64: EMBEDDED_BREAK_IMAGE_BASE64,
    assetCompression: 'none',
    remoteMaxBytes: 8192,
  });
  const showImage = node(slug, 'show-image', 'ShowImage', { x: 560, y: 40 }, {
    label: 'Show break card',
    promptMessage: 'Quick break reminder',
    imageStopMode: 'TIMEOUT',
    displayTimeoutMs: 3000,
  });
  const audio = node(slug, 'audio', 'GetAudio', { x: 280, y: 220 }, {
    label: 'Bundled reminder tone',
    assetKind: 'audio',
    assetMimeType: 'audio/wav',
    assetName: 'break-tone.wav',
    assetDataBase64: EMBEDDED_BREAK_TONE_BASE64,
    assetCompression: 'none',
    remoteMaxBytes: 8192,
  });
  const playSound = node(slug, 'play-sound', 'PlaySound', { x: 560, y: 220 }, {
    label: 'Play tone',
  });
  const message = node(slug, 'message', 'ShowMessage', { x: 560, y: 400 }, {
    label: 'Show reminder text',
    promptMessage: 'Stand up, look away from the screen, and take a short reset.',
    displayMode: 'OVERLAY',
    displayTimeoutMs: 4500,
  });
  const stats = node(slug, 'stats', 'DataStructure', { x: 860, y: 60 }, {
    variableName: 'breakReminder',
    dictKey: 'lastRunMs',
  });
  const stats2 = node(slug, 'stats2', 'DataStructure', { x: 860, y: 200 }, {
    variableName: 'breakReminder',
    dictKey: 'imageResult',
  });
  const stats3 = node(slug, 'stats3', 'DataStructure', { x: 860, y: 340 }, {
    variableName: 'breakReminder',
    dictKey: 'soundResult',
  });
  const stats4 = node(slug, 'stats4', 'DataStructure', { x: 860, y: 480 }, {
    variableName: 'breakReminder',
    dictKey: 'messageResult',
  });
  const save = node(slug, 'save', 'SaveLoad', { x: 1160, y: 200 }, {
    label: 'Remember last reminder',
    literalValue: 'break-reminder:last-run',
  });
  const extendedOutput = node(slug, 'extended-output', 'ExtendedDataOut', { x: 1440, y: 160 });
  const output = node(slug, 'output', 'DataFlowOut', { x: 1440, y: 360 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, now, image, showImage, audio, playSound, message, stats, stats2, stats3, stats4, save, extendedOutput, output],
    [
      edge(image, 'result', showImage, 'asset'),
      edge(audio, 'result', playSound, 'asset'),
      edge(now, 'result', stats, 'value'),
      edge(showImage, 'result', stats2, 'value'),
      edge(stats, 'result', stats2, 'dict'),
      edge(playSound, 'result', stats3, 'value'),
      edge(stats2, 'result', stats3, 'dict'),
      edge(message, 'result', stats4, 'value'),
      edge(stats3, 'result', stats4, 'dict'),
      edge(stats4, 'result', save, 'value'),
      edge(save, 'result', extendedOutput, 'fileBlob'),
      edge(input, 'url', output, 'url'),
    ],
    {
      type: 'HOTKEY',
      hotkey: 'Ctrl+Shift+B',
      inputSources: ['url'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function playbackResume(): WorkspaceFileV2 {
  const slug = 'playback-resume';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 240 }, { locked: true });
  const labelPrompt = node(slug, 'label-prompt', 'PromptText', { x: 0, y: 80 }, {
    promptMessage: 'Playback label',
    promptDefaultValue: 'Bundled sample video',
  });
  const getVideo = node(slug, 'get-video', 'GetVideo', { x: 300, y: 80 }, {
    label: 'Bundled video sample',
    assetKind: 'video',
    assetMimeType: 'video/mp4',
    assetName: 'playback-sample.mp4',
    assetDataBase64: EMBEDDED_SAMPLE_VIDEO_BASE64,
    assetCompression: 'none',
    remoteMaxBytes: 8192,
  });
  const showVideo = node(slug, 'show-video', 'ShowVideo', { x: 620, y: 80 }, {
    label: 'Play sample',
  });
  const playbackDict = node(slug, 'playback-dict', 'DataStructure', { x: 940, y: 80 }, {
    variableName: 'playbackResume',
    dictKey: 'lastResult',
  });
  const labelDict = node(slug, 'label-dict', 'DataStructure', { x: 940, y: 220 }, {
    variableName: 'playbackResume',
    dictKey: 'label',
  });
  const save = node(slug, 'save', 'SaveLoad', { x: 1220, y: 160 }, {
    literalValue: 'playback-resume:last-video',
  });
  const extendedOutput = node(slug, 'extended-output', 'ExtendedDataOut', { x: 1500, y: 120 });
  const output = node(slug, 'output', 'DataFlowOut', { x: 1500, y: 300 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, labelPrompt, getVideo, showVideo, playbackDict, labelDict, save, extendedOutput, output],
    [
      edge(getVideo, 'result', showVideo, 'asset'),
      edge(showVideo, 'result', playbackDict, 'value'),
      edge(labelPrompt, 'result', labelDict, 'value'),
      edge(playbackDict, 'result', labelDict, 'dict'),
      edge(labelDict, 'result', save, 'value'),
      edge(save, 'result', extendedOutput, 'fileBlob'),
      edge(input, 'url', output, 'url'),
    ],
    {
      type: 'HOTKEY',
      hotkey: 'Ctrl+Shift+V',
      inputSources: ['url'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function overlayInputCapture(): WorkspaceFileV2 {
  const slug = 'overlay-input-capture';
  const input = node(slug, 'input', 'DataFlowIn', { x: 0, y: 160 }, { locked: true });
  const capture = node(slug, 'capture', 'OverlayInput', { x: 300, y: 40 }, {
    label: 'Capture overlay controls',
    promptMessage: 'Press arrows, WASD, Space, or click inside this overlay. Close it to save the captured event summary.',
    displayTimeoutMs: 15000,
    captureKeyboard: true,
    captureMouse: true,
  });
  const save = node(slug, 'save', 'SaveLoad', { x: 620, y: 40 }, {
    label: 'Save captured input',
    literalValue: 'overlay-input:last-capture',
  });
  const output = node(slug, 'output', 'DataFlowOut', { x: 620, y: 220 }, { locked: true });

  return baseWorkspace(
    getExample(slug),
    [input, capture, save, output],
    [
      edge(capture, 'result', save, 'value'),
      edge(input, 'url', output, 'url'),
    ],
    {
      type: 'HOTKEY',
      hotkey: 'Ctrl+Shift+G',
      inputSources: ['url'],
      sourceFilters: [{ source: 'url', pattern: '^https?://' }],
    },
  );
}

function snakeOverlayArcade(): WorkspaceFileV2 {
  const slug = 'snake-overlay-arcade';
  const nodes: WorkspaceNodeV2[] = [];
  const edges: ReturnType<typeof edge>[] = [];
  const add = (key: string, type: BlockKind, x: number, y: number, settings: WorkspaceBlockSettings = {}) => {
    const created = node(slug, key, type, { x, y }, settings);
    nodes.push(created);
    return created;
  };
  const connect = (source: WorkspaceNodeV2, sourceHandle: string, target: WorkspaceNodeV2, targetHandle: string) => {
    edges.push(edge(source, sourceHandle, target, targetHandle));
  };
  const constant = (key: string, x: number, y: number, literalValue: string, literalDataType: WorkspaceBlockSettings['literalDataType'] = 'string') =>
    add(key, 'Constant', x, y, { literalValue, literalDataType });
  const logic = (key: string, x: number, y: number, compareValue: string, operator: WorkspaceBlockSettings['operator'] = 'EQ') =>
    add(key, 'Logical', x, y, { compareValue, operator, booleanOutput: true });
  const addMath = (key: string, x: number, y: number, fallbackRight = '0') =>
    add(key, 'Math', x, y, { mathOperation: 'ADD', compareValue: fallbackRight });
  const shared = (key: string, x: number, y: number, mode: WorkspaceBlockSettings['sharedStateMode'], fallbackKey: string, fallbackValue: string, literalDataType: WorkspaceBlockSettings['literalDataType'] = 'Any') =>
    add(key, 'SharedState', x, y, { sharedStateMode: mode, literalValue: fallbackKey, selectFalseValue: fallbackValue, literalDataType });
  const list = (key: string, x: number, y: number, operation: WorkspaceBlockSettings['listOperation'], fallbackList = '[]', fallbackItem = '', literalDataType: WorkspaceBlockSettings['literalDataType'] = 'Any') =>
    add(key, 'ListOperation', x, y, { listOperation: operation, literalValue: fallbackList, selectTrueValue: fallbackItem, literalDataType });
  const dictSet = (key: string, x: number, y: number, dictKey: string) =>
    add(key, 'DataStructure', x, y, { dictKey });
  const select = (key: string, x: number, y: number, trueValue = '1', falseValue = '0', literalDataType: WorkspaceBlockSettings['literalDataType'] = 'number') =>
    add(key, 'ConditionSelect', x, y, { selectTrueValue: trueValue, selectFalseValue: falseValue, literalDataType });

  const input = add('input', 'DataFlowIn', 0, 80, { locked: true });
  const output = add('output', 'DataFlowOut', 320, 80, { locked: true });
  connect(input, 'url', output, 'url');

  const trigger = add('trigger', 'OnTriggerEvent', 0, 260);
  const status = add('overlay-status', 'OverlayControl', 260, 240, {
    overlayControlAction: 'STATUS',
    overlayText: 'Snake Overlay Arcade',
    overlayWidth: 24,
    overlayHeight: 18,
    overlayCellSize: 24,
    overlayTickMs: 135,
    overlayBackground: '#ffffff',
  });
  const active = add('overlay-active', 'DictGet', 520, 240, { dictKey: 'active', literalValue: '0', literalDataType: 'bool' });
  const notActive = logic('overlay-not-active', 760, 210, '0');
  const isActive = logic('overlay-is-active', 760, 310, '1');
  const start = add('overlay-start', 'OverlayControl', 1010, 170, {
    overlayControlAction: 'START',
    overlayText: 'Snake Overlay Arcade',
    overlayWidth: 24,
    overlayHeight: 18,
    overlayCellSize: 24,
    overlayTickMs: 135,
    overlayBackground: '#ffffff',
  });
  const stop = add('overlay-stop', 'OverlayControl', 1010, 330, {
    overlayControlAction: 'STOP',
    overlayText: 'Snake Overlay Arcade',
  });
  const sleepy = add('sleep-before-stop', 'Sleep', 1260, 330, { sleepMs: 1 });
  connect(trigger, 'triggered', status, 'enabled');
  connect(status, 'result', active, 'dict');
  connect(active, 'result', notActive, 'input');
  connect(active, 'result', isActive, 'input');
  connect(notActive, 'result', start, 'enabled');
  connect(isActive, 'result', stop, 'enabled');
  connect(isActive, 'result', sleepy, 'enabled');

  const initialBody = constant('initial-body', 1010, 520, '[{"x":8,"y":8,"color":"#16a34a"},{"x":7,"y":8,"color":"#22c55e"},{"x":6,"y":8,"color":"#22c55e"}]', 'data');
  const initialFood = constant('initial-food', 1010, 650, '{"x":14,"y":8,"color":"#dc2626"}', 'dict');
  const initialDirection = constant('initial-direction', 1010, 780, 'ArrowRight', 'string');
  const initialScore = constant('initial-score', 1010, 910, '0', 'number');
  const initialPaused = constant('initial-paused', 1010, 1040, '0', 'number');
  const saveInitialBody = shared('save-initial-body', 1280, 520, 'SET', 'snake:body', '[]', 'data');
  const saveInitialFood = shared('save-initial-food', 1280, 650, 'SET', 'snake:food', '{}', 'dict');
  const saveInitialDirection = shared('save-initial-direction', 1280, 780, 'SET', 'snake:direction', 'ArrowRight', 'string');
  const saveInitialScore = shared('save-initial-score', 1280, 910, 'SET', 'snake:score', '0', 'number');
  const saveInitialPaused = shared('save-initial-paused', 1280, 1040, 'SET', 'snake:paused', '0', 'number');
  const initialCells = list('initial-cells', 1540, 590, 'APPEND');
  const initialTitle = constant('initial-title', 1540, 720, 'Snake Overlay Arcade', 'string');
  const initialDraw = add('initial-draw', 'OverlayDraw', 1780, 620, {
    overlayWidth: 24,
    overlayHeight: 18,
    overlayCellSize: 24,
    overlayBackground: '#ffffff',
  });
  [
    [initialBody, saveInitialBody],
    [initialFood, saveInitialFood],
    [initialDirection, saveInitialDirection],
    [initialScore, saveInitialScore],
    [initialPaused, saveInitialPaused],
  ].forEach(([value, target]) => {
    connect(value, 'value', target, 'value');
    connect(notActive, 'result', target, 'enabled');
  });
  connect(initialBody, 'value', initialCells, 'list');
  connect(initialFood, 'value', initialCells, 'item');
  connect(initialCells, 'result', initialDraw, 'cells');
  connect(initialTitle, 'value', initialDraw, 'text');
  connect(notActive, 'result', initialDraw, 'enabled');

  const keyboard = add('keyboard', 'KeyboardIn', 0, 1240);
  const keyUp = logic('key-up', 260, 1090, 'ArrowUp');
  const keyW = logic('key-w', 260, 1180, 'w');
  const keyWUpper = logic('key-w-upper', 260, 1270, 'W');
  const upAddA = addMath('up-add-a', 500, 1135);
  const upAddB = addMath('up-add-b', 720, 1175);
  const upPressed = logic('up-pressed', 940, 1175, '0', 'GT');
  const keyDown = logic('key-down', 260, 1370, 'ArrowDown');
  const keyS = logic('key-s', 260, 1460, 's');
  const keySUpper = logic('key-s-upper', 260, 1550, 'S');
  const downAddA = addMath('down-add-a', 500, 1415);
  const downAddB = addMath('down-add-b', 720, 1455);
  const downPressed = logic('down-pressed', 940, 1455, '0', 'GT');
  const keyLeft = logic('key-left', 260, 1650, 'ArrowLeft');
  const keyA = logic('key-a', 260, 1740, 'a');
  const keyAUpper = logic('key-a-upper', 260, 1830, 'A');
  const leftAddA = addMath('left-add-a', 500, 1695);
  const leftAddB = addMath('left-add-b', 720, 1735);
  const leftPressed = logic('left-pressed', 940, 1735, '0', 'GT');
  const keyRight = logic('key-right', 260, 1930, 'ArrowRight');
  const keyD = logic('key-d', 260, 2020, 'd');
  const keyDUpper = logic('key-d-upper', 260, 2110, 'D');
  const rightAddA = addMath('right-add-a', 500, 1975);
  const rightAddB = addMath('right-add-b', 720, 2015);
  const rightPressed = logic('right-pressed', 940, 2015, '0', 'GT');
  const keyEscape = logic('key-escape', 260, 2210, 'Escape');
  const keyBackspace = logic('key-backspace', 260, 2300, 'Backspace');
  const closeAdd = addMath('close-add', 500, 2250);
  const closePressed = logic('close-pressed', 720, 2250, '0', 'GT');
  [
    keyUp, keyW, keyWUpper, keyDown, keyS, keySUpper, keyLeft, keyA, keyAUpper, keyRight, keyD, keyDUpper, keyEscape, keyBackspace,
  ].forEach((compare) => connect(keyboard, 'keyboardKey', compare, 'input'));
  connect(keyUp, 'result', upAddA, 'left');
  connect(keyW, 'result', upAddA, 'right');
  connect(upAddA, 'result', upAddB, 'left');
  connect(keyWUpper, 'result', upAddB, 'right');
  connect(upAddB, 'result', upPressed, 'input');
  connect(keyDown, 'result', downAddA, 'left');
  connect(keyS, 'result', downAddA, 'right');
  connect(downAddA, 'result', downAddB, 'left');
  connect(keySUpper, 'result', downAddB, 'right');
  connect(downAddB, 'result', downPressed, 'input');
  connect(keyLeft, 'result', leftAddA, 'left');
  connect(keyA, 'result', leftAddA, 'right');
  connect(leftAddA, 'result', leftAddB, 'left');
  connect(keyAUpper, 'result', leftAddB, 'right');
  connect(leftAddB, 'result', leftPressed, 'input');
  connect(keyRight, 'result', rightAddA, 'left');
  connect(keyD, 'result', rightAddA, 'right');
  connect(rightAddA, 'result', rightAddB, 'left');
  connect(keyDUpper, 'result', rightAddB, 'right');
  connect(rightAddB, 'result', rightPressed, 'input');
  connect(keyEscape, 'result', closeAdd, 'left');
  connect(keyBackspace, 'result', closeAdd, 'right');
  connect(closeAdd, 'result', closePressed, 'input');
  const dirUp = constant('dir-up', 1180, 1160, 'ArrowUp', 'string');
  const dirDown = constant('dir-down', 1180, 1440, 'ArrowDown', 'string');
  const dirLeft = constant('dir-left', 1180, 1720, 'ArrowLeft', 'string');
  const dirRight = constant('dir-right', 1180, 2000, 'ArrowRight', 'string');
  const saveDirUp = shared('save-dir-up', 1420, 1160, 'SET', 'snake:direction', 'ArrowUp', 'string');
  const saveDirDown = shared('save-dir-down', 1420, 1440, 'SET', 'snake:direction', 'ArrowDown', 'string');
  const saveDirLeft = shared('save-dir-left', 1420, 1720, 'SET', 'snake:direction', 'ArrowLeft', 'string');
  const saveDirRight = shared('save-dir-right', 1420, 2000, 'SET', 'snake:direction', 'ArrowRight', 'string');
  [
    [dirUp, upPressed, saveDirUp],
    [dirDown, downPressed, saveDirDown],
    [dirLeft, leftPressed, saveDirLeft],
    [dirRight, rightPressed, saveDirRight],
  ].forEach(([value, enabled, target]) => {
    connect(value, 'value', target, 'value');
    connect(enabled, 'result', target, 'enabled');
  });
  const closeOverlay = add('keyboard-close-overlay', 'OverlayControl', 1180, 2250, { overlayControlAction: 'STOP', overlayText: 'Snake Overlay Arcade' });
  connect(closePressed, 'result', closeOverlay, 'enabled');

  const mouse = add('mouse', 'MouseIn', 0, 2460);
  const mouseDown = logic('mouse-down', 260, 2420, 'pointerdown');
  const mouseLeft = logic('mouse-left', 260, 2530, '0');
  const mouseAdd = addMath('mouse-add', 500, 2480);
  const leftClick = logic('left-click', 720, 2480, '1', 'GT');
  const loadPausedForMouse = shared('load-paused-mouse', 940, 2450, 'GET', 'snake:paused', '0', 'number');
  const pausedIsOff = logic('paused-is-off', 1180, 2450, '0');
  const pauseOn = constant('pause-on', 1180, 2570, '1', 'number');
  const pauseOff = constant('pause-off', 1180, 2670, '0', 'number');
  const pauseNext = select('pause-next', 1420, 2550);
  const savePaused = shared('save-paused', 1660, 2550, 'SET', 'snake:paused', '0', 'number');
  connect(mouse, 'mouseKind', mouseDown, 'input');
  connect(mouse, 'mouseButton', mouseLeft, 'input');
  connect(mouseDown, 'result', mouseAdd, 'left');
  connect(mouseLeft, 'result', mouseAdd, 'right');
  connect(mouseAdd, 'result', leftClick, 'input');
  connect(loadPausedForMouse, 'result', pausedIsOff, 'input');
  connect(pausedIsOff, 'result', pauseNext, 'condition');
  connect(pauseOn, 'value', pauseNext, 'trueValue');
  connect(pauseOff, 'value', pauseNext, 'falseValue');
  connect(pauseNext, 'result', savePaused, 'value');
  connect(leftClick, 'result', savePaused, 'enabled');

  const tick = add('tick', 'OverlayTickIn', 0, 2900);
  const tickReady = logic('tick-ready', 240, 2900, '0', 'GTE');
  connect(tick, 'tick', tickReady, 'input');
  const loadAlive = shared('load-alive', 240, 3040, 'GET', 'snake:alive', '1', 'number');
  const loadPaused = shared('load-paused', 240, 3160, 'GET', 'snake:paused', '0', 'number');
  const loadBody = shared('load-body', 240, 3280, 'GET', 'snake:body', '[{"x":8,"y":8,"color":"#16a34a"},{"x":7,"y":8,"color":"#22c55e"},{"x":6,"y":8,"color":"#22c55e"}]', 'data');
  const loadDirection = shared('load-direction', 240, 3400, 'GET', 'snake:direction', 'ArrowRight', 'string');
  const loadFood = shared('load-food', 240, 3520, 'GET', 'snake:food', '{"x":14,"y":8,"color":"#dc2626"}', 'dict');
  const loadScore = shared('load-score', 240, 3640, 'GET', 'snake:score', '0', 'number');
  const alive = logic('alive', 500, 3040, '1');
  const notPausedTick = logic('not-paused-tick', 500, 3160, '0');
  const canMoveAdd = addMath('can-move-add', 740, 3090);
  const canMoveBase = logic('can-move-base', 960, 3090, '1', 'GT');
  const canMoveTickAdd = addMath('can-move-tick-add', 1180, 3090);
  const canMove = logic('can-move', 1400, 3090, '1', 'GT');
  connect(loadAlive, 'result', alive, 'input');
  connect(loadPaused, 'result', notPausedTick, 'input');
  connect(alive, 'result', canMoveAdd, 'left');
  connect(notPausedTick, 'result', canMoveAdd, 'right');
  connect(canMoveAdd, 'result', canMoveBase, 'input');
  connect(canMoveBase, 'result', canMoveTickAdd, 'left');
  connect(tickReady, 'result', canMoveTickAdd, 'right');
  connect(canMoveTickAdd, 'result', canMove, 'input');

  const head = list('head', 500, 3300, 'GET');
  const headX = add('head-x', 'DictGet', 740, 3260, { dictKey: 'x', literalValue: '8', literalDataType: 'number' });
  const headY = add('head-y', 'DictGet', 740, 3360, { dictKey: 'y', literalValue: '8', literalDataType: 'number' });
  connect(loadBody, 'result', head, 'list');
  connect(head, 'result', headX, 'dict');
  connect(head, 'result', headY, 'dict');
  const dirRightCheck = logic('dir-right-check', 500, 3800, 'ArrowRight');
  const dirLeftCheck = logic('dir-left-check', 500, 3900, 'ArrowLeft');
  const dirUpCheck = logic('dir-up-check', 500, 4000, 'ArrowUp');
  const dirDownCheck = logic('dir-down-check', 500, 4100, 'ArrowDown');
  [dirRightCheck, dirLeftCheck, dirUpCheck, dirDownCheck].forEach((compare) => connect(loadDirection, 'result', compare, 'input'));
  const dxPositive = select('dx-positive', 740, 3800, '1', '0', 'number');
  const dxNegative = select('dx-negative', 740, 3900, '-1', '0', 'number');
  const dx = addMath('dx', 960, 3850);
  const dyNegative = select('dy-negative', 740, 4000, '-1', '0', 'number');
  const dyPositive = select('dy-positive', 740, 4100, '1', '0', 'number');
  const dy = addMath('dy', 960, 4050);
  connect(dirRightCheck, 'result', dxPositive, 'condition');
  connect(dirLeftCheck, 'result', dxNegative, 'condition');
  connect(dxPositive, 'result', dx, 'left');
  connect(dxNegative, 'result', dx, 'right');
  connect(dirUpCheck, 'result', dyNegative, 'condition');
  connect(dirDownCheck, 'result', dyPositive, 'condition');
  connect(dyNegative, 'result', dy, 'left');
  connect(dyPositive, 'result', dy, 'right');
  const newX = addMath('new-x', 1180, 3260);
  const newY = addMath('new-y', 1180, 3360);
  connect(headX, 'result', newX, 'left');
  connect(dx, 'result', newX, 'right');
  connect(headY, 'result', newY, 'left');
  connect(dy, 'result', newY, 'right');
  const emptyHead = constant('empty-head', 1180, 3480, '{}', 'dict');
  const snakeGreen = constant('snake-green', 1180, 3580, '#16a34a', 'string');
  const newHeadX = dictSet('new-head-x', 1420, 3260, 'x');
  const newHeadY = dictSet('new-head-y', 1660, 3300, 'y');
  const newHead = dictSet('new-head-color', 1900, 3340, 'color');
  connect(emptyHead, 'value', newHeadX, 'dict');
  connect(newX, 'result', newHeadX, 'value');
  connect(newHeadX, 'result', newHeadY, 'dict');
  connect(newY, 'result', newHeadY, 'value');
  connect(newHeadY, 'result', newHead, 'dict');
  connect(snakeGreen, 'value', newHead, 'value');

  const wallLeft = logic('wall-left', 1420, 3680, '0', 'LT');
  const wallRight = logic('wall-right', 1420, 3780, '24', 'GTE');
  const wallTop = logic('wall-top', 1420, 3880, '0', 'LT');
  const wallBottom = logic('wall-bottom', 1420, 3980, '18', 'GTE');
  connect(newX, 'result', wallLeft, 'input');
  connect(newX, 'result', wallRight, 'input');
  connect(newY, 'result', wallTop, 'input');
  connect(newY, 'result', wallBottom, 'input');
  const wallX = addMath('wall-x', 1660, 3720);
  const wallY = addMath('wall-y', 1660, 3920);
  const wallAll = addMath('wall-all', 1900, 3820);
  const wallCollision = logic('wall-collision', 2140, 3820, '0', 'GT');
  connect(wallLeft, 'result', wallX, 'left');
  connect(wallRight, 'result', wallX, 'right');
  connect(wallTop, 'result', wallY, 'left');
  connect(wallBottom, 'result', wallY, 'right');
  connect(wallX, 'result', wallAll, 'left');
  connect(wallY, 'result', wallAll, 'right');
  connect(wallAll, 'result', wallCollision, 'input');
  const selfCollision = list('self-collision', 2140, 3520, 'CONTAINS_POINT');
  connect(loadBody, 'result', selfCollision, 'list');
  connect(newHead, 'result', selfCollision, 'item');
  const collisionAdd = addMath('collision-add', 2380, 3660);
  const collision = logic('collision', 2620, 3660, '0', 'GT');
  const aliveNext = logic('alive-next', 2860, 3660, '0');
  connect(wallCollision, 'result', collisionAdd, 'left');
  connect(selfCollision, 'result', collisionAdd, 'right');
  connect(collisionAdd, 'result', collision, 'input');
  connect(collision, 'result', aliveNext, 'input');

  const oneFood = list('one-food', 2140, 4100, 'APPEND');
  const foodHit = list('food-hit', 2380, 4100, 'CONTAINS_POINT');
  connect(loadFood, 'result', oneFood, 'item');
  connect(oneFood, 'result', foodHit, 'list');
  connect(newHead, 'result', foodHit, 'item');
  const grown = list('grown-body', 2380, 3280, 'PREPEND');
  const moved = list('moved-body', 2620, 3280, 'DROP_LAST');
  const bodyCandidate = select('body-candidate', 2860, 3280, '[]', '[]', 'data');
  const bodyNext = select('body-next', 3100, 3280, '[]', '[]', 'data');
  connect(loadBody, 'result', grown, 'list');
  connect(newHead, 'result', grown, 'item');
  connect(grown, 'result', moved, 'list');
  connect(foodHit, 'result', bodyCandidate, 'condition');
  connect(grown, 'result', bodyCandidate, 'trueValue');
  connect(moved, 'result', bodyCandidate, 'falseValue');
  connect(aliveNext, 'result', bodyNext, 'condition');
  connect(bodyCandidate, 'result', bodyNext, 'trueValue');
  connect(loadBody, 'result', bodyNext, 'falseValue');

  const foodRandomX = add('food-random-x', 'RandomNumber', 2620, 4240, { randomMin: 1, randomMax: 22 });
  const foodRandomY = add('food-random-y', 'RandomNumber', 2620, 4360, { randomMin: 1, randomMax: 16 });
  const emptyFood = constant('empty-food', 2620, 4480, '{}', 'dict');
  const foodRed = constant('food-red', 2620, 4600, '#dc2626', 'string');
  const randFoodX = dictSet('rand-food-x', 2860, 4240, 'x');
  const randFoodY = dictSet('rand-food-y', 3100, 4280, 'y');
  const randFood = dictSet('rand-food-color', 3340, 4320, 'color');
  const foodNext = select('food-next', 3580, 4240, '{}', '{}', 'dict');
  connect(emptyFood, 'value', randFoodX, 'dict');
  connect(foodRandomX, 'result', randFoodX, 'value');
  connect(randFoodX, 'result', randFoodY, 'dict');
  connect(foodRandomY, 'result', randFoodY, 'value');
  connect(randFoodY, 'result', randFood, 'dict');
  connect(foodRed, 'value', randFood, 'value');
  connect(foodHit, 'result', foodNext, 'condition');
  connect(randFood, 'result', foodNext, 'trueValue');
  connect(loadFood, 'result', foodNext, 'falseValue');

  const scorePlus = addMath('score-plus', 2860, 3900, '1');
  const scoreNext = select('score-next', 3100, 3900, '0', '0', 'number');
  const scoreText = add('score-text', 'Convert', 3340, 3900, { convertMode: 'NUMBER_TO_STRING', convertOrd: true });
  connect(loadScore, 'result', scorePlus, 'left');
  connect(foodHit, 'result', scoreNext, 'condition');
  connect(scorePlus, 'result', scoreNext, 'trueValue');
  connect(loadScore, 'result', scoreNext, 'falseValue');
  connect(scoreNext, 'result', scoreText, 'input');

  const saveAlive = shared('save-alive', 3340, 3500, 'SET', 'snake:alive', '1', 'number');
  const saveBody = shared('save-body', 3340, 3620, 'SET', 'snake:body', '[]', 'data');
  const saveFood = shared('save-food', 3820, 4240, 'SET', 'snake:food', '{}', 'dict');
  const saveScore = shared('save-score', 3580, 3900, 'SET', 'snake:score', '0', 'number');
  connect(aliveNext, 'result', saveAlive, 'value');
  connect(canMove, 'result', saveAlive, 'enabled');
  connect(bodyNext, 'result', saveBody, 'value');
  connect(canMove, 'result', saveBody, 'enabled');
  connect(foodNext, 'result', saveFood, 'value');
  connect(canMove, 'result', saveFood, 'enabled');
  connect(scoreNext, 'result', saveScore, 'value');
  connect(canMove, 'result', saveScore, 'enabled');
  const cells = list('draw-cells', 3820, 3440, 'APPEND');
  const draw = add('tick-draw', 'OverlayDraw', 4060, 3520, {
    overlayWidth: 24,
    overlayHeight: 18,
    overlayCellSize: 24,
    overlayBackground: '#ffffff',
  });
  connect(bodyNext, 'result', cells, 'list');
  connect(foodNext, 'result', cells, 'item');
  connect(cells, 'result', draw, 'cells');
  connect(scoreText, 'result', draw, 'text');
  connect(canMove, 'result', draw, 'enabled');

  return baseWorkspace(
    getExample(slug),
    nodes,
    edges,
    {
      type: 'HOTKEY',
      hotkey: 'Ctrl+Shift+S',
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
    cleanWords(),
    breakReminder(),
    playbackResume(),
    overlayInputCapture(),
    snakeOverlayArcade(),
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
