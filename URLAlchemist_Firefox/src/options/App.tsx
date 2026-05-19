import type { CSSProperties, ChangeEvent, DragEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

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
  updateSettings,
  updateWorkspaceV2Viewport,
  upsertActionPackV2,
  upsertWorkspaceV2,
} from '../shared/storage';
import type { ActionPack, GlobalSettings, StoredState } from '../shared/types';
import { exportActionPackBinary } from '../shared/vault';
import { createPageRegexExecutor } from '../shared/regex/pageRunner';
import { BUNDLED_ACTION_PACK_EXAMPLES, type BundledActionPackExample } from '../shared/v2/bundledExamples';
import { compileWorkspace } from '../shared/v2/compiler';
import { executeCompiledActionPackV2, type GraphRuntime } from '../shared/v2/vm';
import { createSandboxGraphRuntime } from '../shared/v2/sandboxRuntime';
import { getFirefoxActionPackCompatibility } from '../shared/v2/browserCompatibility';
import type { CompiledActionPackV2, WorkspaceFileV2, WorkspaceMetadata } from '../shared/v2/types';
import { createDefaultWorkspace, workspaceFromLegacyPack } from '../shared/v2/workspace';
import { URL_ALCHEMIST_VERSION } from '../shared/v2/buildInfo';
import {
  importCompiledActionPackV2Binary,
  exportCompiledActionPackV2Binary,
  exportWorkspaceBinary,
  importAnyArtifact,
  importWorkspaceBinary,
} from '../shared/v2/vault';
import { createStarterVersionFile } from '../shared/v2/versionFile';
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

type OptionsTab = 'examples' | 'manage-resources' | 'import' | 'workspace-editor' | 'security' | 'settings' | 'help' | 'about';

