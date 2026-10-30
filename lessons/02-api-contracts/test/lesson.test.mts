import assert from 'node:assert/strict';
import test from 'node:test';
import { parseV1Product } from '../contract.mts';
import { startService, jsonRequest } from '../../../test/support.mts';

const pencil = { id: 'pencil', name: 'Bút chì', priceCents: 125 };
test('unit: v1 parser projects known fields and accepts additive provider fields', () => {
  assert.deepEqual(parseV1Product({ ...pencil, stock: 40, metadata: { color: 'đen' } }, 'pencil'), pencil);
  assert.deepEqual(parseV1Product({ ...pencil, priceCents: 0 }, 'pencil'), { ...pencil, priceCents: 0 });
});
test('unit: v1 parser rejects missing, mistyped, mismatched and unsafe fields', () => {
  const invalid: unknown[] = [null, [], {}, { ...pencil, id: undefined },
    { ...pencil, id: 'other' }, { ...pencil, id: '../pencil' }, { ...pencil, id: 1 },
    { ...pencil, name: undefined }, { ...pencil, name: '' }, { ...pencil, name: 42 },
    { ...pencil, priceCents: undefined }, { ...pencil, priceCents: '125' },
    { ...pencil, priceCents: -1 }, { ...pencil, priceCents: 1.25 },
    { ...pencil, priceCents: NaN }, { ...pencil, priceCents: Infinity },
    { ...pencil, priceCents: Number.MAX_SAFE_INTEGER + 1 },
    { id: 'pencil', name: 'Bút chì', price: { amountCents: 125, currency: 'USD' } }];
  for (const value of invalid) assert.throws(() => parseV1Product(value, 'pencil'), JSON.stringify(value));
});

for (const mode of ['baseline', 'additive', 'incompatible']) {
  test(`integration: separate provider/consumer processes with ${mode} v1 deployment`, async (t) => {
    const catalog = await startService(new URL('../catalog.mts', import.meta.url), { CATALOG_MODE: mode });
    t.after(() => catalog.stop());
    const orders = await startService(new URL('../orders.mts', import.meta.url), { CATALOG_URL: catalog.url });
    t.after(() => orders.stop());
    assert.notEqual(catalog.child.pid, orders.child.pid);
    const get = (path: string) => fetch(`${catalog.url}${path}`, { signal: AbortSignal.timeout(5000) });
    const v2 = await get('/v2/products/pencil');
    assert.equal(v2.status, 200);
    const nested: unknown = await v2.json();
    assert.deepEqual(nested, { id: 'pencil', name: 'Bút chì', price: { amountCents: 125, currency: 'USD' } });
    assert.throws(() => parseV1Product(nested, 'pencil'));
    const v1 = await get('/v1/products/pencil');
    assert.equal(v1.status, 200);
    assert.deepEqual(await v1.json(), mode === 'incompatible' ? { ...pencil, priceCents: '125' } :
      mode === 'additive' ? { ...pencil, stock: 40, tags: ['stationery'] } : pencil);
    const response = await jsonRequest(`${orders.url}/orders`, { productId: 'pencil', quantity: 2 });
    assert.equal(response.status, mode === 'incompatible' ? 502 : 201);
    const body: unknown = await response.json();
    if (mode === 'incompatible') {
      assert.deepEqual(body, { error: { code: 'catalog_invalid_response', message: 'Invalid v1 product' } });
    } else {
      assert.ok(typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string');
      assert.match(body.id, /^[a-f0-9-]{36}$/);
      assert.deepEqual(body, { id: body.id, product: pencil, quantity: 2, totalCents: 250 });
    }
    assert.equal((await get('/v1/products/missing')).status, 404);
    assert.equal((await jsonRequest(`${orders.url}/orders`, { productId: 'missing', quantity: 1 })).status, 422);
    assert.equal((await jsonRequest(`${orders.url}/orders`, { productId: 'pencil', quantity: 0 })).status, 400);
    await catalog.stop();
    const unavailable = await jsonRequest(`${orders.url}/orders`, { productId: 'pencil', quantity: 1 });
    assert.equal(unavailable.status, 503);
  });
}
