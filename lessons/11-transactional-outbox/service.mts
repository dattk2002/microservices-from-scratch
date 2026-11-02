import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { Store } from './store.mts';
import type { Event } from './store.mts';

function event(value: unknown): Event {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('quantity' in value)
    || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id)
    || typeof value.quantity !== 'number' || !Number.isSafeInteger(value.quantity) || value.quantity < 1 || value.quantity > 1000) {
    throw new HttpError(400, 'invalid_event', 'Use id (1..80 ASCII letters/digits/hyphens) and quantity (1..1000)');
  }
  return { id: value.id, quantity: value.quantity };
}
export async function main() {
  const role = process.env.ROLE ?? 'producer';
  if (role !== 'producer' && role !== 'consumer') throw new Error('Invalid ROLE');
  const dbPath = process.env.DB_PATH;
  if (!dbPath) throw new Error('DB_PATH is required');
  const target = role === 'producer' ? new URL(process.env.CONSUMER_URL ?? 'http://127.0.0.1:4112') : undefined;
  if (target && (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password)) throw new Error('Use loopback HTTP consumer URL');
  const store = new Store(dbPath);
  let stopping = false;
  const abort = new AbortController();
  const server = await serve(`outbox-${role}`, role === 'producer' ? 4111 : 4112, async (req, res) => {
    if (req.url === '/state') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      json(res, 200, { orders: store.orders(), pending: store.pending(), total: store.total() }); return;
    }
    if (req.url !== (role === 'producer' ? '/orders' : '/events')) throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'POST') methodNotAllowed(res, 'POST');
    const input = event(await readJson(req));
    try {
      const created = role === 'producer' ? store.create(input.id, input.quantity) : store.consume(input.id, input.quantity);
      json(res, role === 'producer' && created ? 201 : 200, { id: input.id, duplicate: !created });
    } catch (error) {
      if (error instanceof Error && error.message === 'conflict') throw new HttpError(409, 'id_conflict', 'ID already has a different quantity');
      throw error;
    }
  });
  const stop = () => { stopping = true; abort.abort(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const relay = (async () => {
    while (!stopping && target) {
      const item = store.next(Date.now());
      if (item) {
        try {
          const response = await fetch(new URL('/events', target), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: item.id, quantity: item.quantity }), redirect: 'error',
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(500)]),
          });
          await response.arrayBuffer();
          if (response.status !== 200) throw new Error(`Receiver status ${response.status}`);
          store.delivered(item.id);
        } catch { store.failed(item.id, item.attempts, Date.now()); }
      }
      try { await delay(25, undefined, { signal: abort.signal }); } catch { /* shutdown */ }
    }
  })();
  server.once('close', () => {
    stop();
    void relay.finally(() => store.close());
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
