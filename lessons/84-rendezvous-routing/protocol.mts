import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json } from '../../lib/http.mts';
import type { Member } from './placement.mts';

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function replyError(res: ServerResponse, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.setHeader('connection', 'close');
  const { status, code } = error instanceof HttpError ? error : { status: 500, code: 'internal_error' };
  json(res, status, { error: { code, message: code } });
}

export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function isMember(value: unknown): value is Member {
  return value === 'a' || value === 'b' || value === 'c';
}

export function isKey(value: unknown): value is string {
  return typeof value === 'string' && /^k(?:[0-9]|[1-5][0-9]|6[0-3])$/.test(value);
}

export function requestPath(req: IncomingMessage): string {
  const path = req.url ?? '/';
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) fail(400, 'invalid_request');
  return path;
}

export function requireMethod(req: IncomingMessage, res: ServerResponse, method: 'GET' | 'PUT'): void {
  if (req.method === method) return;
  res.setHeader('allow', method);
  fail(405, 'method_not_allowed');
}

export function requireEmptyBody(req: IncomingMessage): void {
  const { 'content-length': length, 'transfer-encoding': encoding } = req.headers;
  if (encoding !== undefined || (length !== undefined && length !== '0')) fail(400, 'invalid_request');
}
