import { HttpError } from '../../lib/http.mts';
import { ALGORITHM, BIN_COUNT } from './quantiles.mts';

export const MAX_RECEIPTS = 64;
export type SourceId = 'a' | 'b';
export type SampleEvent = { id: string; value: number };
export type Snapshot = { id: SourceId; algorithm: typeof ALGORITHM; total: number; bins: number[] };
export type Origins = Record<SourceId, string>;

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function exact(body: unknown, keys: readonly string[]): body is Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    && Object.keys(body).length === keys.length && keys.every(key => Object.hasOwn(body, key));
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function parseEvent(body: unknown): SampleEvent {
  if (!exact(body, ['id', 'value'])) fail(400, 'invalid_request');
  const { id, value } = body;
  if (typeof id !== 'string' || id.length < 1 || id.length > 16 || /[^a-z0-9]/.test(id)
    || !integer(value, 1, 1024)) fail(400, 'invalid_request');
  return { id, value };
}

export function parsePercentile(query: string): number {
  const match = /^\?p=(0|[1-9][0-9]?|100)$/.exec(query);
  if (!match || match[0] !== query) fail(400, 'invalid_request');
  return Number(match[1]);
}

export function parseSnapshot(body: unknown, id: SourceId): Snapshot {
  if (!exact(body, ['id', 'algorithm', 'total', 'bins']) || body.id !== id || body.algorithm !== ALGORITHM
    || !integer(body.total, 0, MAX_RECEIPTS) || !Array.isArray(body.bins) || body.bins.length !== BIN_COUNT) {
    fail(502, 'upstream_failure');
  }
  const bins: number[] = [];
  let total = 0;
  const rawBins: unknown[] = body.bins;
  for (const count of rawBins) {
    if (!integer(count, 0, MAX_RECEIPTS)) fail(502, 'upstream_failure');
    bins.push(count);
    total += count;
  }
  if (body.total !== total) fail(502, 'upstream_failure');
  return { id, algorithm: ALGORITHM, total, bins };
}

function loopbackOrigin(raw: string | undefined): string {
  // Require an authority with only an optional trailing slash before URL normalization.
  const authority = raw && /^http:\/\/[^/?#\\@\s]+\/?$/i.exec(raw);
  const url = raw && authority && authority[0] === raw ? URL.parse(raw) : null;
  if (!url || url.hostname !== '127.0.0.1' || url.port === '0') {
    throw new Error('Expected a loopback HTTP origin');
  }
  return url.origin;
}

export function sourceOrigins(a: string | undefined, b: string | undefined): Origins {
  const origins = { a: loopbackOrigin(a), b: loopbackOrigin(b) };
  if (origins.a === origins.b) throw new Error('Source origins must be distinct');
  return origins;
}
