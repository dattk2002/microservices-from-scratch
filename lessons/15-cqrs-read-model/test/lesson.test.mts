import assert from 'node:assert/strict';
import test from 'node:test';
import { Orders, Projection } from '../store.mts';

const event = { seq: 1, eventId: 'event-1', orderId: 'tea-17', version: 1, quantity: 3, status: 'open', occurredAt: 100 } as const;
test('unit: projection commits summary, inbox and checkpoint once and rejects conflicts and gaps', () => {
  const p = new Projection(':memory:');
  try {
    assert.equal(p.apply(event), 'applied');
    assert.equal(p.apply(event), 'duplicate');
    assert.equal(p.state().totalQuantity, 3);
    assert.throws(() => p.apply({ ...event, quantity: 9 }), /conflict/);
    assert.throws(() => p.apply({ ...event, seq: 3, eventId: 'event-3', version: 3 }), /gap/);
    assert.throws(() => p.apply({ ...event, seq: 2, eventId: 'event-2', version: 1 }), /stale/);
    assert.equal(p.state().checkpoint, 1);
    assert.equal(p.apply({ ...event, seq: 2, eventId: 'event-2', version: 2, quantity: 5 }), 'applied');
    assert.equal(p.state().totalQuantity, 5);
  } finally { p.close(); }
});
test('unit: command rolls back business state when durable event insertion fails', () => {
  const o = new Orders(':memory:');
  try {
    o.db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => o.command('tea-17', 0, 3, 'open'), /injected/);
    assert.equal(o.get('tea-17'), undefined);
    assert.deepEqual(o.events(0), []);
  } finally { o.close(); }
});
test('unit: failed checkpoint commit rolls back inbox and summary so replay is safe', () => {
  const p = new Projection(':memory:');
  try {
    p.db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON progress BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => p.apply(event), /injected/);
    assert.equal(p.state().totalQuantity, 0);
    assert.equal(p.state().checkpoint, 0);
    p.db.exec('DROP TRIGGER fail_checkpoint');
    assert.equal(p.apply(event), 'applied');
  } finally { p.close(); }
});

test('unit: version gaps and identity collisions leave no checkpoint or summary effects', () => {
  const p = new Projection(':memory:');
  try {
    assert.throws(() => p.apply({ ...event, version: 2 }), /version_gap/);
    assert.equal(p.state().checkpoint, 0);
    p.apply(event);
    assert.throws(() => p.apply({ ...event, seq: 2, version: 2 }), /event_conflict/);
    assert.throws(() => p.apply({ ...event, eventId: 'other' }), /event_conflict/);
    assert.equal(p.state().checkpoint, 1);
    assert.equal(p.state().orderCount, 1);
  } finally { p.close(); }
});
test('unit: optimistic commands preserve source state on stale expected version', () => {
  const o = new Orders(':memory:');
  try {
    const first = o.command('tea-17', 0, 3, 'open');
    assert.throws(() => o.command('tea-17', 0, 8, 'open'), /version_conflict/);
    const second = o.command('tea-17', 1, 5, 'shipped');
    assert.equal(second.seq, first.seq + 1);
    assert.equal(second.version, 2);
    assert.notEqual(first.eventId, second.eventId);
    assert.equal(o.get('tea-17')?.quantity, 5);
    assert.deepEqual(o.events(first.seq), [second]);
  } finally { o.close(); }
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { parseEvent } from '../protocol.mts';

test('integration: durable consumer checkpoint and dedup survive reopening a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cqrs-unit-'));
  const path = join(dir, 'query.sqlite');
  let p = new Projection(path);
  try {
    p.apply(event); p.close(); p = new Projection(path);
    assert.equal(p.state().checkpoint, 1);
    assert.equal(p.apply(event), 'duplicate');
    assert.equal(p.state().totalQuantity, 3);
  } finally { p.close(); rmSync(dir, { recursive: true, force: true }); }
});

