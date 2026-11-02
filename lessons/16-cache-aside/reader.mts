import { performance } from 'node:perf_hooks';
import { HttpError, json, methodNotAllowed, numberSetting, serve } from '../../lib/http.mts';
import { Cache, CacheBusy } from './cache.mts';
import { key, product } from './product.mts';
import type { Product } from './product.mts';

export async function startReader() {
  const origin = new URL(process.env.CATALOG_URL ?? 'http://127.0.0.1:4611');
  if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('Invalid CATALOG_URL');
  }
  const deadline = numberSetting('DEADLINE_MS', 800, 1, 10000);
  const cache = new Cache<Product>(numberSetting('CACHE_ENTRIES', 2, 1, 1000),
    numberSetting('MAX_LOADS', 2, 1, 1000), numberSetting('TTL_MS', 2000, 1, 100000), () => performance.now());
  async function load(id: string): Promise<Product> {
    const signal = AbortSignal.timeout(deadline);
    try {
      const response = await fetch(new URL(`/products/${id}`, origin), { signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        throw new HttpError(502, 'upstream_failed', 'Catalog returned failure');
      }
      if (response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') {
        await response.body?.cancel();
        throw new HttpError(502, 'invalid_upstream', 'Catalog must return JSON');
      }
      const reader = response.body?.getReader();
      if (!reader) throw new HttpError(502, 'invalid_upstream', 'Missing body');
      const chunks: Uint8Array[] = []; let size = 0;
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) { await reader.cancel(); throw new HttpError(502, 'invalid_upstream', 'Body too large'); }
        chunks.push(part.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return product(value, id);
    } catch (error) {
      if (signal.aborted) throw new HttpError(504, 'deadline_exceeded', 'Catalog deadline exceeded');
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, 'invalid_upstream', 'Catalog unavailable or invalid JSON');
    }
  }
  return serve('cached-reader', 4612, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.search) throw new HttpError(400, 'invalid_query', 'No query supported');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    if (url.pathname === '/stats' && process.env.TEST_CONTROLS === '1') { json(res, 200, cache.stats()); return; }
    const id = key(url.pathname);
    if (!id) throw new HttpError(404, 'not_found', 'Use /products/a, b or c');
    try { json(res, 200, await cache.get(id, () => load(id))); }
    catch (error) {
      if (error instanceof CacheBusy) { res.setHeader('retry-after', '1'); throw new HttpError(503, 'cache_busy', 'Distinct load capacity reached'); }
      throw error;
    }
  });
}
if (import.meta.main) await startReader();
