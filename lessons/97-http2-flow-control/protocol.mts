import { performance } from 'node:perf_hooks';

export const BLOB_BYTES = 262_144;
export const CHUNK_BYTES = 4096;
export const CAPACITY = 8;
export const STREAM_WINDOW = 16_384;
export const TRANSFER_MS = 2000;
export const JSON_BYTES = 8192;
export const JSON_MS = 500;
export const BINARY = 'application/octet-stream';
export const JSON_MEDIA = 'application/json;charset=utf-8';
export const MARKER = 'x-blob-complete';

export const timeout = new Error('deadline exceeded');

export function deadline(milliseconds: number) {
  const end = performance.now() + milliseconds;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeout), milliseconds);
  return {
    controller,
    signal: controller.signal,
    check() {
      if (performance.now() >= end) controller.abort(timeout);
      controller.signal.throwIfAborted();
    },
    dispose() { clearTimeout(timer); },
  };
}

export function encodeJson(value: object): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > JSON_BYTES) throw new Error('JSON byte limit exceeded');
  return body;
}

export function errorBody(code: string) {
  return { error: { code, message: code } };
}

export function fields(raw: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const value = raw[index + 1];
    if (raw[index]?.toLowerCase() === name && value !== undefined) values.push(value);
  }
  return values;
}

export function bodyless(raw: string[]): boolean {
  const lengths = fields(raw, 'content-length');
  return (lengths.length === 0 || (lengths.length === 1 && lengths[0] === '0')) &&
    ['transfer-encoding', 'content-encoding', 'trailer', 'expect'].every((name) => fields(raw, name).length === 0) &&
    fields(raw, 'content-type').length <= 1;
}

export function rejectRoute(method: string | undefined, path: string | undefined, routes: string[], validBody: boolean) {
  if (path === undefined || path.includes('?') || path.includes('#')) return { status: 400, code: 'invalid_request' };
  if (!routes.includes(path)) return { status: 404, code: 'not_found' };
  if (method !== 'GET') return { status: 405, code: 'method_not_allowed' };
  if (!validBody) return { status: 400, code: 'invalid_request' };
}

export function port(defaultPort: number): number {
  const value = process.env.PORT;
  if (value === undefined) return defaultPort;
  if (!/^\d{1,5}$/.test(value) || Number(value) > 65_535) throw new Error('invalid PORT');
  return Number(value);
}
