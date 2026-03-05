export type HotkeyPlatform = 'mac' | 'other';

export interface HotkeyEventLike {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Command'] as const;
type HotkeyModifier = (typeof MODIFIER_ORDER)[number];

const RESERVED_HOTKEYS: Record<HotkeyPlatform, Record<string, string>> = {
  mac: {
    'Command+,': 'Command+, usually opens Chrome settings on macOS. Pick a different shortcut.',
    'Command+H': 'Command+H usually hides the current app on macOS. Pick a different shortcut.',
    'Command+L': 'Command+L usually focuses the address bar in Chrome. Pick a different shortcut.',
    'Command+M': 'Command+M usually minimizes the current window on macOS. Pick a different shortcut.',
    'Command+N': 'Command+N usually opens a new window in Chrome. Pick a different shortcut.',
    'Command+P': 'Command+P usually opens print in Chrome. Pick a different shortcut.',
    'Command+Q': 'Command+Q usually quits Chrome on macOS. Pick a different shortcut.',
    'Command+R': 'Command+R usually reloads the current page in Chrome. Pick a different shortcut.',
    'Command+T': 'Command+T usually opens a new tab in Chrome. Pick a different shortcut.',
    'Command+W': 'Command+W usually closes the current tab in Chrome. Pick a different shortcut.',
    'Command+Space': 'Command+Space is commonly reserved by macOS. Pick a different shortcut.',
    'Command+Shift+I': 'Command+Shift+I usually opens developer tools in Chrome. Pick a different shortcut.',
  },
  other: {
    'Alt+ArrowLeft': 'Alt+ArrowLeft usually goes back in the browser. Pick a different shortcut.',
    'Alt+ArrowRight': 'Alt+ArrowRight usually goes forward in the browser. Pick a different shortcut.',
    'Ctrl+H': 'Ctrl+H usually opens browsing history in Chrome. Pick a different shortcut.',
    'Ctrl+L': 'Ctrl+L usually focuses the address bar in Chrome. Pick a different shortcut.',
    'Ctrl+N': 'Ctrl+N usually opens a new window in Chrome. Pick a different shortcut.',
    'Ctrl+P': 'Ctrl+P usually opens print in Chrome. Pick a different shortcut.',
    'Ctrl+R': 'Ctrl+R usually reloads the current page in Chrome. Pick a different shortcut.',
    'Ctrl+S': 'Ctrl+S usually opens save in the browser. Pick a different shortcut.',
    'Ctrl+T': 'Ctrl+T usually opens a new tab in Chrome. Pick a different shortcut.',
    'Ctrl+W': 'Ctrl+W usually closes the current tab in Chrome. Pick a different shortcut.',
    'Ctrl+Shift+I': 'Ctrl+Shift+I usually opens developer tools in Chrome. Pick a different shortcut.',
  },
};

function getNavigatorPlatform(): string {
  if (typeof navigator === 'undefined') {
    return '';
  }

  const extendedNavigator = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
    };
  };

  return extendedNavigator.userAgentData?.platform ?? navigator.platform ?? '';
}

function isModifier(value: string): value is HotkeyModifier {
  return (MODIFIER_ORDER as readonly string[]).includes(value);
}

function toTitleCase(value: string): string {
  return value.length <= 1 ? value.toUpperCase() : `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
}

function normalizeModifierToken(token: string): HotkeyModifier | null {
  switch (token.toLowerCase()) {
    case 'alt':
    case 'option':
    case 'opt':
      return 'Alt';
    case 'command':
    case 'cmd':
    case 'meta':
    case 'os':
      return 'Command';
    case 'control':
    case 'ctrl':
      return 'Ctrl';
    case 'shift':
      return 'Shift';
    default:
      return null;
  }
}

function normalizeKeyToken(token: string): string | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }

  const modifier = normalizeModifierToken(trimmed);
  if (modifier) {
    return modifier;
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
    case 'plus':
      return '+';
    case 'minus':
      return '-';
    case 'slash':
      return '/';
    case 'backslash':
      return '\\';
    default:
      break;
  }

  if (/^f\d{1,2}$/i.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  if (trimmed.length === 1) {
    return /[a-z]/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
  }

  if (trimmed === 'Dead' || trimmed === 'Process' || trimmed === 'Unidentified') {
    return null;
  }

  return toTitleCase(trimmed);
}

function collectModifiers(modifiers: Iterable<HotkeyModifier>): HotkeyModifier[] {
  const found = new Set(modifiers);
  return MODIFIER_ORDER.filter((modifier) => found.has(modifier));
}

export function detectHotkeyPlatform(): HotkeyPlatform {
  return /mac|iphone|ipad|ipod/i.test(getNavigatorPlatform()) ? 'mac' : 'other';
}

export function getDefaultHotkey(): string {
  return detectHotkeyPlatform() === 'mac' ? 'Command+Shift+U' : 'Ctrl+Shift+U';
}

export function normalizeHotkeyValue(hotkey?: string | null): string {
  if (!hotkey?.trim()) {
    return '';
  }

  const segments = hotkey
    .split('+')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const modifiers: HotkeyModifier[] = [];
  let key = '';

  segments.forEach((segment) => {
    const normalized = normalizeKeyToken(segment);
    if (!normalized) {
      return;
    }

    if (isModifier(normalized)) {
      modifiers.push(normalized);
      return;
    }

    key = normalized;
  });

  if (!key) {
    return '';
  }

  return [...collectModifiers(modifiers), key].join('+');
}

export function formatHotkeyLabel(hotkey?: string | null): string {
  return normalizeHotkeyValue(hotkey) || 'Click to record a shortcut';
}

export function captureHotkeyFromEvent(event: HotkeyEventLike): { error: string | null; hotkey: string | null } {
  const key = normalizeKeyToken(event.key);

  if (!key) {
    return {
      error: 'That key cannot be used in a shortcut.',
      hotkey: null,
    };
  }

  if (isModifier(key)) {
    return {
      error: 'Press one regular key together with Ctrl, Alt, or Command.',
      hotkey: null,
    };
  }

  const modifiers: HotkeyModifier[] = [];
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
    return {
      error: 'Use Ctrl, Alt, or Command so the shortcut does not fire while someone is typing.',
      hotkey: null,
    };
  }

  return {
    error: null,
    hotkey: [...collectModifiers(modifiers), key].join('+'),
  };
}

export function getHotkeyValidationError(
  hotkey: string | undefined,
  existingHotkeys: string[] = [],
  platform: HotkeyPlatform = detectHotkeyPlatform(),
): string | null {
  const normalized = normalizeHotkeyValue(hotkey);
  if (!normalized) {
    return 'Record a shortcut with Ctrl, Alt, or Command and one other key.';
  }

  if (existingHotkeys.map((candidate) => normalizeHotkeyValue(candidate)).includes(normalized)) {
    return `${normalized} is already used by another hotkey pack.`;
  }

  return RESERVED_HOTKEYS[platform][normalized] ?? null;
}
