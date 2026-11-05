export interface Clock { after(ms: number, fn: () => void): () => void }
export const realClock: Clock = { after(ms, fn) { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); } };
export class Budget {
  active = 0;
  skipped = 0;
  readonly limit: number;
  constructor(limit: number) { if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid capacity'); this.limit = limit; }
  acquire(): (() => void) | undefined {
    if (this.active >= this.limit) { this.skipped++; return undefined; }
    this.active++; let released = false;
    return () => { if (!released) { released = true; this.active--; } };
  }
}
export type Reply = { status: number; value?: { id: string; text: string } };
export type Attempt = (index: number, signal: AbortSignal) => Promise<Reply>;
export function hedge(attempt: Attempt, clock: Clock, budget: Budget, signal: AbortSignal, delay: number, deadline: number): Promise<Reply> {
  if (!Number.isFinite(delay) || delay <= 0 || !Number.isFinite(deadline) || deadline <= delay) throw new Error('Invalid timing');
  return new Promise(resolve => {
    let done = false; let pending = 0; let decided = false;
    let release: (() => void) | undefined;
    const controllers: AbortController[] = [];
    let cancelDelay = () => {}; let cancelDeadline = () => {};
    const finish = (reply: Reply) => {
      if (done) return;
      done = true; cancelDelay(); cancelDeadline(); signal.removeEventListener('abort', disconnected);
      for (const c of controllers) c.abort();
      release?.(); resolve(reply);
    };
    const disconnected = () => finish({status: 499});
    const exhausted = () => { if (decided && pending === 0) finish({status: 502}); };
    const start = (index: number) => {
      const c = new AbortController(); controllers.push(c); pending++;
      let work: Promise<Reply>;
      try { work = attempt(index, c.signal); } catch { work = Promise.reject(new Error('Transport')); }
      void work.catch((): Reply => ({status: 503})).then(reply => {
        if (done) return;
        pending--; if (index === 1) release?.();
        if (reply.status === 200 && reply.value !== undefined) finish(reply);
        else if ([400, 401, 403, 404, 405, 410, 422].includes(reply.status)) finish({status: reply.status});
        else exhausted();
      });
    };
    if (signal.aborted) { finish({status: 499}); return; }
    signal.addEventListener('abort', disconnected, {once: true});
    cancelDeadline = clock.after(deadline, () => finish({status: 504}));
    cancelDelay = clock.after(delay, () => {
      decided = true; release = budget.acquire();
      if (release) start(1);
      exhausted();
    });
    start(0);
  });
}
