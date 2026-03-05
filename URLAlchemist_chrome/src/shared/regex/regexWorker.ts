/// <reference lib="webworker" />

import type { RegexWorkerRequestEnvelope, RegexWorkerResponseEnvelope } from './workerProtocol';
import { executeRegexJobRequest } from './executeRegexJob';

const workerSelf = self as DedicatedWorkerGlobalScope;

workerSelf.onmessage = (event: MessageEvent<RegexWorkerRequestEnvelope>) => {
  const response: RegexWorkerResponseEnvelope = (() => {
    try {
      return {
        id: event.data.id,
        ok: true,
        response: executeRegexJobRequest(event.data.request),
      };
    } catch (error) {
      return {
        id: event.data.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Regex execution failed',
      };
    }
  })();

  workerSelf.postMessage(response);
};

export {};
