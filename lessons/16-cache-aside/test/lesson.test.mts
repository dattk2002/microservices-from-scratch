import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Cache } from '../cache.mts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('unit: TTL begins at completion, exact expiry reloads and hits promote LRU', async () => {
  let now = 0; let calls = 0;
  const cache = new Cache<number>(2, 2, 10, () => now);
  const load = async () => ++calls;
  assert.equal(await cache.get('a', load), 1);
  now = 9; assert.equal(await cache.get('a', load), 1);
  now = 10; assert.equal(await cache.get('a', load), 2);
  await cache.get('b', load);
  await cache.get('a', load);
  await cache.get('c', load);
  assert.equal(await cache.get('a', load), 2);
  assert.equal(await cache.get('b', load), 5);
  const pending = deferred<number>();
  const p = cache.get('slow', () => pending.promise);
  now = 100; pending.resolve(9); await p;
  now = 109; assert.equal(await cache.get('slow', load), 9);
  now = 110; assert.equal(await cache.get('slow', load), 6);
});

test('unit: same key joins at capacity, distinct loads reject, failures release and never cache', { timeout: 1000 }, async () => {
  const cache = new Cache<number>(1, 1, 10, () => 0);
  const gate = deferred<number>(); let calls = 0;
  const load = () => { calls++; return gate.promise; };
  const a = cache.get('a', load); const b = cache.get('a', load);
  const failed = Promise.allSettled([a, b]);
  await assert.rejects(cache.get('b', load), /cache_busy/);
  assert.equal(calls, 1);
  gate.reject(new Error('source failed'));
  assert.deepEqual((await failed).map(v => v.status), ['rejected', 'rejected']);
  assert.equal(await cache.get('b', async () => 2), 2);
  assert.equal(await cache.get('a', async () => 3), 3);
  await assert.rejects(cache.get('x', () => { throw new Error('sync'); }), /sync/);
  assert.equal(await cache.get('x', async () => 4), 4);
});

test('unit: capacities and TTL must be bounded positive integers', () => {
  for (const n of [0, -1, 1.2, NaN, Infinity, 100001]) {
    assert.throws(() => new Cache( n, 1, 1, () => 0));
    assert.throws(() => new Cache(1, n, 1, () => 0));
    assert.throws(() => new Cache(1, 1, n, () => 0));
  }
});

import { product } from '../product.mts';
import type { TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: upstream validation rejects wrong ids, missing fields and unsafe numbers', () => {
  for (const value of [null, [], {}, { id: 'b', price: 1, version: 1 },
    { id: 'a', price: '100', version: 1 }, { id: 'a', price: -1, version: 1 },
    { id: 'a', price: 1, version: 0 }, { id: 'a', price: Infinity, version: 1 },
    { id: 'a', price: 1, version: 1.5 }]) assert.throws(() => product(value, 'a'));
  const value = product({ id: 'a', price: 100, version: 1, ignored: true }, 'a');
  assert.deepEqual(value, { id: 'a', price: 100, version: 1 });
  assert.ok(Object.isFrozen(value));
});

