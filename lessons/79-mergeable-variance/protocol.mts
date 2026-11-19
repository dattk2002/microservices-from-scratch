import { HttpError } from '../../lib/http.mts';
import type { Moments } from './statistics.mts';

export const algorithm = 'welford-v1';
export const receiptLimit = 64;
const maxValue = 1_000_000_000;

export type SourceId = 'a' | 'b';
export type Snapshot = Moments & { id: SourceId; algorithm: typeof algorithm };
export type Event = { id: string; value: number };
export type Origins = Record<SourceId, string>;

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

function exactObject(input: unknown, keys: string[]): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
}

function boundedNumber(input: unknown, max: number): input is number {
  return typeof input === 'number' && Number.isFinite(input) && input >= 0 && input <= max;
}

export function parseEvent(raw: unknown): Event {
  if (!exactObject(raw, ['id', 'value']) || typeof raw.id !== 'string' || !/^[a-z0-9]{1,16}$/.test(raw.id)
      || !boundedNumber(raw.value, maxValue) || !Number.isInteger(raw.value)) {
    fail(400, 'invalid_request');
  }
  return { id: raw.id, value: raw.value };
}

export function decodeSnapshot(raw: unknown, id: SourceId): Snapshot | undefined {
  if (!exactObject(raw, ['id', 'algorithm', 'n', 'mean', 'm2']) || raw.id !== id || raw.algorithm !== algorithm) {
    return undefined;
  }

  const { n, mean, m2 } = raw;
  if (!boundedNumber(n, receiptLimit) || !Number.isInteger(n)
      || !boundedNumber(mean, maxValue) || !boundedNumber(m2, n * 1e18)) {
    return undefined;
  }
  if (n === 0 && (!Object.is(n, 0) || !Object.is(mean, 0))) return undefined;
  if (n <= 1 && !Object.is(m2, 0)) return undefined;
  if (m2 === 0 && !Number.isInteger(mean)) return undefined;
  if ((mean === 0 || mean === maxValue) && m2 !== 0) return undefined;
  if (n > 1) {
    // Necessary bounds for values in [0, M]: M2 <= n*mean*(M-mean),
    // n*(n-1)*mean^2, and n*(n-1)*(M-mean)^2. Expand the mean interval
    // and comparison for the bounded Welford update's binary64 rounding.
    const uncertainty = 32 * Number.EPSILON * n * maxValue;
    const low = Math.max(0, mean - uncertainty);
    const high = Math.min(maxValue, mean + uncertainty);
    const peak = Math.max(low, Math.min(high, maxValue / 2));
    const upper = Math.min(
      n * peak * (maxValue - peak),
      n * (n - 1) * high ** 2,
      n * (n - 1) * (maxValue - low) ** 2,
    );
    const roundoff = uncertainty * n * (Math.sqrt(upper / n) + uncertainty)
      + 32 * n * Number.EPSILON * Math.max(1, upper);
    if (m2 > upper + roundoff) return undefined;
  }
  return { id, algorithm, n, mean, m2 };
}

export function parseSnapshot(raw: unknown, id: SourceId): Snapshot {
  return decodeSnapshot(raw, id) ?? fail(502, 'upstream_failure');
}

function normalizeOrigin(raw: string | undefined): string {
  if (!raw || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/i.test(raw)) {
    throw new Error('Expected a loopback HTTP origin (127.0.0.1)');
  }
  const origin = URL.parse(raw);
  if (!origin || origin.port === '0') throw new Error('Expected a loopback HTTP origin with a valid port');
  return origin.origin;
}

export function origins(a: string | undefined, b: string | undefined): Origins {
  const result = { a: normalizeOrigin(a), b: normalizeOrigin(b) };
  if (result.a === result.b) throw new Error('Source origins must be distinct');
  return result;
}

export function privateDatabaseFile(raw: string | undefined): string {
  if (!raw || !raw.trim() || raw === ':memory:' || raw.startsWith('file:')) {
    throw new Error('Private DB_PATH file required');
  }
  return raw;
}
