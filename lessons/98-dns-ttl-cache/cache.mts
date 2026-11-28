export type Record4 = { address: string; ttl: number };
export type Address = '127.0.0.1' | '127.0.0.2';
export const CAPACITY = 8;

export function allowed(address: string): address is Address {
  return address === '127.0.0.1' || address === '127.0.0.2';
}

type Waiter = (value: Address | Error) => void;
type Flight = { controller: AbortController; waiters: Set<Waiter> };

export class Cache {
  #entry?: { address: Address; expires: number };
  #flight?: Flight;
  #cacheHits = 0;
  #dnsQueries = 0;
  #lookup: (signal: AbortSignal) => Promise<Record4[]>;
  #now: () => number;

  constructor(lookup: (signal: AbortSignal) => Promise<Record4[]>, now = () => performance.now()) {
    this.#lookup = lookup;
    this.#now = now;
  }

  get stats() { return { cacheHits: this.#cacheHits, dnsQueries: this.#dnsQueries }; }

  async #refresh(flight: Flight) {
    let result: Address | Error;
    try {
      const records = await this.#lookup(flight.controller.signal);
      const received = this.#now();
      const first = records[0];
      if (!first || records.length > CAPACITY || !allowed(first.address) ||
          records.some(({ address, ttl }) => !allowed(address) ||
            !Number.isInteger(ttl) || ttl < 0 || ttl > 0xffffffff)) {
        throw new Error('invalid DNS records');
      }
      const ttl = Math.min(30, ...records.map((record) => record.ttl));
      result = first.address;
      if (this.#flight === flight && ttl > 0) {
        this.#entry = { address: result, expires: received + ttl * 1000 };
      }
    } catch (error) {
      result = error instanceof Error ? error : new Error('DNS lookup failed');
    }
    if (this.#flight === flight) this.#flight = undefined;
    for (const waiter of flight.waiters) waiter(result);
  }

  async get(signal: AbortSignal): Promise<Address> {
    signal.throwIfAborted();
    if (this.#entry && this.#now() < this.#entry.expires) {
      this.#cacheHits++;
      return this.#entry.address;
    }
    this.#entry = undefined;
    const existing = this.#flight;
    const flight = existing ?? { controller: new AbortController(), waiters: new Set<Waiter>() };
    if (flight.waiters.size >= CAPACITY) throw new Error('DNS waiters full');
    return new Promise((resolve, reject) => {
      const complete: Waiter = (value) => {
        signal.removeEventListener('abort', abort);
        flight.waiters.delete(complete);
        if (value instanceof Error) reject(value);
        else resolve(value);
      };
      const abort = () => {
        complete(signal.reason instanceof Error ? signal.reason : new Error('cancelled'));
        if (this.#flight === flight && flight.waiters.size === 0) {
          this.#flight = undefined;
          flight.controller.abort();
        }
      };
      flight.waiters.add(complete);
      signal.addEventListener('abort', abort, { once: true });
      if (!existing) {
        this.#flight = flight;
        this.#dnsQueries++;
        void this.#refresh(flight);
      }
    });
  }
}
