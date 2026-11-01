export type RetryOptions = {
  maxAttempts: number; baseMs: number; capMs: number; deadline: number; permitted: boolean;
  now: () => number; rng: () => number; sleep: (ms: number) => Promise<void>;
};
export class DeadlineError extends Error {
  constructor() { super('overall deadline exceeded'); }
}
export async function retry<T extends { status: number }>(operation: (remainingMs: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { maxAttempts, baseMs, capMs, deadline, now } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100 ||
      !Number.isSafeInteger(baseMs) || baseMs < 0 || !Number.isSafeInteger(capMs) || capMs < 0 ||
      !Number.isFinite(deadline)) throw new Error('invalid retry configuration');
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new DeadlineError();
    const result = await operation(remaining);
    if (now() >= deadline) throw new DeadlineError();
    if (!options.permitted || ![502, 503, 504].includes(result.status) || attempt >= maxAttempts) return result;
    const random = options.rng();
    if (!Number.isFinite(random) || random < 0 || random >= 1) throw new Error('invalid RNG');
    const delay = Math.floor(random * Math.min(capMs, baseMs * 2 ** (attempt - 1)));
    // Leave strictly positive time for the next attempt; never sleep to the deadline.
    if (delay >= deadline - now()) throw new DeadlineError();
    await options.sleep(delay);
  }
}
