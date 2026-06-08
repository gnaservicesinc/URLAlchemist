import { useEffect, useState, type ChangeEvent, type RefObject } from 'react';

import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from '../../shared/constants';
import { normalizeUiScale } from '../../shared/hardening';
import type { GlobalSettings } from '../../shared/types';
import type { OllamaModelSummary } from '../../shared/v2/ollama';
import { HelpTooltip } from './HelpTooltip';

interface SettingsPanelProps {
  backupFileInputRef: RefObject<HTMLInputElement | null>;
  builderUuidFileInputRef: RefObject<HTMLInputElement | null>;
  builderUuidInput: string;
  builderUuidMessage: string | null;
  clipboardGranted: boolean;
  ollamaModels: OllamaModelSummary[];
  ollamaModelsBusy: boolean;
  ollamaModelsMessage: string | null;
  settings: GlobalSettings;
  onAdvancedModeToggle: () => void;
  onBackupFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onBuilderUuidFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onBuilderUuidInputChange: (value: string) => void;
  onExportBackup: () => void;
  onExportBuilderUuid: () => void;
  onDefaultLoggingToggle: () => void;
  onGlobalEnabledToggle: () => void;
  onLocalFilesToggle: () => void;
  onOllamaSettingsChange: (settings: Partial<Pick<GlobalSettings, 'ollamaEnabled' | 'ollamaEndpoint' | 'ollamaModel' | 'ollamaTimeoutMs'>>) => void;
  onRefreshOllamaModels: () => void;
  onRequestClipboardPermission: () => void;
  onRestoreBuilderUuid: () => void;
  onSyncEnabledToggle: () => void;
  onUndoHistoryLimitChange: (value: number) => void;
  onUiScaleChange: (value: number) => void;
}

