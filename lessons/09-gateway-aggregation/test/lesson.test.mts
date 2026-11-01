import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSku, combine, validResource } from '../contract.mts';

test('unit: SKU is a single bounded ASCII identifier', () => {
  assert.equal(parseSku(new URL('http://local/product?sku=tea-01')), 'tea-01');
  for (const query of ['', '?sku=', '?sku=a&sku=b', '?sku=tea%0A', '?sku=../x', `?sku=${'a'.repeat(33)}`, '?sku=a&debug=1']) {
    assert.throws(() => parseSku(new URL(`http://local/product${query}`)));
  }
});

test('unit: aggregate distinguishes complete, partial and unavailable without fabricating data', () => {
  const catalog = { state: 'ok', data: { sku: 'tea-01', name: 'Trà sen', priceCents: 42000 } } as const;
  const stock = { state: 'ok', data: { sku: 'tea-01', available: 7 } } as const;
  const failed = { state: 'error', code: 'timeout' } as const;
  assert.deepEqual(combine(catalog, stock), { status: 200, body: { state: 'complete', catalog, stock } });
  assert.deepEqual(combine(catalog, failed), { status: 200, body: { state: 'partial', catalog, stock: failed } });
  assert.deepEqual(combine(failed, stock), { status: 200, body: { state: 'partial', catalog: failed, stock } });
  assert.deepEqual(combine(failed, failed), { status: 503, body: { state: 'unavailable', catalog: failed, stock: failed } });
});

test('unit: downstream schema and resource identity are checked at the gateway boundary', () => {
  assert.equal(validResource('catalog', { sku: 'tea-01', name: 'Trà sen', priceCents: 42000 }, 'tea-01'), true);
  assert.equal(validResource('stock', { sku: 'tea-01', available: 0 }, 'tea-01'), true);
  for (const value of [null, [], { sku: 'other', available: 7 }, { sku: 'tea-01', available: -1 }, { sku: 'tea-01', available: 1.5 }]) {
    assert.equal(validResource('stock', value, 'tea-01'), false);
  }
  assert.equal(validResource('catalog', { sku: 'tea-01', name: '', priceCents: 1 }, 'tea-01'), false);
});

import type { TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

async function setup(t: TestContext, catalogEnv: Record<string, string> = {}, stockEnv: Record<string, string> = {}, gatewayEnv: Record<string, string> = {}) {
  const services: RunningService[] = [];
  t.after(async () => { await Promise.all(services.map(service => service.stop())); });
  const catalog = await startService(new URL('../catalog.mts', import.meta.url), catalogEnv);
  services.push(catalog);
  const stock = await startService(new URL('../stock.mts', import.meta.url), stockEnv);
  services.push(stock);
  const gateway = await startService(new URL('../gateway.mts', import.meta.url), {
    CATALOG_URL: catalog.url, STOCK_URL: stock.url, ...gatewayEnv,
  });
  services.push(gateway);
  assert.equal(new Set(services.map(service => service.child.pid)).size, 3);
  return { catalog, stock, gateway };
}
function get(service: RunningService, query = '?sku=tea-01', method = 'GET', path = '/product') {
  return fetch(`${service.url}${path}${query}`, { method, signal: AbortSignal.timeout(5000) });
}
const catalogOk = { state: 'ok', data: { sku: 'tea-01', name: 'Trà sen', priceCents: 42000 } };
const stockOk = { state: 'ok', data: { sku: 'tea-01', available: 7 } };
const failure = (code: string) => ({ state: 'error', code });

async function expectResult(response: Response, status: number, state: string, catalog: unknown, stock: unknown) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { state, catalog, stock });
}

