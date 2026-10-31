import assert from 'node:assert/strict';
import test from 'node:test';
import { fingerprint, parseInput, parseKey, parseProduct } from '../contract.mts';

test('unit: key contract rejects missing, ambiguous and non-ASCII keys', () => {
  assert.equal(parseKey('checkout_01:abc-123'), 'checkout_01:abc-123');
  for (const key of [undefined, [], ['a', 'b'], '', ' a', 'a b', 'á', 'a,b', 'x'.repeat(129)]) {
    assert.throws(() => parseKey(key));
  }
});
test('unit: normalized input fingerprint ignores JSON property order and surrounding product whitespace', () => {
  const a = parseInput({ productId: ' pencil ', quantity: 2 });
  const b = parseInput({ quantity: 2, productId: 'pencil' });
  assert.deepEqual(a, { productId: 'pencil', quantity: 2 });
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(parseInput({ productId: 'pencil', quantity: 3 })));
  assert.match(fingerprint(a), /^[a-f0-9]{64}$/);
});
test('unit: invalid order cannot gain a fingerprint or accept unknown fields', () => {
  for (const value of [null, [], {}, { productId: '../pencil', quantity: 1 },
    { productId: 'pencil', quantity: '1' }, { productId: 'pencil', quantity: 0 },
    { productId: 'pencil', quantity: 101 }, { productId: 'pencil', quantity: 1.5 },
    { productId: 'pencil', quantity: 1, extra: true }]) assert.throws(() => parseInput(value));
});
test('unit: Catalog response is checked at runtime before snapshot creation', () => {
  const product = { id: 'pencil', name: 'Bút chì', priceCents: 125 };
  assert.deepEqual(parseProduct({ ...product, stock: 7 }, 'pencil'), product);
  for (const value of [null, {}, { ...product, id: 'other' }, { ...product, priceCents: '125' },
    { ...product, priceCents: -1 }, { ...product, priceCents: Number.MAX_SAFE_INTEGER },
    { ...product, name: '' }]) assert.throws(() => parseProduct(value, 'pencil'));
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';
import type { TestContext } from 'node:test';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

const input = { productId: 'pencil', quantity: 2 };
const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(5000) });
const post = (service: RunningService, key: string, body: unknown = input) => {
  const pending = jsonRequest(`${service.url}/orders`, body, { 'Idempotency-Key': key });
  // Tests may fail before a barrier is released: keep cleanup rejections handled.
  void pending.catch(() => {});
  return pending;
};
async function setup(t: TestContext, timeout = '1500') {
  const dir = await mkdtemp(join(tmpdir(), 'idempotency-'));
  const services: RunningService[] = [];
  t.after(async () => {
    await Promise.all(services.map(service => service.stop()));
    await rm(dir, { recursive: true, force: true });
  });
  const dependency = await startService(new URL('./dependency.mts', import.meta.url));
  services.push(dependency);
  const db = join(dir, 'orders.sqlite');
  const startOrders = async () => {
    const service = await startService(new URL('../orders.mts', import.meta.url), {
      CATALOG_URL: dependency.url, ORDERS_DB: db, CATALOG_TIMEOUT_MS: timeout,
    });
    services.push(service); return service;
  };
  const orders = await startOrders();
  return {
    orders, dependency, db, startOrders,
    wait: (count: number) => get(`${dependency.url}/control/wait?count=${count}`),
    release: (mode = 'valid') => jsonRequest(`${dependency.url}/control/release`, { mode }),
    count: async () => { const value: unknown = await (await get(`${dependency.url}/control/state`)).json(); return value; },
  };
}

test('integration: simultaneous identical calls coalesce and changed input conflicts while in flight', async t => {
  const env = await setup(t);
  const pending = Array.from({ length: 12 }, () => post(env.orders, 'same-key'));
  await env.wait(1);
  const changed = await post(env.orders, 'same-key', { ...input, quantity: 3 });
  assert.equal(changed.status, 409);
  await env.release();
  const responses = await Promise.all(pending);
  const bodies = await Promise.all(responses.map(response => response.text()));
  assert.ok(responses.every(response => response.status === 201));
  assert.ok(bodies.every(body => body === bodies[0]));
  const body: unknown = JSON.parse(bodies[0] ?? 'null');
  assert.ok(typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string');
  assert.deepEqual(body, { id: body.id, product: { id: 'pencil', name: 'Bút chì', priceCents: 125 }, quantity: 2, totalCents: 250 });
  assert.deepEqual(await env.count(), { count: 1 });
  assert.equal((await post(env.orders, 'same-key', { ...input, quantity: 3 })).status, 409);
  assert.equal(await (await post(env.orders, 'same-key', { quantity: 2, productId: ' pencil ' })).text(), bodies[0]);
  const db = new DatabaseSync(env.db);
  try { assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get()?.count, 1); }
  finally { db.close(); }
});

test('integration: completed status and exact response survive restart without Catalog', async t => {
  const env = await setup(t);
  await env.release();
  const first = await post(env.orders, 'restart-key');
  assert.equal(first.status, 201);
  const body = await first.text();
  await env.orders.stop();
  await env.dependency.stop();
  const restarted = await env.startOrders();
  const replay = await post(restarted, 'restart-key');
  assert.equal(replay.status, 201);
  assert.equal(await replay.text(), body);
  assert.equal((await post(restarted, 'restart-key', { ...input, quantity: 4 })).status, 409);
});

