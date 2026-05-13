import type { ChangeEvent, DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { MAX_ACTION_PACK_BINARY_BYTES, REGEX_TIMEOUT_MS } from '../shared/constants';
import { simulateActionPack } from '../shared/engine/engine';
import type { EngineRuntime } from '../shared/engine/runtime';
import { formatTimestamp, isGlobalScope, packUsesClipboard } from '../shared/helpers';
import {
  deleteActionPackV2,
  deletePack,
  updateActionPackV2Trace,
  updateSettings,
  upsertActionPackV2,
  upsertWorkspaceV2,
} from '../shared/storage';
import type { ActionPack, StoredState } from '../shared/types';
import { exportActionPackBinary } from '../shared/vault';
import { createPageRegexExecutor } from '../shared/regex/pageRunner';
import { compileWorkspace } from '../shared/v2/compiler';
import { executeCompiledActionPackV2, type GraphRuntime } from '../shared/v2/vm';
import type { CompiledActionPackV2, WorkspaceFileV2 } from '../shared/v2/types';
import { createDefaultWorkspace, workspaceFromLegacyPack } from '../shared/v2/workspace';
import {
  exportCompiledActionPackV2Binary,
  exportWorkspaceBinary,
  importAnyArtifact,
} from '../shared/v2/vault';
import { createStarterVersionFile } from '../shared/v2/versionFile';
import { StagingModal } from './components/StagingModal';
import { WorkspaceEditor } from './components/WorkspaceEditor';
import { useStoredExtensionState } from './hooks/useStoredExtensionState';

type BrowserChromeApi = {
  downloads?: {
    download?: typeof chrome.downloads.download;
  };
  permissions?: {
    contains?: typeof chrome.permissions.contains;
    request?: typeof chrome.permissions.request;
  };
  storage?: {
    local?: typeof chrome.storage.local;
  };
};

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

function riskBadgeClass(pack: CompiledActionPackV2): string {
  if (pack.risk.highest === 'high') {
    return 'risk-badge-danger';
  }

  if (pack.risk.highest === 'extended') {
    return 'risk-badge-warn';
  }

  return 'risk-badge-soft';
}

function riskBadgeLabel(pack: CompiledActionPackV2): string {
  if (pack.risk.highest === 'high') {
    return 'Strong warning';
  }

  if (pack.risk.highest === 'extended') {
    return 'Extended access';
  }

  return 'Standard access';
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

  if (!pack.vm.instructions.some((instruction) => instruction.op === 'OUTPUT')) {
    errors.push('This Action Pack has no output instruction.');
  }

  return errors;
}

function workspaceHasDataOut(workspace: WorkspaceFileV2): boolean {
  return workspace.nodes.some((node) => node.type === 'DataFlowOut');
}

function shouldTrace(pack: CompiledActionPackV2): boolean {
  return Boolean(pack.traceEnabledUntil && pack.traceEnabledUntil > Date.now());
}

function App() {
  const { state, setState, loading } = useStoredExtensionState();
  const [workspace, setWorkspace] = useState<WorkspaceFileV2>(() => createDefaultWorkspace());
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [workspaceMessage, setWorkspaceMessage] = useState<string | null>(null);
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const runtimeRef = useRef<GraphRuntime | null>(null);
  const legacyRuntimeRef = useRef<EngineRuntime | null>(null);
  const compiledWorkspace = compileWorkspace(workspace, { builderUuid: state.settings.builderUuid });
  const stagedValidationErrors = getPackImportValidationErrors(stagedPack, state.actionPacksV2);

  if (!runtimeRef.current) {
    const regex = createPageRegexExecutor();
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

    runtimeRef.current = {
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
    };

    legacyRuntimeRef.current = {
      regex,
      readClipboard,
    };
  }

  useEffect(() => {
    const chromeApi = getChromeApi();
    if (!chromeApi.permissions?.contains) {
      setClipboardGranted(false);
      return;
    }

    void chromeApi.permissions
      .contains({
        permissions: ['clipboardRead'],
      })
      .then(setClipboardGranted);
  }, []);

  useEffect(() => {
    if (!loading && !workspaceLoaded) {
      setWorkspace(state.workspacesV2[0] ?? createDefaultWorkspace());
      setWorkspaceLoaded(true);
    }
  }, [loading, state.workspacesV2, workspaceLoaded]);

  useEffect(() => {
    if (!stagedPack || !sandboxInput.trim()) {
      setSandboxOutput('');
      setSandboxError(null);
      return;
    }

    let cancelled = false;
    void executeCompiledActionPackV2(sandboxInput, stagedPack, runtimeRef.current!, state.settings)
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

  async function requestClipboardPermission(): Promise<void> {
    const chromeApi = getChromeApi();
    if (!chromeApi.permissions?.request) {
      setClipboardGranted(false);
      return;
    }

    const granted = await chromeApi.permissions.request({
      permissions: ['clipboardRead'],
    });

    setClipboardGranted(granted);
  }

  async function saveWorkspace(): Promise<void> {
    if (!workspaceHasDataOut(workspace)) {
      setWorkspaceMessage('Add a Data Out block before saving this workspace.');
      return;
    }

    await applyState(upsertWorkspaceV2({ ...workspace, validationState: compiledWorkspace.validation }));
    setWorkspaceMessage(`Saved workspace "${workspace.metadata.name}".`);
  }

  async function buildActionPack(): Promise<void> {
    const result = compileWorkspace(workspace, { builderUuid: state.settings.builderUuid });
    if (!result.ok || !result.pack) {
      setWorkspaceMessage('Fix workspace validation before building an Action Pack.');
      return;
    }

    await applyState(upsertWorkspaceV2(result.workspace));
    await applyState(upsertActionPackV2(result.pack));
    setWorkspace(result.workspace);
    setWorkspaceMessage(`Built and installed "${result.pack.manifest.name}".`);
  }

  async function exportWorkspace(): Promise<void> {
    if (!workspaceHasDataOut(workspace)) {
      setWorkspaceMessage('Add a Data Out block before exporting this workspace.');
      return;
    }

    await downloadBytes(
      await exportWorkspaceBinary({ ...workspace, validationState: compiledWorkspace.validation }),
      `workspaces/${slugify(workspace.metadata.name) || 'workspace'}.workspace`,
    );
  }

  async function exportActionPack(): Promise<void> {
    const result = compileWorkspace(workspace, { builderUuid: state.settings.builderUuid });
    if (!result.ok || !result.pack) {
      setWorkspaceMessage('Fix workspace validation before exporting an Action Pack.');
      return;
    }

    await downloadBytes(
      await exportCompiledActionPackV2Binary(result.pack),
      `action-packs/${slugify(result.pack.manifest.name) || 'action-pack'}.actionpack`,
    );
  }

  async function exportActionPackVersionFile(): Promise<void> {
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

  async function exportBuilderUuid(): Promise<void> {
    await downloadText(
      `URL_ALCHEMIST_BUILDER_UUID=${state.settings.builderUuid}\n`,
      'url-alchemist-builder-uuid.txt',
    );
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
        await applyState(upsertWorkspaceV2(artifact.workspace));
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
      await applyState(upsertWorkspaceV2(result.workspace));
      if (result.pack) {
        setStagedPack(result.pack);
        setStagedChecksum(artifact.checksumHex);
      }
      setWorkspaceMessage(`Converted v1 pack "${artifact.pack.name}" into a v2 workspace.`);
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

  async function deleteLegacyPack(packId: string): Promise<void> {
    if (!window.confirm('Delete this legacy URL pack?')) {
      return;
    }

    await applyState(deletePack(packId));
  }

  async function enableTraceForPack(pack: CompiledActionPackV2): Promise<void> {
    await applyState(updateActionPackV2Trace(pack.manifest.id, Date.now() + 24 * 60 * 60 * 1000));
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

  async function previewLegacyPack(pack: ActionPack): Promise<void> {
    const convertedWorkspace = workspaceFromLegacyPack(pack);
    const result = compileWorkspace(convertedWorkspace, { builderUuid: state.settings.builderUuid });
    setWorkspace(result.workspace);
    if (result.pack) {
      setStagedPack(result.pack);
      setStagedChecksum(undefined);
    }

    if (legacyRuntimeRef.current) {
      await simulateActionPack('https://example.com/', pack, legacyRuntimeRef.current, state.settings);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <header className="reveal-panel rounded-[1.75rem] border border-white/65 bg-[linear-gradient(135deg,rgba(255,249,242,0.93),rgba(252,236,217,0.88))] px-6 py-7 shadow-[0_24px_70px_rgba(15,23,42,0.16)] md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl">
            <p className="eyebrow">URL Alchemist V2</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 md:text-5xl">
              Visual Action Pack workspaces.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-700 md:text-base">
              Build node workspaces, compile them into optimized Action Packs, and stage binary imports through a sandboxed transparency flow with {REGEX_TIMEOUT_MS}ms regex budgets.
            </p>
          </div>

          <div className="panel-shell min-w-[18rem] max-w-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Global Controls</p>
            <div className="mt-4 space-y-4">
              <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Engine Enabled</p>
                  <p className="text-xs text-slate-500">Allow background navigation interception.</p>
                </div>
                <input checked={state.settings.globalEnabled} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={() => void toggleGlobalEnabled()} />
              </label>

              <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Allow file URLs</p>
                  <p className="text-xs text-slate-500">Disabled by default for local file safety.</p>
                </div>
                <input checked={state.settings.allowLocalFiles} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={() => void toggleLocalFiles()} />
              </label>

              <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Advanced Mode</p>
                  <p className="text-xs text-slate-500">Reserved for compatibility with v1 settings.</p>
                </div>
                <input checked={state.settings.advancedModeEnabled} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={() => void toggleAdvancedMode()} />
              </label>

              <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4">
                <p className="text-sm font-semibold text-slate-900">Local Builder UUID</p>
                <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{state.settings.builderUuid}</p>
                <button className="ghost-button mt-3" type="button" onClick={() => void exportBuilderUuid()}>
                  Save UUID
                </button>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4">
                <p className="text-sm font-semibold text-slate-900">Clipboard Permission</p>
                <p className="mt-1 text-xs text-slate-500">Needed only for high-risk clipboard sources or outputs.</p>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className={`risk-badge ${clipboardGranted ? 'risk-badge-soft' : 'risk-badge-warn'}`}>
                    {clipboardGranted ? 'Granted' : 'Not granted'}
                  </span>
                  <button className="ghost-button" disabled={clipboardGranted} type="button" onClick={() => void requestClipboardPermission()}>
                    Grant Access
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <article className="panel-shell reveal-panel" onDragOver={(event) => event.preventDefault()} onDrop={(event) => void handleDrop(event)}>
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow">Import</p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-900">Open workspace or stage pack</h2>
              <p className="mt-2 text-sm text-slate-600">
                Drop a v2 workspace, v2 Action Pack, or v1 <span className="font-mono">.urlpack</span>. File contents decide the route, not the extension.
              </p>
            </div>
            <button className="ghost-button" type="button" onClick={() => fileInputRef.current?.click()}>
              Choose File
            </button>
          </div>

          <div className="mt-5 rounded-[1.5rem] border border-dashed border-amber-300 bg-amber-50/70 px-6 py-10 text-center">
            <p className="text-lg font-semibold text-slate-900">{importBusy ? 'Inspecting file...' : 'Drop file to inspect'}</p>
            <p className="mt-2 text-sm text-slate-600">Workspaces open in the editor; Action Packs open in the staging gate.</p>
          </div>

          {importError ? <p className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{importError}</p> : null}
          {workspaceMessage ? <p className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{workspaceMessage}</p> : null}

          <input ref={fileInputRef} accept=".workspace,.actionpack,.urlpack,application/octet-stream" className="hidden" type="file" onChange={(event) => void handleImportChange(event)} />
        </article>

        <article className="panel-shell reveal-panel">
          <p className="eyebrow">Dashboard</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">Installed packs</h2>
              <p className="mt-1 text-sm text-slate-600">
                {loading
                  ? 'Loading...'
                  : `${state.actionPacksV2.length} v2 Action Pack${state.actionPacksV2.length === 1 ? '' : 's'} · ${state.packs.length} legacy pack${state.packs.length === 1 ? '' : 's'}`}
              </p>
            </div>
          </div>

          <div className="mt-5 grid gap-4">
            {state.actionPacksV2.length === 0 && state.packs.length === 0 ? (
              <div className="rounded-[1.25rem] border border-slate-200 bg-white/70 px-5 py-8 text-center text-sm text-slate-500">
                No packs installed yet. Build one from the workspace or import a staged binary pack.
              </div>
            ) : null}

            {state.actionPacksV2.map((pack) => (
              <article key={pack.manifest.id} className={`rounded-[1.25rem] border bg-white/85 p-5 shadow-[0_12px_28px_rgba(15,23,42,0.08)] ${pack.risk.highest === 'high' ? 'border-rose-300 ring-2 ring-rose-100' : pack.risk.highest === 'extended' ? 'border-amber-300' : 'border-slate-200'}`}>
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-lg font-semibold text-slate-900">{pack.manifest.name}</h3>
                      <span className={`risk-badge ${pack.manifest.enabled ? 'risk-badge-soft' : 'risk-badge-danger'}`}>
                        {pack.manifest.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      <span className={`risk-badge ${riskBadgeClass(pack)}`}>{riskBadgeLabel(pack)}</span>
                      {isGlobalScope(pack.manifest.trigger.scope_regex) ? <span className="risk-badge risk-badge-danger">Global scope</span> : null}
                      {shouldTrace(pack) ? <span className="risk-badge risk-badge-warn">Trace active</span> : null}
                    </div>
                    <p className="mt-2 text-sm text-slate-600">{pack.manifest.metadata.description?.trim() || 'No description supplied.'}</p>
                    <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500">
                      {pack.manifest.trigger.type} · {pack.vm.instructions.length} instructions · Created {formatTimestamp(pack.manifest.metadata.created_at)}
                    </p>
                  </div>

                  <label className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
                    Enabled
                    <input checked={pack.manifest.enabled} className="h-4 w-4 accent-amber-600" type="checkbox" onChange={() => void toggleV2Pack(pack)} />
                  </label>
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <button className="ghost-button" type="button" onClick={() => void enableTraceForPack(pack)}>
                    Enable 24h Trace
                  </button>
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() =>
                      void exportCompiledActionPackV2Binary(pack).then((bytes) =>
                        downloadBytes(bytes, `action-packs/${slugify(pack.manifest.name) || 'action-pack'}.actionpack`),
                      )
                    }
                  >
                    Export
                  </button>
                  <button className="ghost-button" type="button" onClick={() => void deleteV2Pack(pack.manifest.id)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}

            {state.packs.map((pack) => (
              <article key={pack.id} className="rounded-[1.25rem] border border-slate-200 bg-white/75 p-5">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-semibold text-slate-900">{pack.name}</h3>
                  <span className="risk-badge risk-badge-soft">Legacy v1</span>
                  {packUsesClipboard(pack) ? <span className="risk-badge risk-badge-danger">Clipboard</span> : null}
                </div>
                <p className="mt-2 text-sm text-slate-600">{pack.metadata.description?.trim() || 'No description supplied.'}</p>
                <div className="mt-5 flex flex-wrap gap-3">
                  <button className="ghost-button" type="button" onClick={() => void previewLegacyPack(pack)}>
                    Convert Preview
                  </button>
                  <button className="ghost-button" type="button" onClick={() => void downloadLegacyPack(pack)}>
                    Export v1
                  </button>
                  <button className="ghost-button" type="button" onClick={() => void deleteLegacyPack(pack.id)}>
                    Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </article>
      </section>

      <WorkspaceEditor
        advancedModeEnabled={state.settings.advancedModeEnabled}
        workspace={workspace}
        onBuildActionPack={() => void buildActionPack()}
        onExportActionPack={() => void exportActionPack()}
        onExportActionPackVersionFile={() => void exportActionPackVersionFile()}
        onExportWorkspace={() => void exportWorkspace()}
        onSaveWorkspace={() => void saveWorkspace()}
        onWorkspaceChange={(nextWorkspace) => {
          setWorkspace(nextWorkspace);
          setWorkspaceMessage(null);
        }}
      />

      <section className="panel-shell reveal-panel">
        <p className="eyebrow">Trace</p>
        <h2 className="mt-2 text-2xl font-semibold text-slate-900">Recent local traces</h2>
        <div className="mt-5 grid gap-3">
          {state.traceEntries.length === 0 ? (
            <div className="rounded-[1.25rem] border border-slate-200 bg-white/70 px-5 py-6 text-sm text-slate-500">
              No trace entries yet. Extended and high-risk packs can enable trace from the dashboard.
            </div>
          ) : (
            state.traceEntries.slice(0, 8).map((entry) => (
              <article key={entry.id} className="rounded-[1.25rem] border border-slate-200 bg-white/75 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-semibold text-slate-900">{entry.packName}</p>
                  <p className="text-xs uppercase tracking-[0.18em] text-slate-500">{formatTimestamp(entry.timestamp)}</p>
                </div>
                <p className="mt-2 break-all text-xs text-slate-500">
                  {entry.inputUrl} → {entry.outputUrl}
                </p>
                <p className="mt-2 text-sm text-slate-600">{entry.entries.length} trace steps · {entry.issues.length} issues</p>
              </article>
            ))
          )}
        </div>
      </section>

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
