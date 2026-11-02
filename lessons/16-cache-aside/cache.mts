export class CacheBusy extends Error {
  constructor() { super('cache_busy'); }
}

// Values must be immutable: callers receive the same value on a hit.
export class Cache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  private readonly loads = new Map<string, Promise<T>>();
  private joined = 0;
  private readonly capacity: number;
  private readonly loadCapacity: number;
  private readonly ttl: number;
  private readonly now: () => number;
  constructor(capacity: number, loadCapacity: number, ttl: number, now: () => number) {
    for (const n of [capacity, loadCapacity, ttl]) {
      if (!Number.isSafeInteger(n) || n < 1 || n > 100000) throw new Error('Invalid cache limit');
    }
    this.capacity = capacity; this.loadCapacity = loadCapacity; this.ttl = ttl; this.now = now;
  }
  stats() { return { entries: this.entries.size, inFlight: this.loads.size, joined: this.joined }; }
  async get(key: string, load: () => Promise<T>): Promise<T> {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      if (this.now() < entry.expires) {
        this.entries.set(key, entry);
        return entry.value;
      }
    }
    const existing = this.loads.get(key);
    if (existing) { this.joined++; return existing; }
    if (this.loads.size >= this.loadCapacity) throw new CacheBusy();
    // Install the promise before invoking user code, including synchronous throws.
    const pending = Promise.resolve().then(load).then(value => {
      const now = this.now();
      for (const [k, e] of this.entries) if (now >= e.expires) this.entries.delete(k);
      if (this.entries.size >= this.capacity) {
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
      this.entries.set(key, { value, expires: now + this.ttl });
      return value;
    }).finally(() => { this.loads.delete(key); });
    this.loads.set(key, pending);
    return pending;
  }
}