function ToggleSwitch({ checked, label, onToggle }: { checked: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition focus:outline-none focus:ring-2 focus:ring-teal-100 ${
        checked ? 'border-teal-600 bg-teal-600' : 'border-slate-300 bg-slate-100'
      }`}
      role="switch"
      type="button"
      onClick={onToggle}
    >
      <span
        className={`h-5 w-5 rounded-full bg-white shadow-sm transition ${checked ? 'translate-x-5' : 'translate-x-1'}`}
      />
    </button>
  );
}

export function SettingsPanel({
  backupFileInputRef,
  builderUuidFileInputRef,
  builderUuidInput,
  builderUuidMessage,
  clipboardGranted,
  ollamaModels,
  ollamaModelsBusy,
  ollamaModelsMessage,
  settings,
  onAdvancedModeToggle,
  onBackupFileChange,
  onBuilderUuidFileChange,
  onBuilderUuidInputChange,
  onExportBackup,
  onExportBuilderUuid,
  onDefaultLoggingToggle,
  onGlobalEnabledToggle,
  onLocalFilesToggle,
  onOllamaSettingsChange,
  onRefreshOllamaModels,
  onRequestClipboardPermission,
  onRestoreBuilderUuid,
  onSyncEnabledToggle,
  onUndoHistoryLimitChange,
  onUiScaleChange,
}: SettingsPanelProps) {
  const [pendingUiScale, setPendingUiScale] = useState(() => normalizeUiScale(settings.uiScale));
  const activeUiScale = normalizeUiScale(settings.uiScale);
  const hasPendingUiScale = pendingUiScale !== activeUiScale;
  const selectedOllamaModelAvailable = ollamaModels.some((model) => model.name === settings.ollamaModel);

  useEffect(() => {
    setPendingUiScale(activeUiScale);
  }, [activeUiScale]);

  return (
    <section className="panel-shell reveal-panel">
      <p className="eyebrow">Settings</p>
      <h2 className="mt-2 text-2xl font-semibold text-slate-900">Local controls</h2>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Engine Enabled</p>
            <p className="text-xs text-slate-500">
              Allow background navigation interception. <HelpTooltip label="Engine enabled" text="When disabled, installed Action Packs remain saved but will not run on navigation, hotkeys, intervals, or context-menu actions." />
            </p>
          </div>
          <ToggleSwitch checked={settings.globalEnabled} label="Engine Enabled" onToggle={onGlobalEnabledToggle} />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Allow file URLs</p>
            <p className="text-xs text-slate-500">
              Disabled by default for local file safety. <HelpTooltip label="Allow file URLs" text="Allows transformed outputs to navigate to file:// URLs. Keep this off unless you explicitly need local file navigation." />
            </p>
          </div>
          <ToggleSwitch checked={settings.allowLocalFiles} label="Allow file URLs" onToggle={onLocalFilesToggle} />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Advanced Mode</p>
            <p className="text-xs text-slate-500">
              Enable manual regex editing in supported builders. <HelpTooltip label="Advanced mode" text="Manual regex mode bypasses the visual helper and should be used only when you understand the pattern." />
            </p>
          </div>
          <ToggleSwitch checked={settings.advancedModeEnabled} label="Advanced Mode" onToggle={onAdvancedModeToggle} />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">Google Sync</p>
            <p className="text-xs text-slate-500">
              Best-effort sync for settings and small workspaces or Action Packs. <HelpTooltip label="Google Sync" text="Large workspaces and Action Packs stay local because Chrome sync has a small per-item quota." />
            </p>
          </div>
          <ToggleSwitch checked={settings.syncEnabled} label="Google Sync" onToggle={onSyncEnabledToggle} />
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 bg-white/80 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-slate-900">New Action Pack logging</p>
            <p className="text-xs text-slate-500">
              Default for newly installed packs. Existing packs keep their own setting.
            </p>
          </div>
          <ToggleSwitch checked={settings.defaultActionPackLoggingEnabled} label="New Action Pack logging" onToggle={onDefaultLoggingToggle} />
        </div>

        <div className="rounded-lg border border-slate-200 bg-white/80 px-4 py-4 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">UI Scale</p>
              <p className="mt-1 text-xs text-slate-500">
                Stage a scale change, then apply it when the preview looks right. <HelpTooltip label="UI scale" text={`Allowed range is ${UI_SCALE_MIN}% to ${UI_SCALE_MAX}% in ${UI_SCALE_STEP}% steps.`} />
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="risk-badge risk-badge-soft">{activeUiScale}% active</span>
              {hasPendingUiScale ? <span className="risk-badge risk-badge-warn">{pendingUiScale}% pending</span> : null}
            </div>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_120px_auto_auto]">
            <input
              aria-label="UI scale"
              max={UI_SCALE_MAX}
              min={UI_SCALE_MIN}
              step={UI_SCALE_STEP}
              type="range"
              value={pendingUiScale}
              onChange={(event) => setPendingUiScale(normalizeUiScale(Number.parseInt(event.target.value, 10)))}
            />
            <input
              className="field-input"
              max={UI_SCALE_MAX}
              min={UI_SCALE_MIN}
              step={UI_SCALE_STEP}
              type="number"
              value={pendingUiScale}
              onChange={(event) => setPendingUiScale(normalizeUiScale(Number.parseInt(event.target.value || String(activeUiScale), 10)))}
            />
            <button className="primary-button" disabled={!hasPendingUiScale} type="button" onClick={() => onUiScaleChange(pendingUiScale)}>
              Apply
            </button>
            <button className="ghost-button" disabled={pendingUiScale === 100} type="button" onClick={() => setPendingUiScale(100)}>
              Reset
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white/80 px-4 py-4">
          <p className="text-sm font-semibold text-slate-900">Clipboard Permission</p>
          <p className="mt-1 text-xs text-slate-500">
            Needed for high-risk clipboard sources or outputs. <HelpTooltip label="Clipboard permission" text="Only grant clipboard access if you use packs that explicitly read from or write to the clipboard." />
          </p>
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className={`risk-badge ${clipboardGranted ? 'risk-badge-soft' : 'risk-badge-warn'}`}>
              {clipboardGranted ? 'Granted' : 'Not granted'}
            </span>
            <button className="ghost-button" disabled={clipboardGranted} type="button" onClick={onRequestClipboardPermission}>
              Grant Access
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white/80 px-4 py-4 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-900">AI Connectors</p>
              <p className="mt-1 text-xs text-slate-500">
                Ollama drafts workspace changes through a local loopback server. Runtime Action Packs do not call AI providers.
              </p>
            </div>
            <ToggleSwitch checked={settings.ollamaEnabled} label="AI Connectors" onToggle={() => onOllamaSettingsChange({ ollamaEnabled: !settings.ollamaEnabled })} />
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto_220px_140px]">
            <label className="field-shell">
              <span className="field-label">Endpoint</span>
              <input className="field-input" value={settings.ollamaEndpoint} onChange={(event) => onOllamaSettingsChange({ ollamaEndpoint: event.target.value })} />
            </label>
            <div className="flex items-end">
              <button className="secondary-button" disabled={ollamaModelsBusy} type="button" onClick={onRefreshOllamaModels}>
                {ollamaModelsBusy ? 'Refreshing...' : 'Refresh Models'}
              </button>
            </div>
            <label className="field-shell">
              <span className="field-label">Model</span>
              <select
                className="field-select"
                disabled={ollamaModels.length === 0}
                value={selectedOllamaModelAvailable ? settings.ollamaModel : ''}
                onChange={(event) => onOllamaSettingsChange({ ollamaModel: event.target.value })}
              >
                {ollamaModels.length === 0 ? <option value="">Refresh installed models</option> : null}
                {ollamaModels.map((model) => (
                  <option key={model.name} value={model.name}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-shell">
              <span className="field-label">Timeout ms</span>
              <input className="field-input" min={1000} max={120000} type="number" value={settings.ollamaTimeoutMs} onChange={(event) => onOllamaSettingsChange({ ollamaTimeoutMs: Number.parseInt(event.target.value || '30000', 10) })} />
            </label>
          </div>
          {ollamaModelsMessage ? (
            <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">{ollamaModelsMessage}</p>
          ) : null}
        </div>

        <div className="rounded-lg border border-slate-200 bg-white/80 px-4 py-4 lg:col-span-2">
          <p className="text-sm font-semibold text-slate-900">Undo history</p>
          <p className="mt-1 text-xs text-slate-500">
            Stored only for the open editor session. <HelpTooltip label="Undo history" text="Undo snapshots include workspace graph and block setting changes, but are not saved into backups, sync, or persistent storage." />
          </p>
          <label className="field-shell mt-3 max-w-xs">
            <span className="field-label">History length</span>
            <input className="field-input" min={0} max={10000} type="number" value={settings.undoHistoryLimit} onChange={(event) => onUndoHistoryLimitChange(Math.max(0, Math.min(10000, Number.parseInt(event.target.value || '0', 10))))} />
          </label>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white/80 px-4 py-4 lg:col-span-2">
          <p className="text-sm font-semibold text-slate-900">Local Builder UUID</p>
          <p className="mt-1 text-xs text-slate-500">
            Identifies this browser as the workspace builder. <HelpTooltip label="Local Builder UUID" text="Export this UUID before reinstalling if you want future builds to keep the same builder identity." />
          </p>
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
          {builderUuidMessage ? <p className="mt-3 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">{builderUuidMessage}</p> : null}
          <input ref={builderUuidFileInputRef} accept=".txt,text/plain" className="hidden" type="file" onChange={onBuilderUuidFileChange} />
        </div>

        <div className="rounded-lg border border-slate-200 bg-white/80 px-4 py-4 lg:col-span-2">
          <p className="text-sm font-semibold text-slate-900">Backup and Restore</p>
          <p className="mt-1 text-xs text-slate-500">
            Exports settings, workspaces, Action Packs, metadata, and checksums into one local backup blob. <HelpTooltip label="Backup and restore" text="Backups are the restore path if extension storage is cleared or the extension is uninstalled." />
          </p>
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
