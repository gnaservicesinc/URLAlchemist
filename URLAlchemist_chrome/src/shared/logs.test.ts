import { describe, expect, it } from 'vitest';

import {
  estimateActionPackLogBytes,
  rotateActionPackLogEntries,
} from './logs';
import type { StoredActionPackLogEntry } from './types';

function createEntry(id: string, packId = 'pack-a', message = 'entry'): StoredActionPackLogEntry {
  return {
    id,
    packId,
    packName: packId,
    timestamp: Number.parseInt(id.replace(/\D/g, '') || '0', 10),
    kind: 'message',
    severity: 'info',
    message,
  };
}

describe('action pack log rotation', () => {
  it('keeps the newest per-pack entries and preserves other pack logs', () => {
    const entries = [
      createEntry('a-0'),
      createEntry('b-0', 'pack-b'),
      createEntry('a-1'),
      createEntry('a-2'),
      createEntry('a-3'),
      createEntry('b-1', 'pack-b'),
    ];

    const rotated = rotateActionPackLogEntries(entries, 'pack-a', { maxEntries: 3, maxBytes: 100_000 });

    expect(rotated.map((entry) => entry.id)).toEqual(['a-0', 'b-0', 'a-1', 'a-2', 'b-1']);
  });

  it('drops older entries when the per-pack byte budget is exceeded', () => {
    const entries = [
      createEntry('a-0', 'pack-a', 'x'.repeat(400)),
      createEntry('a-1', 'pack-a', 'x'.repeat(400)),
      createEntry('b-0', 'pack-b', 'untouched'),
      createEntry('a-2', 'pack-a', 'x'.repeat(400)),
      createEntry('a-3', 'pack-a', 'x'.repeat(400)),
    ];

    const rotated = rotateActionPackLogEntries(entries, 'pack-a', { maxEntries: 10, maxBytes: 1_200 });
    const rotatedPackEntries = rotated.filter((entry) => entry.packId === 'pack-a');

    expect(estimateActionPackLogBytes(rotatedPackEntries)).toBeLessThanOrEqual(1_200);
    expect(rotatedPackEntries[0]?.id).toBe('a-0');
    expect(rotated.some((entry) => entry.id === 'b-0')).toBe(true);
  });
});