test('integration: two Orders processes racing same SQLite key commit one durable order', async t => {
  const env = await setup(t);
  const second = await env.startOrders();
  const a = post(env.orders, 'shared-db');
  const b = post(second, 'shared-db');
  await env.wait(2); // Both processes passed the initial durable lookup, before either commit.
  await env.release();
  const responses = await Promise.all([a, b]);
  assert.deepEqual(responses.map(response => response.status), [201, 201]);
  assert.equal(await responses[0]?.text(), await responses[1]?.text());
  const db = new DatabaseSync(env.db);
  try { assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get()?.count, 1); }
  finally { db.close(); }
});

test('integration: key, body, media type and method validation do not call Catalog or create rows', async t => {
  const env = await setup(t);
  for (const key of ['', 'bad key', 'x'.repeat(129)]) assert.equal((await post(env.orders, key)).status, 400);
  assert.equal((await jsonRequest(`${env.orders.url}/orders`, input)).status, 400);
  const duplicateStatus = await new Promise<number>((resolve, reject) => {
    const req = request(`${env.orders.url}/orders`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', 'Idempotency-Key': ['duplicate', 'duplicate'] },
    }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    req.once('error', reject);
    req.end(JSON.stringify(input));
  });
  assert.equal(duplicateStatus, 400);
  for (const body of [null, {}, { ...input, quantity: 0 }, { ...input, extra: true }]) {
    assert.equal((await post(env.orders, 'validation', body)).status, 400);
  }
  assert.equal((await fetch(`${env.orders.url}/orders`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Idempotency-Key': 'validation' }, body: '{}' })).status, 415);
  assert.equal((await fetch(`${env.orders.url}/orders`, { method: 'POST', signal: AbortSignal.timeout(5000), headers: { 'Idempotency-Key': 'validation', 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await post(env.orders, 'validation', { padding: 'x'.repeat(9000) })).status, 413);
  assert.equal((await get(`${env.orders.url}/orders`)).status, 405);
  assert.deepEqual(await env.count(), { count: 0 });
  const db = new DatabaseSync(env.db);
  try { assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get()?.count, 0); }
  finally { db.close(); }
});

for (const mode of ['status', 'oversized', 'invalid', 'malformed', 'wrong-type']) {
  test(`integration: ${mode} Catalog failure leaves key and order retriable`, async t => {
    const env = await setup(t);
    await env.release(mode);
    assert.equal((await post(env.orders, 'retry-key')).status, 502);
    const db = new DatabaseSync(env.db);
    try {
      assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get()?.count, 0);
      assert.equal(db.prepare('SELECT count(*) AS count FROM replays').get()?.count, 0);
    } finally { db.close(); }
    await env.release();
    assert.equal((await post(env.orders, 'retry-key')).status, 201);
  });
}

test('integration: Catalog deadline releases an in-flight key for retry', async t => {
  const env = await setup(t, '300');
  const pending = post(env.orders, 'timeout-key');
  await env.wait(1);
  assert.equal((await pending).status, 504);
  await env.release();
  assert.equal((await post(env.orders, 'timeout-key')).status, 201);
});

test('integration: failed replay insert rolls back order and retry succeeds', async t => {
  const env = await setup(t);
  await env.release();
  const db = new DatabaseSync(env.db);
  try {
    db.exec("CREATE TRIGGER refuse_replay BEFORE INSERT ON replays BEGIN SELECT RAISE(ABORT, 'simulated disk-write rejection'); END");
    assert.equal((await post(env.orders, 'rollback-key')).status, 500);
    assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get()?.count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM replays').get()?.count, 0);
    db.exec('DROP TRIGGER refuse_replay');
    assert.equal((await post(env.orders, 'rollback-key')).status, 201);
  } finally { db.close(); }
});

test('integration: cross-process different payload race has one winner and one conflict', async t => {
  const env = await setup(t);
  const second = await env.startOrders();
  const a = post(env.orders, 'contended-key');
  const b = post(second, 'contended-key', { ...input, quantity: 3 });
  await env.wait(2);
  await env.release();
  const responses = await Promise.all([a, b]);
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
  const db = new DatabaseSync(env.db);
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM orders').get()?.count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM replays').get()?.count, 1);
  } finally { db.close(); }
});

test('integration: Catalog body streaming also obeys deadline and permits retry', async t => {
  const env = await setup(t, '300');
  await env.release('stream');
  assert.equal((await post(env.orders, 'body-timeout')).status, 504);
  await env.release();
  assert.equal((await post(env.orders, 'body-timeout')).status, 201);
});

test('integration: original independent Catalog and Orders serve orders and reject missing products', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'idempotency-original-'));
  const services: RunningService[] = [];
  t.after(async () => { await Promise.all(services.map(service => service.stop())); await rm(dir, { recursive: true, force: true }); });
  const catalog = await startService(new URL('../catalog.mts', import.meta.url));
  services.push(catalog);
  const orders = await startService(new URL('../orders.mts', import.meta.url), { CATALOG_URL: catalog.url, ORDERS_DB: join(dir, 'orders.sqlite') });
  services.push(orders);
  assert.notEqual(catalog.child.pid, orders.child.pid);
  assert.equal((await post(orders, 'original')).status, 201);
  assert.equal((await post(orders, 'missing', { productId: 'missing', quantity: 1 })).status, 422);
  await catalog.stop();
  assert.equal((await post(orders, 'unavailable')).status, 503);
});

test('integration: Orders health rejects POST with Allow GET', async t => {
  const env = await setup(t);
  const response = await jsonRequest(`${env.orders.url}/health`, {});
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
});