const OPTIONS_TABS: Array<{ id: OptionsTab; label: string }> = [
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
  BUNDLED_ACTION_PACK_EXAMPLES.flatMap((example) => [example.workspacePath, example.actionPackPath]),
);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const [activeTab, setActiveTab] = useState<OptionsTab>('examples');
  const [workspace, setWorkspace] = useState<WorkspaceFileV2>(() => createDefaultWorkspace());
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [workspaceDirty, setWorkspaceDirty] = useState(false);
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
  const builderUuidFileInputRef = useRef<HTMLInputElement | null>(null);
  const backupFileInputRef = useRef<HTMLInputElement | null>(null);
  const runtimesRef = useRef(createOptionsRuntimes(state.settings));
  const compiledWorkspace = useMemo(
    () => compileWorkspace(workspace, { builderUuid: state.settings.builderUuid }),
    [workspace, state.settings.builderUuid],
  );
  const stagedCompatibility = useMemo(
    () => stagedPack ? getFirefoxActionPackCompatibility(stagedPack) : { blockers: [], warnings: [] },
    [stagedPack],
  );
  const stagedValidationErrors = [
    ...getPackImportValidationErrors(stagedPack, state.actionPacksV2),
    ...stagedCompatibility.blockers,
  ];

  useEffect(() => {
    if (!workspaceToast) {
      return undefined;
    }

    const timeout = window.setTimeout(() => setWorkspaceToast(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [workspaceToast]);
  const installedExamplePackIds = useMemo(() => new Set(state.actionPacksV2.map((pack) => pack.manifest.id)), [state.actionPacksV2]);
  const savedExampleWorkspaceIds = useMemo(() => new Set(state.workspacesV2.map((savedWorkspace) => savedWorkspace.metadata.id)), [state.workspacesV2]);

  useEffect(() => {
    runtimesRef.current = createOptionsRuntimes(state.settings);
  }, [state.settings]);

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
        setWorkspaceMessage('Restored temporary open workspace draft.');
      } else {
        if (draft) {
          await clearOpenWorkspaceDraft();
        }
        setWorkspace(state.workspacesV2[0] ?? createDefaultWorkspace());
        setWorkspaceDirty(false);
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
    setWorkspaceMessage(`Opened workspace "${savedWorkspace.metadata.name}".`);
    void clearOpenWorkspaceDraft();
  }

  function newWorkspace(): void {
    if (!confirmDiscardDirtyChanges()) {
      return;
    }

    setWorkspace(createDefaultWorkspace());
    setWorkspaceDirty(false);
    setWorkspaceMessage('Started a new workspace.');
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
    await clearOpenWorkspaceDraft();
    setWorkspaceMessage(`Saved workspace "${workspace.metadata.name}".`);
  }

  async function buildActionPack(): Promise<void> {
    const result = compileWorkspace(workspace, { builderUuid: state.settings.builderUuid });
    if (!result.ok || !result.pack) {
      setWorkspaceMessage('Fix workspace validation before building an Action Pack.');
      return;
    }

    const compatibility = getFirefoxActionPackCompatibility(result.pack);
    if (compatibility.blockers.length > 0) {
      setWorkspaceMessage(compatibility.blockers.join(' '));
      return;
    }

    await applyState(upsertWorkspaceV2(result.workspace));
    await applyState(upsertActionPackV2(result.pack));
    setWorkspace(result.workspace);
    setWorkspaceDirty(false);
    await clearOpenWorkspaceDraft();
    setWorkspaceMessage(`Built and installed "${result.pack.manifest.name}".`);
    setWorkspaceToast(`Built and installed "${result.pack.manifest.name}".`);
  }

  async function exportWorkspaceFile(targetWorkspace = workspace): Promise<void> {
    const result = compileWorkspace(targetWorkspace, { builderUuid: state.settings.builderUuid });
    await downloadBytes(
      await exportWorkspaceBinary({ ...targetWorkspace, validationState: result.validation }),
      `workspaces/${slugify(targetWorkspace.metadata.name) || 'workspace'}.workspace`,
    );
  }

  async function exportActionPackFromWorkspace(targetWorkspace = workspace): Promise<void> {
    const result = compileWorkspace(targetWorkspace, { builderUuid: state.settings.builderUuid });
    if (!result.ok || !result.pack) {
      setWorkspaceMessage('Fix workspace validation before exporting an Action Pack.');
      return;
    }

    await downloadBytes(
      await exportCompiledActionPackV2Binary(result.pack),
      `action-packs/${slugify(result.pack.manifest.name) || 'action-pack'}.actionpack`,
    );
  }

  async function exportActionPackVersionFileFromWorkspace(): Promise<void> {
    const result = compileWorkspace(workspace, { builderUuid: state.settings.builderUuid });
    if (!result.ok || !result.pack) {
      setWorkspaceMessage('Fix workspace validation before exporting a version file.');
      return;
    }

    await downloadText(
      createStarterVersionFile(result.pack),
      `version-files/${slugify(result.pack.manifest.name) || 'action-pack'}.version`,
    );
  }

  async function exportInstalledActionPack(pack: CompiledActionPackV2): Promise<void> {
    await downloadBytes(
      await exportCompiledActionPackV2Binary(pack),
      `action-packs/${slugify(pack.manifest.name) || 'action-pack'}.actionpack`,
    );
  }

  async function exportInstalledActionPackVersionFile(pack: CompiledActionPackV2): Promise<void> {
    await downloadText(
      createStarterVersionFile(pack),
      `version-files/${slugify(pack.manifest.name) || 'action-pack'}.version`,
    );
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
      const imported = await importWorkspaceBinary(await fetchBundledArtifact(example.workspacePath));
      setWorkspace(imported.workspace);
      setWorkspaceDirty(false);
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
      const imported = await importCompiledActionPackV2Binary(await fetchBundledArtifact(example.actionPackPath));
      const compatibility = getFirefoxActionPackCompatibility(imported.pack);
      if (compatibility.blockers.length > 0) {
        throw new Error(compatibility.blockers.join(' '));
      }

      await applyState(upsertActionPackV2(imported.pack));
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
      await downloadBytes(await fetchBundledArtifact(example.workspacePath), `workspaces/${example.slug}.workspace`);
    } catch (error) {
      setExampleMessage(error instanceof Error ? error.message : `Unable to export "${example.name}" workspace.`);
    }
  }

  async function downloadBundledActionPack(example: BundledActionPackExample): Promise<void> {
    try {
      await downloadBytes(await fetchBundledArtifact(example.actionPackPath), `action-packs/${example.slug}.actionpack`);
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
        throw new Error('Files larger than 1MB are rejected');
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      const artifact = await importAnyArtifact(bytes);

      if (artifact.kind === 'workspace') {
        setWorkspace(artifact.workspace);
        setWorkspaceDirty(false);
        await applyState(upsertWorkspaceV2(artifact.workspace));
        await clearOpenWorkspaceDraft();
        setActiveTab('workspace-editor');
        setWorkspaceMessage(`Opened workspace "${artifact.workspace.metadata.name}".`);
        return;
      }

      if (artifact.kind === 'action-pack') {
        setStagedPack(artifact.pack);
        setStagedChecksum(artifact.checksumHex);
        return;
      }

      const convertedWorkspace = workspaceFromLegacyPack(artifact.pack);
      const result = compileWorkspace(convertedWorkspace, { builderUuid: state.settings.builderUuid });
      setWorkspace(result.workspace);
      setWorkspaceDirty(false);
      await applyState(upsertWorkspaceV2(result.workspace));
      setActiveTab('workspace-editor');
      if (result.pack) {
        setStagedPack(result.pack);
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

    await applyState(upsertActionPackV2(stagedPack));
    setStagedPack(null);
    setStagedChecksum(undefined);
    setSandboxInput('');
    setSandboxOutput('');
    setSandboxError(null);
    setHasSandboxRun(false);
    setReviewAcknowledged(false);
  }

  async function toggleV2Pack(pack: CompiledActionPackV2): Promise<void> {
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

  async function updateHardening(settings: Partial<GlobalSettings>): Promise<void> {
    await applyState(updateSettings(settings));
  }

  async function exportBackup(): Promise<void> {
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
      await restoreBackupText(await file.text());
    } catch (error) {
      setBuilderUuidMessage(error instanceof Error ? error.message : 'Unable to restore backup.');
    } finally {
      event.target.value = '';
    }
  }

  async function previewLegacyPack(pack: ActionPack): Promise<void> {
    const convertedWorkspace = workspaceFromLegacyPack(pack);
    const result = compileWorkspace(convertedWorkspace, { builderUuid: state.settings.builderUuid });
    setWorkspace(result.workspace);
    setWorkspaceDirty(true);
    setActiveTab('workspace-editor');
    if (result.pack) {
      setStagedPack(result.pack);
      setStagedChecksum(undefined);
    }

    await simulateActionPack('https://example.com/', pack, runtimesRef.current.legacy, state.settings);
  }

  async function resetEverything(): Promise<void> {
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

      {activeTab === 'examples' ? (
        <>
          <BundledExamplesPanel
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
          onDeleteActionPack={(packId) => void deleteV2Pack(packId)}
          onDeleteLegacyPack={(packId) => void deleteLegacyPack(packId)}
          onDeleteWorkspace={(workspaceId) => void deleteWorkspace(workspaceId)}
          onDisableTrace={(pack) => void disableTraceForPack(pack)}
          onEnableTrace={(pack) => void enableTraceForPack(pack)}
          onExportActionPack={(pack) => void exportInstalledActionPack(pack)}
          onExportActionPackLog={(pack) => void exportInstalledActionPackLog(pack)}
          onExportActionPackVersionFile={(pack) => void exportInstalledActionPackVersionFile(pack)}
          onExportLegacyPack={(pack) => void downloadLegacyPack(pack)}
          onExportWorkspace={(targetWorkspace) => void exportWorkspaceFile(targetWorkspace)}
          onOpenWorkspace={(targetWorkspace) => {
            setWorkspace(targetWorkspace);
            setWorkspaceDirty(false);
            setActiveTab('workspace-editor');
            setWorkspaceMessage(`Opened workspace "${targetWorkspace.metadata.name}".`);
            void clearOpenWorkspaceDraft();
          }}
          onPreviewLegacyPack={(pack) => void previewLegacyPack(pack)}
          onToggleActionPack={(pack) => void toggleV2Pack(pack)}
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
          <WorkspaceEditor
            advancedModeEnabled={state.settings.advancedModeEnabled}
            allWorkspaces={state.workspacesV2}
            isDirty={workspaceDirty}
            workspace={workspace}
            onBuildActionPack={() => void buildActionPack()}
            onExportActionPack={() => void exportActionPackFromWorkspace()}
            onExportActionPackVersionFile={() => void exportActionPackVersionFileFromWorkspace()}
            onExportWorkspace={() => void exportWorkspaceFile()}
            onNewWorkspace={newWorkspace}
            onSaveWorkspace={() => void saveWorkspace()}
            onSwitchWorkspace={switchWorkspace}
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
          onGlobalEnabledToggle={() => void toggleGlobalEnabled()}
          onLocalFilesToggle={() => void toggleLocalFiles()}
          onRequestClipboardPermission={() => void requestClipboardPermission()}
          onRestoreBuilderUuid={() => void restoreBuilderUuid(builderUuidInput)}
          onSyncEnabledToggle={() => void toggleSyncEnabled()}
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
        compatibilityWarnings={stagedCompatibility.warnings}
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
