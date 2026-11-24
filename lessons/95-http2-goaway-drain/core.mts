export const CALL_MS = 500;
export const DRAIN_MS = 750;
export const MAX_ACTIVE = 8;
export const MAX_SESSIONS = 2;

export class Drain {
  #active = new Set<number>();
  #cutoff = 0;
  #deadline: number | undefined;

  accept(id: number): boolean {
    if (this.#deadline !== undefined || id <= this.#cutoff) return false;
    this.#active.add(id);
    this.#cutoff = id;
    return true;
  }

  release(id: number): boolean { return this.#active.delete(id); }
  get active(): number { return this.#active.size; }
  get deadline(): number | undefined { return this.#deadline; }
  get cutoff(): number { return this.#cutoff; }

  begin(now: number): boolean {
    if (this.#deadline !== undefined) return false;
    this.#deadline = now + DRAIN_MS;
    return true;
  }
}

export type SessionState = 'open' | 'draining' | 'closed';

export function selectSession<T extends { state: SessionState }>(
  sessions: Iterable<T>,
  hasCapacity: (session: T) => boolean = () => true,
): T | undefined {
  for (const session of sessions) {
    if (session.state === 'open' && hasCapacity(session)) return session;
  }
  return undefined;
}

export function expired(deadline: number, now: number): boolean {
  return now >= deadline;
}

export function callDeadline(startedAt: number): number { return startedAt + CALL_MS; }
