import { DatabaseSync } from 'node:sqlite';
import { HttpError, numberSetting } from '../../lib/http.mts';

// Only main() calls these: importing a lesson must have no runtime side effects.
export function settings() {
  if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1') throw new Error('Only loopback HOST=127.0.0.1 is supported');
  const controls = process.env.TEACHING_CONTROLS ?? '0';
  if (controls !== '0' && controls !== '1') throw new Error('Invalid TEACHING_CONTROLS');
  return {teaching: controls === '1', ttl: numberSetting('LEASE_MS', 5000, 1, 10000)};
}
export function database(): DatabaseSync {
  const path = process.env.DB_PATH;
  if (!path || path.length > 1024 || path === ':memory:') throw new Error('DB_PATH must name a durable local SQLite file');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA max_page_count=128');
    return db;
  } catch (error) { db.close(); throw error; }
}
export function origin(value: string | undefined): string {
  if (!value) throw new Error('Missing upstream URL');
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Expected loopback HTTP origin with explicit port');
  return url.origin;
}
export async function call(url: string, body: unknown): Promise<unknown> {
  try {
    const response = await fetch(url, {
      method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
      signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    if (!response.body) throw new Error('Missing upstream body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) throw new Error('Upstream body too large');
        chunks.push(part.value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (response.status !== 200) throw new HttpError(response.status === 409 ? 409 : 502, 'upstream_rejected', 'Upstream rejected command');
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'upstream_unavailable', 'Upstream unavailable or malformed');
  }
}
