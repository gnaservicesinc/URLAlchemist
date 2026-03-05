import type { ChangeEvent, DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';

import { REGEX_TIMEOUT_MS } from '../shared/constants';
import { simulateActionPack } from '../shared/engine/engine';
import type { EngineRuntime } from '../shared/engine/runtime';
import { getHotkeyValidationError } from '../shared/hotkeys';
import { formatTimestamp, isGlobalScope, packUsesClipboard } from '../shared/helpers';
import { deletePack, saveStoredState, updateSettings, upsertPack } from '../shared/storage';
import type { ActionPack, ImportEnvelope, StoredState } from '../shared/types';
import { exportActionPackBinary, importActionPackBinary } from '../shared/vault';
import {
  createActivityDraft,
  createPackDraft,
  fromPackDraft,
  getActivityPatternValidationError,
  reorderDraftActivities,
  toPackDraft,
  updateActivityDraft,
  validatePackDraftInputs,
  type ActivityDraft,
  type PackDraft,
} from './drafts';
import { StagingModal } from './components/StagingModal';
import { HotkeyRecorder } from './components/HotkeyRecorder';
import { useStoredExtensionState } from './hooks/useStoredExtensionState';
import { createPageRegexExecutor } from '../shared/regex/pageRunner';
import { RegexBuilderPanel } from './components/RegexBuilderPanel';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function downloadPack(pack: ActionPack): Promise<void> {
  const bytes = await exportActionPackBinary(pack);
  const bufferCopy = new Uint8Array(bytes.byteLength);
  bufferCopy.set(bytes);
  const buffer = bufferCopy.buffer;
  const objectUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }));

  try {
    await chrome.downloads.download({
      url: objectUrl,
      filename: `url-alchemist/${slugify(pack.name) || 'action-pack'}.urlpack`,
      saveAs: true,
    });
  } finally {
    window.setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 1_000);
  }
}

function copyForNewPack(draft: PackDraft): PackDraft {
  const freshDraft = createPackDraft();

  return {
    ...freshDraft,
    name: draft.name,
    version: draft.version,
    metadata: {
      ...freshDraft.metadata,
      author: draft.metadata.author,
      description: draft.metadata.description,
    },
    trigger: {
      ...freshDraft.trigger,
      type: draft.trigger.type,
      hotkey: draft.trigger.hotkey,
      scope_regex: draft.trigger.scope_regex,
    },
    activities: draft.activities.map((activity, index) => ({
        ...createActivityDraft(index + 1),
        action: activity.action,
        pattern: activity.pattern,
        payload: activity.payload,
        payload_vars: activity.payload_vars,
        match_mode: activity.match_mode,
        nth_occurrence: activity.nth_occurrence,
        condition: activity.condition,
        helperInput: activity.helperInput,
        helperMode: activity.helperMode,
        regexBuilder: activity.regexBuilder,
        regexSourceMode: activity.regexSourceMode,
      })),
  };
}

