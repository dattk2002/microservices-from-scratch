import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseOrderInput } from '../domain.mts';
import { startService, jsonRequest } from '../../../test/support.mts';

test('unit: order contract rejects invalid identifiers, quantities and unknown fields', () => {
  assert.deepEqual(parseOrderInput({ productId: 'pencil', quantity: 2 }), { productId: 'pencil', quantity: 2 });
  const invalid: unknown[] = [null, [], {}, { productId: '../secret', quantity: 1 },
    { productId: 'pencil', quantity: 0 }, { productId: 'pencil', quantity: 101 },
    { productId: 'pencil', quantity: 1.2 }, { productId: 'pencil', quantity: '2' },
    { productId: 'pencil', quantity: NaN }, { productId: 'pencil', quantity: Infinity },
    { productId: 'pencil', quantity: 1, priceCents: 1 }];
  for (const value of invalid) assert.throws(() => parseOrderInput(value), JSON.stringify(value));
});

test('integration: independent Catalog/Orders processes and explicit HTTP contracts', async (t) => {
  const catalog = await startService(new URL('../catalog.mts', import.meta.url));
  t.after(() => catalog.stop());
  const orders = await startService(new URL('../orders.mts', import.meta.url), { CATALOG_URL: catalog.url });
  t.after(() => orders.stop());
  assert.notEqual(catalog.child.pid, orders.child.pid);
  let orderId = '';
  await t.test('health is independent for each process', async () => {
    for (const service of [catalog, orders]) {
      const response = await fetch(`${service.url}/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as {status: string}).status, 'ok');
    }
  });
  await t.test('Catalog owns price and Orders owns a price snapshot', async () => {
    const product = await fetch(`${catalog.url}/products/pencil`);
    assert.equal(product.status, 200);
    assert.deepEqual(await product.json(), { id: 'pencil', name: 'Pencil', priceCents: 125 });
    const created = await jsonRequest(`${orders.url}/orders`, { productId: 'pencil', quantity: 2 });
    assert.equal(created.status, 201);
    const order = await created.json() as {id: string; totalCents: number; quantity: number; product: unknown};
    orderId = order.id;
    assert.match(orderId, /^[a-f0-9-]{36}$/);
    assert.equal(order.totalCents, 250);
    assert.equal(order.quantity, 2);
    assert.deepEqual(order.product, { id: 'pencil', name: 'Pencil', priceCents: 125 });
    const saved = await fetch(`${orders.url}/orders/${orderId}`);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), order);
  });
  await t.test('validation, absent routes and methods have explicit status', async () => {
    assert.equal((await jsonRequest(`${orders.url}/orders`, { productId: 'pencil', quantity: 0 })).status, 400);
    assert.equal((await jsonRequest(`${orders.url}/orders`, { productId: 'missing', quantity: 1 })).status, 422);
    assert.equal((await fetch(`${catalog.url}/products/missing`)).status, 404);
    assert.equal((await fetch(`${orders.url}/orders/missing`)).status, 404);
    assert.equal((await fetch(`${orders.url}/unknown`)).status, 404);
    assert.equal((await fetch(`${orders.url}/orders`)).status, 405);
    assert.equal((await fetch(`${orders.url}/orders`, { method: 'POST', headers: {'content-type':'application/json'}, body: '{' })).status, 400);
    assert.equal((await fetch(`${orders.url}/orders`, { method: 'POST', body: 'text' })).status, 415);
    assert.equal((await jsonRequest(`${orders.url}/orders`, { data: 'x'.repeat(9000) })).status, 413);
  });
  await t.test('dependency outage does not erase an already-owned order or liveness', async () => {
    await catalog.stop();
    assert.equal((await fetch(`${orders.url}/health`)).status, 200);
    assert.equal((await fetch(`${orders.url}/orders/${orderId}`)).status, 200);
    const unavailable = await jsonRequest(`${orders.url}/orders`, {productId:'pencil', quantity:1});
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json() as {error:{code:string}}).error.code, 'catalog_unavailable');
  });
});

test('integration: slow or malformed upstream is bounded and distinguished', async (t) => {
  let mode: 'slow' | 'bad' = 'slow';
  const upstream = createServer((_req, res) => {
    if (mode === 'slow') setTimeout(() => res.end('{}'), 300).unref();
    else { res.setHeader('content-type', 'application/json'); res.end('{"id":"pencil","priceCents":-1}'); }
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const port = (upstream.address() as {port: number}).port;
  const orders = await startService(new URL('../orders.mts', import.meta.url), {
    CATALOG_URL: `http://127.0.0.1:${port}`, CATALOG_TIMEOUT_MS: '40',
  });
  t.after(() => orders.stop());
  const expired = await jsonRequest(`${orders.url}/orders`, {productId:'pencil',quantity:1});
  assert.equal(expired.status, 504);
  assert.equal((await expired.json() as {error:{code:string}}).error.code, 'catalog_timeout');
  mode = 'bad';
  const malformed = await jsonRequest(`${orders.url}/orders`, {productId:'pencil',quantity:1});
  assert.equal(malformed.status, 502);
  assert.equal((await malformed.json() as {error:{code:string}}).error.code, 'catalog_invalid_response');
});
