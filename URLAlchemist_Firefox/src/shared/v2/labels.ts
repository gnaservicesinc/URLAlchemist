export function formatRunType(type: string | undefined): string {
  switch (type) {
    case 'ALWAYS':
    case 'INPUT_DATA':
      return 'Run on input data';
    case 'HOTKEY':
      return 'Hotkey';
    case 'CONTEXT_MENU':
      return 'Context menu';
    case 'INTERVAL':
      return 'Interval';
    case 'CONDITIONAL':
      return 'Conditional';
    case 'NEVER':
      return 'Never';
    default:
      return type?.trim() || 'Unknown';
  }
}

export function formatEventHandler(handler: string | undefined): string {
  switch (handler) {
    case 'trigger':
      return 'Run event';
    case 'keyboard':
      return 'Keyboard event';
    case 'mouse':
      return 'Mouse event';
    case 'tick':
      return 'Tick event';
    default:
      return handler?.trim() || 'Run event';
  }
}
