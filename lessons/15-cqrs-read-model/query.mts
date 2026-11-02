import { pathToFileURL } from 'node:url';
import { HttpError, json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { identifier, parseEvent } from './protocol.mts';
import { Projection } from './store.mts';
export async function main() {
  if (!process.env.DB_PATH) throw new Error('DB_PATH required');
  const source = new URL(process.env.ORDERS_URL ?? 'http://127.0.0.1:4151');
  if (source.protocol !== 'http:' || source.hostname !== '127.0.0.1' || source.username || source.password) throw new Error('Use loopback Orders URL');
  const store = new Projection(process.env.DB_PATH);
  let syncing = false;
  try {
    const server = await serve('cqrs-query', 4152, async (req, res) => {
      if (req.url === '/state') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        json(res, 200, store.state()); return;
      }
      if (req.url?.startsWith('/orders/')) {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        const summary = store.get(identifier(req.url.slice(8)));
        if (!summary) throw new HttpError(404, 'not_projected', 'Missing or not propagated');
        json(res, 200, { summary, freshness: store.state() }); return;
      }
      // Replay endpoint makes at-least-once delivery and conflicts observable in the lab.
      if (req.url === '/events') {
        if (req.method !== 'POST') methodNotAllowed(res, 'POST');
        json(res, 200, { result: store.apply(parseEvent(await readJson(req))) }); return;
      }
      if (req.url !== '/sync') throw new HttpError(404, 'not_found', 'Unknown route');
      if (req.method !== 'POST') methodNotAllowed(res, 'POST');
      if (syncing) throw new HttpError(409, 'sync_busy', 'One sync at a time');
      syncing = true;
      try {
        let data: unknown;
        try {
          const response = await fetch(new URL(`/events?after=${store.state().checkpoint}`, source), {
            signal: AbortSignal.timeout(700), redirect: 'error',
          });
          if (response.status !== 200) { await response.body?.cancel(); throw new Error('Source status'); }
          // Our source emits at most ten small events; cap bytes even for a faulty peer.
          if (!response.body) throw new Error('Missing body');
          const chunks: Uint8Array[] = []; let size = 0;
          const reader = response.body.getReader();
          try {
            for (;;) {
              const chunk = await reader.read(); if (chunk.done) break;
              size += chunk.value.byteLength;
              if (size > 8192) throw new Error('Oversized page');
              chunks.push(chunk.value);
            }
          } finally { await reader.cancel(); }
          data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          if (!Array.isArray(data) || data.length > 10) throw new Error('Invalid page');
        } catch { throw new HttpError(503, 'source_unavailable', 'Retry sync from durable checkpoint'); }
        if (!Array.isArray(data)) throw new Error('Invalid page');
        const events = data.map(parseEvent);
        for (const event of events) store.apply(event);
        json(res, 200, { fetched: events.length, ...store.state() });
      } finally { syncing = false; }
    });
    server.once('close', () => store.close());
  } catch (error) { store.close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
