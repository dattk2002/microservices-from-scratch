import type { OriginValue } from './contracts.mts';

const freshFor = 100;
const staleWhileRevalidate = 400;
const staleIfError = 1000;

type State = 'fresh' | 'stale' | 'stale-if-error';
type Snapshot = OriginValue & { state: State };
type Entry = { data: OriginValue; storedAt: number };

class InconsistentVersion extends Error {}

export class ValueCache {
  private entry: Entry | undefined;
  private inFlight: Promise<OriginValue> | undefined;
  private readonly shutdown = new AbortController();
  private readonly now: () => number;
  private readonly fetchValue: (signal: AbortSignal) => Promise<OriginValue>;

  constructor(now: () => number, fetchValue: (signal: AbortSignal) => Promise<OriginValue>) {
    this.now = now;
    this.fetchValue = fetchValue;
  }

  async get(): Promise<Snapshot> {
    const signal = this.shutdown.signal;
    signal.throwIfAborted();

    const entry = this.entry;
    if (entry) {
      const age = this.now() - entry.storedAt;
      if (age < freshFor) return { ...entry.data, state: 'fresh' };
      if (age < freshFor + staleWhileRevalidate) {
        void this.refresh().catch(() => {});
        return { ...entry.data, state: 'stale' };
      }
    }

    try {
      return { ...await this.refresh(), state: 'fresh' };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof InconsistentVersion) throw error;
      // Waiting for the upstream can consume the remaining fallback window.
      const lastSuccess = this.entry;
      if (lastSuccess && this.now() - lastSuccess.storedAt < freshFor + staleIfError) {
        return { ...lastSuccess.data, state: 'stale-if-error' };
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.shutdown.abort();
    await this.inFlight?.catch(() => {});
  }

  private refresh(): Promise<OriginValue> {
    if (this.inFlight) return this.inFlight;

    const signal = this.shutdown.signal;
    // Publish the promise before calling the fetcher, even if it throws synchronously.
    this.inFlight = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const { version, value } = await this.fetchValue(signal);
      signal.throwIfAborted();

      const previous = this.entry?.data;
      if (previous && (version < previous.version ||
          (version === previous.version && value !== previous.value))) {
        throw new InconsistentVersion('Inconsistent origin version');
      }

      const data = { version, value };
      this.entry = { data, storedAt: this.now() };
      return data;
    }).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}