async function get(service: RunningService, route: string, expected = 200): Promise<Record<string, unknown>> {
  const response = await fetch(`${service.url}${route}`, { signal: AbortSignal.timeout(1500) });
  assert.equal(response.status, expected);
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null && !Array.isArray(body));
  return body as Record<string, unknown>;
}
async function post(service: RunningService, route: string, body: unknown, expected = 200): Promise<Record<string, unknown>> {
  const response = await jsonRequest(`${service.url}${route}`, body);
  assert.equal(response.status, expected);
  const value: unknown = await response.json();
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}
async function crash(service: RunningService) {
  const exited = once(service.child, 'exit', { signal: AbortSignal.timeout(2000) });
  service.child.kill('SIGKILL'); await exited;
}
function processes(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'cqrs-http-'));
  const running: RunningService[] = [];
  t.after(async () => {
    try { await Promise.all(running.map(s => s.stop())); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  return { dir, launch: async (entry: string, env: Record<string, string>) => {
    const service = await startService(new URL(`../${entry}.mts`, import.meta.url), env);
    running.push(service); return service;
  } };
}

test('integration: paused projection exposes stale reads; sync barriers converge and both processes recover without double counting', { timeout: 14000 }, async t => {
  const { dir, launch } = processes(t);
  const ordersEnv = { DB_PATH: join(dir, 'orders.sqlite') };
  let orders = await launch('orders', ordersEnv);
  const ordersPort = new URL(orders.url).port;
  const queryEnv = { DB_PATH: join(dir, 'query.sqlite'), ORDERS_URL: orders.url };
  let query = await launch('query', queryEnv);
  const command = { id: 'tea-17', expectedVersion: 0, quantity: 3, status: 'open' };
  await post(orders, '/orders', command, 201);
  // No sync has been requested: these reads are a deterministic pause barrier.
  assert.equal((await get(orders, '/orders/tea-17')).version, 1);
  await get(query, '/orders/tea-17', 404);
  assert.equal((await get(query, '/state')).checkpoint, 0);
  assert.equal((await post(query, '/sync', {})).checkpoint, 1);
  const projected = await get(query, '/orders/tea-17');
  assert.equal((projected.summary as Record<string, unknown>).version, 1);
  assert.equal((projected.summary as Record<string, unknown>).quantity, 3);
  assert.equal(typeof (projected.summary as Record<string, unknown>).sourceAt, 'number');
  const response = await fetch(`${orders.url}/events?after=0`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
  const page: unknown = await response.json(); assert.ok(Array.isArray(page));
  const first = parseEvent(page[0]);
  assert.deepEqual(await post(query, '/events', first), { result: 'duplicate' });
  await post(query, '/events', { ...first, quantity: 8 }, 409);
  await post(query, '/events', { ...first, seq: 3, eventId: 'gap', version: 3 }, 409);
  await post(query, '/events', { ...first, seq: 2, eventId: 'stale', version: 1 }, 409);
  assert.equal((await get(query, '/state')).checkpoint, 1);
  await post(orders, '/orders', { ...command, expectedVersion: 1, quantity: 5, status: 'shipped' });
  const stale = await get(query, '/orders/tea-17');
  assert.equal((stale.summary as Record<string, unknown>).quantity, 3);
  await crash(orders); await crash(query);
  orders = await launch('orders', { ...ordersEnv, PORT: ordersPort });
  query = await launch('query', queryEnv);
  assert.equal((await get(orders, '/orders/tea-17')).version, 2);
  assert.equal((await get(query, '/state')).checkpoint, 1);
  assert.deepEqual(await post(query, '/events', first), { result: 'duplicate' });
  assert.equal((await post(query, '/sync', {})).checkpoint, 2);
  assert.equal((await get(query, '/state')).totalQuantity, 5);
  assert.equal((await get(query, '/state')).orderCount, 1);
  assert.equal((await post(query, '/sync', {})).fetched, 0);
  // Kill after acknowledged consumer commit; replay after restart must still deduplicate.
  await crash(query); query = await launch('query', queryEnv);
  assert.deepEqual(await post(query, '/events', first), { result: 'duplicate' });
  assert.equal((await get(query, '/state')).totalQuantity, 5);
  const fresh = await get(query, '/orders/tea-17');
  assert.equal((fresh.summary as Record<string, unknown>).status, 'shipped');
  assert.equal((fresh.freshness as Record<string, unknown>).checkpoint, 2);
});

test('integration: bounded source outage preserves cursor; ten-event pages resume after recovery', { timeout: 14000 }, async t => {
  const { dir, launch } = processes(t);
  const env = { DB_PATH: join(dir, 'orders.sqlite') };
  let orders = await launch('orders', env);
  const port = new URL(orders.url).port;
  const query = await launch('query', { DB_PATH: join(dir, 'query.sqlite'), ORDERS_URL: orders.url });
  for (let n = 0; n < 12; n++) {
    await post(orders, '/orders', { id: `order-${n}`, expectedVersion: 0, quantity: 2, status: 'open' }, 201);
  }
  await orders.stop();
  const started = performance.now();
  await post(query, '/sync', {}, 503);
  assert.ok(performance.now() - started < 2500);
  assert.equal((await get(query, '/state')).checkpoint, 0);
  orders = await launch('orders', { ...env, PORT: port });
  assert.equal((await post(query, '/sync', {})).fetched, 10);
  assert.equal((await get(query, '/state')).checkpoint, 10);
  assert.equal((await post(query, '/sync', {})).fetched, 2);
  assert.equal((await get(query, '/state')).totalQuantity, 24);
});
