import type { ServerResponse } from 'node:http';
import { HttpError, json } from '../../lib/http.mts';

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function replyError(res: ServerResponse, error: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'internal_error';
  res.setHeader('connection', 'close');
  json(res, status, {error: {code, message: code}});
}
