export class Full extends Error {}
export class Pool {
  readonly capacity: number;
  #used = 0;
  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('Invalid capacity');
    this.capacity = capacity;
  }
  acquire(): (() => void) | undefined {
    if (this.#used === this.capacity) return undefined;
    this.#used++;
    let released = false;
    return () => { if (!released) { released = true; this.#used--; } };
  }
}
export async function runBounded<T>(pool: Pool, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  const release = pool.acquire();
  if (!release) throw new Full('Dependency capacity exhausted');
  try { return await work(signal); }
  finally { release(); }
}
