import type { CompiledActionPackV2 } from '../../shared/v2/types';
import { explainInstruction, explainRiskReason, summarizePackBehavior } from '../../shared/v2/explain';
import { formatRunType } from '../../shared/v2/labels';
import { HelpTooltip } from './HelpTooltip';

interface StagingModalProps {
  checksumHex?: string;
  pack: CompiledActionPackV2 | null;
  sandboxInput: string;
  sandboxOutput: string;
  sandboxError: string | null;
  hasSandboxRun: boolean;
  reviewAcknowledged: boolean;
  validationErrors: string[];
  onClose: () => void;
  onConfirm: () => void;
  onReviewAcknowledgedChange: (checked: boolean) => void;
  onSandboxInputChange: (value: string) => void;
}

function riskClass(risk: CompiledActionPackV2['risk']['highest']): string {
  if (risk === 'high') {
    return 'risk-badge-danger';
  }

  if (risk === 'extended') {
    return 'risk-badge-warn';
  }

  return 'risk-badge-soft';
}

function riskLabel(risk: CompiledActionPackV2['risk']['highest']): string {
  if (risk === 'high') {
    return 'Strong warning';
  }

  if (risk === 'extended') {
    return 'Extended access';
  }

  return 'Standard access';
}

function instructionLabel(instruction: CompiledActionPackV2['vm']['instructions'][number]): string {
  return explainInstruction(instruction);
}

function remoteInstructionHost(instruction: Extract<CompiledActionPackV2['vm']['instructions'][number], { op: 'FETCH_GET' | 'HTTP_REQUEST' | 'GET_ASSET' }>): string {
  if (!instruction.fallbackUrl) {
    return 'Dynamic remote host';
  }

  try {
    return new URL(instruction.fallbackUrl).host;
  } catch {
    return 'Invalid static remote URL';
  }
}

function isRemoteInstruction(instruction: CompiledActionPackV2['vm']['instructions'][number]): instruction is Extract<CompiledActionPackV2['vm']['instructions'][number], { op: 'FETCH_GET' | 'HTTP_REQUEST' | 'GET_ASSET' }> {
  return instruction.op === 'FETCH_GET' || instruction.op === 'HTTP_REQUEST' || (instruction.op === 'GET_ASSET' && !instruction.embedded);
}

