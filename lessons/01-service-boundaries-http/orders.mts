import { randomUUID } from 'node:crypto';
import { HttpError, json, methodNotAllowed, numberSetting, readJson, serve } from '../../lib/http.mts';
import { parseOrderInput } from './domain.mts';

type Product = {id: string; name: string; priceCents: number};
type Order = {id: string; product: Product; quantity: number; totalCents: number};
const orders = new Map<string, Order>();
const catalog = new URL(process.env.CATALOG_URL ?? 'http://127.0.0.1:3101');
if (!['http:', 'https:'].includes(catalog.protocol) || catalog.username || catalog.password
    || catalog.pathname !== '/' || catalog.search || catalog.hash) throw new Error('CATALOG_URL must be an HTTP(S) origin');
const timeoutMs = numberSetting('CATALOG_TIMEOUT_MS', 500, 1, 10000);
const invalidProduct = () => new HttpError(502, 'catalog_invalid_response', 'Catalog returned an invalid product');

async function loadProduct(id: string): Promise<Product> {
  try {
    const response = await fetch(new URL(`/products/${id}`, catalog), {signal: AbortSignal.timeout(timeoutMs)});
    if (response.status === 404) {
      await response.body?.cancel();
      throw new HttpError(422, 'unknown_product', 'Choose an existing product');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(503, 'catalog_unavailable', 'Catalog is unavailable');
    }
    if (!response.body) throw invalidProduct();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > 8192) { await reader.cancel(); throw invalidProduct(); }
      chunks.push(result.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null) throw invalidProduct();
    const data = value as Record<string, unknown>;
    if (data.id !== id || typeof data.name !== 'string' || data.name.length < 1 || data.name.length > 100
        || typeof data.priceCents !== 'number' || !Number.isSafeInteger(data.priceCents)
        || data.priceCents < 0 || data.priceCents > 100_000_000) throw invalidProduct();
    return {id, name: data.name, priceCents: data.priceCents};
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new HttpError(504, 'catalog_timeout', 'Catalog request exceeded its deadline');
    }
    if (error instanceof SyntaxError) throw invalidProduct();
    throw new HttpError(503, 'catalog_unavailable', 'Catalog is unavailable');
  }
}

await serve('orders', 3102, async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://local.invalid').pathname;
  if (path === '/health') {
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    json(res, 200, {status: 'ok', service: 'orders'}); return;
  }
  if (path === '/orders') {
    if (req.method !== 'POST') methodNotAllowed(res, 'POST');
    const input = parseOrderInput(await readJson(req));
    const product = await loadProduct(input.productId);
    const order = {id: randomUUID(), product, quantity: input.quantity, totalCents: product.priceCents * input.quantity};
    orders.set(order.id, order);
    res.setHeader('location', `/orders/${order.id}`);
    json(res, 201, order); return;
  }
  const match = /^\/orders\/([a-f0-9-]{36})$/.exec(path);
  if (match?.[1]) {
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const order = orders.get(match[1]);
    if (!order) throw new HttpError(404, 'order_not_found', 'Order does not exist');
    json(res, 200, order); return;
  }
  throw new HttpError(404, 'not_found', 'Route does not exist');
});
