import { useRef, type DragEvent, type ChangeEvent } from 'react';

interface ImportPanelProps {
  importBusy: boolean;
  importError: string | null;
  onFileDrop: (event: DragEvent<HTMLElement>) => void;
  onFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
}

export default function ImportPanel({ importBusy, importError, onFileDrop, onFileSelect }: ImportPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <section className="panel-shell reveal-panel">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Import</p>
          <h2 className="mt-2 text-2xl font-semibold text-slate-900">Open workspace or stage pack</h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Drop a v2 workspace, v2 Action Pack, or v1 <span className="font-mono">.urlpack</span>. File contents decide the route, not the extension.
          </p>
        </div>
        <button className="primary-button" type="button" onClick={() => fileInputRef.current?.click()}>
          Choose File
        </button>
      </div>

      <div
        className="mt-5 rounded-[1.5rem] border border-dashed border-amber-300 bg-amber-50/70 px-6 py-20 text-center"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onFileDrop(event)}
      >
        <p className="text-3xl font-bold text-amber-600">
          {importBusy ? 'Inspecting file...' : 'Drop file to inspect'}
        </p>
        <p className="mt-3 text-sm text-slate-600">
          Workspaces open in the editor; Action Packs open in the staging gate.
        </p>
      </div>

      {importError ? (
        <p className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{importError}</p>
      ) : null}

      <input
        ref={fileInputRef}
        accept=".workspace,.actionpack,.urlpack,application/octet-stream"
        className="hidden"
        type="file"
        onChange={(event) => onFileSelect(event)}
      />
    </section>
  );
}
