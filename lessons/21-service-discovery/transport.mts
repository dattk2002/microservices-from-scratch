import { HttpError } from '../../lib/http.mts';
export async function request(url: string, method = 'GET', body?: unknown): Promise<Response> {
  return fetch(url, {method, redirect: 'error', signal: AbortSignal.timeout(400),
    ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})});
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'object_required', 'Expected object');
  return value as Record<string, unknown>;
}
export function loopbackHost(): void {
  if (process.env.HOST !== undefined && process.env.HOST !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
}
