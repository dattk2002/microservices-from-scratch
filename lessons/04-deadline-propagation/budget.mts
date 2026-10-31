import { HttpError } from '../../lib/http.mts';

// A wall-clock timestamp is forwarded unchanged; only the entry boundary may mint it.
export function deadline(raw: unknown, clock: () => number, allowDefault: boolean): number {
  const now = clock();
  if (raw === undefined && allowDefault) return now + 1000;
  if (typeof raw !== 'string' || !/^[1-9]\d{0,15}$/.test(raw)) {
    throw new HttpError(400, 'invalid_deadline', 'Use one absolute Unix millisecond deadline');
  }
  const end = Number(raw);
  if (!Number.isSafeInteger(end) || end - now > 5000) {
    throw new HttpError(400, 'invalid_deadline', 'Deadline must be at most 5000ms ahead');
  }
  if (end <= now) throw new HttpError(504, 'deadline_exceeded', 'End-to-end budget expired');
  return end;
}

export function remaining(end: number, clock: () => number): number {
  return Math.max(0, end - clock());
}
