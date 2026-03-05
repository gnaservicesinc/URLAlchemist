import { useEffect, useState } from 'react';

import { captureHotkeyFromEvent, formatHotkeyLabel, getDefaultHotkey } from '../../shared/hotkeys';

interface HotkeyRecorderProps {
  onChange: (hotkey: string) => void;
  validationError?: string | null;
  value?: string;
}

export function HotkeyRecorder({ onChange, validationError, value }: HotkeyRecorderProps) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (validationError) {
      setStatusMessage(null);
    }
  }, [validationError]);

  return (
    <div className="field-shell">
      <span className="field-label">Hotkey</span>
      <button
        className={`w-full rounded-2xl border px-4 py-3 text-left text-sm outline-none transition ${
          isCapturing
            ? 'border-amber-400 bg-amber-50 text-slate-900 ring-2 ring-amber-200'
            : 'border-slate-200 bg-white/90 text-slate-900 hover:border-slate-300'
        }`}
        type="button"
        onBlur={() => setIsCapturing(false)}
        onClick={() => {
          setIsCapturing(true);
          setStatusMessage('Press your shortcut now. Backspace clears it. Escape cancels.');
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setIsCapturing(false);
            setStatusMessage('Shortcut recording cancelled.');
            return;
          }

          if (event.key === 'Backspace' || event.key === 'Delete') {
            event.preventDefault();
            onChange('');
            setIsCapturing(false);
            setStatusMessage('Shortcut cleared.');
            return;
          }

          const result = captureHotkeyFromEvent(event);
          if (!result.hotkey) {
            if (result.error) {
              event.preventDefault();
              setStatusMessage(result.error);
            }
            return;
          }

          event.preventDefault();
          onChange(result.hotkey);
          setStatusMessage(`${result.hotkey} recorded.`);
          setIsCapturing(false);
          event.currentTarget.blur();
        }}
      >
        {isCapturing ? 'Press your shortcut now...' : formatHotkeyLabel(value)}
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Click the field, then press the keys you want together. We will save exactly what you press.
        </p>
        <button className="ghost-button px-3 py-1.5 text-xs" type="button" onClick={() => onChange(getDefaultHotkey())}>
          Use Default
        </button>
      </div>

      {validationError ? (
        <p className="rounded-2xl bg-rose-50 px-4 py-3 text-sm text-rose-700">{validationError}</p>
      ) : statusMessage ? (
        <p className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-700">{statusMessage}</p>
      ) : null}

      <p className="text-xs text-slate-500">
        Hotkeys work on normal web pages. Browser-owned pages like <span className="font-mono">about:</span> and
        add-on storefront tabs block extension scripts, so shortcuts cannot run there.
      </p>
    </div>
  );
}
