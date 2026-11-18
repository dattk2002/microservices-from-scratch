import { HttpError } from '../../lib/http.mts';
import type { Counter, Source, Summary } from './summary.mts';

export const MAX_EVENTS = 64;
export type Event = { id: string; key: string };
export type Origins = Record<Source, string>;

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function exactFields(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

export function isSource(value: unknown): value is Source {
  return value === 'a' || value === 'b';
}

function isKey(value: unknown): value is string {
  return typeof value === 'string' && /^k(?:[0-9]|[12][0-9]|3[01])$/.test(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function parseEvent(value: unknown): Event | undefined {
  if (!exactFields(value, ['id', 'key']) || typeof value.id !== 'string'
    || !/^[a-z0-9]{1,16}$/.test(value.id) || !isKey(value.key)) return undefined;
  return { id: value.id, key: value.key };
}

export function parseSummary(value: unknown, source: Source): Summary | undefined {
  if (!exactFields(value, ['id', 'algorithm', 'total', 'dropped', 'counters'])
    || value.id !== source || value.algorithm !== 'mg3-v1'
    || !integer(value.total, 0, MAX_EVENTS) || !integer(value.dropped, 0, MAX_EVENTS / 4)
    || !Array.isArray(value.counters) || value.counters.length > 3) return undefined;

  const counters: Counter[] = [];
  const entries: readonly unknown[] = value.counters;
  let previous = '';
  let mass = 4 * value.dropped;
  for (const entry of entries) {
    if (!exactFields(entry, ['key', 'count']) || !isKey(entry.key)
      || entry.key <= previous || !integer(entry.count, 1, MAX_EVENTS)) return undefined;
    counters.push({ key: entry.key, count: entry.count });
    previous = entry.key;
    mass += entry.count;
  }
  if (mass !== value.total) return undefined;
  return { id: source, algorithm: 'mg3-v1', total: value.total, dropped: value.dropped, counters };
}

function normalizeOrigin(value: string | undefined): string {
  if (value === undefined || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/.test(value)) {
    throw new Error('Expected an HTTP origin on 127.0.0.1');
  }
  const url = new URL(value);
  if (url.port === '0') throw new Error('Upstream origin requires a concrete port');
  return url.origin;
}

export function parseOrigins(a: string | undefined, b: string | undefined): Origins {
  const origins = { a: normalizeOrigin(a), b: normalizeOrigin(b) };
  if (origins.a === origins.b) throw new Error('Source origins must be distinct');
  return origins;
}

export function validateHost(host: string | undefined): void {
  if (host !== undefined && host !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
}
