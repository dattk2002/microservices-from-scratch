import { HttpError, json, methodNotAllowed, numberSetting, readJson, serve } from '../../lib/http.mts';
import { fingerprint, parseInput, parseKey } from './contract.mts';
import { conflict, OrderStore } from './store.mts';
import type { Replay } from './store.mts';
import { fetchProduct } from './upstream.mts';

export async function main(): Promise<void> {
  const catalog = new URL(process.env.CATALOG_URL ?? 'http://127.0.0.1:4501');
  if (catalog.protocol !== 'http:' || catalog.username || catalog.password || catalog.pathname !== '/' || catalog.search || catalog.hash) {
    throw new Error('CATALOG_URL must be an HTTP origin without credentials');
  }
  const timeout = numberSetting('CATALOG_TIMEOUT_MS', 1000, 1, 10000);
  const store = new OrderStore(process.env.ORDERS_DB ?? './data/lesson05-orders.sqlite');
  const active = new Map<string, { hash: string; promise: Promise<Replay> }>();
  try {
    const server = await serve('orders-idempotency', 4502, async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (path === '/health') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        json(res, 200, { status: 'ok' }); return;
      }
      if (path !== '/orders') throw new HttpError(404, 'not_found', 'Unknown route');
      if (req.method !== 'POST') methodNotAllowed(res, 'POST');
      // headersDistinct detects duplicates instead of trusting Node's joined header value.
      const keys = req.headersDistinct['idempotency-key'];
      const key = parseKey(keys?.length === 1 ? keys[0] : undefined);
      const input = parseInput(await readJson(req));
      const hash = fingerprint(input);
      let result = store.find(key, hash);
      if (!result) {
        let entry = active.get(key);
        if (entry && entry.hash !== hash) conflict();
        if (!entry) {
          if (active.size >= 1024) throw new HttpError(503, 'orders_busy', 'Too many active order keys');
          const promise = (async () => {
            const product = await fetchProduct(catalog, input.productId, timeout);
            return store.complete(key, hash, input, product);
          })();
          entry = { hash, promise };
          active.set(key, entry);
        }
        try { result = await entry.promise; }
        finally { if (active.get(key) === entry) active.delete(key); }
      }
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(result.body);
    });
    server.once('close', () => store.close());
  } catch (error) { store.close(); throw error; }
}
if (import.meta.main) await main();
