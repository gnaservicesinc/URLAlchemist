import { useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';

import { formatTimestamp } from '../../shared/helpers';
import type { GlobalSettings, StoredTraceEntry } from '../../shared/types';
import { compileWorkspace } from '../../shared/v2/compiler';
import { explainInstruction, explainRiskReason, summarizePackBehavior } from '../../shared/v2/explain';
import type { CompiledActionPackV2, GraphVmInstruction, WorkspaceFileV2 } from '../../shared/v2/types';
import { importAnyArtifact } from '../../shared/v2/vault';
import { HelpTooltip } from './HelpTooltip';

interface SecurityPanelProps {
  actionPacks: CompiledActionPackV2[];
  settings: GlobalSettings;
  traceEntries: StoredTraceEntry[];
  workspaces: WorkspaceFileV2[];
  onDisableTrace: (pack: CompiledActionPackV2) => void;
  onEnableTrace: (pack: CompiledActionPackV2) => void;
  onHardeningChange: (settings: Partial<GlobalSettings>) => void;
}

interface AuditReport {
  errors: string[];
  instructions: GraphVmInstruction[];
  kind: string;
  permissions: string[];
  riskReasons: string[];
  summary: string;
  title: string;
  trigger: string;
  valid: boolean;
  warnings: string[];
}

function traceActive(pack: CompiledActionPackV2): boolean {
  return Boolean(pack.traceEnabledUntil && pack.traceEnabledUntil > Date.now());
}

function traceRemaining(pack: CompiledActionPackV2): string {
  if (!pack.traceEnabledUntil || pack.traceEnabledUntil <= Date.now()) {
    return 'inactive';
  }

  const minutes = Math.max(1, Math.round((pack.traceEnabledUntil - Date.now()) / 60_000));
  return `${minutes} min remaining`;
}

async function auditBytes(bytes: Uint8Array): Promise<AuditReport> {
  const artifact = await importAnyArtifact(bytes);

  if (artifact.kind === 'workspace') {
    const compiled = compileWorkspace(artifact.workspace);
    return {
      errors: compiled.validation.errors,
      instructions: compiled.pack?.vm.instructions ?? [],
      kind: 'Workspace',
      permissions: compiled.pack?.requiredPermissions ?? [],
      riskReasons: compiled.validation.risk.reasons,
      summary: compiled.pack ? summarizePackBehavior(compiled.pack) : 'This workspace has validation errors and cannot be installed yet.',
      title: artifact.workspace.metadata.name,
      trigger: artifact.workspace.trigger.type,
      valid: compiled.validation.valid,
      warnings: compiled.validation.warnings,
    };
  }

  if (artifact.kind === 'action-pack') {
    return {
      errors: [],
      instructions: artifact.pack.vm.instructions,
      kind: 'Action Pack',
      permissions: artifact.pack.requiredPermissions,
      riskReasons: artifact.pack.risk.reasons,
      summary: summarizePackBehavior(artifact.pack),
      title: artifact.pack.manifest.name,
      trigger: artifact.pack.triggerPlan.type,
      valid: true,
      warnings: [],
    };
  }

  return {
    errors: ['Legacy v1 URL packs can be imported and converted from the Import tab, but the Security audit accepts v2 workspaces and Action Packs.'],
    instructions: [],
    kind: 'Legacy URL pack',
    permissions: [],
    riskReasons: [],
    summary: 'Legacy URL packs must be converted before this audit view can explain them.',
    title: artifact.pack.name,
    trigger: artifact.pack.trigger.type,
    valid: false,
    warnings: [],
  };
}

export function SecurityPanel({
  actionPacks,
  settings,
  traceEntries,
  workspaces,
  onDisableTrace,
  onEnableTrace,
  onHardeningChange,
}: SecurityPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [auditReport, setAuditReport] = useState<AuditReport | null>(null);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [auditBusy, setAuditBusy] = useState(false);
  const workspaceAlerts = useMemo(
    () =>
      workspaces.flatMap((workspace) => {
        const result = compileWorkspace(workspace);
        return [
          ...result.validation.errors.map((message) => ({ workspace, severity: 'error' as const, message })),
          ...result.validation.warnings.map((message) => ({ workspace, severity: 'warning' as const, message })),
        ];
      }),
    [workspaces],
  );

  async function handleAuditFile(file: File): Promise<void> {
    setAuditBusy(true);
    setAuditError(null);
    setAuditReport(null);
    try {
      setAuditReport(await auditBytes(new Uint8Array(await file.arrayBuffer())));
    } catch (error) {
      setAuditError(error instanceof Error ? error.message : 'Unable to audit this file.');
    } finally {
      setAuditBusy(false);
    }
  }

  async function handleAuditChange(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (file) {
      await handleAuditFile(file);
    }
    event.target.value = '';
  }

  async function handleAuditDrop(event: DragEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) {
      await handleAuditFile(file);
    }
  }

  return (
    <section className="grid gap-6">
      <article className="panel-shell reveal-panel">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Security</p>
            <h2 className="mt-2 text-2xl font-semibold text-slate-900">Trace, hardening, and audits</h2>
            <p className="mt-2 max-w-3xl text-sm text-slate-600">
              Trace installed Action Packs, review workspace alerts, reduce runtime budgets, and inspect uninstalled files before they touch storage.
            </p>
          </div>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4">
            <span className="field-label flex items-center gap-2">
              VM instruction limit
              <HelpTooltip label="VM instruction limit" text="Caps the number of compiled VM instructions that can run for one Action Pack execution." />
            </span>
            <input
              className="mt-3 w-full"
              aria-label="VM instruction limit"
              max={300}
              min={1}
              type="range"
              value={settings.hardeningMaxInstructions}
              onChange={(event) => onHardeningChange({ hardeningMaxInstructions: Number.parseInt(event.target.value, 10) })}
            />
            <input
              className="field-input mt-3"
              aria-label="VM instruction limit number"
              max={300}
              min={1}
              type="number"
              value={settings.hardeningMaxInstructions}
              onChange={(event) => onHardeningChange({ hardeningMaxInstructions: Number.parseInt(event.target.value || '300', 10) })}
            />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4">
            <span className="field-label flex items-center gap-2">
              Redirect recursion
              <HelpTooltip label="Redirect recursion" text="Stops repeated redirects from the same pack on the same tab. The effective maximum is capped at 3." />
            </span>
            <input
              className="mt-3 w-full"
              aria-label="Redirect recursion"
              max={3}
              min={1}
              type="range"
              value={Math.min(3, settings.hardeningMaxRecursion)}
              onChange={(event) => onHardeningChange({ hardeningMaxRecursion: Number.parseInt(event.target.value, 10) })}
            />
            <input
              className="field-input mt-3"
              aria-label="Redirect recursion number"
              max={3}
              min={1}
              type="number"
              value={Math.min(3, settings.hardeningMaxRecursion)}
              onChange={(event) => onHardeningChange({ hardeningMaxRecursion: Number.parseInt(event.target.value || '3', 10) })}
            />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4">
            <span className="field-label flex items-center gap-2">
              Regex timeout
              <HelpTooltip label="Regex timeout" text="Maximum time budget for regex operations. Lower values reduce ReDoS risk but can reject slower valid patterns." />
            </span>
            <input
              className="mt-3 w-full"
              aria-label="Regex timeout"
              max={50}
              min={10}
              step={5}
              type="range"
              value={settings.hardeningRegexTimeoutMs}
              onChange={(event) => onHardeningChange({ hardeningRegexTimeoutMs: Number.parseInt(event.target.value, 10) })}
            />
            <input
              className="field-input mt-3"
              aria-label="Regex timeout number"
              max={50}
              min={10}
              step={5}
              type="number"
              value={settings.hardeningRegexTimeoutMs}
              onChange={(event) => onHardeningChange({ hardeningRegexTimeoutMs: Number.parseInt(event.target.value || '50', 10) })}
            />
          </div>
        </div>
      </article>

      <article className="panel-shell reveal-panel">
        <h3 className="text-xl font-semibold text-slate-900">Installed Action Pack tracing</h3>
        <div className="mt-4 grid gap-3">
          {actionPacks.length === 0 ? (
            <div className="rounded-[1.25rem] border border-slate-200 bg-white/70 px-5 py-6 text-sm text-slate-500">No v2 Action Packs installed.</div>
          ) : (
            actionPacks.map((pack) => (
              <div key={pack.manifest.id} className="flex flex-wrap items-center justify-between gap-4 rounded-[1.25rem] border border-slate-200 bg-white/75 p-4">
                <div>
                  <p className="font-semibold text-slate-900">{pack.manifest.name}</p>
                  <p className="text-sm text-slate-500">{traceRemaining(pack)}</p>
                </div>
                <button className="ghost-button" type="button" onClick={() => (traceActive(pack) ? onDisableTrace(pack) : onEnableTrace(pack))}>
                  {traceActive(pack) ? 'Disable Trace' : 'Enable 24h Trace'}
                </button>
              </div>
            ))
          )}
        </div>
      </article>

      <article className="panel-shell reveal-panel">
        <h3 className="text-xl font-semibold text-slate-900">Alerts and issues</h3>
        <div className="mt-4 grid gap-3">
          {workspaceAlerts.length === 0 && traceEntries.every((entry) => entry.issues.length === 0) ? (
            <div className="rounded-[1.25rem] border border-slate-200 bg-white/70 px-5 py-6 text-sm text-slate-500">No installed workspace alerts or trace issues.</div>
          ) : null}
          {workspaceAlerts.map((alert) => (
            <div key={`${alert.workspace.metadata.id}:${alert.message}`} className={`rounded-[1.25rem] border px-5 py-4 text-sm ${alert.severity === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-amber-200 bg-amber-50 text-amber-900'}`}>
              <p className="font-semibold">{alert.workspace.metadata.name}</p>
              <p className="mt-1">{alert.message}</p>
            </div>
          ))}
          {traceEntries
            .filter((entry) => entry.issues.length > 0)
            .slice(0, 8)
            .map((entry) => (
              <div key={entry.id} className="rounded-[1.25rem] border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-800">
                <p className="font-semibold">{entry.packName} · {formatTimestamp(entry.timestamp)}</p>
                <ul className="mt-2 list-disc pl-5">
                  {entry.issues.map((issue) => (
                    <li key={`${entry.id}:${issue.message}`}>{issue.message}</li>
                  ))}
                </ul>
              </div>
            ))}
        </div>
      </article>

      <article className="panel-shell reveal-panel">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-semibold text-slate-900">Audit uninstalled file</h3>
            <p className="mt-2 text-sm text-slate-600">
              Drop a v2 workspace or Action Pack to validate structure and inspect behavior without installing it. <HelpTooltip label="Audit uninstalled file" text="The audit decodes and validates the artifact in memory; it does not save the file to extension storage." />
            </p>
          </div>
          <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
            Choose File
          </button>
        </div>

        <div
          className="mt-5 rounded-[1.5rem] border border-dashed border-slate-300 bg-white/70 px-6 py-12 text-center"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => void handleAuditDrop(event)}
        >
          <p className="text-2xl font-bold text-slate-900">{auditBusy ? 'Auditing...' : 'Drop file to audit'}</p>
          <p className="mt-2 text-sm text-slate-500">The audit is read-only and does not save imported resources.</p>
        </div>
        <input ref={fileInputRef} accept=".workspace,.actionpack,application/octet-stream" className="hidden" type="file" onChange={(event) => void handleAuditChange(event)} />

        {auditError ? <p className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{auditError}</p> : null}

        {auditReport ? (
          <div className="mt-5 grid gap-4">
            <div className={`rounded-[1.25rem] border px-5 py-4 ${auditReport.valid ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-rose-200 bg-rose-50 text-rose-800'}`}>
              <p className="font-semibold">{auditReport.kind}: {auditReport.title}</p>
              <p className="mt-1 text-sm">{auditReport.summary}</p>
              <p className="mt-1 text-sm">Trigger: {auditReport.trigger} · {auditReport.instructions.length} instructions</p>
              <p className="mt-1 text-sm">Permissions: {auditReport.permissions.length > 0 ? auditReport.permissions.join(', ') : 'none'}</p>
            </div>
            {auditReport.errors.length > 0 ? (
              <ul className="list-disc rounded-[1.25rem] border border-rose-200 bg-rose-50 px-8 py-4 text-sm text-rose-800">
                {auditReport.errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
            {auditReport.riskReasons.length > 0 ? (
              <div className="rounded-[1.25rem] border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
                <p className="font-semibold">Risk summary</p>
                <ul className="mt-2 list-disc pl-5">
                  {auditReport.riskReasons.map((reason) => (
                    <li key={reason}>{explainRiskReason(reason)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="rounded-[1.25rem] border border-slate-200 bg-white/75 px-5 py-4">
              <p className="text-sm font-semibold text-slate-900">What it does</p>
              <ol className="mt-3 grid gap-2 text-sm text-slate-700">
                {auditReport.instructions.map((instruction, index) => (
                  <li key={`${instruction.nodeId}:${index}`} className="rounded-2xl border border-slate-100 bg-slate-50 px-4 py-3">
                    <span className="font-semibold text-slate-900">Step {index + 1}:</span> {explainInstruction(instruction)}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        ) : null}
      </article>
    </section>
  );
}
