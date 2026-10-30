import { randomUUID } from 'node:crypto';
import { HttpError, json, methodNotAllowed, numberSetting, readJson, serve } from '../../lib/http.mts';
import { parseV1Product } from './contract.mts';

const catalog = new URL(process.env.CATALOG_URL ?? 'http://127.0.0.1:4201');
if (catalog.protocol !== 'http:' || catalog.username || catalog.password || catalog.pathname !== '/' || catalog.search || catalog.hash) {
  throw new Error('CATALOG_URL must be an HTTP origin without credentials');
}
const timeout = numberSetting('CATALOG_TIMEOUT_MS', 1000, 1, 10000);
await serve('orders-contracts', 4202, async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/health') { json(res, 200, { status: 'ok' }); return; }
  if (path !== '/orders') throw new HttpError(404, 'not_found', 'Unknown route');
  if (req.method !== 'POST') methodNotAllowed(res, 'POST');
  const input = await readJson(req);
  if (typeof input !== 'object' || input === null || Array.isArray(input) ||
      !('productId' in input) || typeof input.productId !== 'string' || !/^[a-z0-9-]{1,64}$/.test(input.productId) ||
      !('quantity' in input) || typeof input.quantity !== 'number' || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > 100 ||
      Object.keys(input).some(key => key !== 'productId' && key !== 'quantity')) {
    throw new HttpError(400, 'invalid_order', 'Use productId and integer quantity 1..100');
  }
  const signal = AbortSignal.timeout(timeout);
  let product;
  try {
    const upstream = await fetch(new URL(`/v1/products/${input.productId}`, catalog), { signal, redirect: 'error' });
    if (upstream.status === 404) {
      await upstream.body?.cancel();
      throw new HttpError(422, 'unknown_product', 'Product does not exist');
    }
    if (upstream.status !== 200) {
      await upstream.body?.cancel();
      throw new HttpError(502, 'catalog_bad_status', 'Unexpected Catalog status');
    }
    if (upstream.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      await upstream.body?.cancel();
      throw new HttpError(502, 'catalog_invalid_response', 'Expected JSON');
    }
    const data: unknown = await upstream.json();
    try { product = parseV1Product(data, input.productId); }
    catch { throw new HttpError(502, 'catalog_invalid_response', 'Invalid v1 product'); }
  } catch (error: unknown) {
    if (error instanceof HttpError) throw error;
    if (signal.aborted) throw new HttpError(504, 'catalog_timeout', 'Catalog deadline exceeded');
    if (error instanceof SyntaxError) throw new HttpError(502, 'catalog_invalid_response', 'Invalid JSON');
    throw new HttpError(503, 'catalog_unavailable', 'Cannot reach Catalog');
  }
  const totalCents = product.priceCents * input.quantity;
  if (!Number.isSafeInteger(totalCents)) throw new HttpError(502, 'catalog_invalid_response', 'Total exceeds safe integer range');
  json(res, 201, { id: randomUUID(), product, quantity: input.quantity, totalCents });
});