function App() {
  const { state, setState, loading } = useStoredExtensionState();
  const [draft, setDraft] = useState<PackDraft>(() => createPackDraft());
  const [draftTouched, setDraftTouched] = useState(false);
  const [draftSaveMessage, setDraftSaveMessage] = useState<string | null>(null);
  const [stagedImport, setStagedImport] = useState<ImportEnvelope | null>(null);
  const [sandboxInput, setSandboxInput] = useState('');
  const [sandboxOutput, setSandboxOutput] = useState('');
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const [hasSandboxRun, setHasSandboxRun] = useState(false);
  const [reviewAcknowledged, setReviewAcknowledged] = useState(false);
  const [clipboardGranted, setClipboardGranted] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [draggedActivityId, setDraggedActivityId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const runtimeRef = useRef<EngineRuntime | null>(null);
  const advancedModeEnabled = state.settings.advancedModeEnabled;
  const hotkeyValidationError =
    draft.trigger.type === 'HOTKEY'
      ? getHotkeyValidationError(
          draft.trigger.hotkey,
          state.packs
            .filter((pack) => pack.id !== draft.id && pack.trigger.type === 'HOTKEY')
            .map((pack) => pack.trigger.hotkey ?? ''),
        )
      : null;
  const draftValidationErrors = validatePackDraftInputs(draft, state.packs);
  const canSaveDraft = draftValidationErrors.length === 0;
  const shouldShowDraftValidation = draftTouched && draftValidationErrors.length > 0;

  if (!runtimeRef.current) {
    runtimeRef.current = {
      regex: createPageRegexExecutor(),
      readClipboard: async () => {
        const granted = await chrome.permissions.contains({
          permissions: ['clipboardRead'],
        });

        if (!granted) {
          throw new Error('Clipboard access requires the optional clipboardRead permission.');
        }

        return await navigator.clipboard.readText();
      },
    };
  }

  useEffect(() => {
    void chrome.permissions
      .contains({
        permissions: ['clipboardRead'],
      })
      .then(setClipboardGranted);
  }, []);

  useEffect(() => {
    if (!stagedImport || !sandboxInput.trim()) {
      setSandboxOutput('');
      setSandboxError(null);
      return;
    }

    let cancelled = false;

    void simulateActionPack(sandboxInput, stagedImport.pack, runtimeRef.current!, state.settings)
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
  }, [sandboxInput, stagedImport, state.settings]);

  async function applyState(nextStatePromise: Promise<StoredState>): Promise<void> {
    const nextState = await nextStatePromise;
    setState(nextState);
  }

  async function requestClipboardPermission(): Promise<void> {
    const granted = await chrome.permissions.request({
      permissions: ['clipboardRead'],
    });

    setClipboardGranted(granted);
  }

  async function handleFileSelection(file: File): Promise<void> {
    setImportBusy(true);
    setImportError(null);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const envelope = await importActionPackBinary(bytes);
      setStagedImport(envelope);
      setSandboxInput('');
      setSandboxOutput('');
      setSandboxError(null);
      setHasSandboxRun(false);
      setReviewAcknowledged(false);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : 'Unable to import this pack');
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

  function resetDraft(): void {
    setDraft(createPackDraft());
    setDraftTouched(false);
    setDraftSaveMessage(null);
  }

  async function handleSaveDraft(): Promise<void> {
    const pack = fromPackDraft(draft);
    await applyState(upsertPack(pack));
    setDraftSaveMessage(`Saved "${pack.name}". You can start a new pack whenever you're ready.`);
    setDraft(createPackDraft());
    setDraftTouched(false);
  }

  async function handleDeletePack(packId: string): Promise<void> {
    if (!window.confirm('Delete this action pack?')) {
      return;
    }

    await applyState(deletePack(packId));
    if (draft.id === packId) {
      resetDraft();
    }
  }

  async function handleTogglePack(pack: ActionPack): Promise<void> {
    await applyState(
      upsertPack({
        ...pack,
        enabled: !pack.enabled,
      }),
    );
  }

  async function handleToggleGlobalEnabled(): Promise<void> {
    await applyState(
      updateSettings({
        globalEnabled: !state.settings.globalEnabled,
      }),
    );
  }

  async function handleToggleLocalFiles(): Promise<void> {
    await applyState(
      updateSettings({
        allowLocalFiles: !state.settings.allowLocalFiles,
      }),
    );
  }

  async function handleToggleAdvancedMode(): Promise<void> {
    await applyState(
      updateSettings({
        advancedModeEnabled: !state.settings.advancedModeEnabled,
      }),
    );
  }

  async function handleConfirmImport(): Promise<void> {
    if (!stagedImport) {
      return;
    }

    await applyState(upsertPack(stagedImport.pack));
    setStagedImport(null);
    setSandboxInput('');
    setSandboxOutput('');
    setSandboxError(null);
    setHasSandboxRun(false);
    setReviewAcknowledged(false);
  }

  function markDraftEditing(): void {
    if (!draftTouched) {
      setDraftTouched(true);
    }

    if (draftSaveMessage) {
      setDraftSaveMessage(null);
    }
  }

  function updateDraftActivity(activityId: string, updates: Partial<ActivityDraft>): void {
    setDraftTouched(true);
    setDraftSaveMessage(null);
    setDraft((current) => ({
      ...current,
      activities: current.activities.map((activity) =>
        activity.id === activityId ? updateActivityDraft(activity, updates) : activity,
      ),
    }));
  }

  function removeDraftActivity(activityId: string): void {
    setDraftTouched(true);
    setDraftSaveMessage(null);
    setDraft((current) => ({
      ...current,
      activities:
        current.activities.length === 1
          ? current.activities
          : current.activities
              .filter((activity) => activity.id !== activityId)
              .map((activity, index) => ({ ...activity, order: index + 1 })),
    }));
  }

  function addDraftActivity(): void {
    setDraftTouched(true);
    setDraftSaveMessage(null);
    setDraft((current) => ({
      ...current,
      activities: [...current.activities, createActivityDraft(current.activities.length + 1)],
    }));
  }

  function handleDragStart(activityId: string): void {
    setDraggedActivityId(activityId);
  }

  function handleDropOnActivity(targetId: string): void {
    if (!draggedActivityId) {
      return;
    }

    setDraftTouched(true);
    setDraftSaveMessage(null);
    setDraft((current) => ({
      ...current,
      activities: reorderDraftActivities(current.activities, draggedActivityId, targetId),
    }));
    setDraggedActivityId(null);
  }

  async function duplicateDraftIntoNewPack(): Promise<void> {
    const duplicated = fromPackDraft(copyForNewPack(draft));
    const nextState = { ...state, packs: [duplicated, ...state.packs] };
    await saveStoredState(nextState);
    setState(nextState);
    setDraftSaveMessage(`Saved a duplicate of "${duplicated.name}".`);
    setDraft(createPackDraft());
    setDraftTouched(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-7xl flex-col gap-6 px-4 py-6 md:px-8 md:py-10">
      <header className="reveal-panel rounded-[2rem] border border-white/65 bg-[linear-gradient(135deg,rgba(255,249,242,0.93),rgba(252,236,217,0.88))] px-6 py-7 shadow-[0_24px_70px_rgba(15,23,42,0.16)] md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-3xl">
            <p className="eyebrow">URL Alchemist</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-tight text-slate-950 md:text-5xl">
              Firefox middleware for URL transformation.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-6 text-slate-700 md:text-base">
              Build action packs, import signed binary packs into a staging area, and route navigation through a
              hardened transformation engine with {REGEX_TIMEOUT_MS}ms regex budgets.
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
                <input checked={state.settings.globalEnabled} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={() => void handleToggleGlobalEnabled()} />
              </label>

              <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Allow file URLs</p>
                  <p className="text-xs text-slate-500">Disabled by default for local file safety.</p>
                </div>
                <input checked={state.settings.allowLocalFiles} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={() => void handleToggleLocalFiles()} />
              </label>

              <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-900">Advanced Mode</p>
                  <p className="text-xs text-slate-500">
                    Shows manual regex, scope rules, raw pattern previews, and conditions.
                  </p>
                </div>
                <input checked={advancedModeEnabled} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={() => void handleToggleAdvancedMode()} />
              </label>

              <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4">
                <p className="text-sm font-semibold text-slate-900">Clipboard Permission</p>
                <p className="mt-1 text-xs text-slate-500">
                  Needed only for packs that interpolate <span className="font-mono">{'{clipboard}'}</span>.
                </p>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <span className={`risk-badge ${clipboardGranted ? 'risk-badge-soft' : 'risk-badge-warn'}`}>
                    {clipboardGranted ? 'Granted' : 'Not granted'}
                  </span>
                  <button className="ghost-button" type="button" disabled={clipboardGranted} onClick={() => void requestClipboardPermission()}>
                    Grant Access
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
        <article
          className="panel-shell reveal-panel"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => void handleDrop(event)}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="eyebrow">Vault</p>
              <h2 className="mt-2 text-2xl font-semibold text-slate-900">Import binary action packs</h2>
              <p className="mt-2 text-sm text-slate-600">
                Drop a <span className="font-mono">.urlpack</span> file here to stage it for review without saving it.
              </p>
            </div>
            <button className="ghost-button" type="button" onClick={() => fileInputRef.current?.click()}>
              Choose File
            </button>
          </div>

          <div className="mt-5 rounded-[1.75rem] border border-dashed border-amber-300 bg-[linear-gradient(135deg,rgba(255,250,243,0.92),rgba(252,235,215,0.76))] px-6 py-10 text-center">
            <p className="text-lg font-semibold text-slate-900">{importBusy ? 'Inspecting pack...' : 'Drop file to stage import'}</p>
            <p className="mt-2 text-sm text-slate-600">The manifest, risk badges, decompiler cards, and sandbox appear before confirmation.</p>
          </div>

          {importError ? <p className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{importError}</p> : null}

          <input
            ref={fileInputRef}
            accept=".urlpack,application/octet-stream"
            className="hidden"
            type="file"
            onChange={(event) => void handleImportChange(event)}
          />
        </article>

        <article className="panel-shell reveal-panel">
          <p className="eyebrow">Dashboard</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-slate-900">Installed packs</h2>
              <p className="mt-1 text-sm text-slate-600">{loading ? 'Loading...' : `${state.packs.length} pack${state.packs.length === 1 ? '' : 's'} installed`}</p>
            </div>
          </div>

          <div className="mt-5 grid gap-4">
            {state.packs.length === 0 ? (
              <div className="rounded-[1.5rem] border border-slate-200 bg-white/70 px-5 py-8 text-center text-sm text-slate-500">
                No packs installed yet. Build one in the Forge or import a staged binary pack.
              </div>
            ) : (
              state.packs.map((pack) => (
                <article key={pack.id} className="rounded-[1.6rem] border border-slate-200 bg-white/85 p-5 shadow-[0_12px_28px_rgba(15,23,42,0.08)]">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-semibold text-slate-900">{pack.name}</h3>
                        <span className={`risk-badge ${pack.enabled ? 'risk-badge-soft' : 'risk-badge-danger'}`}>
                          {pack.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        {isGlobalScope(pack.trigger.scope_regex) ? <span className="risk-badge risk-badge-danger">Global scope</span> : null}
                        {packUsesClipboard(pack) ? <span className="risk-badge risk-badge-warn">Clipboard</span> : null}
                      </div>
                      <p className="mt-2 text-sm text-slate-600">{pack.metadata.description?.trim() || 'No description supplied.'}</p>
                      <p className="mt-3 text-xs uppercase tracking-[0.2em] text-slate-500">
                        {pack.trigger.type} · {pack.activities.length} activities · Created {formatTimestamp(pack.metadata.created_at)}
                      </p>
                    </div>

                    <label className="flex items-center gap-3 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
                      Enabled
                      <input checked={pack.enabled} className="h-4 w-4 accent-amber-600" type="checkbox" onChange={() => void handleTogglePack(pack)} />
                    </label>
                  </div>

                  <div className="mt-5 flex flex-wrap gap-3">
                    <button
                      className="ghost-button"
                      type="button"
                      onClick={() => {
                        setDraft(toPackDraft(pack));
                        setDraftTouched(false);
                        setDraftSaveMessage(null);
                      }}
                    >
                      Edit
                    </button>
                    <button className="ghost-button" type="button" onClick={() => void downloadPack(pack)}>
                      Export
                    </button>
                    <button className="ghost-button" type="button" onClick={() => void handleDeletePack(pack.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </article>
      </section>

      <section className="panel-shell reveal-panel">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Forge</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">Compose an action pack</h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">
              {advancedModeEnabled
                ? 'Advanced mode is on, so you can edit manual regex, scope rules, and conditional logic directly.'
                : 'Simple mode is on, so the Forge stays focused on sample URLs, clear actions, and recorded hotkeys.'}
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <button className="ghost-button" type="button" onClick={resetDraft}>
              New Pack
            </button>
            <button className="ghost-button" disabled={!canSaveDraft} type="button" onClick={() => void duplicateDraftIntoNewPack()}>
              Duplicate Draft
            </button>
            <button className="primary-button" disabled={!canSaveDraft} type="button" onClick={() => void handleSaveDraft()}>
              Save Pack
            </button>
          </div>
        </div>

        {draftSaveMessage ? (
          <div className="mt-5 rounded-[1.5rem] border border-emerald-200 bg-emerald-50/90 px-5 py-4 text-sm text-emerald-800">
            <p className="font-semibold text-emerald-950">{draftSaveMessage}</p>
          </div>
        ) : null}

        {shouldShowDraftValidation ? (
          <div className="mt-5 rounded-[1.5rem] border border-rose-200 bg-rose-50/80 px-5 py-4 text-sm text-rose-700">
            <p className="font-semibold text-rose-900">Fix these safety checks before saving:</p>
            <ul className="mt-2 list-disc pl-5">
              {draftValidationErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {!advancedModeEnabled ? (
          <div className="mt-5 rounded-[1.5rem] border border-amber-200 bg-amber-50/75 px-5 py-4 text-sm text-amber-900">
            Simple mode hides manual regex, scope regex, raw regex previews, payload variables, and activity
            conditions. Turn on <strong>Advanced Mode</strong> in Global Controls whenever you need those tools.
          </div>
        ) : null}

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <label className="field-shell">
            <span className="field-label">Pack Name</span>
            <input
              className="field-input"
              value={draft.name}
              onChange={(event) => {
                markDraftEditing();
                setDraft((current) => ({ ...current, name: event.target.value }));
              }}
            />
          </label>
          <label className="field-shell">
            <span className="field-label">Version</span>
            <input
              className="field-input"
              min={1}
              type="number"
              value={draft.version}
              onChange={(event) => {
                markDraftEditing();
                setDraft((current) => ({
                  ...current,
                  version: Math.max(1, Number.parseInt(event.target.value || '1', 10)),
                }));
              }}
            />
          </label>
          <label className="field-shell">
            <span className="field-label">Author</span>
            <input
              className="field-input"
              value={draft.metadata.author ?? ''}
              onChange={(event) => {
                markDraftEditing();
                setDraft((current) => ({
                  ...current,
                  metadata: {
                    ...current.metadata,
                    author: event.target.value,
                  },
                }));
              }}
            />
          </label>
          <label className="field-shell">
            <span className="field-label">Trigger</span>
            <select
              className="field-select"
              value={draft.trigger.type}
              onChange={(event) => {
                markDraftEditing();
                setDraft((current) => ({
                  ...current,
                  trigger: {
                    ...current.trigger,
                    type: event.target.value as PackDraft['trigger']['type'],
                  },
                }));
              }}
            >
              <option value="ALWAYS">Always</option>
              <option value="HOTKEY">Hotkey</option>
              <option value="CONTEXT_MENU">Context Menu</option>
              <option value="NEVER">Never</option>
            </select>
          </label>
          <label className="field-shell lg:col-span-2">
            <span className="field-label">Description</span>
            <textarea
              className="field-textarea min-h-24"
              value={draft.metadata.description ?? ''}
              onChange={(event) => {
                markDraftEditing();
                setDraft((current) => ({
                  ...current,
                  metadata: {
                    ...current.metadata,
                    description: event.target.value,
                  },
                }));
              }}
            />
          </label>
          {advancedModeEnabled ? (
            <label className="field-shell">
              <span className="field-label">Scope Regex</span>
              <input
                className="field-input"
                placeholder="Leave blank to run globally"
                value={draft.trigger.scope_regex ?? ''}
                onChange={(event) => {
                  markDraftEditing();
                  setDraft((current) => ({
                    ...current,
                    trigger: {
                      ...current.trigger,
                      scope_regex: event.target.value,
                    },
                  }));
                }}
              />
            </label>
          ) : null}

          {draft.trigger.type === 'HOTKEY' ? (
            <div className={advancedModeEnabled ? '' : 'lg:col-span-2'}>
              <HotkeyRecorder
                validationError={hotkeyValidationError}
                value={draft.trigger.hotkey}
                onChange={(hotkey) => {
                  markDraftEditing();
                  setDraft((current) => ({
                    ...current,
                    trigger: {
                      ...current.trigger,
                      hotkey,
                    },
                  }));
                }}
              />
            </div>
          ) : null}
        </div>

        <div className="mt-8 flex items-center justify-between gap-4">
          <div>
            <p className="eyebrow">Activities</p>
            <p className="mt-1 text-sm text-slate-600">Drag cards to reorder the execution pipeline.</p>
          </div>
          <button className="secondary-button" type="button" onClick={addDraftActivity}>
            Add Activity
          </button>
        </div>

        <div className="mt-5 grid gap-4">
          {draft.activities.map((activity) => (
            <article
              key={activity.id}
              draggable
              className="rounded-[1.7rem] border border-slate-200 bg-white/85 p-5 shadow-[0_14px_30px_rgba(15,23,42,0.08)]"
              onDragOver={(event) => event.preventDefault()}
              onDragStart={() => handleDragStart(activity.id)}
              onDrop={() => handleDropOnActivity(activity.id)}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Activity {activity.order}</p>
                  <h3 className="mt-2 text-xl font-semibold text-slate-900">{activity.action}</h3>
                </div>
                <div className="flex flex-wrap gap-3">
                  <button className="ghost-button" type="button" onClick={() => removeDraftActivity(activity.id)}>
                    Remove
                  </button>
                </div>
              </div>

              <div className="mt-5 grid gap-4 lg:grid-cols-2">
                <label className="field-shell">
                  <span className="field-label">Action</span>
                  <select
                    className="field-select"
                    value={activity.action}
                    onChange={(event) =>
                      updateDraftActivity(activity.id, {
                        action: event.target.value as ActivityDraft['action'],
                      })
                    }
                  >
                    <option value="SUBSTITUTE">Substitute</option>
                    <option value="REMOVE">Remove</option>
                    <option value="APPEND">Append</option>
                    <option value="PREPEND">Prepend</option>
                  </select>
                </label>

                <label className="field-shell">
                  <span className="field-label">Match Mode</span>
                  <select
                    className="field-select"
                    value={activity.match_mode}
                    onChange={(event) =>
                      updateDraftActivity(activity.id, {
                        match_mode: event.target.value as ActivityDraft['match_mode'],
                      })
                    }
                  >
                    <option value="STANDARD">Standard</option>
                    <option value="BEFORE_PATTERN">Before Pattern</option>
                    <option value="AFTER_PATTERN">After Pattern</option>
                    <option value="NTH_OCCURRENCE">Nth Occurrence</option>
                  </select>
                </label>

                {activity.match_mode === 'NTH_OCCURRENCE' ? (
                  <label className="field-shell">
                    <span className="field-label">Occurrence Number</span>
                    <input
                      className="field-input"
                      min={1}
                      type="number"
                      value={activity.nth_occurrence ?? 1}
                      onChange={(event) =>
                        updateDraftActivity(activity.id, {
                          nth_occurrence: Math.max(1, Number.parseInt(event.target.value || '1', 10)),
                        })
                      }
                    />
                  </label>
                ) : null}

                <label className="field-shell">
                  <span className="field-label">Match Helper</span>
                  <select
                    className="field-select"
                    value={activity.helperMode}
                    onChange={(event) =>
                      updateDraftActivity(activity.id, {
                        helperMode: event.target.value as ActivityDraft['helperMode'],
                      })
                    }
                  >
                    <option value="CONTAINS">Contains</option>
                    <option value="STARTS_WITH">Starts With</option>
                    <option value="REGEX">{advancedModeEnabled ? 'Manual Regex' : 'Build From Sample URL'}</option>
                  </select>
                </label>

                {activity.helperMode === 'REGEX' ? (
                  <RegexBuilderPanel
                    advancedModeEnabled={advancedModeEnabled}
                    activity={activity}
                    validationError={getActivityPatternValidationError(activity)}
                    onUpdate={(updates) => updateDraftActivity(activity.id, updates)}
                  />
                ) : (
                  <label className="field-shell lg:col-span-2">
                    <span className="field-label">Text to Match</span>
                    <input
                      className="field-input"
                      value={activity.helperInput}
                      onChange={(event) =>
                        updateDraftActivity(activity.id, {
                          helperInput: event.target.value,
                        })
                      }
                    />
                  </label>
                )}

                {advancedModeEnabled ? (
                  <label className="field-shell lg:col-span-2">
                    <span className="field-label">Generated Pattern</span>
                    <input className="field-input font-mono text-xs" readOnly value={activity.pattern} />
                  </label>
                ) : null}

                <label className="field-shell lg:col-span-2">
                  <span className="field-label">Payload</span>
                  <textarea
                    className="field-textarea min-h-24"
                    disabled={activity.action === 'REMOVE'}
                    placeholder={activity.action === 'REMOVE' ? 'Ignored for REMOVE activities' : 'Injected value or replacement text'}
                    value={activity.payload}
                    onChange={(event) =>
                      updateDraftActivity(activity.id, {
                        payload: event.target.value,
                      })
                    }
                  />
                </label>

                {advancedModeEnabled ? (
                  <>
                    <label className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/70 px-4 py-3 text-sm text-slate-700 lg:col-span-2">
                      <input
                        checked={activity.payload_vars}
                        className="h-4 w-4 accent-amber-600"
                        type="checkbox"
                        onChange={(event) =>
                          updateDraftActivity(activity.id, {
                            payload_vars: event.target.checked,
                          })
                        }
                      />
                      Resolve payload variables like <span className="font-mono">{'{date}'}</span>,{' '}
                      <span className="font-mono">{'{clipboard}'}</span>, and regex groups.
                    </label>

                    <label className="field-shell">
                      <span className="field-label">Condition</span>
                      <select
                        className="field-select"
                        value={activity.condition?.type ?? 'NONE'}
                        onChange={(event) =>
                          updateDraftActivity(activity.id, {
                            condition:
                              event.target.value === 'NONE'
                                ? undefined
                                : {
                                    type: event.target.value as NonNullable<ActivityDraft['condition']>['type'],
                                    value: activity.condition?.value ?? '',
                                    target: activity.condition?.target ?? 'PREVIOUS_OUTPUT',
                                  },
                          })
                        }
                      >
                        <option value="NONE">No Condition</option>
                        <option value="IF_CONTAINS">If Contains</option>
                        <option value="IF_REGEX_MATCH">If Regex Match</option>
                      </select>
                    </label>

                    {activity.condition ? (
                      <>
                        <label className="field-shell">
                          <span className="field-label">Condition Target</span>
                          <select
                            className="field-select"
                            value={activity.condition.target}
                            onChange={(event) =>
                              updateDraftActivity(activity.id, {
                                condition: {
                                  ...activity.condition!,
                                  target: event.target.value as NonNullable<ActivityDraft['condition']>['target'],
                                },
                              })
                            }
                          >
                            <option value="URL">Original URL</option>
                            <option value="PREVIOUS_OUTPUT">Previous Output</option>
                          </select>
                        </label>
                        <label className="field-shell lg:col-span-2">
                          <span className="field-label">Condition Value</span>
                          <input
                            className="field-input"
                            value={activity.condition.value}
                            onChange={(event) =>
                              updateDraftActivity(activity.id, {
                                condition: {
                                  ...activity.condition!,
                                  value: event.target.value,
                                },
                              })
                            }
                          />
                        </label>
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      </section>

      <StagingModal
        envelope={stagedImport}
        hasSandboxRun={hasSandboxRun}
        reviewAcknowledged={reviewAcknowledged}
        sandboxError={sandboxError}
        sandboxInput={sandboxInput}
        sandboxOutput={sandboxOutput}
        onClose={() => setStagedImport(null)}
        onConfirm={() => void handleConfirmImport()}
        onReviewAcknowledgedChange={setReviewAcknowledged}
        onSandboxInputChange={setSandboxInput}
      />
    </main>
  );
}

export default App;
