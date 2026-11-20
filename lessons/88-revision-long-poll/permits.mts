import { fail } from './contracts.mts';
import type { PeerResult } from './contracts.mts';

type Dial = (after: number, signal: AbortSignal) => Promise<PeerResult>;

export function createObserver(dial: Dial): Dial {
  let active = 0;
  return async (after, signal) => {
    signal.throwIfAborted();
    if (active === 8) fail(503, 'busy');
    active++;
    try {
      return await dial(after, signal);
    } catch {
      fail(502, 'upstream_failure');
    } finally {
      active--;
    }
  };
}
