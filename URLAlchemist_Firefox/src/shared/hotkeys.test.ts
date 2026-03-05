import { describe, expect, it } from 'vitest';

import {
  captureHotkeyFromEvent,
  getHotkeyValidationError,
  normalizeHotkeyValue,
} from './hotkeys';

describe('hotkeys', () => {
  it('normalizes stored shortcut labels into a stable order', () => {
    expect(normalizeHotkeyValue('shift+ctrl+u')).toBe('Ctrl+Shift+U');
    expect(normalizeHotkeyValue('cmd+option+k')).toBe('Alt+Command+K');
  });

  it('captures a shortcut from keyboard state', () => {
    expect(
      captureHotkeyFromEvent({
        altKey: false,
        ctrlKey: true,
        key: 'u',
        metaKey: false,
        shiftKey: true,
      }),
    ).toEqual({
      error: null,
      hotkey: 'Ctrl+Shift+U',
    });
  });

  it('rejects shortcuts that would fire during normal typing', () => {
    expect(
      captureHotkeyFromEvent({
        altKey: false,
        ctrlKey: false,
        key: 'u',
        metaKey: false,
        shiftKey: false,
      }).error,
    ).toContain('Use Ctrl, Alt, or Command');
  });

  it('flags duplicate or browser-reserved shortcuts', () => {
    expect(getHotkeyValidationError('Ctrl+Shift+U', ['Ctrl+Shift+U'])).toContain('already used');
    expect(getHotkeyValidationError('Command+Q', [], 'mac')).toContain('quits the browser');
  });
});
