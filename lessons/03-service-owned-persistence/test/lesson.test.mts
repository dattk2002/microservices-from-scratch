import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { parseOrderInput, parseProduct, snapshot } from '../domain.mts';
import { CatalogStore, OrdersStore } from '../store.mts';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

const orderId = 'b37346d1-3e00-4420-8845-6b1e1af07552';
const product = { id: 'pencil', name: 'Pencil', priceCents: 125 };

async function sandbox(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'lesson03-'));
  const services: RunningService[] = [];
  t.after(async () => {
    try { await Promise.all(services.map((service) => service.stop())); }
    finally { await rm(dir, { recursive: true, force: true }); }
  });
  return {
    dir,
    async start(entry: URL, env: Record<string, string>) {
      const service = await startService(entry, env);
      services.push(service);
      return service;
    },
  };
}

test('unit: reject untrusted order fields and unsafe quantities before persistence', () => {
  assert.deepEqual(parseOrderInput({ productId: 'pencil', quantity: 2 }), { productId: 'pencil', quantity: 2 });
  for (const value of [null, [], {}, { productId: '../file', quantity: 1 },
    { productId: 'pencil', quantity: 0 }, { productId: 'pencil', quantity: 101 },
    { productId: 'pencil', quantity: 1.5 }, { productId: 'pencil', quantity: '2' },
    { productId: 'pencil', quantity: Infinity }, { productId: 'pencil', quantity: 1, priceCents: 1 }]) {
    assert.throws(() => parseOrderInput(value), { status: 400 });
  }
});

test('unit: upstream parser copies valid fields and rejects incompatible snapshots', () => {
  assert.deepEqual(parseProduct({ ...product, additive: true }, 'pencil'), product);
  for (const value of [null, [], {}, { ...product, id: 'other' }, { ...product, name: '' },
    { ...product, name: 'x'.repeat(101) }, { ...product, priceCents: -1 },
    { ...product, priceCents: 1.5 }, { ...product, priceCents: '125' },
    { ...product, priceCents: 100_000_001 }]) {
    assert.throws(() => parseProduct(value, 'pencil'), { status: 502 });
  }
});

test('unit: snapshot owns copied price data and computes integer cents', () => {
  const mutableProduct = { ...product };
  const order = snapshot(orderId, { productId: 'pencil', quantity: 2 }, mutableProduct);
  mutableProduct.priceCents = 999;
  assert.deepEqual(order, { id: orderId, product, quantity: 2, totalCents: 250 });
  assert.throws(() => snapshot(orderId, { productId: 'pencil', quantity: 0 }, product));
  assert.throws(() => snapshot(orderId, { productId: 'other', quantity: 1 }, product));
});

test('unit: failed insert rolls back and cannot overwrite the existing snapshot', async (t) => {
  const { dir } = await sandbox(t);
  const path = join(dir, 'orders.sqlite');
  const store = new OrdersStore(path);
  try {
    store.create(snapshot(orderId, { productId: 'pencil', quantity: 2 }, product));
    assert.throws(() => store.create(snapshot(orderId, { productId: 'pencil', quantity: 3 }, product)));
    const secondId = 'b37346d1-3e00-4420-8845-6b1e1af07553';
    store.create(snapshot(secondId, { productId: 'pencil', quantity: 1 }, product));
    assert.deepEqual(store.get(orderId), { id: orderId, product, quantity: 2, totalCents: 250 });
    assert.deepEqual(store.get(secondId), { id: secondId, product, quantity: 1, totalCents: 125 });
  } finally { store.close(); }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA ignore_check_constraints = ON');
    db.prepare('UPDATE orders SET totalCents = 1 WHERE id = ?').run(orderId);
  } finally { db.close(); }
  const reopened = new OrdersStore(path);
  try { assert.throws(() => reopened.get(orderId), /Corrupt persisted order/); }
  finally { reopened.close(); }
});

test('unit: schema initialization preserves Catalog data and refuses unknown versions or unowned files', async (t) => {
  const { dir } = await sandbox(t);
  const path = join(dir, 'catalog.sqlite');
  const initial = new CatalogStore(path);
  initial.close();
  const db = new DatabaseSync(path);
  try { db.prepare('UPDATE products SET priceCents = ? WHERE id = ?').run(175, 'pencil'); }
  finally { db.close(); }
  const reopened = new CatalogStore(path);
  try { assert.deepEqual(reopened.get('pencil'), { ...product, priceCents: 175 }); }
  finally { reopened.close(); }
  const future = new DatabaseSync(path);
  try { future.exec('PRAGMA user_version = 2'); }
  finally { future.close(); }
  assert.throws(() => new CatalogStore(path), /Unsupported schema version/);
  const unknownPath = join(dir, 'unknown.sqlite');
  const unknown = new DatabaseSync(unknownPath);
  try { unknown.exec('CREATE TABLE existing (id TEXT)'); }
  finally { unknown.close(); }
  assert.throws(() => new OrdersStore(unknownPath), /Refusing to adopt/);
});

