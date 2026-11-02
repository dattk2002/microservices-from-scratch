export function validClient(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(value);
}
export type Config = { capacity: number; refillMs: number; maxClients: number; idleMs: number };
export type Decision = { kind: 'allowed' } | { kind: 'limited'; retryAfter: number } | { kind: 'full' };
type Bucket = { credit: number; updated: number; seen: number };

export class Buckets {
  readonly #config: Config;
  readonly #clock: () => number;
  readonly #clients = new Map<string, Bucket>();
  #last = 0;
  constructor(config: Config, clock: () => number) {
    for (const [key, max] of [['capacity', 1000], ['refillMs', 3600000], ['maxClients', 10000], ['idleMs', 86400000]] as const) {
      const value = config[key];
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${key}`);
    }
    this.#config = { ...config };
    this.#clock = clock;
  }
  take(id: string): Decision {
    if (!validClient(id)) throw new Error('Invalid client ID');
    const now = this.#clock();
    if (!Number.isFinite(now) || now < this.#last) throw new Error('Clock must be finite, nonnegative and monotonic');
    this.#last = now;
    const { capacity, refillMs, maxClients, idleMs } = this.#config;
    const ceiling = capacity * refillMs;
    let bucket = this.#clients.get(id);
    if (!bucket) {
      // Only sweep at capacity; never evict a bucket with outstanding token debt.
      if (this.#clients.size >= maxClients) {
        for (const [key, candidate] of this.#clients) {
          if (now - candidate.seen >= idleMs && now - candidate.updated >= ceiling - candidate.credit) {
            this.#clients.delete(key);
          }
        }
      }
      if (this.#clients.size >= maxClients) return { kind: 'full' };
      bucket = { credit: ceiling, updated: now, seen: now };
      this.#clients.set(id, bucket);
    }
    // Credit is measured in milliseconds: one request costs refillMs credits.
    bucket.credit = Math.min(ceiling, bucket.credit + (now - bucket.updated));
    bucket.updated = now;
    bucket.seen = now;
    if (bucket.credit < refillMs) {
      return { kind: 'limited', retryAfter: Math.max(1, Math.ceil((refillMs - bucket.credit) / 1000)) };
    }
    bucket.credit -= refillMs;
    return { kind: 'allowed' };
  }
}
