import type { CSSProperties, ChangeEvent, DragEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { MAX_ACTION_PACK_BINARY_BYTES, REGEX_TIMEOUT_MS } from '../shared/constants';
import { exportBackupState, importBackupState } from '../shared/backup';
import { simulateActionPack } from '../shared/engine/engine';
import type { EngineRuntime } from '../shared/engine/runtime';
import { formatActionPackLogText } from '../shared/logs';
import { effectiveRegexTimeoutMs, normalizeUiScale } from '../shared/hardening';
import {
  clearActionPackLog,
  clearOpenWorkspaceDraft,
  deleteActionPackV2,
  deletePack,
  deleteWorkspaceV2,
  loadOpenWorkspaceDraft,
  resetExtensionStorage,
  saveOpenWorkspaceDraft,
  saveStoredState,
  updateActionPackV2Trace,
  updateActionPackV2Install,
  updateSettings,
  updateWorkspaceV2Viewport,
  upsertActionPackV2,
  upsertCustomBlockV2,
  upsertWorkspaceV2,
} from '../shared/storage';
import type { ActionPack, GlobalSettings, StoredState } from '../shared/types';
import { exportActionPackBinary } from '../shared/vault';
import { createPageRegexExecutor } from '../shared/regex/pageRunner';
import { BUNDLED_ACTION_PACK_EXAMPLES, type BundledActionPackExample } from '../shared/v2/bundledExamples';
import { compileWorkspace } from '../shared/v2/compiler';
import { isActionPackLocked, isContentBlockerActionPack, withInstallMetadata } from '../shared/v2/installMetadata';
import { createChallengeLockState, createPasswordLockState, unlockedLockState, verifyPasswordLock } from '../shared/v2/locks';
import { listOllamaModels, previewOllamaWorkspaceDraft, requestOllamaWorkspaceDraft, validateOllamaEndpoint, type OllamaModelSummary, type OllamaWorkspaceDraft, type OllamaWorkspaceDraftPreview } from '../shared/v2/ollama';
import { inferAssetKind, listResources, putResourceBytes, resourceToAssetRef } from '../shared/v2/resources';
import { executeCompiledActionPackV2, type GraphRuntime } from '../shared/v2/vm';
import { createSandboxGraphRuntime } from '../shared/v2/sandboxRuntime';
import type { ActionPackLockLevel, ActionPackLockState, AssetRef, CompiledActionPackV2, CompiledCustomBlockV2, WorkspaceEmbeddedCustomBlock, WorkspaceFileV2, WorkspaceMetadata, WorkspaceType } from '../shared/v2/types';
import { normalizeAiWorkspaceInstructions } from '../shared/v2/aiInstructions';
import { createDefaultContentBlockerWorkspace, createDefaultCustomBlockWorkspace, createDefaultWorkspace, workspaceFromLegacyPack } from '../shared/v2/workspace';
import { URL_ALCHEMIST_VERSION } from '../shared/v2/buildInfo';
import {
  importCompiledActionPackV2Binary,
  exportCompiledActionPackV2Binary,
  exportWorkspaceBinary,
  importAnyArtifact,
  importWorkspaceBinary,
} from '../shared/v2/vault';
import { AboutPanel } from './components/AboutPanel';
import { BundledExamplesPanel } from './components/BundledExamplesPanel';
import { HelpPanel } from './components/HelpPanel';
import ImportPanel from './components/ImportPanel';
import { ManageResourcesPanel } from './components/ManageResourcesPanel';
import { SecurityPanel } from './components/SecurityPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { StagingModal } from './components/StagingModal';
import { WorkspaceEditor, type WorkspaceChangeOptions } from './components/WorkspaceEditor';
import { useStoredExtensionState } from './hooks/useStoredExtensionState';

type BrowserChromeApi = {
  downloads?: {
    download?: typeof chrome.downloads.download;
  };
  permissions?: {
    contains?: typeof chrome.permissions.contains;
    request?: typeof chrome.permissions.request;
  };
  runtime?: {
    getURL?: typeof chrome.runtime.getURL;
    reload?: typeof chrome.runtime.reload;
  };
  storage?: {
    local?: typeof chrome.storage.local;
  };
};

type OptionsTab = 'bundled' | 'examples' | 'manage-resources' | 'import' | 'workspace-editor' | 'security' | 'settings' | 'help' | 'about';

const OPTIONS_TABS: Array<{ id: OptionsTab; label: string }> = [
  { id: 'bundled', label: 'Bundled' },
  { id: 'examples', label: 'Examples' },
  { id: 'manage-resources', label: 'Manage Resources' },
  { id: 'import', label: 'Import' },
  { id: 'workspace-editor', label: 'Workspace Editor' },
  { id: 'security', label: 'Security' },
  { id: 'settings', label: 'Settings' },
  { id: 'help', label: 'Help' },
  { id: 'about', label: 'About' },
];

const ALLOWED_BUNDLED_ARTIFACT_PATHS = new Set(
  BUNDLED_ACTION_PACK_EXAMPLES.flatMap((example) => [example.workspacePath, example.actionPackPath].filter((path): path is string => Boolean(path))),
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let bundledIndexPromise: Promise<BundledArtifactIndex> | null = null;

interface BundledArtifactIndex {
  examples: Array<{
    id: string;
    artifactHashes?: {
      workspaceSha256?: string;
      actionPackSha256?: string;
    };
  }>;
}

function getChromeApi(): BrowserChromeApi {
  return (globalThis as unknown as { chrome?: BrowserChromeApi }).chrome ?? {};
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function downloadBytes(bytes: Uint8Array, filename: string): Promise<void> {
  const bufferCopy = new Uint8Array(bytes.byteLength);
  bufferCopy.set(bytes);
  const objectUrl = URL.createObjectURL(new Blob([bufferCopy.buffer], { type: 'application/octet-stream' }));

  try {
    const chromeApi = getChromeApi();
    if (chromeApi.downloads?.download) {
      await chromeApi.downloads.download({
        url: objectUrl,
        filename,
        saveAs: true,
      });
      return;
    }

    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename.split('/').pop() || 'download.bin';
    anchor.click();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}

async function downloadText(text: string, filename: string): Promise<void> {
  await downloadBytes(new TextEncoder().encode(text), filename);
}

async function downloadLegacyPack(pack: ActionPack): Promise<void> {
  await downloadBytes(await exportActionPackBinary(pack), `action-packs/${slugify(pack.name) || 'legacy-pack'}.urlpack`);
}

function getBundledArtifactUrl(path: string): string {
  const chromeApi = getChromeApi();
  if (chromeApi.runtime?.getURL) {
    return chromeApi.runtime.getURL(path);
  }

  return `/${path}`;
}

async function fetchBundledArtifact(path: string): Promise<Uint8Array> {
  if (!ALLOWED_BUNDLED_ARTIFACT_PATHS.has(path)) {
    throw new Error('Bundled artifact path is not recognized');
  }

  const response = await fetch(getBundledArtifactUrl(path));
  if (!response.ok) {
    throw new Error(`Unable to load bundled artifact ${path}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(bytes.byteLength);
  buffer.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buffer.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadBundledIndex(): Promise<BundledArtifactIndex> {
  if (!bundledIndexPromise) {
    bundledIndexPromise = fetch(getBundledArtifactUrl('bundled-actionpacks/index.json')).then(async (response) => {
      if (!response.ok) {
        throw new Error('Unable to load bundled artifact index.');
      }
      return await response.json() as BundledArtifactIndex;
    });
  }
  return bundledIndexPromise;
}

async function fetchVerifiedBundledArtifact(example: BundledActionPackExample, kind: 'workspace' | 'action-pack'): Promise<Uint8Array> {
  const path = kind === 'workspace' ? example.workspacePath : example.actionPackPath;
  if (!path) {
    throw new Error(`${example.name} does not include a compiled Action Pack.`);
  }
  const bytes = await fetchBundledArtifact(path);
  const index = await loadBundledIndex();
  const indexEntry = index.examples.find((candidate) => candidate.id === example.id);
  const expected = kind === 'workspace'
    ? indexEntry?.artifactHashes?.workspaceSha256
    : indexEntry?.artifactHashes?.actionPackSha256;
  if (!expected) {
    throw new Error(`Bundled artifact index is missing a hash for ${example.name}.`);
  }
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(`Bundled artifact hash mismatch for ${example.name}.`);
  }
  return bytes;
}

function parseBuilderUuid(value: string): string | null {
  const keyValueMatch = value.match(/URL_ALCHEMIST_BUILDER_UUID\s*=\s*([0-9a-f-]+)/i);
  const candidate = keyValueMatch?.[1] ?? value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? value.trim();

  return UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

function getPackImportValidationErrors(pack: CompiledActionPackV2 | null, installedPacks: CompiledActionPackV2[]): string[] {
  if (!pack) {
    return [];
  }

  const errors: string[] = [];
  const existing = installedPacks.find((candidate) => candidate.manifest.id === pack.manifest.id);
  if (existing) {
    errors.push(`An installed Action Pack already uses this ID (${existing.manifest.name}). Delete it before importing this file.`);
  }

  return errors;
}

function createOptionsRuntimes(settings: GlobalSettings): { graph: GraphRuntime; legacy: EngineRuntime } {
  const regex = createPageRegexExecutor(effectiveRegexTimeoutMs(settings));
  const readClipboard = async () => {
    const chromeApi = getChromeApi();
    if (!chromeApi.permissions?.contains) {
      return await navigator.clipboard.readText();
    }

    const granted = await chromeApi.permissions.contains({
      permissions: ['clipboardRead'],
    });

    if (!granted) {
      throw new Error('Clipboard access requires the optional clipboardRead permission.');
    }

    return await navigator.clipboard.readText();
  };
  const writeClipboard = async (text: string) => {
    const chromeApi = getChromeApi();
    if (!chromeApi.permissions?.contains) {
      await navigator.clipboard.writeText(text);
      return;
    }

    const granted = await chromeApi.permissions.contains({
      permissions: ['clipboardWrite'],
    });

    if (!granted) {
      throw new Error('Clipboard writes require the optional clipboardWrite permission.');
    }

    await navigator.clipboard.writeText(text);
  };
  const graph: GraphRuntime = {
    regex,
    readClipboard,
    readSource: async (source) => {
      if (source === 'clipboard') {
        return { type: 'string', value: await readClipboard() };
      }

      return undefined;
    },
    loadSessionValue: async (key) => {
      const chromeApi = getChromeApi();
      if (!chromeApi.storage?.local) {
        const stored = globalThis.localStorage?.getItem(`url-alchemist-session:${key}`);
        return stored ? JSON.parse(stored) : undefined;
      }

      const stored = await chromeApi.storage.local.get(`url-alchemist-session:${key}`);
      return stored[`url-alchemist-session:${key}`] as Awaited<ReturnType<NonNullable<GraphRuntime['loadSessionValue']>>>;
    },
    saveSessionValue: async (key, value) => {
      const chromeApi = getChromeApi();
      if (!chromeApi.storage?.local) {
        globalThis.localStorage?.setItem(`url-alchemist-session:${key}`, JSON.stringify(value));
        return;
      }

      await chromeApi.storage.local.set({ [`url-alchemist-session:${key}`]: value });
    },
    writeDestination: async (destination, value) => {
      if (destination === 'clipboard') {
        await writeClipboard(typeof value.value === 'string' ? value.value : JSON.stringify(value.value));
      }
    },
  };

  return {
    graph,
    legacy: {
      regex,
      readClipboard,
    },
  };
}

function App() {
  const { state, setState, loading } = useStoredExtensionState();
  const [activeTab, setActiveTab] = useState<OptionsTab>('bundled');
  const [workspace, setWorkspace] = useState<WorkspaceFileV2>(() => createDefaultWorkspace());
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
  const [undoStack, setUndoStack] = useState<WorkspaceFileV2[]>([]);
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
  const [workspaceToast, setWorkspaceToast] = useState<string | null>(null);
  const [exampleMessage, setExampleMessage] = useState<string | null>(null);
  const [stagedPack, setStagedPack] = useState<CompiledActionPackV2 | null>(null);
  const [stagedChecksum, setStagedChecksum] = useState<string | undefined>(undefined);
  const [sandboxInput, setSandboxInput] = useState('');
  const [sandboxOutput, setSandboxOutput] = useState('');
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [hasSandboxRun, setHasSandboxRun] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [clipboardGranted, setClipboardGranted] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [builderUuidInput, setBuilderUuidInput] = useState('');
  const [builderUuidMessage, setBuilderUuidMessage] = useState<string | null>(null);
  const [resourceAssets, setResourceAssets] = useState<AssetRef[]>([]);
  const [ollamaPrompt, setOllamaPrompt] = useState('');
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const [ollamaMessage, setOllamaMessage] = useState<string | null>(null);
  const [ollamaModels, setOllamaModels] = useState<OllamaModelSummary[]>([]);
  const [ollamaModelsBusy, setOllamaModelsBusy] = useState(false);
  const [ollamaModelsMessage, setOllamaModelsMessage] = useState<string | null>(null);
  const [pendingOllamaDraft, setPendingOllamaDraft] = useState<{
    recipe: OllamaWorkspaceDraft;
    preview: OllamaWorkspaceDraftPreview;
    sourceWorkspaceFingerprint: string;
  } | null>(null);
  const builderUuidFileInputRef = useRef<HTMLInputElement | null>(null);
  const backupFileInputRef = useRef<HTMLInputElement | null>(null);
  const runtimesRef = useRef(createOptionsRuntimes(state.settings));
  const stagedValidationErrors = getPackImportValidationErrors(stagedPack, state.actionPacksV2);
  const currentWorkspaceFingerprint = useMemo(() => JSON.stringify(workspace), [workspace]);
  const pendingOllamaDraftIsStale = Boolean(
    pendingOllamaDraft && pendingOllamaDraft.sourceWorkspaceFingerprint !== currentWorkspaceFingerprint,
  );

  async function refreshResources(): Promise<void> {
    setResourceAssets((await listResources()).map(resourceToAssetRef));
  }

  useEffect(() => {
    if (!workspaceToast) {
      return undefined;
    }

    const timeout = window.setTimeout(() => setWorkspaceToast(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [workspaceToast]);

  useEffect(() => {
    void refreshResources().catch((error) => {
      setWorkspaceMessage(error instanceof Error ? error.message : 'Unable to load local resources.');
    });
  }, []);
  const installedExamplePackIds = useMemo(() => new Set(state.actionPacksV2.map((pack) => pack.manifest.id)), [state.actionPacksV2]);
  const savedExampleWorkspaceIds = useMemo(() => new Set(state.workspacesV2.map((savedWorkspace) => savedWorkspace.metadata.id)), [state.workspacesV2]);
  const conditionWorkspaces = useMemo(() => {
    const byId = new Map(state.workspacesV2.map((savedWorkspace) => [savedWorkspace.metadata.id, savedWorkspace]));
    byId.set(workspace.metadata.id, workspace);
    return Array.from(byId.values());
  }, [state.workspacesV2, workspace]);

  function workspaceWithEmbeddedCustomBlocks(targetWorkspace: WorkspaceFileV2): WorkspaceFileV2 {
    const nodes = [
      ...targetWorkspace.nodes,
      ...(targetWorkspace.surfaces ?? []).flatMap((surface) => surface.nodes),
    ];
    const referencedIds = Array.from(new Set(nodes
      .filter((node) => node.type === 'CustomBlock' && node.settings.customBlockId)
      .map((node) => node.settings.customBlockId!)));
    if (referencedIds.length === 0) {
      return {
        ...targetWorkspace,
        embeddedCustomBlocks: targetWorkspace.embeddedCustomBlocks,
      };
    }

    const existing = new Map((targetWorkspace.embeddedCustomBlocks ?? []).map((entry) => [`${entry.blockId}:${entry.version}`, entry]));
    const embeddedCustomBlocks: WorkspaceEmbeddedCustomBlock[] = referencedIds.flatMap((blockId): WorkspaceEmbeddedCustomBlock[] => {
      const workspaceLocal = (targetWorkspace.embeddedCustomBlocks ?? []).filter((entry) => entry.blockId === blockId && entry.useEmbedded);
      if (workspaceLocal.length > 0) {
        const installed = state.customBlocksV2.find((block) => block.blockId === blockId);
        return workspaceLocal.map((entry) => ({
          ...entry,
          installedVersion: installed?.version ?? entry.installedVersion,
          useEmbedded: true,
        }));
      }
      const installed = state.customBlocksV2.find((block) => block.blockId === blockId);
      if (!installed?.sourceWorkspace) {
        return [];
      }
      const key = `${installed.blockId}:${installed.version}`;
      return [{
        ...existing.get(key),
        blockId: installed.blockId,
        version: installed.version,
        checksumHex: installed.sourceChecksumHex,
        workspace: installed.sourceWorkspace,
        installedVersion: installed.version,
        useEmbedded: false,
      }];
    });

    return {
      ...targetWorkspace,
      embeddedCustomBlocks,
    };
  }

  async function installEmbeddedCustomBlocksFromWorkspace(importedWorkspace: WorkspaceFileV2): Promise<WorkspaceFileV2> {
    const embedded = importedWorkspace.embeddedCustomBlocks ?? [];
    if (embedded.length === 0) {
      return importedWorkspace;
    }

    let nextWorkspace = importedWorkspace;
    for (const entry of embedded) {
      const installed = state.customBlocksV2.find((block) => block.blockId === entry.blockId);
      let shouldInstall = false;
      if (installed) {
        if (installed.version === entry.version) {
          continue;
        }
        shouldInstall = window.confirm(`Custom Block "${entry.blockId}" is installed at version ${installed.version}. Update to embedded version ${entry.version}? Cancel uses the embedded version only for this workspace.`);
        if (!shouldInstall) {
          nextWorkspace = {
            ...nextWorkspace,
            embeddedCustomBlocks: (nextWorkspace.embeddedCustomBlocks ?? []).map((candidate) => (
              candidate.blockId === entry.blockId && candidate.version === entry.version
                ? { ...candidate, installedVersion: installed.version, useEmbedded: true }
                : candidate
            )),
          };
          continue;
        }
      } else {
        shouldInstall = window.confirm(`Install embedded Custom Block "${entry.blockId}" version ${entry.version}? The imported workspace is blocked until this block is installed.`);
      }
      if (!shouldInstall) {
        continue;
      }

      const result = compileWorkspace(entry.workspace, {
        builderUuid: state.settings.builderUuid,
        conditionWorkspaces: [entry.workspace],
        customBlocks: state.customBlocksV2,
      });
      if (result.ok && result.customBlock) {
        await applyState(upsertWorkspaceV2(result.workspace));
        await applyState(upsertCustomBlockV2(result.customBlock));
        nextWorkspace = {
          ...nextWorkspace,
          embeddedCustomBlocks: (nextWorkspace.embeddedCustomBlocks ?? []).map((candidate) => (
            candidate.blockId === entry.blockId && candidate.version === entry.version
              ? { ...candidate, installedVersion: entry.version, useEmbedded: false }
              : candidate
          )),
        };
      } else {
        setImportError(result.validation.errors.join('\n') || `Embedded Custom Block "${entry.blockId}" did not compile.`);
      }
    }

    return nextWorkspace;
  }

  const customBlocksForWorkspace = useCallback((targetWorkspace: WorkspaceFileV2): { customBlocks: CompiledCustomBlockV2[]; errors: string[] } => {
    const byId = new Map(state.customBlocksV2.map((block) => [block.blockId, block]));
    const pending = [...(targetWorkspace.embeddedCustomBlocks ?? []).filter((entry) => entry.useEmbedded)];
    const errors = new Map<string, string>();

    while (pending.length > 0) {
      let progressed = false;
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const entry = pending[index];
        const result = compileWorkspace(entry.workspace, {
          builderUuid: state.settings.builderUuid,
          conditionWorkspaces: [...conditionWorkspaces, entry.workspace],
          customBlocks: Array.from(byId.values()),
        });
        if (result.ok && result.customBlock) {
          byId.set(result.customBlock.blockId, {
            ...result.customBlock,
            sourceChecksumHex: entry.checksumHex ?? result.customBlock.sourceChecksumHex,
          });
          pending.splice(index, 1);
          errors.delete(`${entry.blockId}:${entry.version}`);
          progressed = true;
        } else {
          errors.set(`${entry.blockId}:${entry.version}`, result.validation.errors.join('; ') || `Embedded Custom Block "${entry.blockId}" did not compile.`);
        }
      }

      if (!progressed) {
        break;
      }
    }

    return {
      customBlocks: Array.from(byId.values()),
      errors: Array.from(errors.values()),
    };
  }, [conditionWorkspaces, state.customBlocksV2, state.settings.builderUuid]);

  const compileWithConditions = useCallback((targetWorkspace: WorkspaceFileV2) => {
    const byId = new Map(conditionWorkspaces.map((candidate) => [candidate.metadata.id, candidate]));
    byId.set(targetWorkspace.metadata.id, targetWorkspace);
    const localCustomBlocks = customBlocksForWorkspace(targetWorkspace);
    const result = compileWorkspace(targetWorkspace, {
      builderUuid: state.settings.builderUuid,
      conditionWorkspaces: Array.from(byId.values()),
      customBlocks: localCustomBlocks.customBlocks,
    });
    if (localCustomBlocks.errors.length === 0) {
      return result;
    }
    const validation = {
      ...result.validation,
      valid: false,
      errors: Array.from(new Set([...result.validation.errors, ...localCustomBlocks.errors])),
    };
    return {
      ...result,
      ok: false as const,
      workspace: {
        ...result.workspace,
        validationState: validation,
      },
      validation,
    };
  }, [conditionWorkspaces, customBlocksForWorkspace, state.settings.builderUuid]);
  const workspaceScopedCustomBlocks = useMemo(() => customBlocksForWorkspace(workspace).customBlocks, [customBlocksForWorkspace, workspace]);
  const compiledWorkspace = useMemo(
    () => compileWithConditions(workspace),
    [compileWithConditions, workspace],
  );

  useEffect(() => {
    runtimesRef.current = createOptionsRuntimes(state.settings);
  }, [state.settings]);

  useEffect(() => {
    if (!state.settings.ollamaEnabled) {
      return;
    }

    void refreshOllamaModels();
  }, [state.settings.ollamaEnabled, state.settings.ollamaEndpoint]);

  useEffect(() => {
    const chromeApi = getChromeApi();
    const contains = chromeApi.permissions?.contains;
    if (!contains) {
      setClipboardGranted(false);
      return;
    }

    void (async () => {
      const readGranted = await contains({ permissions: ['clipboardRead'] });
      const writeGranted = await contains({ permissions: ['clipboardWrite'] });
      setClipboardGranted(readGranted || writeGranted);
    })();
  }, []);

  useEffect(() => {
    if (loading || workspaceLoaded) {
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const draft = await loadOpenWorkspaceDraft();
      if (cancelled) {
        return;
      }

      if (draft && window.confirm(`Restore unsaved workspace draft "${draft.metadata.name}"?`)) {
        setWorkspace(draft);
        setWorkspaceDirty(true);
        setUndoStack([]);
        setWorkspaceMessage('Restored temporary open workspace draft.');
      } else {
        if (draft) {
          await clearOpenWorkspaceDraft();
        }
        setWorkspace(state.workspacesV2[0] ?? createDefaultWorkspace());
        setWorkspaceDirty(false);
        setUndoStack([]);
      }
      setWorkspaceLoaded(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, state.workspacesV2, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || !workspaceDirty) {
      return undefined;
    }

    const timeout = window.setTimeout(() => {
      void saveOpenWorkspaceDraft(workspace);
    }, 1_500);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [workspace, workspaceDirty, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceLoaded || !workspaceDirty) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      void saveOpenWorkspaceDraft(workspace);
    }, 15_000);

    return () => {
      window.clearInterval(interval);
    };
  }, [workspace, workspaceDirty, workspaceLoaded]);

  useEffect(() => {
    if (!workspaceDirty) {
      return undefined;
    }

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [workspaceDirty]);

  useEffect(() => {
    document.documentElement.style.setProperty('--url-alchemist-ui-scale', String(normalizeUiScale(state.settings.uiScale) / 100));
  }, [state.settings.uiScale]);

  useEffect(() => {
    if (!stagedPack || !sandboxInput.trim()) {
      setSandboxOutput('');
      setSandboxError(null);
      return undefined;
    }

    let cancelled = false;
    void executeCompiledActionPackV2(
      sandboxInput,
      stagedPack,
      createSandboxGraphRuntime(runtimesRef.current.graph),
      state.settings,
    )
      .then((result) => {
        if (cancelled) {
          return;
        }

        setSandboxOutput(result.finalUrl);
        setSandboxError(result.issues[0]?.message ?? null);
        setHasSandboxRun(true);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }

        setSandboxOutput('');
        setSandboxError(error instanceof Error ? error.message : 'Sandbox execution failed');
      });

    return () => {
      cancelled = true;
    };
  }, [sandboxInput, stagedPack, state.settings]);

  async function applyState(nextStatePromise: Promise<StoredState>): Promise<void> {
    const nextState = await nextStatePromise;
    setState(nextState);
  }

  function pushUndoSnapshot(snapshot: WorkspaceFileV2): void {
    const limit = Math.max(0, Math.min(10_000, Math.trunc(state.settings.undoHistoryLimit ?? 100)));
    if (limit <= 0) {
      return;
    }
    const copy = structuredClone(snapshot);
    setUndoStack((current) => [...current, copy].slice(-limit));
  }

  function undoWorkspaceChange(): void {
    const previous = undoStack[undoStack.length - 1];
    if (!previous) {
      return;
    }
    setUndoStack((current) => current.slice(0, -1));
    setWorkspace(previous);
    setWorkspaceDirty(true);
    setWorkspaceMessage('Undid the last workspace edit.');
    void saveOpenWorkspaceDraft(previous);
  }

  function handleWorkspaceChange(nextWorkspace: WorkspaceFileV2, options: WorkspaceChangeOptions = {}): void {
    setWorkspace(nextWorkspace);
    setWorkspaceMessage(null);

    if (options.viewportOnly) {
      if (workspaceDirty) {
        void saveOpenWorkspaceDraft(nextWorkspace);
      }
      if (state.workspacesV2.some((savedWorkspace) => savedWorkspace.metadata.id === nextWorkspace.metadata.id)) {
        void applyState(updateWorkspaceV2Viewport(nextWorkspace.metadata.id, nextWorkspace.viewport));
      }
      return;
    }

    if (nextWorkspace !== workspace) {
      pushUndoSnapshot(workspace);
    }
    setWorkspaceDirty(true);
  }

  function confirmDiscardDirtyChanges(): boolean {
    return !workspaceDirty || window.confirm('You have unsaved workspace changes. Discard them?');
  }

  function switchWorkspace(workspaceId: string): void {
    if (!confirmDiscardDirtyChanges()) {
      return;
    }

    const savedWorkspace = state.workspacesV2.find((candidate) => candidate.metadata.id === workspaceId);
    if (!savedWorkspace) {
      return;
    }

    setWorkspace(savedWorkspace);
    setWorkspaceDirty(false);
    setUndoStack([]);
    setWorkspaceMessage(`Opened workspace "${savedWorkspace.metadata.name}".`);
    void clearOpenWorkspaceDraft();
  }

  function newWorkspace(type: WorkspaceType = 'data-modifier'): void {
    if (!confirmDiscardDirtyChanges()) {
      return;
    }

    const nextWorkspace = type === 'content-blocker'
      ? createDefaultContentBlockerWorkspace()
      : type === 'custom-block'
        ? createDefaultCustomBlockWorkspace()
        : createDefaultWorkspace();
    setWorkspace(nextWorkspace);
    setWorkspaceDirty(false);
    setUndoStack([]);
    setWorkspaceMessage(`Started a new ${type === 'content-blocker' ? 'Content Blocker' : type === 'custom-block' ? 'Custom Block' : 'Data Modifier'} workspace.`);
    void clearOpenWorkspaceDraft();
  }

  async function requestClipboardPermission(): Promise<void> {
    const chromeApi = getChromeApi();
    if (!chromeApi.permissions?.request) {
      setClipboardGranted(false);
      return;
    }

    const readGranted = await chromeApi.permissions.request({ permissions: ['clipboardRead'] });
    const writeGranted = await chromeApi.permissions.request({ permissions: ['clipboardWrite'] });
    setClipboardGranted(readGranted || writeGranted);
  }

  async function saveWorkspace(): Promise<void> {
    const savedWorkspace = { ...workspace, validationState: compiledWorkspace.validation };
    await applyState(upsertWorkspaceV2(savedWorkspace));
    setWorkspace(savedWorkspace);
    setWorkspaceDirty(false);
    setUndoStack([]);
    await clearOpenWorkspaceDraft();
    setWorkspaceMessage(`Saved workspace "${workspace.metadata.name}".`);
  }

  async function storeLocalResource(file: File): Promise<AssetRef> {
    const asset = await putResourceBytes(new Uint8Array(await file.arrayBuffer()), {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      kind: inferAssetKind(file.type || ''),
    });
    await refreshResources();
    return asset;
  }

  async function uploadWorkspaceResource(file: File): Promise<AssetRef> {
    const asset = await storeLocalResource(file);
    pushUndoSnapshot(workspace);
    setWorkspace((current) => ({
      ...current,
      assets: [
        ...(current.assets ?? []).filter((candidate) => (candidate.resourceId ?? candidate.sha256) !== (asset.resourceId ?? asset.sha256)),
        asset,
      ],
      metadata: {
        ...current.metadata,
        updated_at: Date.now(),
      },
    }));
    setWorkspaceDirty(true);
    return asset;
  }

  async function authorizeLockedActionPack(pack: CompiledActionPackV2, actionLabel: string): Promise<boolean> {
    const lockState = pack.install?.lockState;
    if (!lockState?.locked || lockState.level === 0) {
      return true;
    }

    if (lockState.level === 3) {
      window.alert(`Level 3 locks have no in-app ${actionLabel} path. Browser extension removal or browser profile tampering remains the practical bypass.`);
      return false;
    }

    if (lockState.level === 1) {
      const challenge = lockState.challengeText ?? `UNLOCK ${pack.manifest.name}`;
      if (window.prompt(`Type this challenge exactly: ${challenge}`) !== challenge) {
        setWorkspaceMessage('Level 1 challenge did not match.');
        return false;
      }
      for (let index = 0; index < 3; index += 1) {
        if (!window.confirm(`Confirm ${actionLabel} ${index + 1} of 3 for "${pack.manifest.name}".`)) {
          setWorkspaceMessage(`Level 1 ${actionLabel} cancelled.`);
          return false;
        }
      }
      setWorkspaceMessage(`Level 1 ${actionLabel} delay started. Keep this page active.`);
      await new Promise((resolve) => window.setTimeout(resolve, 10_000));
      if (document.hidden) {
        setWorkspaceMessage(`Level 1 ${actionLabel} reset because the page was left during the delay.`);
        return false;
      }
      return true;
    }

    const password = window.prompt(`Enter password for "${pack.manifest.name}".`);
    if (!password || !(await verifyPasswordLock(lockState, password))) {
      setWorkspaceMessage('Level 2 password verification failed.');
      return false;
    }
    return true;
  }

  async function lockStateFromLevel(packName: string, level: ActionPackLockLevel): Promise<ActionPackLockState | undefined> {
    const note = 'Extension-local lock. Extension removal or browser profile tampering can bypass it.';
    if (level === 0) {
      return undefined;
    }
    if (level === 2) {
      const password = window.prompt(`Create a password for "${packName}". Level 2 passwords must be at least 8 characters.`);
      if (!password) {
        throw new Error('Level 2 lock installation requires a password.');
      }
      return await createPasswordLockState(password, note);
    }
    return createChallengeLockState(packName, level, note);
  }

  async function buildActionPackFromWorkspace(targetWorkspace: WorkspaceFileV2): Promise<void> {
    const buildWorkspace = workspaceWithEmbeddedCustomBlocks(targetWorkspace);
    const result = compileWithConditions(buildWorkspace);
    if (!result.ok || (!result.pack && !result.customBlock)) {
      setWorkspaceMessage(targetWorkspace.workspaceType === 'custom-block' ? 'Fix custom block validation before installing it.' : 'Fix workspace validation before building an Action Pack.');
      return;
    }

    if (targetWorkspace.workspaceType === 'custom-block' && result.customBlock) {
      await applyState(upsertWorkspaceV2(result.workspace));
      await applyState(upsertCustomBlockV2(result.customBlock));
      setWorkspace(result.workspace);
      setWorkspaceDirty(false);
      await clearOpenWorkspaceDraft();
      setWorkspaceMessage(`Installed Custom Block "${result.customBlock.label}".`);
      setWorkspaceToast(`Installed Custom Block "${result.customBlock.label}".`);
      return;
    }

    try {
      if (!result.pack) {
        setWorkspaceMessage('Fix workspace validation before building an Action Pack.');
        return;
      }
      const isContentBlocker = result.workspace.workspaceType === 'content-blocker' || isContentBlockerActionPack(result.pack);
      const existingPack = state.actionPacksV2.find((candidate) => candidate.manifest.id === result.pack!.manifest.id);
      let allowLockedOverwrite = false;
      if (isContentBlocker && existingPack && isActionPackLocked(existingPack)) {
        allowLockedOverwrite = await authorizeLockedActionPack(existingPack, 'overwrite');
        if (!allowLockedOverwrite) {
          return;
        }
      }

      const lockState = isContentBlocker
        ? await lockStateFromLevel(result.pack.manifest.name, result.workspace.contentBlocker?.lockLevel ?? 0)
        : undefined;
      const pack = withInstallMetadata(result.pack, state.settings, {
        source: isContentBlocker ? 'content-blocker' : 'user-created',
        trustStatus: 'trusted',
        loggingEnabled: isContentBlocker ? true : state.settings.defaultActionPackLoggingEnabled,
        lockState,
        contentBlocker: result.pack.install?.contentBlocker,
      });
      await applyState(upsertWorkspaceV2(result.workspace));
      await applyState(upsertActionPackV2(pack, { allowLockedOverwrite }));
    } catch (error) {
      setWorkspaceMessage(error instanceof Error ? error.message : 'Unable to build Action Pack.');
      return;
    }

    if (workspace.metadata.id === targetWorkspace.metadata.id) {
      setWorkspace(result.workspace);
      setWorkspaceDirty(false);
      await clearOpenWorkspaceDraft();
    }
    setWorkspaceMessage(`Built and installed "${result.pack.manifest.name}".`);
    setWorkspaceToast(`Built and installed "${result.pack.manifest.name}".`);
  }

  async function buildActionPack(): Promise<void> {
    await buildActionPackFromWorkspace(workspace);
  }

  async function runOllamaBuilder(): Promise<void> {
    if (!state.settings.ollamaEnabled) {
      setOllamaMessage('Enable AI Connectors in Settings first.');
      return;
    }
    if (!state.settings.ollamaModel || !ollamaModels.some((model) => model.name === state.settings.ollamaModel)) {
      setOllamaMessage('Refresh AI Connectors and choose an installed Ollama model before drafting.');
      return;
    }
    if (!ollamaPrompt.trim()) {
      setOllamaMessage('Enter a workspace request first.');
      return;
    }
    if (workspace.workspaceType === 'content-blocker') {
      setOllamaMessage('AI workspace drafting currently supports data-modifier and custom-block workspaces, not content blockers.');
      return;
    }

    setOllamaBusy(true);
    setOllamaMessage(null);
    setPendingOllamaDraft(null);
    try {
      const sourceWorkspaceFingerprint = currentWorkspaceFingerprint;
      const draft = await requestOllamaWorkspaceDraft(state.settings, ollamaPrompt, workspace);
      const preview = previewOllamaWorkspaceDraft(draft, workspace);
      setPendingOllamaDraft({ recipe: draft, preview, sourceWorkspaceFingerprint });
      setOllamaMessage('AI Connectors draft is ready for review.');
    } catch (error) {
      setOllamaMessage(error instanceof Error ? error.message : 'AI Connectors drafting failed.');
    } finally {
      setOllamaBusy(false);
    }
  }

  async function refreshOllamaModels(): Promise<void> {
    setOllamaModelsBusy(true);
    setOllamaModelsMessage(null);
    try {
      const models = await listOllamaModels(state.settings);
      setOllamaModels(models);
      if (models.length > 0) {
        const modelNames = models.map((model) => model.name);
        const nextModel = modelNames.includes(state.settings.ollamaModel) ? state.settings.ollamaModel : modelNames[0];
        if (nextModel !== state.settings.ollamaModel) {
          await applyState(updateSettings({ ollamaModel: nextModel }));
        }
        setOllamaModelsMessage(`Found ${models.length} installed Ollama model${models.length === 1 ? '' : 's'}.`);
      } else {
        if (state.settings.ollamaModel) {
          await applyState(updateSettings({ ollamaModel: '' }));
        }
        setOllamaModelsMessage('No installed Ollama models were returned by the local server. Drafting is disabled until a model is installed.');
      }
    } catch (error) {
      setOllamaModels([]);
      setOllamaModelsMessage(error instanceof Error ? error.message : 'Unable to reach the local Ollama server.');
    } finally {
      setOllamaModelsBusy(false);
    }
  }

  function applyOllamaDraft(): void {
    if (!pendingOllamaDraft) {
      return;
    }
    if (pendingOllamaDraft.sourceWorkspaceFingerprint !== currentWorkspaceFingerprint) {
      setPendingOllamaDraft(null);
      setOllamaMessage('The open workspace changed after this draft was requested. The stale draft was discarded; draft again from the current graph.');
      return;
    }

    const nextWorkspace = pendingOllamaDraft.preview.workspace;
    pushUndoSnapshot(workspace);
    setWorkspace(nextWorkspace);
    setWorkspaceDirty(true);
    setPendingOllamaDraft(null);
    setOllamaMessage('Applied AI Connectors draft to the open workspace.');
  }

  async function exportWorkspaceFile(targetWorkspace = workspace): Promise<void> {
    const exportWorkspace = workspaceWithEmbeddedCustomBlocks(targetWorkspace);
    const result = compileWithConditions(exportWorkspace);
    await downloadBytes(
      await exportWorkspaceBinary({ ...exportWorkspace, validationState: result.validation }),
      `workspaces/${slugify(exportWorkspace.metadata.name) || 'workspace'}.workspace`,
    );
  }

  async function exportActionPackFromWorkspace(targetWorkspace = workspace): Promise<void> {
    if (targetWorkspace.workspaceType === 'content-blocker') {
      setWorkspaceMessage('Content Blocker Action Packs install locally. Export the .workspace source and compile it locally instead.');
      return;
    }
    if (targetWorkspace.workspaceType === 'custom-block') {
      setWorkspaceMessage('Custom Blocks install locally from workspace source. Export the .workspace source instead.');
      return;
    }

    const result = compileWithConditions(workspaceWithEmbeddedCustomBlocks(targetWorkspace));
    if (!result.ok || !result.pack) {
      setWorkspaceMessage('Fix workspace validation before exporting an Action Pack.');
      return;
    }

    await downloadBytes(
      await exportCompiledActionPackV2Binary(result.pack),
      `action-packs/${slugify(result.pack.manifest.name) || 'action-pack'}.actionpack`,
    );
  }

  async function exportInstalledActionPack(pack: CompiledActionPackV2): Promise<void> {
    try {
      await downloadBytes(
        await exportCompiledActionPackV2Binary(pack),
        `action-packs/${slugify(pack.manifest.name) || 'action-pack'}.actionpack`,
      );
    } catch (error) {
      setWorkspaceMessage(error instanceof Error ? error.message : 'Unable to export this Action Pack.');
    }
  }

  async function exportInstalledActionPackLog(pack: CompiledActionPackV2): Promise<void> {
    const entries = state.actionPackLogs.filter((entry) => entry.packId === pack.manifest.id);
    await downloadText(
      formatActionPackLogText(pack.manifest.name, entries),
      `logs/${slugify(pack.manifest.name) || 'action-pack'}.log.txt`,
    );
  }

  async function clearInstalledActionPackLog(pack: CompiledActionPackV2): Promise<void> {
    const entries = state.actionPackLogs.filter((entry) => entry.packId === pack.manifest.id);
    if (entries.length === 0) {
      return;
    }

    if (!window.confirm(`Clear ${entries.length} stored log entries for "${pack.manifest.name}"?`)) {
      return;
    }

    await applyState(clearActionPackLog(pack.manifest.id));
  }

  async function exportBuilderUuid(): Promise<void> {
    await downloadText(
      `URL_ALCHEMIST_BUILDER_UUID=${state.settings.builderUuid}\n`,
      'url-alchemist-builder-uuid.txt',
    );
  }

  async function restoreBuilderUuid(rawValue: string): Promise<void> {
    const builderUuid = parseBuilderUuid(rawValue);
    if (!builderUuid) {
      setBuilderUuidMessage('Enter a valid UUID or upload the UUID file exported by this extension.');
      return;
    }

    await applyState(updateSettings({ builderUuid }));
    setBuilderUuidInput('');
    setBuilderUuidMessage(`Restored builder UUID ${builderUuid}.`);
  }

  async function handleBuilderUuidFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    await restoreBuilderUuid(await file.text());
    event.target.value = '';
  }

  async function openBundledWorkspace(example: BundledActionPackExample): Promise<void> {
    try {
      const imported = await importWorkspaceBinary(await fetchVerifiedBundledArtifact(example, 'workspace'));
      setWorkspace(imported.workspace);
      setWorkspaceDirty(false);
      setUndoStack([]);
      await applyState(upsertWorkspaceV2(imported.workspace));
      await clearOpenWorkspaceDraft();
      setActiveTab('workspace-editor');
      setWorkspaceMessage(`Opened bundled workspace "${imported.workspace.metadata.name}".`);
      setExampleMessage(`Opened "${example.name}" in Workspace Editor.`);
    } catch (error) {
      setExampleMessage(error instanceof Error ? error.message : `Unable to open "${example.name}".`);
    }
  }

  async function installBundledActionPack(example: BundledActionPackExample): Promise<void> {
    try {
      const imported = await importCompiledActionPackV2Binary(await fetchVerifiedBundledArtifact(example, 'action-pack'));
      await applyState(upsertActionPackV2(withInstallMetadata(imported.pack, state.settings, {
        source: 'bundled',
        trustStatus: 'trusted',
        bundledHashVerified: true,
        artifactChecksumHex: imported.checksumHex,
      })));
      setExampleMessage(`Installed bundled Action Pack "${imported.pack.manifest.name}".`);
    } catch (error) {
      setExampleMessage(error instanceof Error ? error.message : `Unable to install "${example.name}".`);
    }
  }

  async function deleteBundledWorkspace(example: BundledActionPackExample): Promise<void> {
    if (!window.confirm(`Delete installed workspace "${example.name}"?`)) {
      return;
    }

    await applyState(deleteWorkspaceV2(example.id));
    setExampleMessage(`Deleted installed workspace "${example.name}".`);
  }

  async function deleteBundledActionPack(example: BundledActionPackExample): Promise<void> {
    if (!window.confirm(`Delete installed Action Pack "${example.name}"?`)) {
      return;
    }

    await applyState(deleteActionPackV2(example.id));
    setExampleMessage(`Deleted installed Action Pack "${example.name}".`);
  }

  async function downloadBundledWorkspace(example: BundledActionPackExample): Promise<void> {
    try {
      await downloadBytes(await fetchVerifiedBundledArtifact(example, 'workspace'), `workspaces/${example.slug}.workspace`);
    } catch (error) {
      setExampleMessage(error instanceof Error ? error.message : `Unable to export "${example.name}" workspace.`);
    }
  }

  async function downloadBundledActionPack(example: BundledActionPackExample): Promise<void> {
    try {
      await downloadBytes(await fetchVerifiedBundledArtifact(example, 'action-pack'), `action-packs/${example.slug}.actionpack`);
    } catch (error) {
      setExampleMessage(error instanceof Error ? error.message : `Unable to export "${example.name}" Action Pack.`);
    }
  }

  async function handleFileSelection(file: File): Promise<void> {
    setImportBusy(true);
    setImportError(null);
    setStagedPack(null);
    setStagedChecksum(undefined);
    setSandboxInput('');
    setSandboxOutput('');
    setSandboxError(null);
    setHasSandboxRun(false);
    setReviewAcknowledged(false);

    try {
      if (file.size > MAX_ACTION_PACK_BINARY_BYTES) {
        throw new Error('Files larger than 128 MB are rejected');
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const artifact = await importAnyArtifact(bytes);

      if (artifact.kind === 'workspace') {
        const importedWorkspace = await installEmbeddedCustomBlocksFromWorkspace(artifact.workspace);
        setWorkspace(importedWorkspace);
        setWorkspaceDirty(false);
        setUndoStack([]);
        await applyState(upsertWorkspaceV2(importedWorkspace));
        await clearOpenWorkspaceDraft();
        setActiveTab('workspace-editor');
        setWorkspaceMessage(`Opened workspace "${importedWorkspace.metadata.name}".`);
        return;
      }

      if (artifact.kind === 'action-pack') {
        setStagedPack(withInstallMetadata(artifact.pack, state.settings, {
          source: 'imported',
          trustStatus: artifact.pack.risk.highest === 'high' ? 'blocked' : 'review',
          artifactChecksumHex: artifact.checksumHex,
        }));
        setStagedChecksum(artifact.checksumHex);
        return;
      }

      const convertedWorkspace = workspaceFromLegacyPack(artifact.pack);
      const result = compileWithConditions(convertedWorkspace);
      setWorkspace(result.workspace);
      setWorkspaceDirty(false);
      setUndoStack([]);
      await applyState(upsertWorkspaceV2(result.workspace));
      setActiveTab('workspace-editor');
      if (result.pack) {
        setStagedPack(withInstallMetadata(result.pack, state.settings, {
          source: 'legacy-converted',
          trustStatus: result.pack.risk.highest === 'high' ? 'review' : 'trusted',
          artifactChecksumHex: artifact.checksumHex,
        }));
        setStagedChecksum(artifact.checksumHex);
      }
      setWorkspaceMessage(`Converted v1 pack "${artifact.pack.name}" into an editable workspace.`);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Unable to import this file');
    } finally {
      setImportBusy(false);
    }
  }

  async function handleImportChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    await handleFileSelection(file);
    event.target.value = '';
  }

  async function handleDrop(event: DragEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) {
      await handleFileSelection(file);
    }
  }

  async function confirmImport(): Promise<void> {
    if (!stagedPack || stagedValidationErrors.length > 0) {
      return;
    }

    await applyState(upsertActionPackV2({
      ...stagedPack,
      install: {
        ...stagedPack.install,
        source: stagedPack.install?.source ?? 'imported',
        trustStatus: reviewAcknowledged ? 'user-reviewed' : stagedPack.install?.trustStatus ?? 'review',
        loggingEnabled: stagedPack.install?.loggingEnabled ?? state.settings.defaultActionPackLoggingEnabled,
        installedAt: Date.now(),
      },
    }));
    setStagedPack(null);
    setStagedChecksum(undefined);
    setSandboxInput('');
    setSandboxOutput('');
    setSandboxError(null);
    setHasSandboxRun(false);
    setReviewAcknowledged(false);
  }

  async function toggleV2Pack(pack: CompiledActionPackV2): Promise<void> {
    if (isActionPackLocked(pack)) {
      setWorkspaceMessage('Locked Action Packs must be unlocked before they can be disabled.');
      return;
    }

    await applyState(
      upsertActionPackV2({
        ...pack,
        manifest: {
          ...pack.manifest,
          enabled: !pack.manifest.enabled,
        },
      }),
    );
  }

  async function deleteV2Pack(packId: string): Promise<void> {
    const pack = state.actionPacksV2.find((candidate) => candidate.manifest.id === packId);
    if (pack && isActionPackLocked(pack)) {
      setWorkspaceMessage('Locked Action Packs must be unlocked before they can be deleted.');
      return;
    }

    if (!window.confirm('Delete this Action Pack?')) {
      return;
    }

    await applyState(deleteActionPackV2(packId));
  }

  async function deleteWorkspace(workspaceId: string): Promise<void> {
    if (!window.confirm('Delete this workspace? The paired Action Pack, if any, will remain installed.')) {
      return;
    }

    await applyState(deleteWorkspaceV2(workspaceId));
    if (workspace.metadata.id === workspaceId) {
      setWorkspace(createDefaultWorkspace());
      setWorkspaceDirty(false);
      setUndoStack([]);
      await clearOpenWorkspaceDraft();
    }
  }

  async function updateWorkspaceMetadata(workspaceId: string, metadata: Partial<WorkspaceMetadata>): Promise<void> {
    const savedWorkspace = state.workspacesV2.find((candidate) => candidate.metadata.id === workspaceId);
    if (!savedWorkspace) {
      return;
    }

    const nextWorkspace: WorkspaceFileV2 = {
      ...savedWorkspace,
      metadata: {
        ...savedWorkspace.metadata,
        ...metadata,
        updated_at: Date.now(),
      },
    };
    await applyState(upsertWorkspaceV2(nextWorkspace));
    if (workspace.metadata.id === workspaceId) {
      setWorkspace((current) => ({
        ...current,
        metadata: nextWorkspace.metadata,
      }));
    }
  }

  async function deleteLegacyPack(packId: string): Promise<void> {
    if (!window.confirm('Delete this legacy URL pack?')) {
      return;
    }

    await applyState(deletePack(packId));
  }

  async function enableTraceForPack(pack: CompiledActionPackV2): Promise<void> {
    await applyState(updateActionPackV2Trace(pack.manifest.id, Date.now() + 24 * 60 * 60 * 1000));
  }

  async function disableTraceForPack(pack: CompiledActionPackV2): Promise<void> {
    await applyState(updateActionPackV2Trace(pack.manifest.id, 0));
  }

  async function toggleActionPackLogging(pack: CompiledActionPackV2): Promise<void> {
    await applyState(updateActionPackV2Install(pack.manifest.id, {
      loggingEnabled: pack.install?.loggingEnabled === false,
    }));
  }

  async function markActionPackReviewed(pack: CompiledActionPackV2): Promise<void> {
    await applyState(updateActionPackV2Install(pack.manifest.id, {
      trustStatus: 'user-reviewed',
      userReview: {
        reviewedAt: Date.now(),
        trustStatus: 'user-reviewed',
      },
    }));
  }

  async function unlockActionPack(pack: CompiledActionPackV2): Promise<void> {
    const lockState = pack.install?.lockState;
    if (!lockState?.locked || lockState.level === 0) {
      return;
    }

    if (lockState.level === 3) {
      window.alert('Level 3 locks have no in-app unlock path. Browser extension removal or browser profile tampering remains the practical bypass.');
      return;
    }

    if (lockState.level === 1) {
      const challenge = lockState.challengeText ?? `UNLOCK ${pack.manifest.name}`;
      if (window.prompt(`Type this challenge exactly: ${challenge}`) !== challenge) {
        setWorkspaceMessage('Level 1 unlock challenge did not match.');
        return;
      }
      for (let index = 0; index < 3; index += 1) {
        if (!window.confirm(`Confirm unlock ${index + 1} of 3 for "${pack.manifest.name}".`)) {
          setWorkspaceMessage('Level 1 unlock cancelled.');
          return;
        }
      }
      setWorkspaceMessage('Level 1 unlock delay started. Keep this page active.');
      await new Promise((resolve) => window.setTimeout(resolve, 10_000));
      if (document.hidden) {
        setWorkspaceMessage('Level 1 unlock reset because the page was left during the delay.');
        return;
      }
    } else if (lockState.level === 2) {
      const password = window.prompt(`Enter password for "${pack.manifest.name}".`);
      if (!password || !(await verifyPasswordLock(lockState, password))) {
        setWorkspaceMessage('Level 2 password verification failed.');
        return;
      }
    }

    await applyState(updateActionPackV2Install(pack.manifest.id, {
      lockState: unlockedLockState(lockState),
    }));
    setWorkspaceMessage(`Unlocked "${pack.manifest.name}".`);
  }

  async function increaseContentBlockerLock(pack: CompiledActionPackV2): Promise<void> {
    if (!isContentBlockerActionPack(pack) || !pack.install?.contentBlocker?.allowLockIncrease) {
      setWorkspaceMessage('This Action Pack does not allow lock increases.');
      return;
    }

    const currentLevel = pack.install?.lockState?.locked ? pack.install.lockState.level : 0;
    if (currentLevel >= 3) {
      setWorkspaceMessage('This Action Pack already has the highest lock level.');
      return;
    }

    const rawLevel = window.prompt(`Increase lock level for "${pack.manifest.name}" to 1, 2, or 3. Current level is ${currentLevel}.`);
    const nextLevel = Number.parseInt(rawLevel ?? '', 10) as ActionPackLockLevel;
    if (![1, 2, 3].includes(nextLevel) || nextLevel <= currentLevel) {
      setWorkspaceMessage('Lock increase must choose a higher level: 1, 2, or 3.');
      return;
    }

    const lockState = await lockStateFromLevel(pack.manifest.name, nextLevel);
    if (!lockState) {
      return;
    }

    await applyState(updateActionPackV2Install(pack.manifest.id, { lockState }));
    setWorkspaceMessage(`Increased lock for "${pack.manifest.name}" to level ${nextLevel}.`);
  }

  async function toggleGlobalEnabled(): Promise<void> {
    await applyState(updateSettings({ globalEnabled: !state.settings.globalEnabled }));
  }

  async function toggleLocalFiles(): Promise<void> {
    await applyState(updateSettings({ allowLocalFiles: !state.settings.allowLocalFiles }));
  }

  async function toggleAdvancedMode(): Promise<void> {
    await applyState(updateSettings({ advancedModeEnabled: !state.settings.advancedModeEnabled }));
  }

  async function toggleSyncEnabled(): Promise<void> {
    await applyState(updateSettings({ syncEnabled: !state.settings.syncEnabled }));
  }

  async function toggleDefaultLogging(): Promise<void> {
    await applyState(updateSettings({ defaultActionPackLoggingEnabled: !state.settings.defaultActionPackLoggingEnabled }));
  }

  async function updateOllamaSettings(settings: Partial<Pick<GlobalSettings, 'ollamaEnabled' | 'ollamaEndpoint' | 'ollamaModel' | 'ollamaTimeoutMs' | 'aiWorkspaceInstructions'>>): Promise<void> {
    try {
      const next: Partial<GlobalSettings> = { ...settings };
      if (settings.ollamaEndpoint !== undefined) {
        next.ollamaEndpoint = validateOllamaEndpoint(settings.ollamaEndpoint);
      }
      if (settings.aiWorkspaceInstructions !== undefined) {
        next.aiWorkspaceInstructions = normalizeAiWorkspaceInstructions(settings.aiWorkspaceInstructions);
      }
      await applyState(updateSettings(next));
      setOllamaModelsMessage(null);
    } catch (error) {
      setOllamaModelsMessage(error instanceof Error ? error.message : 'Invalid Ollama settings.');
    }
  }

  async function updateHardening(settings: Partial<GlobalSettings>): Promise<void> {
    await applyState(updateSettings(settings));
  }

  async function updateUndoHistoryLimit(value: number): Promise<void> {
    const undoHistoryLimit = Math.max(0, Math.min(10_000, Math.trunc(value)));
    await applyState(updateSettings({ undoHistoryLimit }));
    setUndoStack((current) => current.slice(-undoHistoryLimit));
  }

  async function exportBackup(): Promise<void> {
    if (state.actionPacksV2.some(isActionPackLocked)) {
      setBuilderUuidMessage('Unlock locked Action Packs before exporting or restoring a full backup.');
      return;
    }

    await downloadText(await exportBackupState(state), `url-alchemist-backup-${Date.now()}.json`);
  }

  async function restoreBackupText(text: string): Promise<void> {
    const restored = await importBackupState(text);
    await saveStoredState(restored);
    setState(restored);
    setBuilderUuidMessage('Restored backup into local storage.');
  }

  async function handleBackupFileChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      if (state.actionPacksV2.some(isActionPackLocked)) {
        throw new Error('Unlock locked Action Packs before restoring a backup.');
      }
      await restoreBackupText(await file.text());
    } catch (error) {
      setBuilderUuidMessage(error instanceof Error ? error.message : 'Unable to restore backup.');
    } finally {
      event.target.value = '';
    }
  }

  async function previewLegacyPack(pack: ActionPack): Promise<void> {
    const convertedWorkspace = workspaceFromLegacyPack(pack);
    const result = compileWithConditions(convertedWorkspace);
    setWorkspace(result.workspace);
    setWorkspaceDirty(true);
    setUndoStack([]);
    setActiveTab('workspace-editor');
    if (result.pack) {
      setStagedPack(result.pack);
      setStagedChecksum(undefined);
    }

    await simulateActionPack('https://example.com/', pack, runtimesRef.current.legacy, state.settings);
  }

  async function resetEverything(): Promise<void> {
    if (state.actionPacksV2.some(isActionPackLocked)) {
      setBuilderUuidMessage('Unlock locked Action Packs before resetting URL Alchemist.');
      return;
    }

    if (!window.confirm('This will delete all settings, workspaces, Action Packs, logs, traces, and temporary drafts. Continue?')) {
      return;
    }

    if (!window.confirm('This cannot be undone. Reset URL Alchemist to a fresh install state?')) {
      return;
    }

    await resetExtensionStorage();
    getChromeApi().runtime?.reload?.();
    window.location.reload();
  }

  const scaleStyle = {
    zoom: `${normalizeUiScale(state.settings.uiScale)}%`,
  } as CSSProperties;
  const appIconUrl = getChromeApi().runtime?.getURL?.('icons/icon-48.png') ?? '/icons/icon-48.png';

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1500px] flex-col gap-5 px-4 py-5 sm:px-6 lg:px-8 lg:py-8" style={scaleStyle}>
      {workspaceToast ? (
        <div className="fixed right-5 top-5 z-50 max-w-sm rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-800 shadow-[0_18px_42px_rgba(15,118,110,0.18)]">
          {workspaceToast}
        </div>
      ) : null}
      <header className="reveal-panel overflow-hidden rounded-xl border border-slate-200 bg-white px-4 py-5 shadow-[0_18px_46px_rgba(31,41,55,0.08)] sm:px-6 lg:px-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="flex min-w-0 max-w-3xl gap-4">
            <img
              alt="URL Alchemist"
              className="mt-1 h-11 w-11 shrink-0 rounded-lg shadow-[0_12px_24px_rgba(15,118,110,0.22)]"
              src={appIconUrl}
            />
            <div className="min-w-0">
              <p className="eyebrow">URL Alchemist Firefox {URL_ALCHEMIST_VERSION}</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Action Pack Workbench</h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
                Build workspace source files, compile optimized Action Packs, and stage binary imports through a sandboxed review flow with {REGEX_TIMEOUT_MS}ms regex budgets.
              </p>
            </div>
          </div>
          <div className="ml-auto grid min-w-[220px] gap-2 sm:grid-cols-3 lg:min-w-[430px]">
            <span className={`risk-badge ${state.settings.globalEnabled ? 'bg-teal-100 text-teal-800' : 'risk-badge-danger'}`}>
              {state.settings.globalEnabled ? 'Engine on' : 'Engine off'}
            </span>
            <span className="risk-badge risk-badge-soft">{state.actionPacksV2.length} Action Packs</span>
            <span className="risk-badge risk-badge-soft">{state.workspacesV2.length} workspaces</span>
          </div>
        </div>
      </header>

      <nav className="panel-shell tab-scroll reveal-panel sticky top-3 z-30 flex gap-2 overflow-x-auto p-2" aria-label="Options sections">
        {OPTIONS_TABS.map((tab) => (
          <button
            key={tab.id}
            className={`${activeTab === tab.id ? 'primary-button' : 'ghost-button'} flex-none`}
            type="button"
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'bundled' || activeTab === 'examples' ? (
        <>
          <BundledExamplesPanel
            collection={activeTab}
            examples={BUNDLED_ACTION_PACK_EXAMPLES}
            installedPackIds={installedExamplePackIds}
            savedWorkspaceIds={savedExampleWorkspaceIds}
            onDeleteInstalledActionPack={(example) => void deleteBundledActionPack(example)}
            onDeleteInstalledWorkspace={(example) => void deleteBundledWorkspace(example)}
            onDownloadActionPack={(example) => void downloadBundledActionPack(example)}
            onDownloadWorkspace={(example) => void downloadBundledWorkspace(example)}
            onInstallActionPack={(example) => void installBundledActionPack(example)}
            onOpenWorkspace={(example) => void openBundledWorkspace(example)}
          />
          {exampleMessage ? <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{exampleMessage}</p> : null}
        </>
      ) : null}

      {activeTab === 'manage-resources' ? (
        <ManageResourcesPanel
          actionPacks={state.actionPacksV2}
          actionPackLogs={state.actionPackLogs}
          legacyPacks={state.packs}
          workspaces={state.workspacesV2}
          onClearActionPackLog={(pack) => void clearInstalledActionPackLog(pack)}
          onCompileExportWorkspace={(targetWorkspace) => void exportActionPackFromWorkspace(targetWorkspace)}
          onCompileInstallWorkspace={(targetWorkspace) => void buildActionPackFromWorkspace(targetWorkspace)}
          onDeleteActionPack={(packId) => void deleteV2Pack(packId)}
          onDeleteLegacyPack={(packId) => void deleteLegacyPack(packId)}
          onDeleteWorkspace={(workspaceId) => void deleteWorkspace(workspaceId)}
          onDisableTrace={(pack) => void disableTraceForPack(pack)}
          onEnableTrace={(pack) => void enableTraceForPack(pack)}
          onExportActionPack={(pack) => void exportInstalledActionPack(pack)}
          onExportActionPackLog={(pack) => void exportInstalledActionPackLog(pack)}
          onExportLegacyPack={(pack) => void downloadLegacyPack(pack)}
          onExportWorkspace={(targetWorkspace) => void exportWorkspaceFile(targetWorkspace)}
          onIncreaseContentBlockerLock={(pack) => void increaseContentBlockerLock(pack)}
          onMarkActionPackReviewed={(pack) => void markActionPackReviewed(pack)}
          onOpenWorkspace={(targetWorkspace) => {
            setWorkspace(targetWorkspace);
            setWorkspaceDirty(false);
            setUndoStack([]);
            setActiveTab('workspace-editor');
            setWorkspaceMessage(`Opened workspace "${targetWorkspace.metadata.name}".`);
            void clearOpenWorkspaceDraft();
          }}
          onPreviewLegacyPack={(pack) => void previewLegacyPack(pack)}
          onToggleActionPack={(pack) => void toggleV2Pack(pack)}
          onToggleActionPackLogging={(pack) => void toggleActionPackLogging(pack)}
          onUnlockActionPack={(pack) => void unlockActionPack(pack)}
          onUpdateWorkspaceMetadata={(workspaceId, metadata) => void updateWorkspaceMetadata(workspaceId, metadata)}
        />
      ) : null}

      {activeTab === 'import' ? (
        <ImportPanel
          importBusy={importBusy}
          importError={importError}
          onFileDrop={(event) => void handleDrop(event)}
          onFileSelect={(event) => void handleImportChange(event)}
        />
      ) : null}

      {activeTab === 'workspace-editor' ? (
        <>
          {state.settings.ollamaEnabled ? (
            <section className="panel-shell reveal-panel">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="eyebrow">AI Connectors</p>
                  <h2 className="mt-2 text-xl font-semibold text-slate-900">Ollama workspace draft</h2>
                  <p className="mt-2 max-w-3xl text-sm text-slate-600">
                    Drafting sends your request, editable AI instructions, the block and port catalog, and a recipe for the eligible open graph to the selected loopback Ollama endpoint. Nothing changes until you review and apply the complete replacement graph. Content Blockers and graphs with embedded resources or installed Custom Block dependencies are rejected instead of converted lossily.
                  </p>
                </div>
                <span className="risk-badge risk-badge-soft">{state.settings.ollamaModel || 'No installed model selected'}</span>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
                <textarea
                  className="field-textarea min-h-24"
                  placeholder="Describe the workflow or graph change you want..."
                  value={ollamaPrompt}
                  onChange={(event) => setOllamaPrompt(event.target.value)}
                />
                <button className="primary-button self-start" disabled={ollamaBusy || !ollamaPrompt.trim()} type="button" onClick={() => void runOllamaBuilder()}>
                  {ollamaBusy ? 'Drafting...' : 'Draft'}
                </button>
              </div>
              {pendingOllamaDraft ? (
                <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
                  <div><span className="font-semibold text-slate-900">Name:</span> {pendingOllamaDraft.recipe.name}</div>
                  <div><span className="font-semibold text-slate-900">Workspace type:</span> {pendingOllamaDraft.recipe.workspaceType}</div>
                  <div><span className="font-semibold text-slate-900">Trigger:</span> {pendingOllamaDraft.recipe.trigger.type}</div>
                  <div><span className="font-semibold text-slate-900">Graph:</span> {pendingOllamaDraft.recipe.nodes.length} blocks, {pendingOllamaDraft.recipe.connections.length} connections</div>
                  <div><span className="font-semibold text-slate-900">Description:</span> {pendingOllamaDraft.recipe.description}</div>
                  <div><span className="font-semibold text-slate-900">Derived risk:</span> {pendingOllamaDraft.preview.risk.highest}</div>
                  <div><span className="font-semibold text-slate-900">Required permissions:</span> {pendingOllamaDraft.preview.requiredPermissions === null ? 'Determined when this Custom Block is used in an Action Pack' : pendingOllamaDraft.preview.requiredPermissions.length > 0 ? pendingOllamaDraft.preview.requiredPermissions.join(', ') : 'None'}</div>
                  {pendingOllamaDraft.preview.risk.reasons.length > 0 ? (
                    <div>
                      <p className="font-semibold text-slate-900">Risk reasons:</p>
                      <ul className="mt-1 list-disc pl-5 text-xs">
                        {pendingOllamaDraft.preview.risk.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                    </div>
                  ) : <p className="text-xs text-slate-600">Uses safe-core inputs and outputs only.</p>}
                  {pendingOllamaDraft.preview.sensitiveBehaviors.length > 0 ? (
                    <div>
                      <p className="font-semibold text-slate-900">Sensitive destinations and behaviors:</p>
                      <ul className="mt-1 list-disc pl-5 text-xs">
                        {pendingOllamaDraft.preview.sensitiveBehaviors.map((behavior) => <li key={behavior}>{behavior}</li>)}
                      </ul>
                    </div>
                  ) : null}
                  <details className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
                    <summary className="cursor-pointer font-semibold text-slate-900">Review complete recipe JSON</summary>
                    <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words text-[11px] text-slate-700">{JSON.stringify(pendingOllamaDraft.recipe, null, 2)}</pre>
                  </details>
                  <p className="text-xs text-slate-600">Existing compatibility metadata is cleared because the graph changed; review cross-browser behavior before sharing.</p>
                  {pendingOllamaDraftIsStale ? <p className="text-xs font-semibold text-rose-700">The open workspace changed after this draft was requested. Discard it and draft again.</p> : null}
                  <p className="text-xs text-amber-800">Apply replaces the open workspace graph. You can undo the change before saving.</p>
                  <div className="flex flex-wrap gap-2">
                    <button className="secondary-button" disabled={pendingOllamaDraftIsStale} type="button" onClick={applyOllamaDraft}>
                      Apply Draft
                    </button>
                    <button className="ghost-button" type="button" onClick={() => setPendingOllamaDraft(null)}>
                      Discard Draft
                    </button>
                  </div>
                </div>
              ) : null}
              {ollamaMessage ? <p className="mt-3 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">{ollamaMessage}</p> : null}
            </section>
          ) : null}
          <WorkspaceEditor
            advancedModeEnabled={state.settings.advancedModeEnabled}
            allWorkspaces={state.workspacesV2}
            canUndo={undoStack.length > 0}
            customBlocks={workspaceScopedCustomBlocks}
            isDirty={workspaceDirty}
            resourceAssets={resourceAssets}
            workspace={workspace}
            onBuildActionPack={() => void buildActionPack()}
            onExportActionPack={() => void exportActionPackFromWorkspace()}
            onExportWorkspace={() => void exportWorkspaceFile()}
            onNewWorkspace={newWorkspace}
            onSaveWorkspace={() => void saveWorkspace()}
            onSwitchWorkspace={switchWorkspace}
            onUndo={undoWorkspaceChange}
            onUploadResource={(file) => uploadWorkspaceResource(file)}
            onWorkspaceChange={handleWorkspaceChange}
          />
          {workspaceMessage ? <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{workspaceMessage}</p> : null}
        </>
      ) : null}

      {activeTab === 'security' ? (
        <SecurityPanel
          actionPacks={state.actionPacksV2}
          settings={state.settings}
          traceEntries={state.traceEntries}
          workspaces={state.workspacesV2}
          onDisableTrace={(pack) => void disableTraceForPack(pack)}
          onEnableTrace={(pack) => void enableTraceForPack(pack)}
          onHardeningChange={(settings) => void updateHardening(settings)}
        />
      ) : null}

      {activeTab === 'settings' ? (
        <SettingsPanel
          backupFileInputRef={backupFileInputRef}
          builderUuidFileInputRef={builderUuidFileInputRef}
          builderUuidInput={builderUuidInput}
          builderUuidMessage={builderUuidMessage}
          clipboardGranted={clipboardGranted}
          ollamaModels={ollamaModels}
          ollamaModelsBusy={ollamaModelsBusy}
          ollamaModelsMessage={ollamaModelsMessage}
          settings={state.settings}
          onAdvancedModeToggle={() => void toggleAdvancedMode()}
          onBackupFileChange={(event) => void handleBackupFileChange(event)}
          onBuilderUuidFileChange={(event) => void handleBuilderUuidFileChange(event)}
          onBuilderUuidInputChange={(value) => {
            setBuilderUuidInput(value);
            setBuilderUuidMessage(null);
          }}
          onExportBackup={() => void exportBackup()}
          onExportBuilderUuid={() => void exportBuilderUuid()}
          onDefaultLoggingToggle={() => void toggleDefaultLogging()}
          onGlobalEnabledToggle={() => void toggleGlobalEnabled()}
          onLocalFilesToggle={() => void toggleLocalFiles()}
          onOllamaSettingsChange={(settings) => void updateOllamaSettings(settings)}
          onRefreshOllamaModels={() => void refreshOllamaModels()}
          onRequestClipboardPermission={() => void requestClipboardPermission()}
          onRestoreBuilderUuid={() => void restoreBuilderUuid(builderUuidInput)}
          onSyncEnabledToggle={() => void toggleSyncEnabled()}
          onUndoHistoryLimitChange={(value) => void updateUndoHistoryLimit(value)}
          onUiScaleChange={(value) => void updateHardening({ uiScale: normalizeUiScale(value) })}
        />
      ) : null}

      {activeTab === 'help' ? <HelpPanel /> : null}

      {activeTab === 'about' ? <AboutPanel onResetEverything={() => void resetEverything()} /> : null}

      <StagingModal
        checksumHex={stagedChecksum}
        hasSandboxRun={hasSandboxRun}
        pack={stagedPack}
        reviewAcknowledged={reviewAcknowledged}
        sandboxError={sandboxError}
        sandboxInput={sandboxInput}
        sandboxOutput={sandboxOutput}
        validationErrors={stagedValidationErrors}
        onClose={() => setStagedPack(null)}
        onConfirm={() => void confirmImport()}
        onReviewAcknowledgedChange={setReviewAcknowledged}
        onSandboxInputChange={setSandboxInput}
      />
    </main>
  );
}

export default App;
