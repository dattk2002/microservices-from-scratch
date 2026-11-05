import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { object, profile } from './model.mts';
import { Projection } from './store.mts';
export async function main() {
 const supported = profile(process.env.PROFILE ?? 'current');
 const source = new URL(process.env.OWNER_URL ?? 'http://127.0.0.1:3027');
 if (source.protocol !== 'http:' || source.hostname !== '127.0.0.1' || source.username || source.password || source.pathname !== '/') throw new Error('Invalid OWNER_URL');
 const db = new Projection(process.env.DB_PATH ?? 'consumer.sqlite');
 let busy = false;
 try {
 const server = await serve('schema-consumer', 3028, async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (req.method === 'GET' && path === '/state') return json(res, 200, db.state());
  if (req.method === 'POST' && path === '/sync') {
   if (busy) throw new HttpError(409, 'busy', 'Sync in progress');
   const input = object(await readJson(req));
   if (Object.keys(input).length) throw new HttpError(400, 'input', 'Use empty object');
   busy = true;
   try {
    const response = await fetch(new URL('/events?after=' + db.state().checkpoint, source), { signal: AbortSignal.timeout(2000) });
    if (!response.ok) throw new HttpError(502, 'source', 'Source failed');
    // Bound decoded response bytes before JSON parsing, not only page count.
    const reader = response.body?.getReader(); if (!reader) throw new Error('Missing body');
    let text = ''; let size = 0; const decoder = new TextDecoder();
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 32768) throw new HttpError(502, 'page_size', 'Page too large'); text += decoder.decode(chunk.value, { stream: true }); } }
    finally { await reader.cancel(); }
    text += decoder.decode(); const page: unknown = JSON.parse(text);
    if (!Array.isArray(page) || page.length > 10) throw new HttpError(502, 'page', 'Invalid page');
    for (const event of page) db.apply(event, supported);
    return json(res, 200, db.state());
   } finally { busy = false; }
  }
  if (req.method === 'POST' && path === '/teaching/deliver' && process.env.TEACHING_CONTROLS === '1') return json(res, 200, { applied: db.apply(await readJson(req), supported) });
  throw new HttpError(404, 'route', 'Unknown route');
 });
 server.once('close', () => db.close());
 } catch (e) { db.close(); throw e; }
}
if (import.meta.main) await main();
