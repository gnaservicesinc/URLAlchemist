import { useState } from 'react';

import { URL_ALCHEMIST_BUILD_TIME, URL_ALCHEMIST_VERSION } from '../../shared/v2/buildInfo';

const SOURCE_URL = 'https://github.com/gnaservicesinc/URLAlchemist';
const LICENSE_URL = 'https://raw.githubusercontent.com/gnaservicesinc/URLAlchemist/refs/heads/main/LICENSE';
const ISSUE_URL = 'https://github.com/gnaservicesinc/URLAlchemist/issues/new';

interface AboutPanelProps {
  onResetEverything: () => void;
}

function openExternal(url: string): void {
  const chromeApi = (globalThis as unknown as { chrome?: typeof chrome }).chrome;
  if (chromeApi?.tabs?.create) {
    void chromeApi.tabs.create({ url });
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

function downloadText(text: string, filename: string): void {
  const objectUrl = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

export function AboutPanel({ onResetEverything }: AboutPanelProps) {
  const [licenseText, setLicenseText] = useState('');
  const [licenseMessage, setLicenseMessage] = useState<string | null>(null);
  const [licenseBusy, setLicenseBusy] = useState(false);

  async function loadLicense(): Promise<string> {
    if (licenseText) {
      return licenseText;
    }

    setLicenseBusy(true);
    setLicenseMessage(null);
    try {
      const response = await fetch(LICENSE_URL);
      if (!response.ok) {
        throw new Error(`License fetch failed with HTTP ${response.status}`);
      }
      const text = await response.text();
      setLicenseText(text);
      return text;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to fetch license.';
      setLicenseMessage(message);
      throw error;
    } finally {
      setLicenseBusy(false);
    }
  }

  async function handleCopyLicense(): Promise<void> {
    try {
      const text = await loadLicense();
      await navigator.clipboard.writeText(text);
      setLicenseMessage('License text copied.');
    } catch {
      // loadLicense already reported the useful error.
    }
  }

  async function handleDownloadLicense(): Promise<void> {
    try {
      downloadText(await loadLicense(), 'URLAlchemist-GPLv3-LICENSE.txt');
      setLicenseMessage('License file prepared.');
    } catch {
      // loadLicense already reported the useful error.
    }
  }

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">About</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">URL Alchemist Chrome target</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">Version, build, project links, license access, and environment reset.</p>
        </div>
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="info-chip">
          <span className="field-label">Version</span>
          <p className="mt-2 text-lg font-semibold text-slate-900">{URL_ALCHEMIST_VERSION}</p>
        </div>
        <div className="info-chip">
          <span className="field-label">Build</span>
          <p className="mt-2 break-all text-sm font-semibold text-slate-900">{URL_ALCHEMIST_BUILD_TIME}</p>
        </div>
        <div className="info-chip">
          <span className="field-label">Target</span>
          <p className="mt-2 text-lg font-semibold text-slate-900">Google Chrome MV3</p>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        <button className="primary-button" type="button" onClick={() => openExternal(SOURCE_URL)}>
          Source Code
        </button>
        <button className="ghost-button" type="button" onClick={() => void handleDownloadLicense()}>
          Download GPLv3 License
        </button>
        <button className="ghost-button" type="button" onClick={() => void handleCopyLicense()}>
          Copy License Text
        </button>
        <button className="ghost-button" type="button" onClick={() => openExternal(ISSUE_URL)}>
          Report Issue
        </button>
      </div>

      {licenseMessage ? <p className="mt-4 rounded-lg bg-slate-50 px-4 py-3 text-sm text-slate-700">{licenseMessage}</p> : null}

      <div className="mt-5 max-h-80 overflow-auto rounded-lg border border-slate-200 bg-slate-950 p-4 text-xs text-slate-100">
        <pre>{licenseBusy ? 'Loading license...' : licenseText || 'Use Download or Copy to fetch the GPLv3 license text.'}</pre>
      </div>

      <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-5 py-4">
        <h3 className="text-lg font-semibold text-rose-900">Reset extension environment</h3>
        <p className="mt-2 text-sm text-rose-800">
          This clears installed workspaces, Action Packs, settings, traces, sync snapshots, session values, and temporary recovery drafts.
        </p>
        <button className="mt-4 rounded-full bg-rose-700 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-rose-800" type="button" onClick={onResetEverything}>
          Reset Everything
        </button>
      </div>
    </section>
  );
}
