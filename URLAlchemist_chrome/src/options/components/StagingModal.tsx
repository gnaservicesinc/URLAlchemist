import type { CompiledActionPackV2 } from '../../shared/v2/types';

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

function instructionLabel(instruction: CompiledActionPackV2['vm']['instructions'][number]): string {
  switch (instruction.op) {
    case 'SOURCE':
      return `Reads ${instruction.source}`;
    case 'OUTPUT':
      return `Writes ${instruction.destination}`;
    case 'REGEX_TRANSFORM':
      return `${instruction.action} with "${instruction.pattern}"`;
    case 'COMPARE':
      return `Compares input ${instruction.operator} ${instruction.compareValue}`;
    case 'MATH':
      return `Runs ${instruction.operation.toLowerCase()}`;
    case 'CONVERT':
      return `Converts ${instruction.mode.toLowerCase()}`;
    case 'DECLARE':
      return `Declares ${instruction.name}`;
    case 'SAVELOAD':
      return `${instruction.mode.toLowerCase()} session value`;
    case 'DICT_SET':
      return 'Adds or updates a dictionary key';
    case 'LOOP':
      return `Loops up to ${instruction.loopLimit} times`;
    default:
      return 'Instruction';
  }
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

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 px-4 py-10 backdrop-blur-md">
      <div className="reveal-panel relative w-full max-w-6xl rounded-[2rem] border border-white/60 bg-[rgba(255,252,246,0.97)] p-6 shadow-[0_32px_90px_rgba(15,23,42,0.26)] md:p-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Staging Area</p>
            <h2 className="text-3xl font-semibold tracking-tight text-slate-900">Inspect Action Pack</h2>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              The pack is staged in memory only. Nothing is installed until you confirm after reviewing or testing.
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
              This Action Pack touches sensitive inputs or outputs such as clipboard, raw page content, full page text, file data, console-like data, or page mutation.
            </p>
          </div>
        ) : pack.risk.highest === 'extended' ? (
          <div className="mb-5 rounded-[1.5rem] border border-amber-300 bg-amber-100 px-5 py-4 text-amber-950">
            <p className="font-semibold">Extended data access</p>
            <p className="mt-1 text-sm">Enable trace for the first day after install so you can inspect what the pack touches.</p>
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
                <span className={`risk-badge ${riskClass(pack.risk.highest)}`}>{pack.risk.highest} risk</span>
                <span className="risk-badge risk-badge-soft">Schema {pack.schemaVersion}</span>
              </div>
            </div>

            <dl className="mt-5 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
              <div className="info-chip">
                <dt className="font-semibold text-slate-900">Trigger</dt>
                <dd>{pack.manifest.trigger.type}</dd>
              </div>
              <div className="info-chip">
                <dt className="font-semibold text-slate-900">Instructions</dt>
                <dd>{pack.vm.instructions.length}</dd>
              </div>
              <div className="info-chip sm:col-span-2">
                <dt className="font-semibold text-slate-900">Scope Regex</dt>
                <dd className="break-all">{pack.manifest.trigger.scope_regex?.trim() || 'Runs globally'}</dd>
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
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {checksumHex ? (
              <div className="mt-5 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Checksum</p>
                <p className="mt-2 break-all font-mono text-xs text-slate-700">{checksumHex}</p>
              </div>
            ) : null}
          </section>

          <section className="panel-shell">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-teal-700">Interactive Sandbox</p>
            <div className="mt-4 space-y-4">
              <label className="field-shell">
                <span className="field-label">Test URL</span>
                <input
                  className="field-input"
                  placeholder="https://example.com/?utm_source=newsletter"
                  value={sandboxInput}
                  onChange={(event) => onSandboxInputChange(event.target.value)}
                />
              </label>

              <label className="field-shell">
                <span className="field-label">Result</span>
                <textarea
                  className="field-textarea min-h-28"
                  placeholder="Run the pack in-memory by entering a test URL."
                  readOnly
                  value={sandboxError ? sandboxError : sandboxOutput}
                />
              </label>
            </div>

            <label className="mt-4 flex items-center gap-3 rounded-2xl border border-slate-200 bg-white/75 px-4 py-3 text-sm text-slate-700">
              <input
                checked={reviewAcknowledged}
                className="h-4 w-4 accent-amber-600"
                type="checkbox"
                onChange={(event) => onReviewAcknowledgedChange(event.target.checked)}
              />
              I have reviewed this logic and understand what it does.
            </label>

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
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-700">Visual Decompiler</p>
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
