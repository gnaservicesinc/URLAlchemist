import { REGEX_TIMEOUT_MS } from '../constants';
import type { RegexExecutor } from '../engine/runtime';
import type { RegexJobResponse, RegexTransformRequest } from '../types';
import type { RegexWorkerRequestEnvelope, RegexWorkerResponseEnvelope } from './workerProtocol';

async function executeRegexJob(request: RegexWorkerRequestEnvelope['request']): Promise<RegexJobResponse> {
  const worker = new Worker(new URL('./regexWorker.ts', import.meta.url), { type: 'module' });
  const requestId = crypto.randomUUID();

  return await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error(`Regex execution exceeded ${REGEX_TIMEOUT_MS}ms`));
    }, REGEX_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<RegexWorkerResponseEnvelope>) => {
      if (event.data.id !== requestId) {
        return;
      }

      window.clearTimeout(timeout);
      worker.terminate();

      if (!event.data.ok) {
        reject(new Error(event.data.error));
        return;
      }

      resolve(event.data.response);
    };

    worker.onerror = (event) => {
      window.clearTimeout(timeout);
      worker.terminate();
      reject(new Error(event.message || 'Regex worker failed'));
    };

    worker.postMessage({
      id: requestId,
      request,
    } satisfies RegexWorkerRequestEnvelope);
  });
}

export function createPageRegexExecutor(): RegexExecutor {
  return {
    async test(input, pattern) {
      const response = await executeRegexJob({
        kind: 'test',
        input,
        pattern,
      });

      return response.matched;
    },
    async transform(request: Omit<RegexTransformRequest, 'kind'>) {
      const response = await executeRegexJob({
        kind: 'transform',
        ...request,
      });

      return {
        matched: response.matched,
        result: response.result ?? request.input,
      };
    },
  };
}
