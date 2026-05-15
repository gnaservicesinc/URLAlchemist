import type { GraphValue } from './types';
import type { GraphRuntime } from './vm';

const SANDBOX_SOURCE_VALUES: Record<string, GraphValue> = {
  selectedText: { type: 'string', value: 'sandbox-selected-text' },
  pageTitle: { type: 'string', value: 'Sandbox Page Title' },
  pageMetadata: { type: 'dict', value: {} },
  clipboard: { type: 'string', value: 'sandbox-clipboard' },
  pageText: { type: 'string', value: 'sandbox-page-text' },
  rawHtml: { type: 'string', value: '<html></html>' },
  mediaData: { type: 'dict', value: {} },
  pageLinks: { type: 'data', value: [] },
  jsMetadata: { type: 'dict', value: {} },
  consoleOutput: { type: 'data', value: [] },
};

export function createSandboxGraphRuntime(runtime: GraphRuntime): GraphRuntime {
  const sessionValues = new Map<string, GraphValue>();

  return {
    regex: runtime.regex,
    readClipboard: async () => 'sandbox-clipboard',
    now: runtime.now,
    readSource: async (source) => SANDBOX_SOURCE_VALUES[source],
    loadSessionValue: async (key) => sessionValues.get(key),
    saveSessionValue: async (key, value) => {
      sessionValues.set(key, value);
    },
    writeDestination: async () => {
      // Staged imports must not mutate browser state before confirmation.
    },
    fetchRemote: async (request) => {
      if (request.outputDataType === 'bool') {
        return { type: 'bool', value: 0 };
      }

      if (request.outputDataType === 'number' || request.outputDataType === 'floatingPoint') {
        return { type: request.outputDataType, value: 0 } as GraphValue;
      }

      if (request.outputDataType === 'dict') {
        return { type: 'dict', value: {} };
      }

      if (request.outputDataType === 'data' || request.outputDataType === 'Any') {
        return { type: request.outputDataType, value: null } as GraphValue;
      }

      return { type: request.outputDataType, value: '' } as GraphValue;
    },
    resolveAsset: async (request) => ({
      source: 'remote',
      kind: request.kind,
      mimeType: `${request.kind}/*`,
      url: request.url,
      sizeBytes: 0,
      cacheKey: request.url,
    }),
    requestUserInteraction: async (request) => ({
      type: 'dict',
      value: {
        ok: { type: 'bool', value: 1 },
        cancelled: { type: 'bool', value: 0 },
        value: request.kind === 'PROMPT_NUMBER' ? { type: 'number', value: 1 } : { type: 'string', value: 'sandbox' },
        source: { type: 'string', value: 'sandbox' },
      },
    }),
    displayOverlay: async (request) => ({
      type: 'dict',
      value: {
        ok: { type: 'bool', value: 1 },
        completed: { type: 'bool', value: request.type === 'video' || request.type === 'sound' ? 1 : 0 },
        cancelled: { type: 'bool', value: 0 },
        stoppedAtSeconds: { type: 'number', value: 0 },
        durationSeconds: { type: 'number', value: 0 },
        watchedPercent: { type: 'number', value: request.type === 'video' ? 100 : 0 },
        reason: { type: 'string', value: 'sandbox' },
      },
    }),
    mutatePageText: async () => {
      // Staged imports must not mutate page state before confirmation.
    },
  };
}
