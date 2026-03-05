import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS } from '../constants';
import { executeRegexJobRequest } from '../regex/executeRegexJob';
import type { EngineRuntime } from './runtime';
import { simulateActionPack } from './engine';
import type { ActionPack, RegexTransformRequest } from '../types';

const runtime: EngineRuntime = {
  regex: {
    async test(input, pattern) {
      return executeRegexJobRequest({
        kind: 'test',
        input,
        pattern,
      }).matched;
    },
    async transform(request: Omit<RegexTransformRequest, 'kind'>) {
      const response = executeRegexJobRequest({
        kind: 'transform',
        ...request,
      });

      return {
        matched: response.matched,
        result: response.result ?? request.input,
      };
    },
  },
  readClipboard: async () => 'clipboard-token',
  now: () => new Date('2026-03-05T12:00:00.000Z'),
};

function createPack(partial: Partial<ActionPack>): ActionPack {
  return {
    id: 'pack-1',
    name: 'Test Pack',
    version: 1,
    enabled: true,
    metadata: {
      created_at: Date.now(),
      author: 'Test Author',
      description: 'Engine test pack',
    },
    trigger: {
      type: 'ALWAYS',
      hotkey: 'Ctrl+Shift+U',
      scope_regex: '',
    },
    activities: [],
    ...partial,
  };
}

describe('simulateActionPack', () => {
  it('applies standard substitutions with regex groups', async () => {
    const pack = createPack({
      activities: [
        {
          id: 'activity-1',
          order: 1,
          action: 'SUBSTITUTE',
          pattern: 'utm_([^=]+)=([^&]+)',
          match_mode: 'STANDARD',
          nth_occurrence: 1,
          payload: '$1=redacted',
          payload_vars: true,
        },
      ],
    });

    const result = await simulateActionPack(
      'https://example.com/?utm_source=newsletter&utm_medium=email',
      pack,
      runtime,
      DEFAULT_SETTINGS,
    );

    expect(result.finalUrl).toBe('https://example.com/?source=redacted&medium=redacted');
  });

  it('removes everything after the first matched boundary', async () => {
    const pack = createPack({
      activities: [
        {
          id: 'activity-1',
          order: 1,
          action: 'REMOVE',
          pattern: 'keep=1',
          match_mode: 'AFTER_PATTERN',
          nth_occurrence: 1,
          payload: '',
          payload_vars: false,
        },
      ],
    });

    const result = await simulateActionPack(
      'https://example.com/path?keep=1&utm_source=newsletter',
      pack,
      runtime,
      DEFAULT_SETTINGS,
    );

    expect(result.finalUrl).toBe('https://example.com/path?keep=1');
  });

  it('targets only the configured nth occurrence', async () => {
    const pack = createPack({
      activities: [
        {
          id: 'activity-1',
          order: 1,
          action: 'PREPEND',
          pattern: '-',
          match_mode: 'NTH_OCCURRENCE',
          nth_occurrence: 2,
          payload: 'X',
          payload_vars: false,
        },
      ],
    });

    const result = await simulateActionPack('https://example.com/a-b-c', pack, runtime, DEFAULT_SETTINGS);

    expect(result.finalUrl).toBe('https://example.com/a-bX-c');
  });

  it('interpolates clipboard and date placeholders', async () => {
    const pack = createPack({
      activities: [
        {
          id: 'activity-1',
          order: 1,
          action: 'APPEND',
          pattern: 'example',
          match_mode: 'STANDARD',
          nth_occurrence: 1,
          payload: '-{clipboard}-{date}',
          payload_vars: true,
        },
      ],
    });

    const result = await simulateActionPack('https://example.com', pack, runtime, DEFAULT_SETTINGS);

    expect(result.finalUrl).toBe('https://example-clipboard-token-2026-03-05T12:00:00.000Z.com');
  });

  it('blocks file urls when local file access is disabled', async () => {
    const pack = createPack({
      activities: [
        {
          id: 'activity-1',
          order: 1,
          action: 'REMOVE',
          pattern: 'demo',
          match_mode: 'STANDARD',
          nth_occurrence: 1,
          payload: '',
          payload_vars: false,
        },
      ],
    });

    const result = await simulateActionPack('file:///tmp/demo.txt', pack, runtime, DEFAULT_SETTINGS);

    expect(result.changed).toBe(false);
    expect(result.issues[0]?.message).toContain('Local file URLs are blocked');
  });
});
