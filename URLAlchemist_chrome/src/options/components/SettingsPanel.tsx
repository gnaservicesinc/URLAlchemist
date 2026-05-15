import type { ChangeEvent, RefObject } from 'react';

import type { GlobalSettings } from '../../shared/types';

interface SettingsPanelProps {
  backupFileInputRef: RefObject<HTMLInputElement | null>;
  builderUuidFileInputRef: RefObject<HTMLInputElement | null>;
  builderUuidInput: string;
  builderUuidMessage: string | null;
  clipboardGranted: boolean;
  settings: GlobalSettings;
  onAdvancedModeToggle: () => void;
  onBackupFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onBuilderUuidFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onBuilderUuidInputChange: (value: string) => void;
  onExportBackup: () => void;
  onExportBuilderUuid: () => void;
  onGlobalEnabledToggle: () => void;
  onLocalFilesToggle: () => void;
  onRequestClipboardPermission: () => void;
  onRestoreBuilderUuid: () => void;
  onSyncEnabledToggle: () => void;
  onUiScaleChange: (value: number) => void;
}

export function SettingsPanel({
  backupFileInputRef,
  builderUuidFileInputRef,
  builderUuidInput,
  builderUuidMessage,
  clipboardGranted,
  settings,
  onAdvancedModeToggle,
  onBackupFileChange,
  onBuilderUuidFileChange,
  onBuilderUuidInputChange,
  onExportBackup,
  onExportBuilderUuid,
  onGlobalEnabledToggle,
  onLocalFilesToggle,
  onRequestClipboardPermission,
  onRestoreBuilderUuid,
  onSyncEnabledToggle,
  onUiScaleChange,
}: SettingsPanelProps) {
  return (
    <section className="panel-shell reveal-panel">
      <p className="eyebrow">Settings</p>
      <h2 className="mt-2 text-2xl font-semibold text-slate-900">Local controls</h2>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Engine Enabled</p>
            <p className="text-xs text-slate-500">Allow background navigation interception.</p>
          </div>
          <input checked={settings.globalEnabled} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={onGlobalEnabledToggle} />
        </label>

        <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Allow file URLs</p>
            <p className="text-xs text-slate-500">Disabled by default for local file safety.</p>
          </div>
          <input checked={settings.allowLocalFiles} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={onLocalFilesToggle} />
        </label>

        <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Advanced Mode</p>
            <p className="text-xs text-slate-500">Enable manual regex editing in supported builders.</p>
          </div>
          <input checked={settings.advancedModeEnabled} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={onAdvancedModeToggle} />
        </label>

        <label className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Google Sync</p>
            <p className="text-xs text-slate-500">Best-effort sync for settings and small workspaces or Action Packs.</p>
          </div>
          <input checked={settings.syncEnabled} className="h-5 w-5 accent-amber-600" type="checkbox" onChange={onSyncEnabledToggle} />
        </label>

        <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">UI Scale</p>
              <p className="mt-1 text-xs text-slate-500">Scales the options interface from compact review mode to high-zoom accessibility mode.</p>
            </div>
            <span className="risk-badge risk-badge-soft">{settings.uiScale}%</span>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_120px_auto]">
            <input
              aria-label="UI scale"
              max={600}
              min={10}
              step={10}
              type="range"
              value={settings.uiScale}
              onChange={(event) => onUiScaleChange(Number.parseInt(event.target.value, 10))}
            />
            <input
              className="field-input"
              max={600}
              min={10}
              step={10}
              type="number"
              value={settings.uiScale}
              onChange={(event) => onUiScaleChange(Number.parseInt(event.target.value || '100', 10))}
            />
            <button className="ghost-button" type="button" onClick={() => onUiScaleChange(100)}>
              Reset
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4">
          <p className="text-sm font-semibold text-slate-900">Clipboard Permission</p>
          <p className="mt-1 text-xs text-slate-500">Needed for high-risk clipboard sources or outputs.</p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className={`risk-badge ${clipboardGranted ? 'risk-badge-soft' : 'risk-badge-warn'}`}>
              {clipboardGranted ? 'Granted' : 'Not granted'}
            </span>
            <button className="ghost-button" disabled={clipboardGranted} type="button" onClick={onRequestClipboardPermission}>
              Grant Access
            </button>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 lg:col-span-2">
          <p className="text-sm font-semibold text-slate-900">Local Builder UUID</p>
          <p className="mt-1 break-all font-mono text-[11px] text-slate-500">{settings.builderUuid}</p>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_auto_auto]">
            <input
              className="field-input"
              placeholder="Paste UUID or URL_ALCHEMIST_BUILDER_UUID=..."
              value={builderUuidInput}
              onChange={(event) => onBuilderUuidInputChange(event.target.value)}
            />
            <button className="primary-button" type="button" onClick={onRestoreBuilderUuid}>
              Restore UUID
            </button>
            <button className="ghost-button" type="button" onClick={() => builderUuidFileInputRef.current?.click()}>
              Upload UUID
            </button>
            <button className="ghost-button" type="button" onClick={onExportBuilderUuid}>
              Save UUID
            </button>
          </div>
          {builderUuidMessage ? <p className="mt-3 rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">{builderUuidMessage}</p> : null}
          <input ref={builderUuidFileInputRef} accept=".txt,text/plain" className="hidden" type="file" onChange={onBuilderUuidFileChange} />
        </div>

        <div className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-4 lg:col-span-2">
          <p className="text-sm font-semibold text-slate-900">Backup and Restore</p>
          <p className="mt-1 text-xs text-slate-500">Exports settings, workspaces, Action Packs, metadata, and checksums into one local backup blob.</p>
          <div className="mt-4 flex flex-wrap gap-3">
            <button className="primary-button" type="button" onClick={onExportBackup}>
              Export Backup
            </button>
            <button className="ghost-button" type="button" onClick={() => backupFileInputRef.current?.click()}>
              Restore Backup
            </button>
          </div>
          <input ref={backupFileInputRef} accept=".json,application/json,text/plain" className="hidden" type="file" onChange={onBackupFileChange} />
        </div>
      </div>
    </section>
  );
}
