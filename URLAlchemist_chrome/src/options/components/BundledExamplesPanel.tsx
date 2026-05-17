import type { BundledActionPackExample } from '../../shared/v2/bundledExamples';
import { formatRunType } from '../../shared/v2/labels';
import { useMemo, useState } from 'react';

interface BundledExamplesPanelProps {
  examples: BundledActionPackExample[];
  installedPackIds: Set<string>;
  savedWorkspaceIds: Set<string>;
  onDownloadActionPack: (example: BundledActionPackExample) => void;
  onDownloadWorkspace: (example: BundledActionPackExample) => void;
  onDeleteInstalledActionPack: (example: BundledActionPackExample) => void;
  onDeleteInstalledWorkspace: (example: BundledActionPackExample) => void;
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
  onDeleteInstalledActionPack,
  onDeleteInstalledWorkspace,
  onInstallActionPack,
  onOpenWorkspace,
}: BundledExamplesPanelProps) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');
  const categories = useMemo(() => ['All', ...Array.from(new Set(examples.map((example) => example.category))).sort()], [examples]);
  const visibleExamples = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return examples.filter((example) => {
      const matchesCategory = category === 'All' || example.category === category;
      const matchesQuery = !normalized || [
        example.name,
        example.description,
        example.trigger,
        formatRunType(example.trigger),
        example.category,
        ...example.features,
      ].join(' ').toLowerCase().includes(normalized);
      return matchesCategory && matchesQuery;
    });
  }, [category, examples, query]);

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Examples</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Built-in Action Packs</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Search practical examples by task. Install the compiled Action Pack directly, or open the workspace source to inspect and adapt the blocks first. These examples are never installed automatically.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-3">
        <input
          className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm text-slate-800 outline-none focus:border-amber-400"
          placeholder="Search examples"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {categories.map((entry) => (
            <button
              key={entry}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${category === entry ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-amber-300 hover:bg-amber-50'}`}
              type="button"
              onClick={() => setCategory(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {visibleExamples.map((example) => {
          const installed = installedPackIds.has(example.id);
          const savedWorkspace = savedWorkspaceIds.has(example.id);

          return (
            <article key={example.id} className="rounded-[1.25rem] border border-slate-200 bg-white/85 p-5 shadow-[0_12px_28px_rgba(15,23,42,0.07)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{example.name}</h3>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{example.category} / {formatRunType(example.trigger)}</p>
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
                {installed ? (
                  <button className="ghost-button" type="button" onClick={() => onDeleteInstalledActionPack(example)}>
                    Delete Installed Action Pack
                  </button>
                ) : null}
                {savedWorkspace ? (
                  <button className="ghost-button" type="button" onClick={() => onDeleteInstalledWorkspace(example)}>
                    Delete Installed Workspace
                  </button>
                ) : null}
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