test('integration: healthy aggregation uses three processes and overlaps downstream HTTP work', async t => {
  const f = await setup(t, { DELAY_MS: '1000' }, { DELAY_MS: '1000' }, {
    CATALOG_TIMEOUT_MS: '3000', STOCK_TIMEOUT_MS: '3000', OVERALL_TIMEOUT_MS: '3500',
  });
  const started = performance.now();
  await expectResult(await get(f.gateway), 200, 'complete', catalogOk, stockOk);
  assert.ok(performance.now() - started < 1800, 'two 1000ms calls should overlap, not take 2000ms sequentially');
  // Ownership is visible through independently addressable resource APIs.
  const direct = await get(f.stock, '?sku=tea-01', 'GET', '/stock');
  assert.deepEqual(await direct.json(), stockOk.data);
});

test('integration: either dependency may fail while the other remains usable', async t => {
  const left = await setup(t, { MODE: 'fail' });
  await expectResult(await get(left.gateway), 200, 'partial', failure('upstream_status'), stockOk);
  const right = await setup(t, {}, { MODE: 'fail' });
  await expectResult(await get(right.gateway), 200, 'partial', catalogOk, failure('upstream_status'));
});

test('integration: total failure is explicit 503, including connection refusal', async t => {
  const f = await setup(t, { MODE: 'fail' });
  await f.stock.stop();
  await expectResult(await get(f.gateway), 503, 'unavailable', failure('upstream_status'), failure('unreachable'));
});

test('integration: per-dependency deadline retains a healthy result', async t => {
  const f = await setup(t, {}, { DELAY_MS: '1000' }, {
    STOCK_TIMEOUT_MS: '150', CATALOG_TIMEOUT_MS: '1500', OVERALL_TIMEOUT_MS: '2000',
  });
  const started = performance.now();
  await expectResult(await get(f.gateway), 200, 'partial', catalogOk, failure('timeout'));
  assert.ok(performance.now() - started < 900);
});

test('integration: overall deadline caps both larger dependency budgets', async t => {
  const f = await setup(t, { DELAY_MS: '1500' }, { DELAY_MS: '1500' }, {
    CATALOG_TIMEOUT_MS: '2500', STOCK_TIMEOUT_MS: '2500', OVERALL_TIMEOUT_MS: '200',
  });
  const started = performance.now();
  await expectResult(await get(f.gateway), 503, 'unavailable', failure('timeout'), failure('timeout'));
  assert.ok(performance.now() - started < 1000);
});

test('integration: invalid downstream JSON shape is a resource failure, not invented stock', async t => {
  const f = await setup(t, {}, { MODE: 'invalid' });
  await expectResult(await get(f.gateway), 200, 'partial', catalogOk, failure('invalid_response'));
});

test('integration: input validation and route/method contracts precede aggregation', async t => {
  const f = await setup(t);
  await Promise.all([f.catalog.stop(), f.stock.stop()]);
  for (const query of ['', '?sku=', '?sku=a&sku=b', '?sku=bad%0A', '?sku=a&extra=1']) {
    const response = await get(f.gateway, query);
    assert.equal(response.status, 400);
    const value: unknown = await response.json();
    assert.ok(typeof value === 'object' && value !== null && 'error' in value);
  }
  const wrongMethod = await get(f.gateway, '?sku=tea-01', 'POST');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  await wrongMethod.arrayBuffer();
  const missing = await get(f.gateway, '', 'GET', '/missing');
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
});

test('integration: overall deadline preserves an already completed resource', async t => {
  const f = await setup(t, {}, { DELAY_MS: '1500' }, {
    CATALOG_TIMEOUT_MS: '2500', STOCK_TIMEOUT_MS: '2500', OVERALL_TIMEOUT_MS: '500',
  });
  await expectResult(await get(f.gateway), 200, 'partial', catalogOk, failure('timeout'));
});

test('integration: valid but unknown SKU remains an explicit total resource failure', async t => {
  const f = await setup(t);
  await expectResult(await get(f.gateway, '?sku=unknown'), 503, 'unavailable', failure('upstream_status'), failure('upstream_status'));
});
