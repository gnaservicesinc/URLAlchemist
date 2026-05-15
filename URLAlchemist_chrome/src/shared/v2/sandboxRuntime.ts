import type { GraphValue } from './types';
import type { GraphRuntime } from './vm';

export function createSandboxGraphRuntime(runtime: GraphRuntime): GraphRuntime {
  const sessionValues = new Map<string, GraphValue>();

  return {
    regex: runtime.regex,
    readClipboard: runtime.readClipboard,
    now: runtime.now,
    readSource: runtime.readSource,
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
  };
}