export function StagingModal({
  checksumHex,
  pack,
  sandboxInput,
  sandboxOutput,
  sandboxError,
  hasSandboxRun,
  reviewAcknowledged,
  validationErrors,
  onClose,
  onConfirm,
  onReviewAcknowledgedChange,
  onSandboxInputChange,
}: StagingModalProps) {
  if (!pack) {
    return null;
  }

  const confirmUnlocked = (hasSandboxRun || reviewAcknowledged) && validationErrors.length === 0;
  const remoteInstructions = pack.vm.instructions.filter(isRemoteInstruction);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 px-4 py-10 backdrop-blur-md">
      <div className="reveal-panel relative w-full max-w-6xl rounded-[2rem] border border-white/60 bg-[rgba(255,252,246,0.97)] p-6 shadow-[0_32px_90px_rgba(15,23,42,0.26)] md:p-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Staging Area</p>
            <h2 className="text-3xl font-semibold tracking-tight text-slate-900">Inspect Action Pack</h2>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              The pack is staged in memory only. Review the plain-language steps before installing it. <HelpTooltip label="Staged import" text="Staged packs are not saved until Confirm Import succeeds." />
            </p>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        {pack.risk.highest === 'high' ? (
          <div className="mb-5 rounded-[1.5rem] border-2 border-rose-300 bg-rose-100 px-5 py-4 text-rose-900">
              <p className="text-lg font-bold">High-risk pack</p>
              <p className="mt-1 text-sm">
                {summarizePackBehavior(pack)}
              </p>
          </div>
        ) : pack.risk.highest === 'extended' ? (
          <div className="mb-5 rounded-[1.5rem] border border-amber-300 bg-amber-100 px-5 py-4 text-amber-950">
            <p className="font-semibold">Extended data access</p>
            <p className="mt-1 text-sm">Enable trace for the first day after install so you can inspect what the pack touches.</p>
          </div>
        ) : null}

        {remoteInstructions.length > 0 ? (
          <div className="mb-5 rounded-[1.5rem] border-2 border-rose-300 bg-rose-100 px-5 py-4 text-rose-900">
            <p className="text-lg font-bold">Remote data access</p>
            <p className="mt-1 text-sm">
              This Action Pack can contact remote servers. Static hosts are shown below when known; dynamic remote hosts depend on runtime input data.
            </p>
            <ul className="mt-2 list-disc pl-5 text-sm">
              {remoteInstructions.map((instruction) => (
                <li key={instruction.nodeId}>
                  {remoteInstructionHost(instruction)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1fr_0.95fr]">
          <section className="panel-shell">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">Manifest</p>
                <h3 className="mt-2 text-2xl font-semibold text-slate-900">{pack.manifest.name}</h3>
                <p className="mt-1 text-sm text-slate-600">
                  {pack.manifest.metadata.author?.trim() || 'Unknown author'} · Version {pack.manifest.version}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className={`risk-badge ${riskClass(pack.risk.highest)}`}>{riskLabel(pack.risk.highest)}</span>
                <span className="risk-badge risk-badge-soft">Schema {pack.schemaVersion}</span>
              </div>
            </div>

            <dl className="mt-5 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
              <div className="info-chip">
                <dt className="font-semibold text-slate-900">Run</dt>
                <dd>{formatRunType(pack.triggerPlan.type)}</dd>
              </div>
              <div className="info-chip">
                <dt className="font-semibold text-slate-900">Instructions</dt>
                <dd>{pack.vm.instructions.length}</dd>
              </div>
              <div className="info-chip sm:col-span-2">
                <dt className="flex items-center gap-2 font-semibold text-slate-900">
                  Input Filters
                  <HelpTooltip label="Input filters" text="Filters decide which input sources are allowed to run this pack." />
                </dt>
                <dd className="break-all">{pack.triggerPlan.sourceFilters.map((filter) => `${filter.source}: ${filter.pattern}`).join(', ') || 'No input filters'}</dd>
              </div>
              <div className="info-chip sm:col-span-2">
                <dt className="font-semibold text-slate-900">Description</dt>
                <dd>{pack.manifest.metadata.description?.trim() || 'No description supplied'}</dd>
              </div>
            </dl>

            {pack.risk.reasons.length > 0 ? (
              <div className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
                <p className="font-semibold">Risk reasons</p>
                <ul className="mt-2 list-disc pl-5">
                  {pack.risk.reasons.map((reason) => (
                    <li key={reason}>{explainRiskReason(reason)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {checksumHex ? (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
                <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">
                  Checksum
                  <HelpTooltip label="Checksum" text="The checksum proves file integrity, not safety. The staged validator still checks every compiled instruction." />
                </p>
                <p className="mt-2 break-all font-mono text-xs text-slate-700">{checksumHex}</p>
              </div>
            ) : null}
          </section>

          <section className="panel-shell">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-teal-700">Interactive Sandbox</p>
            <div className="mt-4 space-y-4">
              <div className="field-shell">
                <span className="field-label flex items-center gap-2">
                  Test URL
                  <HelpTooltip label="Test URL" text="Runs this pack in memory against a sample URL without installing it." />
                </span>
                <input
                  aria-label="Test URL"
                  className="field-input"
                  placeholder="https://example.com/?utm_source=newsletter"
                  value={sandboxInput}
                  onChange={(event) => onSandboxInputChange(event.target.value)}
                />
              </div>

              <div className="field-shell">
                <span className="field-label flex items-center gap-2">
                  Result
                  <HelpTooltip label="Sandbox result" text="Shows the in-memory output or the validation/runtime error from the sandbox run." />
                </span>
                <textarea
                  aria-label="Result"
                  className="field-textarea min-h-28"
                  placeholder="Run the pack in-memory by entering a test URL."
                  readOnly
                  value={sandboxError ? sandboxError : sandboxOutput}
                />
              </div>
            </div>

            <div className="mt-4 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/75 px-4 py-3 text-sm text-slate-700">
              <input
                aria-label="Review acknowledged"
                checked={reviewAcknowledged}
                className="h-4 w-4 accent-amber-600"
                type="checkbox"
                onChange={(event) => onReviewAcknowledgedChange(event.target.checked)}
              />
              <span className="flex items-center gap-2">
                I have reviewed this logic and understand what it does.
                <HelpTooltip label="Review acknowledgment" text="This unlocks import only after you manually accept the staged behavior, or after a sandbox test has run." />
              </span>
            </div>

            {validationErrors.length > 0 ? (
              <div className="mt-4 rounded-2xl border border-rose-200 bg-rose-50/90 px-4 py-3 text-sm text-rose-700">
                <p className="font-semibold text-rose-900">Import is blocked until these issues are resolved:</p>
                <ul className="mt-2 list-disc pl-5">
                  {validationErrors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button className="ghost-button" type="button" onClick={onClose}>
                Cancel
              </button>
              <button className="primary-button" disabled={!confirmUnlocked} type="button" onClick={onConfirm}>
                Confirm Import
              </button>
            </div>
          </section>
        </div>

        <section className="panel-shell mt-6">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-700">What This Pack Does</p>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {pack.vm.instructions.map((instruction, index) => (
              <article key={`${instruction.nodeId}-${index}`} className="rounded-2xl border border-slate-200 bg-white/85 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">Step {index + 1}</p>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">{instruction.op}</span>
                </div>
                <p className="mt-3 text-sm font-semibold text-slate-900">{instructionLabel(instruction)}</p>
                <p className="mt-2 break-all font-mono text-[11px] text-slate-500">{instruction.nodeId}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
