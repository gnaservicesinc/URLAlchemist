import type { ActionPackLogSeverity, StoredActionPackLogEntry } from './types';

export const ACTION_PACK_LOG_SEVERITIES: ActionPackLogSeverity[] = ['debug', 'info', 'warn', 'error'];
export const ACTION_PACK_LOG_MAX_ENTRIES_PER_PACK = 300;
export const ACTION_PACK_LOG_MAX_BYTES_PER_PACK = 256 * 1024;

export function normalizeLogSeverity(value: unknown): ActionPackLogSeverity {
  return ACTION_PACK_LOG_SEVERITIES.includes(value as ActionPackLogSeverity)
    ? value as ActionPackLogSeverity
    : 'info';
}

export function capLogMessage(value: string): string {
  const normalized = value.replace(/\r\n?/g, '\n');
  return normalized.length > 4_000 ? `${normalized.slice(0, 3_997)}...` : normalized;
}

export function estimateActionPackLogBytes(entries: StoredActionPackLogEntry[]): number {
  return new TextEncoder().encode(JSON.stringify(entries)).byteLength;
}

export function rotateActionPackLogEntries(
  entries: StoredActionPackLogEntry[],
  packId: string,
  options: { maxEntries?: number; maxBytes?: number } = {},
): StoredActionPackLogEntry[] {
  const maxEntries = options.maxEntries ?? ACTION_PACK_LOG_MAX_ENTRIES_PER_PACK;
  const maxBytes = options.maxBytes ?? ACTION_PACK_LOG_MAX_BYTES_PER_PACK;
  const packEntries = entries.filter((entry) => entry.packId === packId).slice(0, maxEntries);

  while (packEntries.length > 1 && estimateActionPackLogBytes(packEntries) > maxBytes) {
    packEntries.pop();
  }

  const keptPackEntries = new Set(packEntries);
  return entries.filter((entry) => entry.packId !== packId || keptPackEntries.has(entry));
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
