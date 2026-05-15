import type { BundledActionPackExample } from '../../shared/v2/bundledExamples';

interface BundledExamplesPanelProps {
  examples: BundledActionPackExample[];
  installedPackIds: Set<string>;
  savedWorkspaceIds: Set<string>;
  onDownloadActionPack: (example: BundledActionPackExample) => void;
  onDownloadWorkspace: (example: BundledActionPackExample) => void;
  onInstallActionPack: (example: BundledActionPackExample) => void;
  onOpenWorkspace: (example: BundledActionPackExample) => void;
}

function riskClass(risk: BundledActionPackExample['risk']): string {
  if (risk === 'high') {
    return 'risk-badge-danger';
  }

  if (risk === 'extended') {
    return 'risk-badge-warn';
  }

  return 'risk-badge-soft';
}

function riskLabel(risk: BundledActionPackExample['risk']): string {
  if (risk === 'high') {
    return 'High risk';
  }

  if (risk === 'extended') {
    return 'Extended';
  }

  return 'Standard';
}

export function BundledExamplesPanel({
  examples,
  installedPackIds,
  savedWorkspaceIds,
  onDownloadActionPack,
  onDownloadWorkspace,
  onInstallActionPack,
  onOpenWorkspace,
}: BundledExamplesPanelProps) {
  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Examples</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Built-in Action Packs</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Open a workspace to inspect or change the source, or install the compiled Action Pack directly. These examples are never installed automatically.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {examples.map((example) => {
          const installed = installedPackIds.has(example.id);
          const savedWorkspace = savedWorkspaceIds.has(example.id);

          return (
            <article key={example.id} className="rounded-[1.25rem] border border-slate-200 bg-white/85 p-5 shadow-[0_12px_28px_rgba(15,23,42,0.07)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{example.name}</h3>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{example.trigger}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={`risk-badge ${riskClass(example.risk)}`}>{riskLabel(example.risk)}</span>
                  {installed ? <span className="risk-badge risk-badge-soft">Installed</span> : null}
                  {savedWorkspace ? <span className="risk-badge risk-badge-soft">Workspace saved</span> : null}
                </div>
              </div>

              <p className="mt-3 text-sm leading-6 text-slate-600">{example.description}</p>

              <div className="mt-4 flex flex-wrap gap-2">
                {example.features.map((feature) => (
                  <span key={feature} className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">
                    {feature}
                  </span>
                ))}
              </div>

              <div className="mt-5 flex flex-wrap gap-3">
                <button className="primary-button" type="button" onClick={() => onInstallActionPack(example)}>
                  {installed ? 'Reinstall Action Pack' : 'Install Action Pack'}
                </button>
                <button className="secondary-button" type="button" onClick={() => onOpenWorkspace(example)}>
                  {savedWorkspace ? 'Restore Workspace' : 'Open Workspace'}
                </button>
                <button className="ghost-button" type="button" onClick={() => onDownloadActionPack(example)}>
                  Export Pack
                </button>
                <button className="ghost-button" type="button" onClick={() => onDownloadWorkspace(example)}>
                  Export Workspace
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

