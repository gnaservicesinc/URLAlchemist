import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegexWorkerRequestEnvelope } from './workerProtocol';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn<(request: RegexWorkerRequestEnvelope) => void>();
  constructor() { FakeWorker.instances.push(this); }
  ready() { this.onmessage?.({ data: { ready: true } } as MessageEvent); }
  respond(ok = true) {
    const request = this.postMessage.mock.calls.at(-1)![0];
    this.onmessage?.({ data: ok ? { id: request.id, ok: true, response: { kind: 'test', matched: true } }
      : { id: request.id, ok: false, error: 'Unsafe pattern' } } as MessageEvent);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('regex worker lifecycle', () => {
  it('reuses initialized workers across executors and releases idle workers', async () => {
    const { createPageRegexExecutor } = await import('./pageRunner');
    const first = createPageRegexExecutor().test('a', 'a');
    const worker = FakeWorker.instances[0];
    expect(worker.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); // startup is outside execution budget
    worker.ready(); worker.respond();
    expect(await first).toBe(true);
    const second = createPageRegexExecutor().test('b', 'b');
    worker.respond();
    expect(await second).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('bounds concurrency and starts queued deadlines only on dispatch', async () => {
    const { createPageRegexExecutor } = await import('./pageRunner');
    const regex = createPageRegexExecutor();
    const results = Array.from({ length: 3 }, () => regex.test('a', 'a'));
    expect(FakeWorker.instances).toHaveLength(2);
    const [first, second] = FakeWorker.instances;
    first.ready(); second.ready();
    await vi.advanceTimersByTimeAsync(40);
    first.respond(); // third request starts now, after 40ms in queue
    second.respond();
    await vi.advanceTimersByTimeAsync(20);
    first.respond();
    expect(await Promise.all(results)).toEqual([true, true, true]);
  });

  it('terminates timed out workers, ignores stale replies, and recovers', async () => {
    const { createPageRegexExecutor } = await import('./pageRunner');
    const regex = createPageRegexExecutor();
    const timedOut = expect(regex.test('a', 'a', 10)).rejects.toThrow('exceeded 10ms');
    const worker = FakeWorker.instances[0];
    worker.ready();
    const staleHandler = worker.onmessage;
    const oldId = worker.postMessage.mock.calls[0][0].id;
    await vi.advanceTimersByTimeAsync(10);
    await timedOut;
    expect(worker.terminate).toHaveBeenCalledOnce();
    const next = regex.test('b', 'b');
    const replacement = FakeWorker.instances[1];
    replacement.ready();
    staleHandler?.({ data: { id: oldId, ok: true, response: { kind: 'test', matched: false } } } as MessageEvent);
    replacement.respond();
    expect(await next).toBe(true);
  });

  it('recovers from worker startup, script and message failures', async () => {
    const { createPageRegexExecutor } = await import('./pageRunner');
    const regex = createPageRegexExecutor();
    const startup = expect(regex.test('a', 'a')).rejects.toThrow('startup timed out');
    await vi.advanceTimersByTimeAsync(5000); await startup;
    const script = expect(regex.test('a', 'a')).rejects.toThrow('script failure');
    FakeWorker.instances[1].onerror?.({ message: 'script failure' } as ErrorEvent); await script;
    const clone = expect(regex.test('a', 'a')).rejects.toThrow('clone failure');
    const worker = FakeWorker.instances[2];
    worker.postMessage.mockImplementation(() => { throw new Error('clone failure'); });
    worker.ready(); await clone;
    expect(FakeWorker.instances.every((instance) => instance.terminate.mock.calls.length === 1)).toBe(true);
  });

  it('does not discard a healthy worker for a rejected pattern', async () => {
    const { createPageRegexExecutor } = await import('./pageRunner');
    const regex = createPageRegexExecutor();
    const rejected = expect(regex.test('a', 'a')).rejects.toThrow('Unsafe pattern');
    const worker = FakeWorker.instances[0];
    worker.ready(); worker.respond(false); await rejected;
    const next = regex.test('a', 'a'); worker.respond();
    expect(await next).toBe(true);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('rejects excess queued work without creating unbounded workers', async () => {
    const { createPageRegexExecutor } = await import('./pageRunner');
    const regex = createPageRegexExecutor();
    const pending = Array.from({ length: 130 }, () => regex.test('a', 'a').catch(() => false));
    await expect(regex.test('a', 'a')).rejects.toThrow('queue is full');
    expect(FakeWorker.instances).toHaveLength(2);
    await vi.runAllTimersAsync();
    await Promise.all(pending);
  });
});
