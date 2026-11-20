import { fail } from './contracts.mts';

export type Snapshot = { revision: number; value: number };

export type WaitDependencies<Timer> = {
  read: () => Snapshot;
  now: () => number;
  schedule: (callback: () => void, ms: number) => Timer;
  cancel: (timer: Timer) => void;
};

const WAIT_MS = 250;
const CAPACITY = 8;

type Waiter = { recheck: () => void; stop: (reason: unknown) => void };
type Outcome = { snapshot: Snapshot | null } | { failure: unknown };

export function createWaiters<Timer>(deps: WaitDependencies<Timer>) {
  const parked = new Set<Waiter>();
  const shutdown = new Error('Waiters shut down');
  let closed = false;

  function read(): Snapshot {
    try { return deps.read(); }
    catch { fail(500, 'internal_error'); }
  }

  return {
    get waiting() { return parked.size; },

    async poll(after: number, signal: AbortSignal): Promise<Snapshot | null> {
      signal.throwIfAborted();
      if (closed) throw shutdown;
      const initial = read();
      if (after > initial.revision) fail(409, 'future_revision');
      if (after < initial.revision) return initial;
      const deadline = deps.now() + WAIT_MS;
      if (parked.size >= CAPACITY) fail(503, 'busy');

      return new Promise<Snapshot | null>((resolve, reject) => {
        let timer: { cancel?: () => void } | undefined;

        function cancelTimer(): void {
          const previous = timer;
          timer = undefined;
          previous?.cancel?.();
        }

        function settle(outcome: Outcome): void {
          if (!parked.delete(waiter)) return;
          cancelTimer();
          signal.removeEventListener('abort', onAbort);
          if ('failure' in outcome) reject(outcome.failure);
          else resolve(outcome.snapshot);
        }

        const waiter: Waiter = {
          stop: failure => settle({ failure }),
          recheck: () => {
            if (!parked.has(waiter)) return;
            if (signal.aborted) {
              onAbort();
              return;
            }
            try {
              const latest = read();
              if (deps.now() >= deadline) settle({ snapshot: null });
              else if (latest.revision > after) settle({ snapshot: latest });
            } catch (error) {
              waiter.stop(error);
            }
          },
        };
        function onAbort(): void { waiter.stop(signal.reason); }
        function arm(ms: number): void {
          try {
            cancelTimer();
            if (!parked.has(waiter)) return;
            // Scheduling can settle the waiter or replace this timer before returning a handle.
            const pending: { cancel?: () => void } = {};
            timer = pending;
            const handle = deps.schedule(() => {
              if (timer !== pending) return;
              const remaining = deadline - deps.now();
              if (remaining <= 0) settle({ snapshot: null });
              else arm(remaining);
            }, ms);
            if (timer === pending) pending.cancel = () => deps.cancel(handle);
            else deps.cancel(handle);
          } catch (error) {
            waiter.stop(error);
          }
        }

        // Register before re-reading so a transition cannot fall between the read and the park.
        parked.add(waiter);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) return onAbort();
        arm(Math.max(0, deadline - deps.now()));
        waiter.recheck();
      });
    },

    notify(): void {
      for (const waiter of parked) waiter.recheck();
    },

    shutdown(): void {
      closed = true;
      for (const waiter of parked) waiter.stop(shutdown);
    },
  };
}
