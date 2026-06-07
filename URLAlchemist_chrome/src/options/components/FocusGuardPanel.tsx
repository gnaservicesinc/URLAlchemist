import { useState } from 'react';

import type { AssetRef, ActionPackLockLevel } from '../../shared/v2/types';

export interface FocusGuardDraft {
  name: string;
  description: string;
  blockedPatterns: string[];
  allowPatterns: string[];
  pageTitle: string;
  pageMessage: string;
  resourceId?: string;
  lockLevel: ActionPackLockLevel;
  password?: string;
}

interface FocusGuardPanelProps {
  resourceAssets: AssetRef[];
  onCreateFocusGuard: (draft: FocusGuardDraft) => void;
  onUploadResource: (file: File) => Promise<AssetRef>;
}

function linesFromText(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function FocusGuardPanel({ resourceAssets, onCreateFocusGuard, onUploadResource }: FocusGuardPanelProps) {
  const [name, setName] = useState('Focus Guard');
  const [description, setDescription] = useState('Local content blocker workspace.');
  const [blockedPatterns, setBlockedPatterns] = useState('social.example.com\n*.shorts.example');
  const [allowPatterns, setAllowPatterns] = useState('');
  const [pageTitle, setPageTitle] = useState('Focus Guard');
  const [pageMessage, setPageMessage] = useState('This page is blocked by URL Alchemist.');
  const [resourceId, setResourceId] = useState('');
  const [lockLevel, setLockLevel] = useState<ActionPackLockLevel>(1);
  const [password, setPassword] = useState('');

  const imageResources = resourceAssets.filter((asset) => asset.kind === 'image' || asset.kind === 'unknown');
  const canCreate = name.trim().length > 0
    && linesFromText(blockedPatterns).length > 0
    && (lockLevel !== 2 || password.trim().length >= 8);

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Focus Guard</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Content blocker workspace</h2>
        </div>
        <span className="risk-badge risk-badge-warn">Local only</span>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <label className="field-shell">
          <span className="field-label">Workspace name</span>
          <input className="field-input" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field-shell">
          <span className="field-label">Description</span>
          <input className="field-input" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="field-shell">
          <span className="field-label">Block rules</span>
          <textarea className="field-textarea min-h-36 font-mono text-xs" value={blockedPatterns} onChange={(event) => setBlockedPatterns(event.target.value)} />
        </label>
        <label className="field-shell">
          <span className="field-label">Allow rules</span>
          <textarea className="field-textarea min-h-36 font-mono text-xs" value={allowPatterns} onChange={(event) => setAllowPatterns(event.target.value)} />
        </label>
        <label className="field-shell">
          <span className="field-label">Block page title</span>
          <input className="field-input" value={pageTitle} onChange={(event) => setPageTitle(event.target.value)} />
        </label>
        <label className="field-shell">
          <span className="field-label">Block page message</span>
          <input className="field-input" value={pageMessage} onChange={(event) => setPageMessage(event.target.value)} />
        </label>
        <label className="field-shell">
          <span className="field-label">Block page image</span>
          <select className="field-input" value={resourceId} onChange={(event) => setResourceId(event.target.value)}>
            <option value="">None</option>
            {imageResources.map((asset) => {
              const id = asset.resourceId ?? asset.sha256 ?? '';
              return (
                <option key={id} value={id}>
                  {asset.name ?? id.slice(0, 12)}
                </option>
              );
            })}
          </select>
        </label>
        <label className="field-shell">
          <span className="field-label">Upload image</span>
          <input
            className="field-input"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                void onUploadResource(file).then((asset) => setResourceId(asset.resourceId ?? asset.sha256 ?? ''));
              }
              event.currentTarget.value = '';
            }}
          />
        </label>
        <label className="field-shell">
          <span className="field-label">Lock level</span>
          <select className="field-input" value={lockLevel} onChange={(event) => setLockLevel(Number(event.target.value) as ActionPackLockLevel)}>
            <option value={0}>Level 0 - none</option>
            <option value={1}>Level 1 - challenge</option>
            <option value={2}>Level 2 - password</option>
            <option value={3}>Level 3 - no in-app unlock</option>
          </select>
        </label>
        {lockLevel === 2 ? (
          <label className="field-shell">
            <span className="field-label">Password</span>
            <input className="field-input" minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
        ) : null}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <button
          className="primary-button"
          disabled={!canCreate}
          type="button"
          onClick={() => onCreateFocusGuard({
            name: name.trim(),
            description: description.trim(),
            blockedPatterns: linesFromText(blockedPatterns),
            allowPatterns: linesFromText(allowPatterns),
            pageTitle: pageTitle.trim() || 'Focus Guard',
            pageMessage: pageMessage.trim() || 'This page is blocked by URL Alchemist.',
            resourceId: resourceId || undefined,
            lockLevel,
            password,
          })}
        >
          Create Focus Guard
        </button>
        <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
          Locked packs can still be bypassed by extension removal or browser profile tampering.
        </span>
      </div>
    </section>
  );
}
