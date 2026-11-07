interface StorageArea {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}
export interface SessionScope { tabId?: number; packId: string }

// Serialize writes and cleanup so a storage.set already in progress cannot
// complete after its tab/pack cleanup. Check ownership again at write time.
export class RuntimeSessions {
  private fallback = new Map<string, { value: unknown; bytes: number }>();
  private fallbackBytes = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private area: () => StorageArea | undefined,
    private isActive: (scope: SessionScope) => Promise<boolean>,
    private maxFallbackBytes = 8 * 1024 * 1024,
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }

  get<T>(key: string): Promise<T | undefined> {
    return this.enqueue(async () => {
      const storage = this.area();
      const value = storage ? (await storage.get(key))[key] : this.fallback.get(key)?.value;
      return structuredClone(value) as T | undefined;
    });
  }

  set(key: string, value: unknown, scope: SessionScope): Promise<void> {
    // Snapshot before queuing, like the browser storage structured clone.
    const snapshot = structuredClone(value);
    return this.enqueue(async () => {
      if (!await this.isActive(scope)) return;
      const storage = this.area();
      if (storage) { await storage.set({ [key]: snapshot }); return; }
      const bytes = new TextEncoder().encode(key + JSON.stringify(snapshot)).byteLength;
      const nextBytes = this.fallbackBytes - (this.fallback.get(key)?.bytes ?? 0) + bytes;
      if (nextBytes > this.maxFallbackBytes) throw new Error('Runtime session storage limit exceeded');
      this.fallback.set(key, { value: snapshot, bytes });
      this.fallbackBytes = nextBytes;
    });
  }

  removeWhere(predicate: (key: string, value: unknown) => boolean | Promise<boolean>): Promise<void> {
    return this.enqueue(async () => {
      const storage = this.area();
      const values = storage ? await storage.get(null) : Object.fromEntries(
        [...this.fallback].map(([key, entry]) => [key, entry.value]),
      );
      const keys: string[] = [];
      for (const key of Object.keys(values)) {
        if (await predicate(key, values[key])) keys.push(key);
      }
      if (storage) { if (keys.length) await storage.remove(keys); return; }
      for (const key of keys) {
        this.fallbackBytes -= this.fallback.get(key)!.bytes;
        this.fallback.delete(key);
      }
    });
  }
}

export function isTabSessionKey(key: string, tabId: number): boolean {
  return key.startsWith(`url-alchemist-overlay-session:${tabId}:`)
    || key.startsWith(`url-alchemist-content-blocker-allow:${tabId}:`);
}

export function isPackSessionKey(key: string, packId: string, conditionKey?: string): boolean {
  return key.startsWith(`url-alchemist-v2-shared:${packId}:`)
    || key === `url-alchemist-trigger-log:${packId}`
    || key === `url-alchemist-condition:${packId}`
    || (conditionKey !== undefined && key === conditionKey)
    || (key.startsWith('url-alchemist-overlay-session:') && key.endsWith(`:${packId}`))
    || /^url-alchemist-content-blocker-allow:[0-9]+:/.test(key)
      && key.replace(/^url-alchemist-content-blocker-allow:[0-9]+:/, '').startsWith(`${packId}:`);
}

export function isExpiredAllowance(key: string, value: unknown, now = Date.now()): boolean {
  if (!key.startsWith('url-alchemist-content-blocker-allow:')) return false;
  const expiry = typeof value === 'number' ? value : (value as { expiresAt?: unknown } | null)?.expiresAt;
  return typeof expiry !== 'number' || expiry <= now;
}
