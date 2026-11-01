export class CircuitOpenError extends Error {
  constructor() { super('Circuit rejects this call'); }
}
export type Options = { threshold: number; cooldownMs: number; maxProbes: number; now: () => number };
export class CircuitBreaker {
  #state: 'closed' | 'open' | 'half-open' = 'closed';
  #failures = 0;
  #retryAt = 0;
  #generation = 0;
  #active = 0;
  #admitted = 0;
  readonly #options: Options;
  constructor(options: Options) {
    if (![options.threshold, options.cooldownMs, options.maxProbes].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error('Invalid circuit configuration');
    }
    this.#options = { ...options };
  }
  get state() { return this.#state; }
  #open() {
    this.#state = 'open';
    this.#retryAt = this.#options.now() + this.#options.cooldownMs;
    this.#generation++;
  }
  #complete(generation: number, healthy: boolean) {
    // In-flight work from a previous generation still returns to its caller only.
    if (generation !== this.#generation) return;
    if (this.#state === 'half-open') {
      this.#active--;
      if (!healthy) this.#open();
      else if (this.#active === 0) {
        this.#state = 'closed'; this.#failures = 0; this.#generation++;
      }
    } else if (this.#state === 'closed') {
      this.#failures = healthy ? 0 : this.#failures + 1;
      if (this.#failures >= this.#options.threshold) this.#open();
    }
  }
  async run<T extends { status: number }>(operation: () => Promise<T>): Promise<T> {
    if (this.#state === 'open') {
      if (this.#options.now() < this.#retryAt) throw new CircuitOpenError();
      this.#state = 'half-open'; this.#active = 0; this.#admitted = 0;
      this.#generation++;
    }
    if (this.#state === 'half-open') {
      if (this.#admitted >= this.#options.maxProbes) throw new CircuitOpenError();
      this.#active++; this.#admitted++;
    }
    const generation = this.#generation;
    let result: T;
    try { result = await operation(); }
    catch (error) { this.#complete(generation, false); throw error; }
    this.#complete(generation, result.status < 500);
    return result;
  }
}
