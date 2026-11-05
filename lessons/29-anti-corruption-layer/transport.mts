import { HttpError } from '../../lib/http.mts';
import { exact, object } from './model.mts';
export function origin(value: string | undefined): string {
  if (!value || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value) || Number(new URL(value).port) > 65535) throw new Error('trusted loopback origin required');
  return value;
}
export async function bounded(response: Response, limit: number): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0] !== 'application/json') throw new Error('JSON required');
  if (!response.body) throw new Error('body required');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > limit) throw new Error('upstream too large');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function upstream(url: string, limit: number, deadline: number): Promise<unknown> {
  try {
    const response = await fetch(url, {redirect:'manual', signal:AbortSignal.timeout(deadline)});
    const value = await bounded(response, limit);
    if (response.status === 200) return value;
    const error = object(value); exact(error, ['error']);
    if (response.status === 404 && error.error === 'not_found') throw new HttpError(404, 'not_found', 'Product missing');
    if (response.status === 503 && error.error === 'temporary') throw new HttpError(503, 'temporary', 'Dependency unavailable');
    if (response.status === 502 && error.error === 'invalid_upstream') throw new HttpError(502,'invalid_upstream','Invalid dependency response');
    if (response.status === 504 && error.error === 'deadline') throw new HttpError(504,'deadline','Dependency deadline');
    throw new Error('unexpected upstream status');
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new HttpError(504, 'deadline', 'Dependency deadline');
    throw new HttpError(502, 'invalid_upstream', 'Invalid dependency response');
  }
}
export function invalidUpstream<T>(parse: () => T): T {
  try { return parse(); } catch { throw new HttpError(502, 'invalid_upstream', 'Invalid dependency semantics'); }
}
