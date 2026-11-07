import { REGEX_TIMEOUT_MS } from '../constants';
import type { RegexExecutor } from '../engine/runtime';
import type { RegexJobResponse, RegexTransformRequest } from '../types';
import type { RegexWorkerRequestEnvelope, RegexWorkerResponseEnvelope } from './workerProtocol';

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs)) return REGEX_TIMEOUT_MS;
  return Math.max(10, Math.min(REGEX_TIMEOUT_MS, Math.trunc(timeoutMs)));
}

interface Job {
  envelope: RegexWorkerRequestEnvelope;
  resolve: (response: RegexJobResponse) => void;
  reject: (error: Error) => void;
}
interface Slot {
  worker: Worker;
  ready: boolean;
  job?: Job;
  timer?: ReturnType<typeof setTimeout>;
}

// Shared across executors in this document, including successive Firefox runs.
// A busy worker handles exactly one job; timeout/error discards that worker.
const slots = new Set<Slot>();
const queue: Job[] = [];
const MAX_WORKERS = 2;
const MAX_QUEUED_JOBS = 128;
const WORKER_STARTUP_MS = 5000;
const WORKER_IDLE_MS = 30_000;

function discard(slot: Slot): void {
  clearTimeout(slot.timer);
  slot.worker.onmessage = null;
  slot.worker.onerror = null;
  slot.worker.onmessageerror = null;
  slot.worker.terminate();
  slots.delete(slot);
  slot.job = undefined;
}

function fail(slot: Slot, error: Error): void {
  const job = slot.job;
  discard(slot);
  job?.reject(error);
  drain();
}

function dispatch(slot: Slot): void {
  if (!slot.ready || !slot.job) return;
  clearTimeout(slot.timer);
  const timeoutMs = normalizeTimeout(slot.job.envelope.request.timeoutMs);
  slot.timer = setTimeout(() => fail(slot, new Error(`Regex execution exceeded ${timeoutMs}ms`)), timeoutMs);
  try {
    slot.worker.postMessage(slot.job.envelope);
  } catch (error) {
    fail(slot, error instanceof Error ? error : new Error('Regex worker message failed'));
  }
}

function drain(): void {
  while (queue.length) {
    let slot = [...slots].find((candidate) => !candidate.job);
    if (!slot) {
      if (slots.size >= MAX_WORKERS) return;
      let worker: Worker;
      try {
        worker = new Worker(new URL('./regexWorker.ts', import.meta.url), { type: 'module' });
      } catch (error) {
        queue.shift()!.reject(error instanceof Error ? error : new Error('Regex worker failed to start'));
        continue;
      }
      slot = { worker, ready: false };
      slots.add(slot);
      const current = slot;
      current.timer = setTimeout(() => fail(current, new Error('Regex worker startup timed out')), WORKER_STARTUP_MS);
      worker.onmessage = (event: MessageEvent<RegexWorkerResponseEnvelope | { ready: true }>) => {
        if ('ready' in event.data) {
          if (!current.ready) {
            current.ready = true;
            dispatch(current);
          }
          return;
        }
        const job = current.job;
        if (!job || event.data.id !== job.envelope.id) return;
        clearTimeout(current.timer);
        current.job = undefined;
        if (event.data.ok) job.resolve(event.data.response);
        else job.reject(new Error(event.data.error));
        current.timer = setTimeout(() => discard(current), WORKER_IDLE_MS);
        drain();
      };
      worker.onerror = (event) => fail(current, new Error(event.message || 'Regex worker failed'));
      worker.onmessageerror = () => fail(current, new Error('Regex worker response could not be decoded'));
    }
    slot.job = queue.shift()!;
    dispatch(slot);
  }
}

async function executeRegexJob(request: RegexWorkerRequestEnvelope['request']): Promise<RegexJobResponse> {
  if (queue.length >= MAX_QUEUED_JOBS) throw new Error('Regex worker queue is full');
  return new Promise((resolve, reject) => {
    queue.push({ envelope: { id: crypto.randomUUID(), request }, resolve, reject });
    drain();
  });
}

export function createPageRegexExecutor(timeoutMs = REGEX_TIMEOUT_MS): RegexExecutor {
  return {
    async test(input, pattern, requestTimeoutMs) {
      const response = await executeRegexJob({ kind: 'test', input, pattern, timeoutMs: requestTimeoutMs ?? timeoutMs });
      return response.matched;
    },
    async transform(request: Omit<RegexTransformRequest, 'kind'>) {
      const response = await executeRegexJob({ kind: 'transform', ...request, timeoutMs: request.timeoutMs ?? timeoutMs });
      return { matched: response.matched, result: response.result ?? request.input };
    },
  };
}
