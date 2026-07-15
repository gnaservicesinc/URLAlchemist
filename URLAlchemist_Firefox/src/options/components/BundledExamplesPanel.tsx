import type { BundledActionPackExample } from '../../shared/v2/bundledExamples';
import { formatRunType } from '../../shared/v2/labels';
import { useMemo, useState } from 'react';

interface BundledExamplesPanelProps {
  examples: BundledActionPackExample[];
  collection: 'bundled' | 'examples';
  installedPackIds: Set<string>;
  savedWorkspaceIds: Set<string>;
  onDownloadActionPack: (example: BundledActionPackExample) => void;
  onDownloadWorkspace: (example: BundledActionPackExample) => void;
  onDeleteInstalledActionPack: (example: BundledActionPackExample) => void;
  onDeleteInstalledWorkspace: (example: BundledActionPackExample) => void;
  onInstallActionPack: (example: BundledActionPackExample) => void;
  onOpenWorkspace: (example: BundledActionPackExample) => void;
}

function collectionForExample(example: BundledActionPackExample): 'bundled' | 'examples' {
  return example.collection;
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
  collection,
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
  const collectionExamples = useMemo(
    () => examples.filter((example) => collectionForExample(example) === collection),
    [collection, examples],
  );
  const categories = useMemo(() => ['All', ...Array.from(new Set(collectionExamples.map((example) => example.category))).sort()], [collectionExamples]);
  const visibleExamples = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return collectionExamples.filter((example) => {
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
  }, [category, collectionExamples, query]);

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">{collection === 'bundled' ? 'Bundled' : 'Examples'}</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">{collection === 'bundled' ? 'Verified starter packs' : 'Example workspaces'}</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Search practical examples by task. Install the compiled Action Pack directly, or open the workspace source to inspect and adapt the blocks first. These examples are never installed automatically.
          </p>
        </div>
      </div>

      <div className="mt-6 grid gap-3">
        <input
          className="field-input"
          placeholder="Search examples"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          {categories.map((entry) => (
            <button
              key={entry}
              className={`rounded-md border px-3 py-1.5 text-xs font-bold transition ${category === entry ? 'border-teal-700 bg-teal-700 text-white' : 'border-slate-200 bg-white text-slate-600 hover:border-teal-300 hover:bg-teal-50 hover:text-teal-900'}`}
              type="button"
              onClick={() => setCategory(entry)}
            >
              {entry}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visibleExamples.map((example) => {
          const hasActionPack = Boolean(example.actionPackPath);
          const installed = hasActionPack && installedPackIds.has(example.id);
          const savedWorkspace = savedWorkspaceIds.has(example.id);

          return (
            <article key={example.id} className="flex h-full flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-[0_8px_20px_rgba(31,41,55,0.06)]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-slate-900">{example.name}</h3>
                  <p className="mt-1 text-xs uppercase tracking-[0.18em] text-slate-500">{example.category} / {formatRunType(example.trigger)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={`risk-badge ${riskClass(example.risk)}`}>{riskLabel(example.risk)}</span>
                  <span className="risk-badge risk-badge-soft">Chrome</span>
                  <span className="risk-badge risk-badge-soft">Firefox desktop</span>
                  <span className="risk-badge risk-badge-warn">Android source-only</span>
                  {installed ? <span className="risk-badge risk-badge-soft">Installed</span> : null}
                  {savedWorkspace ? <span className="risk-badge risk-badge-soft">Workspace saved</span> : null}
                </div>
              </div>

              <p className="mt-3 text-sm leading-6 text-slate-600">{example.description}</p>

              <div className="mt-4 flex flex-wrap gap-2">
                {example.features.map((feature) => (
                  <span key={feature} className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-600">
                    {feature}
                  </span>
                ))}
              </div>

              <div className="mt-auto flex flex-wrap gap-2 pt-5">
                {hasActionPack ? (
                  <button className="primary-button" type="button" onClick={() => onInstallActionPack(example)}>
                    {installed ? 'Reinstall Action Pack' : 'Install Action Pack'}
                  </button>
                ) : null}
                <button className="secondary-button" type="button" onClick={() => onOpenWorkspace(example)}>
                  {savedWorkspace ? 'Restore Workspace' : 'Open Workspace'}
                </button>
                {hasActionPack ? (
                  <button className="ghost-button" type="button" onClick={() => onDownloadActionPack(example)}>
                    Export Pack
                  </button>
                ) : null}
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
