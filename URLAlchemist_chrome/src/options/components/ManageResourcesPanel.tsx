import { useMemo, useState } from 'react';

import { formatTimestamp, packUsesClipboard } from '../../shared/helpers';
import {
  ACTION_PACK_LOG_MAX_BYTES_PER_PACK,
  ACTION_PACK_LOG_MAX_ENTRIES_PER_PACK,
  formatActionPackLogText,
} from '../../shared/logs';
import type { ActionPack, StoredActionPackLogEntry } from '../../shared/types';
import { isActionPackLocked, isContentBlockerActionPack } from '../../shared/v2/installMetadata';
import { compileWorkspace } from '../../shared/v2/compiler';
import { formatRunType } from '../../shared/v2/labels';
import type { CompiledActionPackV2, WorkspaceFileV2, WorkspaceMetadata } from '../../shared/v2/types';

interface ManageResourcesPanelProps {
  actionPacks: CompiledActionPackV2[];
  actionPackLogs: StoredActionPackLogEntry[];
  legacyPacks: ActionPack[];
  workspaces: WorkspaceFileV2[];
  onClearActionPackLog: (pack: CompiledActionPackV2) => void;
  onCompileExportWorkspace: (workspace: WorkspaceFileV2) => void;
  onCompileInstallWorkspace: (workspace: WorkspaceFileV2) => void;
  onDeleteActionPack: (packId: string) => void;
  onDeleteLegacyPack: (packId: string) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  onEnableTrace: (pack: CompiledActionPackV2) => void;
  onDisableTrace: (pack: CompiledActionPackV2) => void;
  onExportActionPack: (pack: CompiledActionPackV2) => void;
  onExportActionPackLog: (pack: CompiledActionPackV2) => void;
  onExportLegacyPack: (pack: ActionPack) => void;
  onExportWorkspace: (workspace: WorkspaceFileV2) => void;
  onIncreaseContentBlockerLock: (pack: CompiledActionPackV2) => void;
  onOpenWorkspace: (workspace: WorkspaceFileV2) => void;
  onPreviewLegacyPack: (pack: ActionPack) => void;
  onToggleActionPack: (pack: CompiledActionPackV2) => void;
  onToggleActionPackLogging: (pack: CompiledActionPackV2) => void;
  onUnlockActionPack: (pack: CompiledActionPackV2) => void;
  onMarkActionPackReviewed: (pack: CompiledActionPackV2) => void;
  onUpdateWorkspaceMetadata: (workspaceId: string, metadata: Partial<WorkspaceMetadata>) => void;
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

function isTraceActive(pack: CompiledActionPackV2): boolean {
  return Boolean(pack.traceEnabledUntil && pack.traceEnabledUntil > Date.now());
}

function pairedWorkspaceId(pack: CompiledActionPackV2): string {
  return pack.sourceWorkspaceId ?? pack.manifest.id;
}

function WorkspaceCard({
  conditionWorkspaces,
  workspace,
  onCompileExportWorkspace,
  onCompileInstallWorkspace,
  onDeleteWorkspace,
  onExportWorkspace,
  onOpenWorkspace,
  onUpdateWorkspaceMetadata,
}: Pick<
  ManageResourcesPanelProps,
  'onCompileExportWorkspace' | 'onCompileInstallWorkspace' | 'onDeleteWorkspace' | 'onExportWorkspace' | 'onOpenWorkspace' | 'onUpdateWorkspaceMetadata'
> & { conditionWorkspaces: WorkspaceFileV2[]; workspace: WorkspaceFileV2 }) {
  const compileResult = useMemo(() => compileWorkspace(workspace, { conditionWorkspaces }), [conditionWorkspaces, workspace]);
  const isContentBlocker = workspace.workspaceType === 'content-blocker';

  return (
    <article className="rounded-lg border border-slate-200 bg-white/85 p-5 shadow-[0_12px_28px_rgba(31,41,55,0.07)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Workspace</p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">{workspace.metadata.name}</h3>
          <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">
            {isContentBlocker ? 'Content Blocker' : 'Data Modifier'} · {isContentBlocker ? workspace.surfaces?.reduce((count, surface) => count + surface.nodes.length, 0) ?? 0 : workspace.nodes.length} blocks · Updated {formatTimestamp(workspace.metadata.updated_at)}
          </p>
        </div>
        <span className={`risk-badge ${compileResult.ok ? 'risk-badge-soft' : 'risk-badge-danger'}`}>
          {compileResult.ok ? 'Valid' : 'Needs work'}
        </span>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="field-shell">
          <span className="field-label">Name</span>
          <input
            className="field-input"
            value={workspace.metadata.name}
            onChange={(event) => onUpdateWorkspaceMetadata(workspace.metadata.id, { name: event.target.value })}
          />
        </label>
        <label className="field-shell">
          <span className="field-label">Version</span>
          <input
            className="field-input"
            min={1}
            type="number"
            value={workspace.metadata.version}
            onChange={(event) =>
              onUpdateWorkspaceMetadata(workspace.metadata.id, {
                version: Math.max(1, Number.parseInt(event.target.value || '1', 10)),
              })
            }
          />
        </label>
        <label className="field-shell">
          <span className="field-label">Author</span>
          <input
            className="field-input"
            value={workspace.metadata.author ?? ''}
            onChange={(event) => onUpdateWorkspaceMetadata(workspace.metadata.id, { author: event.target.value })}
          />
        </label>
        <label className="field-shell">
          <span className="field-label">Type</span>
          <input className="field-input" readOnly value={isContentBlocker ? 'Content Blocker' : 'Data Modifier'} />
        </label>
        <label className="field-shell md:col-span-2">
          <span className="field-label">Description</span>
          <textarea
            className="field-textarea min-h-20"
            value={workspace.metadata.description ?? ''}
            onChange={(event) => onUpdateWorkspaceMetadata(workspace.metadata.id, { description: event.target.value })}
          />
        </label>
      </div>

      {!compileResult.ok ? (
        <ul className="mt-4 list-disc rounded-lg border border-rose-200 bg-rose-50 px-6 py-3 text-sm text-rose-800">
          {compileResult.validation.errors.slice(0, 3).map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-3">
        <button className="primary-button" type="button" onClick={() => onOpenWorkspace(workspace)}>
          Open in Editor
        </button>
        <button className="ghost-button" type="button" onClick={() => onExportWorkspace(workspace)}>
          Export .workspace
        </button>
        <button className="secondary-button" disabled={!compileResult.ok} type="button" onClick={() => isContentBlocker ? onCompileInstallWorkspace(workspace) : onCompileExportWorkspace(workspace)}>
          {isContentBlocker ? 'Compile & Install' : 'Compile & Export'}
        </button>
        <button className="ghost-button" type="button" onClick={() => onDeleteWorkspace(workspace.metadata.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}

function ActionPackCard({
  logCount,
  pack,
  onDeleteActionPack,
  onDisableTrace,
  onEnableTrace,
  onClearActionPackLog,
  onExportActionPack,
  onExportActionPackLog,
  onViewActionPackLog,
  onToggleActionPack,
  onToggleActionPackLogging,
  onUnlockActionPack,
  onIncreaseContentBlockerLock,
  onMarkActionPackReviewed,
}: Pick<
  ManageResourcesPanelProps,
  | 'onDeleteActionPack'
  | 'onDisableTrace'
  | 'onEnableTrace'
  | 'onClearActionPackLog'
  | 'onExportActionPack'
  | 'onExportActionPackLog'
  | 'onToggleActionPack'
  | 'onToggleActionPackLogging'
  | 'onUnlockActionPack'
  | 'onIncreaseContentBlockerLock'
  | 'onMarkActionPackReviewed'
> & { pack: CompiledActionPackV2; logCount: number; onViewActionPackLog: (pack: CompiledActionPackV2) => void }) {
  const traceActive = isTraceActive(pack);
  const locked = isActionPackLocked(pack);
  const contentBlocker = isContentBlockerActionPack(pack);
  const canIncreaseLock = contentBlocker && Boolean(pack.install?.contentBlocker?.allowLockIncrease) && (!pack.install?.lockState?.locked || pack.install.lockState.level < 3);
  const trust = pack.install?.userReview?.trustStatus ?? pack.install?.trustStatus ?? 'review';

  return (
    <article className="rounded-lg border border-slate-200 bg-white/85 p-5 shadow-[0_12px_28px_rgba(31,41,55,0.07)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Action Pack</p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">{pack.manifest.name}</h3>
          <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">
            {formatRunType(pack.triggerPlan.type)} · {pack.vm.instructions.length} instructions · Built {formatTimestamp(pack.builder.buildTimeUtc * 1000)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={`risk-badge ${pack.manifest.enabled ? 'risk-badge-soft' : 'risk-badge-danger'}`}>
            {pack.manifest.enabled ? 'Enabled' : 'Disabled'}
          </span>
          <span className={`risk-badge ${riskBadgeClass(pack)}`}>{pack.risk.highest}</span>
          <span className={`risk-badge ${trust === 'trusted' || trust === 'user-reviewed' ? 'risk-badge-soft' : trust === 'blocked' ? 'risk-badge-danger' : 'risk-badge-warn'}`}>
            {trust === 'trusted' ? 'Trusted' : trust === 'user-reviewed' ? 'Reviewed' : trust === 'blocked' ? 'Needs review' : 'Review'}
          </span>
          <span className={`risk-badge ${pack.install?.loggingEnabled ? 'risk-badge-soft' : 'risk-badge-warn'}`}>
            Logs {pack.install?.loggingEnabled ? 'on' : 'off'}
          </span>
          {locked ? <span className="risk-badge risk-badge-danger">Lock L{pack.install?.lockState?.level}</span> : null}
          {contentBlocker ? <span className="risk-badge risk-badge-soft">Content Blocker</span> : null}
          {traceActive ? <span className="risk-badge risk-badge-warn">Trace active</span> : null}
        </div>
      </div>

      <p className="mt-3 text-sm leading-6 text-slate-600">{pack.manifest.metadata.description?.trim() || 'No description supplied.'}</p>

      <div className="mt-4 grid gap-3 text-sm text-slate-600 md:grid-cols-2">
        <div className="info-chip">
          <span className="field-label">Source workspace</span>
          <p className="mt-1 break-all font-mono text-xs">{pairedWorkspaceId(pack)}</p>
        </div>
        <div className="info-chip">
          <span className="field-label">Permissions</span>
          <p className="mt-1">{pack.requiredPermissions.length > 0 ? pack.requiredPermissions.join(', ') : 'None'}</p>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
          Enabled
          <input checked={pack.manifest.enabled} className="h-4 w-4 accent-teal-700" disabled={locked} type="checkbox" onChange={() => onToggleActionPack(pack)} />
        </label>
        <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700">
          Logging
          <input checked={pack.install?.loggingEnabled !== false} className="h-4 w-4 accent-teal-700" type="checkbox" onChange={() => onToggleActionPackLogging(pack)} />
        </label>
        <button className="ghost-button" disabled={trust === 'trusted' || trust === 'user-reviewed'} type="button" onClick={() => onMarkActionPackReviewed(pack)}>
          Mark Reviewed
        </button>
        {locked ? (
          <button className="ghost-button" disabled={pack.install?.lockState?.level === 3} type="button" onClick={() => onUnlockActionPack(pack)}>
            Unlock
          </button>
        ) : null}
        {canIncreaseLock ? (
          <button className="ghost-button" type="button" onClick={() => onIncreaseContentBlockerLock(pack)}>
            Increase Lock
          </button>
        ) : null}
        <button className="ghost-button" type="button" onClick={() => (traceActive ? onDisableTrace(pack) : onEnableTrace(pack))}>
          {traceActive ? 'Disable Trace' : 'Enable Trace'}
        </button>
        <button className="ghost-button" disabled={locked || contentBlocker} title={contentBlocker ? 'Compiled Content Blocker Action Packs are local installs. Export the workspace source instead.' : undefined} type="button" onClick={() => onExportActionPack(pack)}>
          Export
        </button>
        <button className="ghost-button" type="button" onClick={() => onViewActionPackLog(pack)}>
          View Log{logCount > 0 ? ` (${logCount})` : ''}
        </button>
        <button className="ghost-button" type="button" onClick={() => onExportActionPackLog(pack)}>
          Export Log
        </button>
        <button className="ghost-button" disabled={logCount === 0} type="button" onClick={() => onClearActionPackLog(pack)}>
          Clear Log
        </button>
        <button className="ghost-button" disabled={locked} type="button" onClick={() => onDeleteActionPack(pack.manifest.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}

export function ManageResourcesPanel(props: ManageResourcesPanelProps) {
  const [logPackId, setLogPackId] = useState<string | null>(null);
  const packsByWorkspaceId = useMemo(() => {
    const map = new Map<string, CompiledActionPackV2[]>();
    props.actionPacks.forEach((pack) => {
      const id = pairedWorkspaceId(pack);
      map.set(id, [...(map.get(id) ?? []), pack]);
    });
    return map;
  }, [props.actionPacks]);
  const workspaceIds = useMemo(() => new Set(props.workspaces.map((workspace) => workspace.metadata.id)), [props.workspaces]);
  const unpairedPacks = props.actionPacks.filter((pack) => !workspaceIds.has(pairedWorkspaceId(pack)));
  const logsByPackId = useMemo(() => {
    const map = new Map<string, StoredActionPackLogEntry[]>();
    props.actionPackLogs.forEach((entry) => {
      map.set(entry.packId, [...(map.get(entry.packId) ?? []), entry]);
    });
    return map;
  }, [props.actionPackLogs]);
  const logPack = props.actionPacks.find((pack) => pack.manifest.id === logPackId) ?? null;
  const logEntries = logPack ? logsByPackId.get(logPack.manifest.id) ?? [] : [];

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Manage Resources</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Installed workspaces and Action Packs</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Workspaces are editable source documents. Action Packs are compiled runtime artifacts. They are paired when they share a source workspace ID, but each can be removed independently.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className="risk-badge risk-badge-soft">{props.workspaces.length} workspaces</span>
          <span className="risk-badge risk-badge-soft">{props.actionPacks.length} Action Packs</span>
        </div>
      </div>

      <div className="mt-6 grid gap-5">
        {props.workspaces.length === 0 && props.actionPacks.length === 0 && props.legacyPacks.length === 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white/70 px-5 py-8 text-center text-sm text-slate-500">
            No resources are installed yet. Use Examples or Import to add a workspace or Action Pack.
          </div>
        ) : null}

        {props.workspaces.map((workspace) => {
          const pairedPacks = packsByWorkspaceId.get(workspace.metadata.id) ?? [];
          return (
            <div key={workspace.metadata.id} className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_70px_minmax(0,1fr)]">
              <WorkspaceCard
                conditionWorkspaces={props.workspaces}
                workspace={workspace}
                onCompileExportWorkspace={props.onCompileExportWorkspace}
                onCompileInstallWorkspace={props.onCompileInstallWorkspace}
                onDeleteWorkspace={props.onDeleteWorkspace}
                onExportWorkspace={props.onExportWorkspace}
                onOpenWorkspace={props.onOpenWorkspace}
                onUpdateWorkspaceMetadata={props.onUpdateWorkspaceMetadata}
              />
              <div className="hidden items-center justify-center lg:flex">
                <div className={`h-1 w-full rounded-full ${pairedPacks.length > 0 ? 'bg-teal-400' : 'bg-slate-200'}`} />
              </div>
              <div className="grid gap-4">
                {pairedPacks.length > 0 ? (
                  pairedPacks.map((pack) => (
                    <ActionPackCard
                      key={pack.manifest.id}
                      pack={pack}
                      logCount={logsByPackId.get(pack.manifest.id)?.length ?? 0}
                      onDeleteActionPack={props.onDeleteActionPack}
                      onDisableTrace={props.onDisableTrace}
                      onEnableTrace={props.onEnableTrace}
                      onClearActionPackLog={props.onClearActionPackLog}
                      onExportActionPack={props.onExportActionPack}
                      onExportActionPackLog={props.onExportActionPackLog}
                      onIncreaseContentBlockerLock={props.onIncreaseContentBlockerLock}
                      onMarkActionPackReviewed={props.onMarkActionPackReviewed}
                      onToggleActionPackLogging={props.onToggleActionPackLogging}
                      onToggleActionPack={props.onToggleActionPack}
                      onUnlockActionPack={props.onUnlockActionPack}
                      onViewActionPackLog={(targetPack) => setLogPackId(targetPack.manifest.id)}
                    />
                  ))
                ) : (
                  <div className="rounded-lg border border-dashed border-slate-300 bg-white/65 px-5 py-8 text-center text-sm text-slate-500">
                    No installed Action Pack is compiled from this workspace.
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {unpairedPacks.length > 0 ? (
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Action Packs without installed workspaces</h3>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {unpairedPacks.map((pack) => (
                <ActionPackCard
                  key={pack.manifest.id}
                  pack={pack}
                  logCount={logsByPackId.get(pack.manifest.id)?.length ?? 0}
                  onDeleteActionPack={props.onDeleteActionPack}
                  onDisableTrace={props.onDisableTrace}
                  onEnableTrace={props.onEnableTrace}
                  onClearActionPackLog={props.onClearActionPackLog}
                  onExportActionPack={props.onExportActionPack}
                  onExportActionPackLog={props.onExportActionPackLog}
                  onIncreaseContentBlockerLock={props.onIncreaseContentBlockerLock}
                  onMarkActionPackReviewed={props.onMarkActionPackReviewed}
                  onToggleActionPackLogging={props.onToggleActionPackLogging}
                  onToggleActionPack={props.onToggleActionPack}
                  onUnlockActionPack={props.onUnlockActionPack}
                  onViewActionPackLog={(targetPack) => setLogPackId(targetPack.manifest.id)}
                />
              ))}
            </div>
          </div>
        ) : null}

        {props.legacyPacks.length > 0 ? (
          <div>
            <h3 className="text-lg font-semibold text-slate-900">Legacy v1 URL packs</h3>
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              {props.legacyPacks.map((pack) => (
                <article key={pack.id} className="rounded-lg border border-slate-200 bg-white/75 p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-lg font-semibold text-slate-900">{pack.name}</h4>
                    <span className="risk-badge risk-badge-soft">Legacy v1</span>
                    {packUsesClipboard(pack) ? <span className="risk-badge risk-badge-danger">Clipboard</span> : null}
                  </div>
                  <p className="mt-2 text-sm text-slate-600">{pack.metadata.description?.trim() || 'No description supplied.'}</p>
                  <div className="mt-5 flex flex-wrap gap-3">
                    <button className="ghost-button" type="button" onClick={() => props.onPreviewLegacyPack(pack)}>
                      Convert Preview
                    </button>
                    <button className="ghost-button" type="button" onClick={() => props.onExportLegacyPack(pack)}>
                      Export v1
                    </button>
                    <button className="ghost-button" type="button" onClick={() => props.onDeleteLegacyPack(pack.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {logPack ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 px-4 py-10 backdrop-blur-md">
          <div className="reveal-panel w-full max-w-5xl rounded-xl border border-white/70 bg-white p-5 shadow-[0_32px_90px_rgba(31,41,55,0.26)]">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="eyebrow">Action Pack Log</p>
                <h3 className="mt-2 text-2xl font-semibold text-slate-900">{logPack.manifest.name}</h3>
                <p className="mt-1 text-sm text-slate-600">
                  {logEntries.length} stored entries in local extension storage. URL Alchemist keeps the newest{' '}
                  {ACTION_PACK_LOG_MAX_ENTRIES_PER_PACK} entries or about {Math.round(ACTION_PACK_LOG_MAX_BYTES_PER_PACK / 1024)} KB per Action Pack,
                  whichever comes first.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="ghost-button" type="button" onClick={() => props.onExportActionPackLog(logPack)}>
                  Export Log
                </button>
                <button className="ghost-button" disabled={logEntries.length === 0} type="button" onClick={() => props.onClearActionPackLog(logPack)}>
                  Clear Log
                </button>
                <button className="ghost-button" type="button" onClick={() => setLogPackId(null)}>
                  Close
                </button>
              </div>
            </div>
            <pre className="mt-5 max-h-[65vh] overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-4 text-xs leading-5 text-slate-100">
              {formatActionPackLogText(logPack.manifest.name, logEntries)}
            </pre>
          </div>
        </div>
      ) : null}
    </section>
  );
}