async function setup(t: TestContext, env: Record<string, string> = {}) {
  const services: RunningService[] = [];
  t.after(async () => { await Promise.all(services.map(s => s.stop())); });
  const catalog = await startService(new URL('../catalog.mts', import.meta.url), { TEST_CONTROLS: '1' });
  services.push(catalog);
  const reader = await startService(new URL('../reader.mts', import.meta.url), {
    CATALOG_URL: catalog.url, TEST_CONTROLS: '1', MAX_LOADS: '1', TTL_MS: '100000', DEADLINE_MS: '8000', ...env,
  });
  services.push(reader);
  assert.notEqual(reader.child.pid, catalog.child.pid);
  return { catalog, reader };
}
function request(service: RunningService, path: string, method = 'GET', body?: unknown) {
  return fetch(`${service.url}${path}`, {
    method, signal: AbortSignal.timeout(10000),
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}
async function body(response: Response, status = 200): Promise<unknown> {
  assert.equal(response.status, status);
  return response.json();
}
async function control(catalog: RunningService, mode: string) {
  await body(await request(catalog, `/control?mode=${mode}`, 'POST'));
}
// A synchronization barrier observes actual process state, with a wall-clock bound.
async function barrier(service: RunningService, field: string, expected: number) {
  const until = performance.now() + 4000;
  for (;;) {
    const stats = await body(await request(service, '/stats'));
    if (typeof stats === 'object' && stats !== null && field in stats && Reflect.get(stats, field) === expected) return;
    assert.ok(performance.now() < until, `barrier ${field}=${expected}: ${JSON.stringify(stats)}`);
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
}

test('integration: simultaneous misses join one load, distinct overload rejects, hits avoid Catalog', async t => {
  const { catalog, reader } = await setup(t);
  await control(catalog, 'hold');
  const first = request(reader, '/products/a');
  const settled: Promise<PromiseSettledResult<Response>[]>[] = [Promise.allSettled([first])];
  t.after(async () => { await Promise.all(settled); });
  await barrier(catalog, 'active', 1);
  const second = request(reader, '/products/a');
  settled.push(Promise.allSettled([second]));
  await barrier(reader, 'joined', 1);
  const overloaded = await request(reader, '/products/b');
  assert.equal(overloaded.headers.get('retry-after'), '1');
  assert.deepEqual(await body(overloaded, 503), { error: { code: 'cache_busy', message: 'Distinct load capacity reached' } });
  assert.deepEqual(await body(await request(catalog, '/stats')), { calls: 1, active: 1 });
  await control(catalog, 'open');
  const expected = { id: 'a', price: 100, version: 1 };
  assert.deepEqual(await body(await first), expected);
  assert.deepEqual(await body(await second), expected);
  assert.deepEqual(await body(await request(reader, '/products/a')), expected);
  assert.deepEqual(await body(await request(catalog, '/stats')), { calls: 1, active: 0 });
  await body(await request(reader, '/products/b'));
  await barrier(reader, 'inFlight', 0);
});

test('integration: Catalog owns updates; cached data stays old before TTL and refreshes after expiry', async t => {
  const { catalog, reader } = await setup(t, { TTL_MS: '2000' });
  const original = await body(await request(reader, '/products/a'));
  assert.deepEqual(await body(await request(catalog, '/products/a', 'PUT', { price: 250 })), { id: 'a', price: 250, version: 2 });
  assert.deepEqual(await body(await request(reader, '/products/a')), original);
  await control(catalog, 'hold');
  // Waiting past TTL only triggers expiry; the barrier proves the reload actually entered Catalog.
  // Exact boundary behavior is tested with the injected clock above.
  await new Promise<void>(resolve => setTimeout(resolve, 2050));
  const pending = request(reader, '/products/a');
  const settled = Promise.allSettled([pending]);
  t.after(async () => { await settled; });
  await barrier(catalog, 'active', 1);
  await control(catalog, 'open');
  const refreshed = await body(await pending);
  assert.deepEqual(refreshed, { id: 'a', price: 250, version: 2 });
  assert.deepEqual(await body(await request(catalog, '/stats')), { calls: 2, active: 0 });
});

test('integration: failed and malformed loads are not cached and release capacity', async t => {
  const { catalog, reader } = await setup(t);
  for (const mode of ['fail', 'malformed']) {
    await control(catalog, mode);
    await body(await request(reader, '/products/a'), 502);
    await barrier(reader, 'inFlight', 0);
  }
  await control(catalog, 'open');
  assert.deepEqual(await body(await request(reader, '/products/a')), { id: 'a', price: 100, version: 1 });
  assert.deepEqual(await body(await request(catalog, '/stats')), { calls: 3, active: 0 });
});

test('integration: deadline cancels held upstream, frees slot and permits recovery', async t => {
  const { catalog, reader } = await setup(t, { DEADLINE_MS: '1000' });
  await control(catalog, 'hold');
  const started = performance.now();
  const pending = request(reader, '/products/a');
  const settled = Promise.allSettled([pending]);
  t.after(async () => { await settled; });
  await barrier(catalog, 'active', 1);
  assert.deepEqual(await body(await pending, 504), { error: { code: 'deadline_exceeded', message: 'Catalog deadline exceeded' } });
  assert.ok(performance.now() - started < 4000, 'deadline must bound response');
  await barrier(reader, 'inFlight', 0);
  await barrier(catalog, 'active', 0);
  await control(catalog, 'open');
  await body(await request(reader, '/products/a'));
  assert.deepEqual(await body(await request(catalog, '/stats')), { calls: 2, active: 0 });
});

test('unit: successful coalescing occupies one slot and expired failures never serve stale', async () => {
  let now = 0; let calls = 0;
  const cache = new Cache<number>(1, 1, 10, () => now);
  const gate = deferred<number>();
  const load = () => { calls++; return gate.promise; };
  const first = cache.get('a', load);
  const second = cache.get('a', load);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.deepEqual(cache.stats(), { entries: 0, inFlight: 1, joined: 1 });
  gate.resolve(42);
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.deepEqual(cache.stats(), { entries: 1, inFlight: 0, joined: 1 });
  now = 10;
  await assert.rejects(cache.get('a', async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(cache.stats(), { entries: 0, inFlight: 0, joined: 1 });
  assert.equal(await cache.get('a', async () => 43), 43);
});
