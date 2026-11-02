import { HttpError, json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { key } from './product.mts';
import type { Product } from './product.mts';

export async function startCatalog() {
  const products = new Map<string, Product>(['a', 'b', 'c'].map(id => [id, { id, price: 100, version: 1 }]));
  let mode = 'open'; let calls = 0; let active = 0;
  const held = new Set<() => void>();
  return serve('catalog', 4611, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname === '/control' && process.env.TEST_CONTROLS === '1') {
      if (req.method !== 'POST') methodNotAllowed(res, 'POST');
      const next = url.searchParams.get('mode');
      if (!next || !['hold', 'open', 'fail', 'malformed'].includes(next)) throw new HttpError(400, 'invalid_mode', 'Unknown mode');
      mode = next;
      if (mode !== 'hold') for (const release of held) release();
      json(res, 200, { mode }); return;
    }
    if (url.search) throw new HttpError(400, 'invalid_query', 'No query supported');
    if (url.pathname === '/stats' && process.env.TEST_CONTROLS === '1') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      json(res, 200, { calls, active }); return;
    }
    const id = key(url.pathname);
    if (!id) throw new HttpError(404, 'not_found', 'Unknown product');
    const current = products.get(id);
    if (!current) throw new Error('Missing seed');
    if (req.method === 'PUT') {
      const body = await readJson(req);
      if (typeof body !== 'object' || body === null || !('price' in body) || typeof body.price !== 'number' || !Number.isSafeInteger(body.price) || body.price < 0) {
        throw new HttpError(400, 'invalid_product', 'price must be a nonnegative integer');
      }
      const updated = { id, price: body.price, version: current.version + 1 };
      products.set(id, updated); json(res, 200, updated); return;
    }
    if (req.method !== 'GET') methodNotAllowed(res, 'GET, PUT');
    calls++; active++;
    try {
      if (mode === 'hold') await new Promise<void>(resolve => {
        const release = () => { held.delete(release); res.off('close', release); clearTimeout(timer); resolve(); };
        const timer = setTimeout(release, 10000);
        held.add(release); res.once('close', release);
      });
      if (res.destroyed) return;
      if (mode === 'fail') throw new HttpError(503, 'catalog_failed', 'Injected failure');
      if (mode === 'malformed') { json(res, 200, { id, price: 'invalid' }); return; }
      // Read at response time: the barrier may span a source update.
      json(res, 200, products.get(id));
    } finally { active--; }
  });
}
if (import.meta.main) await startCatalog();
