import { HttpError } from '../../lib/http.mts';
export function origin(name: string): string {
  const url = new URL(process.env[name] ?? 'invalid');
  if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error(`Invalid ${name}`);
  return url.origin;
}
// Config: 64 UTF-16 units may each need six JSON bytes, plus <128 bytes of fields.
// 1024 also admits the bounded backend contract (only a variant).
export async function upstream(url: string): Promise<unknown> {
  const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(500), headers: {accept: 'application/json'}});
  try {
    if (!response.ok) throw new Error('upstream status');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('missing body');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const {value, done} = await reader.read(); if (done) break;
      size += value.length; if (size > 1024) { await reader.cancel(); throw new Error('upstream bytes'); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await response.body?.cancel().catch(() => {}); }
}
export function badInput(): never { throw new HttpError(400, 'invalid_input', 'Invalid primitive or configuration'); }
