import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HttpError, json, methodNotAllowed, numberSetting, readJson, serve } from '../../lib/http.mts';
import { invalidProduct, orderIdPattern, parseOrderInput, parseProduct, snapshot } from './domain.mts';
import type { Product } from './domain.mts';
import { OrdersStore } from './store.mts';

async function loadProduct(catalog: URL, timeoutMs: number, id: string): Promise<Product> {
  try {
    const response = await fetch(new URL(`/products/${id}`, catalog), {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (response.status === 404) {
      await response.body?.cancel();
      throw new HttpError(422, 'unknown_product', 'Choose an existing product');
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new HttpError(503, 'catalog_unavailable', 'Catalog is unavailable');
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      await response.body?.cancel();
      throw invalidProduct();
    }
    if (!response.body) throw invalidProduct();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > 8192) { await reader.cancel(); throw invalidProduct(); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parseProduct(value, id);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof SyntaxError) throw invalidProduct();
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new HttpError(504, 'catalog_timeout', 'Catalog request exceeded its deadline');
    }
    throw new HttpError(503, 'catalog_unavailable', 'Catalog is unavailable');
  }
}

async function main() {
  const catalog = new URL(process.env.CATALOG_URL ?? 'http://127.0.0.1:3301');
  if (!['http:', 'https:'].includes(catalog.protocol) || catalog.username || catalog.password
      || catalog.pathname !== '/' || catalog.search || catalog.hash) throw new Error('CATALOG_URL must be an HTTP(S) origin');
  const timeoutMs = numberSetting('CATALOG_TIMEOUT_MS', 500, 1, 10000);
  const store = new OrdersStore(process.env.ORDERS_DB_PATH ?? fileURLToPath(new URL('./data/orders.sqlite', import.meta.url)));
  try {
    const server = await serve('orders', 3302, async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://local.invalid').pathname;
      if (path === '/health') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        json(res, 200, { status: 'ok', service: 'orders' }); return;
      }
      if (path === '/orders') {
        if (req.method !== 'POST') methodNotAllowed(res, 'POST');
        const input = parseOrderInput(await readJson(req));
        const product = await loadProduct(catalog, timeoutMs, input.productId);
        const order = snapshot(randomUUID(), input, product);
        store.create(order);
        res.setHeader('location', `/orders/${order.id}`);
        json(res, 201, order); return;
      }
      const id = path.startsWith('/orders/') ? path.slice('/orders/'.length) : '';
      if (orderIdPattern.test(id)) {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        const order = store.get(id);
        if (!order) throw new HttpError(404, 'order_not_found', 'Order does not exist');
        json(res, 200, order); return;
      }
      throw new HttpError(404, 'not_found', 'Route does not exist');
    });
    server.once('close', () => store.close());
  } catch (error) { store.close(); throw error; }
}

if (import.meta.main) await main();
