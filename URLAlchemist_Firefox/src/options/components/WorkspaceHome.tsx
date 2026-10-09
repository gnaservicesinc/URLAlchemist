import { useMemo, useState } from 'react';

import { formatRunType } from '../../shared/v2/labels';
import type { WorkspaceFileV2, WorkspaceType } from '../../shared/v2/types';

interface WorkspaceHomeProps {
  workspaces: WorkspaceFileV2[];
  currentWorkspace: WorkspaceFileV2;
  isDirty: boolean;
  onNew: (type: WorkspaceType) => void;
  onOpen: (id: string) => void;
  onResume: () => void;
  onExamples: () => void;
  onImport: () => void;
}

const WORKSPACE_TYPES: Array<{ type: WorkspaceType; title: string; description: string; mark: string }> = [
  { type: 'data-modifier', title: 'Browser workflow', description: 'Transform links, text, clipboard data, and pages into useful actions.', mark: '↗' },
  { type: 'content-blocker', title: 'Content Blocker', description: 'Build a Focus Guard with your own block rules and page experience.', mark: '◇' },
  { type: 'custom-block', title: 'Reusable block', description: 'Package a flow once, then use it in other workspaces.', mark: '▦' },
];

function workspaceTypeLabel(type: WorkspaceType): string {
  return WORKSPACE_TYPES.find((entry) => entry.type === type)?.title ?? 'Browser workflow';
}

export function WorkspaceHome({ workspaces, currentWorkspace, isDirty, onNew, onOpen, onResume, onExamples, onImport }: WorkspaceHomeProps) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<WorkspaceType | 'all'>('all');
  const visibleWorkspaces = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return workspaces
      .filter((workspace) => (type === 'all' || workspace.workspaceType === type)
        && (!normalized || `${workspace.metadata.name} ${workspace.metadata.description ?? ''} ${workspaceTypeLabel(workspace.workspaceType)} ${formatRunType(workspace.trigger.type)}`.toLowerCase().includes(normalized)))
      .slice()
      .sort((left, right) => right.metadata.updated_at - left.metadata.updated_at);
  }, [query, type, workspaces]);
  const hasCurrentWorkspace = isDirty || workspaces.some((entry) => entry.metadata.id === currentWorkspace.metadata.id);

  return (
    <div className="workspace-home space-y-7">
      <section className="workspace-welcome">
        <div>
          <p className="eyebrow">Your workspace</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Make the browser work your way.</h1>
          <p className="mt-3 max-w-xl text-sm leading-6 text-slate-600">Start with a workflow, connect your blocks, and test the result. Your editable workspace stays here as you build.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <button className="primary-button" type="button" onClick={() => onNew('data-modifier')}>+ New workspace</button>
            <button className="ghost-button" type="button" onClick={onExamples}>Explore examples</button>
            <button className="ghost-button" type="button" onClick={onImport}>Import a file</button>
          </div>
        </div>
        <ol className="workspace-journey" aria-label="How to build a project">
          <li><span>01</span><div><strong>Configure</strong><p>Name your workspace and choose what starts it.</p></div></li>
          <li><span>02</span><div><strong>Build flow</strong><p>Add blocks and connect inputs to outputs.</p></div></li>
          <li><span>03</span><div><strong>Test & review</strong><p>Try sample data, then build your Action Pack.</p></div></li>
        </ol>
      </section>

      {hasCurrentWorkspace ? (
        <button className="workspace-resume" type="button" onClick={onResume}>
          <span className="workspace-project-mark" aria-hidden="true">↗</span>
          <span className="min-w-0 flex-1 text-left"><span className="block text-xs font-semibold text-teal-700">{isDirty ? 'Continue your draft' : 'Return to the editor'}</span><span className="mt-1 block truncate font-semibold text-slate-900">{currentWorkspace.metadata.name}</span></span>
          <span className="text-xs text-slate-500">{isDirty ? 'Unsaved changes' : 'Saved workspace'}</span>
          <span aria-hidden="true">→</span>
        </button>
      ) : null}

      <section aria-labelledby="saved-workspaces-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h2 id="saved-workspaces-heading" className="text-xl font-semibold text-slate-950">Your workspaces <span className="ml-1 text-sm font-normal text-slate-400">{workspaces.length}</span></h2><p className="mt-1 text-sm text-slate-500">Open a project to keep building. Recently edited workspaces appear first.</p></div>
          <label className="workspace-search"><span aria-hidden="true">⌕</span><input aria-label="Search workspaces" placeholder="Search your workspaces…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Filter workspace types">
          {[{ type: 'all' as const, title: 'All workspaces' }, ...WORKSPACE_TYPES].map((entry) => (
            <button key={entry.type} type="button" aria-pressed={type === entry.type} className={`workspace-filter ${type === entry.type ? 'is-active' : ''}`} onClick={() => setType(entry.type)}>{entry.title}</button>
          ))}
        </div>
        {visibleWorkspaces.length > 0 ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {visibleWorkspaces.map((workspace) => (
              <button key={workspace.metadata.id} type="button" className="workspace-project-card" onClick={() => onOpen(workspace.metadata.id)}>
                <span className="flex items-center justify-between gap-3"><span className="workspace-project-mark" aria-hidden="true">{WORKSPACE_TYPES.find((entry) => entry.type === workspace.workspaceType)?.mark}</span><span className="text-xs text-slate-500">{workspaceTypeLabel(workspace.workspaceType)}</span></span>
                <span className="mt-4 block truncate text-base font-semibold text-slate-950">{workspace.metadata.name}</span>
                <span className="mt-1 line-clamp-2 block min-h-10 text-sm leading-5 text-slate-500">{workspace.metadata.description || 'Ready for your next idea.'}</span>
                <span className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 text-xs text-slate-500"><span>{workspace.nodes.length + (workspace.surfaces ?? []).reduce((count, surface) => count + surface.nodes.length, 0)} blocks</span><span aria-hidden="true">·</span><span>{formatRunType(workspace.trigger.type)}</span><span className="ml-auto text-teal-700">Open →</span></span>
              </button>
            ))}
          </div>
        ) : (
          <div className="workspace-empty mt-4">
            <span className="workspace-project-mark mx-auto" aria-hidden="true">▦</span>
            <h3 className="mt-3 font-semibold text-slate-900">{workspaces.length === 0 ? 'A place for your next idea' : 'No matching workspaces'}</h3>
            <p className="mt-2 text-sm text-slate-500">{workspaces.length === 0 ? 'Create a workspace from scratch or start with an example you can adapt.' : 'Try another search or workspace type.'}</p>
            <button className="ghost-button mt-4" type="button" onClick={() => workspaces.length === 0 ? onNew('data-modifier') : (setQuery(''), setType('all'))}>{workspaces.length === 0 ? 'Create your first workspace' : 'Clear filters'}</button>
          </div>
        )}
      </section>

      <section aria-labelledby="workspace-start-heading">
        <h2 id="workspace-start-heading" className="text-lg font-semibold text-slate-950">Choose a starting point</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-3">
          {WORKSPACE_TYPES.map((entry) => <button className="workspace-start-card" type="button" key={entry.type} onClick={() => onNew(entry.type)}><span className="text-2xl text-teal-700" aria-hidden="true">{entry.mark}</span><span><strong className="block text-sm text-slate-900">{entry.title}</strong><span className="mt-1 block text-xs leading-5 text-slate-500">{entry.description}</span></span></button>)}
        </div>
      </section>
    </div>
  );
}
