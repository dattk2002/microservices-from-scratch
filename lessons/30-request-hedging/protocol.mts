import type { Reply } from './hedge.mts';
export const validId = (id: string) => /^[A-Za-z0-9_-]{1,64}$/.test(id);
// id: 64 ASCII bytes; text: 256 UTF-16 units, each may require six JSON bytes.
export const MAX_BODY = Buffer.byteLength(JSON.stringify({id: '', text: ''})) + 64 + 256 * 6;
export function parseValue(raw: unknown, id: string): {id: string; text: string} {
  if (typeof raw !== 'object' || raw === null || !('id' in raw) || !('text' in raw) ||
      typeof raw.id !== 'string' || raw.id !== id || !validId(raw.id) || typeof raw.text !== 'string' || raw.text.length > 256 || Object.keys(raw).length !== 2) throw new Error('Invalid representation');
  return {id: raw.id, text: raw.text};
}
export function loopback(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Loopback origin required');
  return url.origin;
}
export async function upstream(origin: string, id: string, signal: AbortSignal): Promise<Reply> {
  const response = await fetch(`${origin}/items/${id}`, {signal, redirect: 'error'});
  return readResponse(response, id);
}
export async function readResponse(response: Response, id: string): Promise<Reply> {
  if (response.status !== 200) { await response.body?.cancel(); return {status: response.status}; }
  if (!response.headers.get('content-type')?.startsWith('application/json')) { await response.body?.cancel(); throw new Error('Invalid media'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('Missing body');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_BODY) throw new Error('Oversized'); chunks.push(part.value); }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return {status: 200, value: parseValue(raw, id)};
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