test('integration: isolated SQLite files retain the exact order across restart with Catalog stopped', async (t) => {
  const { dir, start } = await sandbox(t);
  const catalogPath = join(dir, 'catalog.sqlite');
  const ordersPath = join(dir, 'orders.sqlite');
  const catalog = await start(new URL('../catalog.mts', import.meta.url), { CATALOG_DB_PATH: catalogPath });
  const env = { ORDERS_DB_PATH: ordersPath, CATALOG_URL: catalog.url };
  const orders = await start(new URL('../orders.mts', import.meta.url), env);
  assert.notEqual(catalog.child.pid, orders.child.pid);
  const created = await jsonRequest(`${orders.url}/orders`, { productId: 'pencil', quantity: 2 });
  assert.equal(created.status, 201);
  const saved: unknown = await created.json();
  assert.ok(typeof saved === 'object' && saved !== null && 'id' in saved && typeof saved.id === 'string');
  assert.deepEqual(saved, { id: saved.id, product, quantity: 2, totalCents: 250 });
  assert.equal(created.headers.get('location'), `/orders/${saved.id}`);
  await orders.stop();
  await catalog.stop();
  const restarted = await start(new URL('../orders.mts', import.meta.url), env);
  const response = await fetch(`${restarted.url}/orders/${saved.id}`, { signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), saved);
  assert.equal((await jsonRequest(`${restarted.url}/orders`, { productId: 'pencil', quantity: 1 })).status, 503);
  await restarted.stop();
  const catalogDb = new DatabaseSync(catalogPath);
  const ordersDb = new DatabaseSync(ordersPath);
  try {
    assert.equal(catalogDb.prepare('SELECT count(*) AS n FROM products').get()?.n, 2);
    assert.equal(ordersDb.prepare('SELECT count(*) AS n FROM orders').get()?.n, 1);
    assert.equal(catalogDb.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='orders'").get()?.n, 0);
    assert.equal(ordersDb.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='products'").get()?.n, 0);
  } finally { catalogDb.close(); ordersDb.close(); }
  await assert.rejects(startService(new URL('../orders.mts', import.meta.url), {
    ORDERS_DB_PATH: catalogPath, CATALOG_URL: catalog.url,
  }), /Database belongs to another service/);
  const catalogAgain = await start(new URL('../catalog.mts', import.meta.url), { CATALOG_DB_PATH: catalogPath });
  assert.deepEqual(await (await fetch(`${catalogAgain.url}/products/pencil`)).json(), product);
});

test('integration: invalid input, routes and methods never create a durable order', async (t) => {
  const { dir, start } = await sandbox(t);
  const catalog = await start(new URL('../catalog.mts', import.meta.url), { CATALOG_DB_PATH: join(dir, 'catalog.sqlite') });
  const ordersPath = join(dir, 'orders.sqlite');
  const orders = await start(new URL('../orders.mts', import.meta.url), { ORDERS_DB_PATH: ordersPath, CATALOG_URL: catalog.url });
  assert.equal((await jsonRequest(`${orders.url}/orders`, { productId: 'pencil', quantity: 0 })).status, 400);
  assert.equal((await jsonRequest(`${orders.url}/orders`, { productId: 'missing', quantity: 1 })).status, 422);
  assert.equal((await fetch(`${orders.url}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await fetch(`${orders.url}/orders`, { method: 'POST', body: 'text' })).status, 415);
  assert.equal((await jsonRequest(`${orders.url}/orders`, { data: 'x'.repeat(9000) })).status, 413);
  for (const [url, method, allow] of [
    [`${orders.url}/orders`, 'GET', 'POST'],
    [`${orders.url}/orders/${orderId}`, 'DELETE', 'GET'],
    [`${catalog.url}/products/pencil`, 'POST', 'GET'],
    [`${orders.url}/health`, 'POST', 'GET'],
  ]) {
    assert.ok(url && method && allow);
    const response = await fetch(url, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), allow);
  }
  assert.equal((await fetch(`${orders.url}/orders/${orderId}`)).status, 404);
  assert.equal((await fetch(`${catalog.url}/products/missing`)).status, 404);
  assert.equal((await fetch(`${orders.url}/unrecognized`)).status, 404);
  await orders.stop();
  const db = new DatabaseSync(ordersPath);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get()?.n, 0); }
  finally { db.close(); }
});

test('integration: bounded upstream body and deadline leave no partial persisted order', async (t) => {
  const { dir, start } = await sandbox(t);
  let mode = 'malformed';
  const upstream = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (mode === 'slow') { res.write('{"id":'); return; }
    if (mode === 'oversized') res.end('x'.repeat(8193));
    else if (mode === 'wrong-id') res.end(JSON.stringify({ ...product, id: 'wrong' }));
    else if (mode === 'invalid-json') res.end('{');
    else if (mode === 'unavailable') { res.statusCode = 500; res.end('{}'); }
    else res.end(JSON.stringify({ ...product, priceCents: -1 }));
  });
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const ordersPath = join(dir, 'orders.sqlite');
  const orders = await start(new URL('../orders.mts', import.meta.url), {
    ORDERS_DB_PATH: ordersPath, CATALOG_URL: `http://127.0.0.1:${address.port}`, CATALOG_TIMEOUT_MS: '150',
  });
  for (const [nextMode, status] of [
    ['malformed', 502], ['oversized', 502], ['wrong-id', 502], ['invalid-json', 502], ['unavailable', 503], ['slow', 504],
  ]) {
    assert.equal(typeof nextMode, 'string');
    if (typeof nextMode !== 'string') throw new Error('Invalid test fixture');
    mode = nextMode;
    const response = await jsonRequest(`${orders.url}/orders`, { productId: 'pencil', quantity: 1 });
    assert.equal(response.status, status, nextMode);
  }
  await orders.stop();
  const db = new DatabaseSync(ordersPath);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get()?.n, 0); }
  finally { db.close(); }
});
