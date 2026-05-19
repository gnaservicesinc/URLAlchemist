import { REGEX_TIMEOUT_MS } from '../constants';
import type { RegexExecutor } from '../engine/runtime';
import type { RegexJobResponse, RegexTransformRequest } from '../types';
import type { RegexWorkerRequestEnvelope, RegexWorkerResponseEnvelope } from './workerProtocol';

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) {
    return REGEX_TIMEOUT_MS;
  }

  return Math.max(10, Math.min(REGEX_TIMEOUT_MS, Math.trunc(timeoutMs)));
}

async function executeRegexJob(request: RegexWorkerRequestEnvelope['request']): Promise<RegexJobResponse> {
  const worker = new Worker(new URL('./regexWorker.ts', import.meta.url), { type: 'module' });
  const requestId = crypto.randomUUID();
  const timeoutMs = normalizeTimeout(request.timeoutMs);

  return await new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      reject(new Error(`Regex execution exceeded ${timeoutMs}ms`));
    }, timeoutMs);

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

export function createPageRegexExecutor(timeoutMs = REGEX_TIMEOUT_MS): RegexExecutor {
  return {
    async test(input, pattern, requestTimeoutMs) {
      const response = await executeRegexJob({
        kind: 'test',
        input,
        pattern,
        timeoutMs: requestTimeoutMs ?? timeoutMs,
      });

      return response.matched;
    },
    async transform(request: Omit<RegexTransformRequest, 'kind'>) {
      const response = await executeRegexJob({
        kind: 'transform',
        ...request,
        timeoutMs: request.timeoutMs ?? timeoutMs,
      });

      return {
        matched: response.matched,
        result: response.result ?? request.input,
      };
    },
  };
}
