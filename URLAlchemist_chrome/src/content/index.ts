const HOTKEY_TRIGGER_MESSAGE = 'URL_ALCHEMIST_HOTKEY_TRIGGER';

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable || target.closest('[contenteditable="true"]')) {
    return true;
  }

  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
}

function normalizeKeyToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  switch (trimmed.toLowerCase()) {
    case ' ':
    case 'space':
    case 'spacebar':
      return 'Space';
    case 'arrowleft':
    case 'left':
      return 'ArrowLeft';
    case 'arrowright':
    case 'right':
      return 'ArrowRight';
    case 'arrowup':
    case 'up':
      return 'ArrowUp';
    case 'arrowdown':
    case 'down':
      return 'ArrowDown';
    case 'esc':
      return 'Escape';
    case 'return':
      return 'Enter';
    case 'comma':
      return ',';
    case 'period':
      return '.';
    default:
      break;
  }

  if (/^(control|ctrl)$/i.test(trimmed)) {
    return 'Ctrl';
  }

  if (/^(alt|option|opt)$/i.test(trimmed)) {
    return 'Alt';
  }

  if (/^shift$/i.test(trimmed)) {
    return 'Shift';
  }

  if (/^(command|cmd|meta|os)$/i.test(trimmed)) {
    return 'Command';
  }

  if (/^f\d{1,2}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  if (trimmed === 'Dead' || trimmed === 'Process' || trimmed === 'Unidentified') {
    return null;
  }

  if (trimmed.length === 1) {
    return /[a-z]/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
  }

  return trimmed.length <= 1 ? trimmed.toUpperCase() : `${trimmed.slice(0, 1).toUpperCase()}${trimmed.slice(1).toLowerCase()}`;
}

function toHotkey(event: KeyboardEvent): string | null {
  const key = normalizeKeyToken(event.key);
  if (!key || ['Ctrl', 'Alt', 'Shift', 'Command'].includes(key)) {
    return null;
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push('Ctrl');
  }
  if (event.altKey) {
    modifiers.push('Alt');
  }
  if (event.shiftKey) {
    modifiers.push('Shift');
  }
  if (event.metaKey) {
    modifiers.push('Command');
  }

  if (!modifiers.some((modifier) => modifier !== 'Shift')) {
    return null;
  }

  return [...modifiers, key].join('+');
}

if (window.top === window) {
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) {
        return;
      }

      const hotkey = toHotkey(event);
      if (!hotkey) {
        return;
      }

      chrome.runtime.sendMessage(
        {
          type: HOTKEY_TRIGGER_MESSAGE,
          hotkey,
          url: window.location.href,
        },
        () => {
          void chrome.runtime.lastError;
        },
      );
    },
    { capture: true },
  );
}
