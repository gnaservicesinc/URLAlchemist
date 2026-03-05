import { describeMatchMode, formatTimestamp, isGlobalScope, normalizeHotkeyLabel, packUsesClipboard } from '../../shared/helpers';
import type { ImportEnvelope } from '../../shared/types';

interface StagingModalProps {
  envelope: ImportEnvelope | null;
  sandboxInput: string;
  sandboxOutput: string;
  sandboxError: string | null;
  hasSandboxRun: boolean;
  reviewAcknowledged: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onReviewAcknowledgedChange: (checked: boolean) => void;
  onSandboxInputChange: (value: string) => void;
}

export function StagingModal({
  envelope,
  sandboxInput,
  sandboxOutput,
  sandboxError,
  hasSandboxRun,
  reviewAcknowledged,
  onClose,
  onConfirm,
  onReviewAcknowledgedChange,
  onSandboxInputChange,
}: StagingModalProps) {
  if (!envelope) {
    return null;
  }

  const { pack } = envelope;
  const confirmUnlocked = hasSandboxRun || reviewAcknowledged;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/55 px-4 py-10 backdrop-blur-md">
      <div className="reveal-panel relative w-full max-w-5xl rounded-[2rem] border border-white/60 bg-[rgba(255,252,246,0.95)] p-6 shadow-[0_32px_90px_rgba(15,23,42,0.26)] md:p-8">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">Staging Area</p>
            <h2 className="text-3xl font-semibold tracking-tight text-slate-900">Inspect before import</h2>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              The pack is staged in memory only. Nothing is saved until you confirm after reviewing or testing.
            </p>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <section className="panel-shell">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">Manifest</p>
                <h3 className="mt-2 text-2xl font-semibold text-slate-900">{pack.name}</h3>
                <p className="mt-1 text-sm text-slate-600">
                  {pack.metadata.author?.trim() || 'Unknown author'} · Version {pack.version}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {isGlobalScope(pack.trigger.scope_regex) ? <span className="risk-badge risk-badge-danger">Global scope</span> : null}
                {packUsesClipboard(pack) ? <span className="risk-badge risk-badge-warn">Clipboard access</span> : null}
                <span className="risk-badge risk-badge-soft">Schema {envelope.schemaVersion}</span>
              </div>
            </div>

            <dl className="mt-5 grid gap-3 text-sm text-slate-700 sm:grid-cols-2">
              <div className="info-chip">
                <dt className="font-semibold text-slate-900">Trigger</dt>
                <dd>{pack.trigger.type}</dd>
              </div>
              <div className="info-chip">
                <dt className="font-semibold text-slate-900">Hotkey</dt>
                <dd>{normalizeHotkeyLabel(pack.trigger.hotkey)}</dd>
              </div>
              <div className="info-chip sm:col-span-2">
                <dt className="font-semibold text-slate-900">Scope Regex</dt>
                <dd className="break-all">{pack.trigger.scope_regex?.trim() || 'Runs globally'}</dd>
              </div>
              <div className="info-chip sm:col-span-2">
                <dt className="font-semibold text-slate-900">Created</dt>
                <dd>{formatTimestamp(pack.metadata.created_at)}</dd>
              </div>
              <div className="info-chip sm:col-span-2">
                <dt className="font-semibold text-slate-900">Description</dt>
                <dd>{pack.metadata.description?.trim() || 'No description supplied'}</dd>
              </div>
            </dl>

            <div className="mt-6 rounded-3xl border border-amber-200/80 bg-amber-50/80 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-amber-700">Checksum</p>
              <p className="mt-2 break-all font-mono text-xs text-amber-950">{envelope.checksumHex}</p>
            </div>
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
                  value={sandboxError ? sandboxError : sandboxOutput}
                  placeholder="Run the logic in-memory by entering a test URL."
                  readOnly
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

            <p className="mt-3 text-xs text-slate-500">
              Confirm unlocks after one sandbox run or after the review checkbox is enabled.
            </p>

            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <button className="ghost-button" type="button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary-button"
                disabled={!confirmUnlocked}
                type="button"
                onClick={onConfirm}
              >
                Confirm Import
              </button>
            </div>
          </section>
        </div>

        <section className="panel-shell mt-6">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-700">Visual Decompiler</p>
          <div className="mt-4 grid gap-4">
            {pack.activities.map((activity) => (
              <article key={activity.id} className="rounded-3xl border border-slate-200 bg-white/85 p-4 shadow-[0_12px_34px_rgba(15,23,42,0.08)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-500">Activity {activity.order}</p>
                    <h4 className="mt-2 text-lg font-semibold text-slate-900">{activity.action}</h4>
                  </div>
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                    {describeMatchMode(activity)}
                  </span>
                </div>
                <p className="mt-4 text-sm text-slate-700">
                  Pattern: <span className="font-mono text-xs text-slate-950">{activity.pattern}</span>
                </p>
                {activity.payload ? (
                  <p className="mt-2 text-sm text-slate-700">
                    Payload: <span className="font-mono text-xs text-slate-950">{activity.payload}</span>
                  </p>
                ) : null}
                {activity.condition ? (
                  <p className="mt-2 text-sm text-slate-700">
                    Condition: {activity.condition.type} on {activity.condition.target.toLowerCase()} using{' '}
                    <span className="font-mono text-xs text-slate-950">{activity.condition.value}</span>
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-slate-500">Condition: Always executes when the pack runs.</p>
                )}
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
