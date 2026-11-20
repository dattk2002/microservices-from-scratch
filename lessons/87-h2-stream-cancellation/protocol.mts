import { HttpError } from '../../lib/http.mts';

export const DEADLINE_MS = 500;
export const SLOW_LIFETIME_MS = 1000;
export const MAX_SESSIONS = 4;
export const MAX_STREAMS = 2;
export const MAX_BYTES = 8192;

export const h2Options = {
  maxHeaderListPairs: 256,
  settings: { maxHeaderListSize: MAX_BYTES, maxConcurrentStreams: MAX_STREAMS },
};

const singletonFields = new Set([
  'host', 'content-type', 'content-encoding', 'content-length', 'transfer-encoding',
  'trailer', 'te', 'expect', 'range', 'if-range', 'if-match', 'if-none-match',
  'if-modified-since', 'if-unmodified-since',
]);
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const loopbackAuthority = /^127\.0\.0\.1(?::([1-9][0-9]{0,4}))?$/;
const originForm = /^\/(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*$/;
const jsonMime = /^[ \t]*application\/json[ \t]*(?:;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8")[ \t]*)?$/i;

export function fault(status: number, code: string): HttpError {
  return new HttpError(status, code, code);
}

export function errorBody(code: string) {
  return { error: { code, message: code } };
}

function validAuthority(authority: string): boolean {
  const match = loopbackAuthority.exec(authority);
  return match?.[0] === authority && (match[1] === undefined || Number(match[1]) <= 65535);
}

export function workerOrigin(value: string): URL {
  const authority = value.startsWith('http://') ? value.slice(7).replace(/\/$/, '') : '';
  if (!validAuthority(authority)) throw new Error('Invalid WORKER_ORIGIN');
  return new URL(value);
}

function rawFields(raw: readonly string[], h2Pseudo?: ReadonlySet<string>) {
  const fields = new Map<string, string>();
  let bytes = 0;
  let sawRegular = false;
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name === undefined || value === undefined) throw fault(400, 'invalid_headers');
    const key = name.toLowerCase();
    if (h2Pseudo) {
      if (/[\0\r\n]/.test(value)) throw fault(400, 'invalid_headers');
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 32;
      if (bytes > MAX_BYTES) throw fault(431, 'headers_too_large');
      if (key.startsWith(':')) {
        if (sawRegular || !h2Pseudo.has(name)) throw fault(400, 'invalid_headers');
      } else {
        sawRegular = true;
        if (key !== name || !token.test(name)) throw fault(400, 'invalid_headers');
      }
    }
    if (key.startsWith(':') || singletonFields.has(key)) {
      if (fields.has(key)) throw fault(400, 'invalid_headers');
    }
    fields.set(key, value);
  }
  return fields;
}

export function http1Fields(raw: readonly string[]) {
  return rawFields(raw);
}

const requestPseudo = new Set([':method', ':scheme', ':authority', ':path']);
const responsePseudo = new Set([':status']);

export function sendHeaders(fields: Record<string, string>, kind: 'request' | 'response') {
  rawFields(Object.entries(fields).flat(), kind === 'request' ? requestPseudo : responsePseudo);
  return fields;
}

export function readRequest(raw: readonly string[]) {
  const fields = rawFields(raw, requestPseudo);
  const method = fields.get(':method');
  const path = fields.get(':path');
  const authority = fields.get(':authority');
  const host = fields.get('host');
  if (!method || !token.test(method) || !path || !originForm.test(path) ||
      fields.get(':scheme') !== 'http' || !authority || !validAuthority(authority) ||
      (host !== undefined && (!validAuthority(host) ||
        workerOrigin(`http://${host}`).host !== workerOrigin(`http://${authority}`).host))) {
    throw fault(400, 'invalid_headers');
  }
  return { method, path, fields };
}

export function requireGet<T extends string>(path: string, method: string | undefined, routes: readonly T[]): T {
  const query = path.indexOf('?');
  const name = query < 0 ? path : path.slice(0, query);
  const route = routes.find((candidate) => candidate === name);
  if (!route) throw fault(404, 'not_found');
  if (method !== 'GET') throw fault(405, 'method_not_allowed');
  if (query >= 0) throw fault(400, 'invalid_query');
  return route;
}

function identity(fields: ReadonlyMap<string, string>) {
  const encoding = fields.get('content-encoding');
  return encoding === undefined || /^[ \t]*identity[ \t]*$/i.test(encoding);
}

export function requireBodyless(fields: ReadonlyMap<string, string>) {
  const length = fields.get('content-length');
  if (fields.has('transfer-encoding') || fields.has('trailer') || !identity(fields) ||
      (length !== undefined && !/^0+$/.test(length))) {
    throw fault(400, 'invalid_body');
  }
}

export function readResponse(raw: readonly string[]): number | undefined {
  const fields = rawFields(raw, responsePseudo);
  const type = fields.get('content-type');
  const length = fields.get('content-length');
  if (fields.get(':status') !== '200' || type === undefined || !jsonMime.test(type) ||
      !identity(fields) || fields.has('trailer') || fields.has('transfer-encoding')) {
    throw fault(502, 'upstream_failure');
  }
  if (length === undefined) return undefined;
  if (!/^\d+$/.test(length) || Number(length) > MAX_BYTES) throw fault(502, 'upstream_failure');
  return Number(length);
}

export function validFastBody(body: Buffer): boolean {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === 1 && Object.hasOwn(value, 'value') &&
    'value' in value && value.value === 'ok';
}
