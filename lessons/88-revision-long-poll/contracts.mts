import { HttpError } from '../../lib/http.mts';
import type { Snapshot } from './waiters.mts';

export type PeerResult =
  | { status: 200; snapshot: Snapshot }
  | { status: 204 }
  | { status: 409; code: 'future_revision' }
  | { status: 503; code: 'busy' };

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function parseAfter(query: string | undefined): number {
  const canonical = query === undefined ? null : /^after=(0|[1-9]|1[0-6])$/.exec(query);
  if (!canonical || canonical[0] !== query) fail(400, 'invalid_query');
  return Number(canonical[1]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

export function parseValue(body: unknown): number {
  if (!isRecord(body) || Object.keys(body).length !== 1 || !isInteger(body.value, 100)) {
    fail(400, 'invalid_body');
  }
  return body.value;
}

export function parseSnapshot(body: unknown): Snapshot {
  if (!isRecord(body) || Object.keys(body).length !== 2 ||
      !isInteger(body.revision, 16) || !isInteger(body.value, 100)) {
    throw new Error('Invalid document snapshot');
  }
  return { revision: body.revision, value: body.value };
}

export function isJsonMedia(value: string | undefined): boolean {
  // Match the complete field, including the closing quote and end of input.
  return value !== undefined &&
    /^[ \t]*application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*(?![\s\S])/i.test(value);
}

export function parseOrigin(raw: string | undefined): URL {
  if (raw === undefined || raw.trim() !== raw || !/^http:\/\/127\.0\.0\.1(?::\d{1,5})?\/?$/.test(raw)) {
    throw new Error('ORIGIN_ORIGIN must be http://127.0.0.1 with an optional port and slash');
  }
  const origin = new URL(raw);
  if (origin.port === '0') throw new Error('ORIGIN_ORIGIN must use a nonzero port');
  return origin;
}

function matchesError(body: unknown, code: string): boolean {
  if (!isRecord(body) || Object.keys(body).length !== 1) return false;
  const error = body.error;
  return isRecord(error) && Object.keys(error).length === 2 &&
    error.code === code && error.message === code;
}

export function parsePeerBody(status: number, body: unknown, after: number): PeerResult {
  if (status === 200) {
    const snapshot = parseSnapshot(body);
    if (snapshot.revision <= after) throw new Error('Origin snapshot did not advance');
    return { status, snapshot };
  }
  if (status === 409 && after > 0 && matchesError(body, 'future_revision')) return { status, code: 'future_revision' };
  if (status === 503 && matchesError(body, 'busy')) return { status, code: 'busy' };
  throw new Error('Invalid origin error envelope');
}
