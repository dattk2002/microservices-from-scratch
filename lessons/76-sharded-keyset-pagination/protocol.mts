import { HttpError } from '../../lib/http.mts';

export type Shard = 'a' | 'b';
export type Origins = Record<Shard, string>;
export type Vector = Record<Shard, number>;
export type Item = { id: string; score: number };
export type PageOptions = { limit: number; after: Item | null };
export type QueryPage = PageOptions & { snapshots: Vector };
export type ShardPage = { shard: Shard; revision: number; items: Item[] };

export const MAX_REVISION = 16;
const MAX_LIMIT = 4;
const MAX_SCORE = 100;

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function invalid(): never {
  return fail(400, 'invalid_request');
}

export function upstreamFailure(): never {
  return fail(502, 'upstream_failure');
}

export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

export function isScore(value: unknown): value is number {
  return integer(value, 0, MAX_SCORE);
}

export function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 2 && /^[ab][0-7]$/.test(value);
}

export function isOwnedId(value: unknown, shard: Shard): value is string {
  return isId(value) && value[0] === shard;
}

export function compareItems(left: Item, right: Item): number {
  return right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

function decimal(raw: string | null | undefined, min: number, max: number): number {
  if (typeof raw !== 'string') invalid();
  const value = Number(raw);
  if (!integer(value, min, max) || String(value) !== raw) invalid();
  return value;
}

export function parseRevision(raw: string | null | undefined): number {
  return decimal(raw, 0, MAX_REVISION);
}

export function requestTarget(raw = '/'): { path: string; search: string | null } {
  const separator = raw.indexOf('?');
  if (separator === -1) return { path: raw, search: null };
  return { path: raw.slice(0, separator), search: raw.slice(separator + 1) };
}

function pageParameters(raw: string | null, required: readonly string[]): URLSearchParams {
  if (raw === null) invalid();
  const params = new URLSearchParams(raw);
  const keys = params.has('afterId') || params.has('afterScore')
    ? [...required, 'afterId', 'afterScore']
    : required;
  // Reject duplicate/extra parameters, encoded aliases and empty separators.
  if (params.size !== keys.length || !keys.every(key => params.has(key)) || params.toString() !== raw) invalid();
  return params;
}

function pageOptions(params: URLSearchParams): PageOptions {
  const limit = decimal(params.get('limit'), 1, MAX_LIMIT);
  const id = params.get('afterId');
  if (id === null) return { limit, after: null };
  if (!isId(id)) invalid();
  return { limit, after: { id, score: decimal(params.get('afterScore'), 0, MAX_SCORE) } };
}

export function parseShardPage(raw: string | null): PageOptions {
  return pageOptions(pageParameters(raw, ['limit']));
}

export function parseQueryPage(raw: string | null): QueryPage {
  const params = pageParameters(raw, ['limit', 'a', 'b']);
  return {
    ...pageOptions(params),
    snapshots: { a: parseRevision(params.get('a')), b: parseRevision(params.get('b')) },
  };
}

export function validatePage(body: unknown, shard: Shard, revision: number, options: PageOptions): Item[] {
  if (!exact(body, ['shard', 'revision', 'items']) || body.shard !== shard || body.revision !== revision ||
      !Array.isArray(body.items) || body.items.length > options.limit) upstreamFailure();

  const seen = new Set<string>();
  const items: Item[] = [];
  let previous = options.after;
  for (const value of body.items) {
    if (!exact(value, ['id', 'score']) || !isOwnedId(value.id, shard) || !isScore(value.score) ||
        seen.has(value.id)) upstreamFailure();
    const item = { id: value.id, score: value.score };
    // The first row is checked against the caller's cursor, then each row against its predecessor.
    if (previous && compareItems(previous, item) >= 0) upstreamFailure();
    items.push(item);
    seen.add(item.id);
    previous = item;
  }
  return items;
}

function loopbackOrigin(raw: string | undefined): string {
  if (!raw || raw.trim() !== raw || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/i.test(raw)) {
    throw new Error('Expected a loopback HTTP origin at 127.0.0.1');
  }
  const url = new URL(raw);
  if (url.port === '0') throw new Error('Expected a loopback HTTP origin with a nonzero port');
  return url.origin;
}

export function normalizeOrigins(a: string | undefined, b: string | undefined): Origins {
  const config = { a: loopbackOrigin(a), b: loopbackOrigin(b) };
  if (config.a === config.b) throw new Error('Shard origins must be distinct');
  return config;
}

export function validateHost(host: string | undefined): void {
  if (host !== undefined && host !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
}
