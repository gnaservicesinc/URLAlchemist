import type { ActionPackLogSeverity, StoredActionPackLogEntry } from './types';

export const ACTION_PACK_LOG_SEVERITIES: ActionPackLogSeverity[] = ['debug', 'info', 'warn', 'error'];

export function normalizeLogSeverity(value: unknown): ActionPackLogSeverity {
  return ACTION_PACK_LOG_SEVERITIES.includes(value as ActionPackLogSeverity)
    ? value as ActionPackLogSeverity
    : 'info';
}

export function capLogMessage(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  return normalized.length > 4_000 ? `${normalized.slice(0, 3_997)}...` : normalized;
}

export function formatActionPackLogText(packName: string, entries: StoredActionPackLogEntry[]): string {
  const header = [
    `URL Alchemist Action Pack Log`,
    `Action Pack: ${packName}`,
    `Exported: ${new Date().toISOString()}`,
    '',
  ];
  const lines = entries
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp)
    .flatMap((entry) => {
      const stamp = new Date(entry.timestamp).toISOString();
      if (entry.kind === 'run') {
        const route = entry.inputUrl || entry.outputUrl
          ? ` ${entry.inputUrl ?? ''}${entry.changed ? ' -> ' : ''}${entry.changed ? entry.outputUrl ?? '' : ''}`.trimEnd()
          : '';
        return [
          `[${stamp}] RUN exit=${entry.exitCode ?? 0} severity=${entry.severity} handler=${entry.handler ?? 'trigger'} issues=${entry.issueCount ?? 0}`,
          route ? `  ${route}` : '',
          entry.message ? `  ${entry.message}` : '',
        ].filter(Boolean);
      }

      return [
        `[${stamp}] ${entry.severity.toUpperCase()}${entry.nodeId ? ` node=${entry.nodeId}` : ''}`,
        `  ${entry.message}`,
      ];
    });

  return [...header, ...lines, ''].join('\n');
}
