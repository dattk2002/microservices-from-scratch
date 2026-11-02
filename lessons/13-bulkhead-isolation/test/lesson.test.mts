import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool, runBounded } from '../bulkhead.mts';
import { startGateway } from '../gateway.mts';

test('unit: validates capacity and admits only bounded work with idempotent release', () => {
  for (const n of [0, -1, 1.5, NaN, Infinity, 1001, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new Pool(n));
  const pool = new Pool(1);
  const release = pool.acquire();
  assert.ok(release);
  assert.equal(pool.acquire(), undefined);
  release(); release();
  assert.ok(pool.acquire());
  assert.equal(pool.acquire(), undefined);
});

test('unit: acquires before work and releases after success, error and cancellation', async () => {
  const pool = new Pool(1);
  for (const mode of ['success', 'error', 'cancel']) {
    const controller = new AbortController();
    let entered = false;
    const pending = runBounded(pool, controller.signal, async (signal) => {
      entered = true;
      assert.equal(pool.acquire(), undefined);
      if (mode === 'error') throw new Error('downstream');
      if (mode === 'cancel') await new Promise<void>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return 42;
    });
    assert.equal(entered, true);
    let called = false;
    await assert.rejects(runBounded(pool, controller.signal, async () => { called = true; }));
    assert.equal(called, false);
    if (mode === 'cancel') controller.abort(new Error('cancelled'));
    if (mode === 'success') assert.equal(await pending, 42);
    else await assert.rejects(pending);
    const release = pool.acquire(); assert.ok(release); release();
  }
  const cancelled = AbortSignal.abort(new Error('already cancelled'));
  await assert.rejects(runBounded(pool, cancelled, async () => assert.fail('must not start')));
  const release = pool.acquire(); assert.ok(release); release();
});


test('unit: gateway rejects invalid environment configuration before starting a listener', async () => {
  for (const [name, value] of [
    ['CATALOG_CAPACITY', '0'], ['SHIPPING_CAPACITY', '1.5'],
    ['DEADLINE_MS', '0'], ['DEADLINE_MS', '10001'],
    ['CATALOG_URL', 'https://127.0.0.1:4311'],
    ['SHIPPING_URL', 'http://user:pass@127.0.0.1:4312'],
    ['CATALOG_URL', 'http://127.0.0.1:4311/work'],
    ['SHIPPING_URL', 'http://127.0.0.1:4312/?debug=1'],
  ] as const) {
    const previous = process.env[name];
    process.env[name] = value;
    try { await assert.rejects(startGateway(), /Invalid/); }
    finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

import type { TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

async function setup(t: TestContext, deadline = '8000') {
  const services: RunningService[] = [];
  t.after(async () => { await Promise.all(services.map(s => s.stop())); });
  const catalog = await startService(new URL('../catalog.mts', import.meta.url), { TEST_CONTROLS: '1' });
  services.push(catalog);
  const shipping = await startService(new URL('../shipping.mts', import.meta.url), { TEST_CONTROLS: '1' });
  services.push(shipping);
  const gateway = await startService(new URL('../gateway.mts', import.meta.url), {
    CATALOG_URL: catalog.url, SHIPPING_URL: shipping.url,
    CATALOG_CAPACITY: '2', SHIPPING_CAPACITY: '1', DEADLINE_MS: deadline,
  });
  services.push(gateway);
  assert.equal(new Set(services.map(s => s.child.pid)).size, 3);
  return { catalog, shipping, gateway };
}
function request(service: RunningService, path: string, method = 'GET', timeout = 5000) {
  return fetch(`${service.url}${path}`, { method, signal: AbortSignal.timeout(timeout) });
}
async function control(service: RunningService, mode: string) {
  const response = await request(service, `/control?mode=${mode}`, 'POST');
  assert.equal(response.status, 200); await response.arrayBuffer();
}
async function ok(response: Response, dependency: string) {
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { dependency, state: 'ok' });
}

test('integration: full catalog rejects before downstream admission while shipping remains usable', async t => {
  const f = await setup(t);
  await control(f.catalog, 'hold');
  // Attach rejection handlers immediately; teardown also settles outstanding requests.
  const first = request(f.gateway, '/catalog', 'GET', 10000);
  const second = request(f.gateway, '/catalog', 'GET', 10000);
  const settled = Promise.allSettled([first, second]);
  t.after(async () => { await settled; });
  const barrier = await request(f.catalog, '/barrier?count=2');
  assert.equal(barrier.status, 200); await barrier.arrayBuffer();
  const before = await request(f.catalog, '/stats');
  assert.deepEqual(await before.json(), { entered: 2, active: 2 });
  // A queued request would remain blocked until the 8s downstream deadline.
  const rejected = await request(f.gateway, '/catalog', 'GET', 1500);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get('retry-after'), '1');
  assert.deepEqual(await rejected.json(), { error: { code: 'bulkhead_full', dependency: 'catalog' } });
  await ok(await request(f.gateway, '/shipping'), 'shipping');
  const after = await request(f.catalog, '/stats');
  assert.deepEqual(await after.json(), { entered: 2, active: 2 });
  await control(f.catalog, 'open');
  await ok(await first, 'catalog'); await ok(await second, 'catalog');
  await ok(await request(f.gateway, '/catalog'), 'catalog');
});

test('integration: downstream failure returns permits before the next request', async t => {
  const f = await setup(t);
  await control(f.catalog, 'fail');
  for (let i = 0; i < 4; i++) {
    const response = await request(f.gateway, '/catalog');
    assert.equal(response.status, 502);
    const body: unknown = await response.json();
    assert.deepEqual(body, { error: { code: 'dependency_failed', message: 'Downstream returned failure' } });
  }
  await control(f.catalog, 'open');
  await ok(await request(f.gateway, '/catalog'), 'catalog');
});

test('integration: deadline abort frees both permits and cancels held HTTP work', async t => {
  const f = await setup(t, '1200');
  await control(f.catalog, 'hold');
  const requests = [request(f.gateway, '/catalog'), request(f.gateway, '/catalog')];
  const settled = Promise.allSettled(requests);
  t.after(async () => { await settled; });
  const barrier = await request(f.catalog, '/barrier?count=2');
  assert.equal(barrier.status, 200); await barrier.arrayBuffer();
  for (const pending of requests) {
    const response = await pending;
    assert.equal(response.status, 504);
    assert.deepEqual(await response.json(), { error: { code: 'deadline_exceeded', message: 'Downstream deadline exceeded' } });
  }
  // Observe socket cancellation with a bounded polling deadline, not a fixed sleep.
  const until = performance.now() + 2000;
  for (;;) {
    const response = await request(f.catalog, '/stats');
    const stats: unknown = await response.json();
    if (typeof stats === 'object' && stats !== null && 'active' in stats && stats.active === 0) break;
    assert.ok(performance.now() < until, 'downstream must observe cancellation');
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  const recovered = [request(f.gateway, '/catalog'), request(f.gateway, '/catalog')];
  const recoveredSettled = Promise.allSettled(recovered);
  t.after(async () => { await recoveredSettled; });
  const recoveredBarrier = await request(f.catalog, '/barrier?count=4');
  assert.equal(recoveredBarrier.status, 200); await recoveredBarrier.arrayBuffer();
  await control(f.catalog, 'open');
  for (const pending of recovered) await ok(await pending, 'catalog');
  await ok(await request(f.gateway, '/shipping'), 'shipping');
});

test('integration: gateway rejects invalid routes, queries and methods', async t => {
  const f = await setup(t);
  for (const [path, method, status] of [['/missing', 'GET', 404], ['/catalog?mode=hold', 'GET', 400], ['/shipping', 'POST', 405]] as const) {
    const response = await request(f.gateway, path, method);
    assert.equal(response.status, status);
    if (status === 405) assert.equal(response.headers.get('allow'), 'GET');
    await response.arrayBuffer();
  }
});

test('integration: shipping also has its own bounded admission pool', async t => {
  const f = await setup(t);
  await control(f.shipping, 'hold');
  const held = request(f.gateway, '/shipping', 'GET', 10000);
  const settled = Promise.allSettled([held]);
  t.after(async () => { await settled; });
  const barrier = await request(f.shipping, '/barrier?count=1');
  assert.equal(barrier.status, 200); await barrier.arrayBuffer();
  const rejected = await request(f.gateway, '/shipping', 'GET', 1500);
  assert.equal(rejected.status, 503);
  assert.deepEqual(await rejected.json(), { error: { code: 'bulkhead_full', dependency: 'shipping' } });
  await ok(await request(f.gateway, '/catalog'), 'catalog');
  const stats = await request(f.shipping, '/stats');
  assert.deepEqual(await stats.json(), { entered: 1, active: 1 });
  await control(f.shipping, 'open');
  await ok(await held, 'shipping');
});
