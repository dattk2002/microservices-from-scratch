import assert from 'node:assert/strict';
import test from 'node:test';
import { retryDelay } from '../store.mts';

test('unit: retry backs off and caps the delay', () => {
  assert.equal(retryDelay(0), 100);
  assert.equal(retryDelay(1), 200);
  assert.equal(retryDelay(20), 2000);
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.mts';

function fixture(t: import('node:test').TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-'));
  const store = new Store(join(dir, 'service.sqlite'));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
test('unit: failed outbox insertion rolls back the business change', t => {
  const { store, dir } = fixture(t);
  const inspect = new DatabaseSync(join(dir, 'service.sqlite'));
  t.after(() => inspect.close());
  inspect.exec("CREATE TRIGGER reject_event BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  assert.throws(() => store.create('order-1', 3), /injected failure/);
  assert.equal(store.orders(), 0);
  assert.equal(store.pending(), 0);
});
test('unit: durable pending events survive reopen and acknowledgement removes eligibility', t => {
  const { store, dir } = fixture(t);
  store.create('order-1', 3);
  store.close();
  const reopened = new Store(join(dir, 'service.sqlite'));
  t.after(() => reopened.close());
  assert.equal(reopened.orders(), 1);
  assert.deepEqual(reopened.next(0), { id: 'order-1', quantity: 3, attempts: 0 });
  reopened.failed('order-1', 0, 1000);
  assert.equal(reopened.next(1099), undefined);
  assert.equal(reopened.next(1100)?.attempts, 1);
  reopened.delivered('order-1');
  assert.equal(reopened.pending(), 0);
});
test('unit: consumer deduplication and business effect commit together', t => {
  const { store } = fixture(t);
  assert.equal(store.consume('order-1', 3), true);
  assert.equal(store.consume('order-1', 3), false);
  assert.equal(store.total(), 3);
  assert.throws(() => store.consume('order-1', 4), /conflict/);
  assert.equal(store.total(), 3);
});

import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

async function state(service: RunningService) {
  const response = await fetch(`${service.url}/state`, { signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200);
  return await response.json() as unknown;
}
async function eventually(check: () => Promise<void>) {
  const end = performance.now() + 6000;
  let last: unknown;
  do {
    try { await check(); return; } catch (error) { last = error; }
    await delay(30);
  } while (performance.now() < end);
  throw last;
}

test('integration: receiver outage, producer crash recovery and duplicate delivery use durable service files', { timeout: 14000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-http-'));
  const services: RunningService[] = [];
  t.after(async () => {
    try { await Promise.all(services.map(service => service.stop())); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const launch = async (env: Record<string, string>) => {
    const service = await startService(new URL('../service.mts', import.meta.url), env);
    services.push(service); return service;
  };
  const consumerPath = join(dir, 'consumer.sqlite');
  const producerPath = join(dir, 'producer.sqlite');
  const consumer = await launch({ ROLE: 'consumer', DB_PATH: consumerPath });
  const port = new URL(consumer.url).port;
  await consumer.stop();
  const producerEnv = { ROLE: 'producer', DB_PATH: producerPath, CONSUMER_URL: consumer.url };
  const producer = await launch(producerEnv);
  const event = { id: 'tea-order-17', quantity: 3 };
  const accepted = await jsonRequest(`${producer.url}/orders`, event);
  assert.equal(accepted.status, 201); await accepted.arrayBuffer();
  // Observe persisted retry metadata, rather than assuming a sleep implies an attempted delivery.
  await eventually(async () => {
    const db = new DatabaseSync(producerPath);
    try {
      const row = db.prepare('SELECT attempts FROM outbox WHERE id=?').get(event.id);
      assert.ok(row && typeof row.attempts === 'number' && row.attempts >= 2);
    } finally { db.close(); }
  });
  assert.deepEqual(await state(producer), { orders: 1, pending: 1, total: 0 });
  const exited = once(producer.child, 'exit', { signal: AbortSignal.timeout(2000) });
  producer.child.kill('SIGKILL');
  await exited;
  const recoveredConsumer = await launch({ ROLE: 'consumer', DB_PATH: consumerPath, PORT: port });
  // Model the crash window after consumer commit but before producer acknowledgement:
  // deliver the exact pending envelope while the producer is stopped.
  const first = await jsonRequest(`${recoveredConsumer.url}/events`, event);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { id: event.id, duplicate: false });
  const recoveredProducer = await launch(producerEnv);
  await eventually(async () => {
    assert.deepEqual(await state(recoveredProducer), { orders: 1, pending: 0, total: 0 });
    assert.deepEqual(await state(recoveredConsumer), { orders: 0, pending: 0, total: 3 });
  });
  const duplicate = await jsonRequest(`${recoveredConsumer.url}/events`, event);
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { id: event.id, duplicate: true });
  const conflict = await jsonRequest(`${recoveredConsumer.url}/events`, { ...event, quantity: 4 });
  assert.equal(conflict.status, 409); await conflict.arrayBuffer();
  await recoveredConsumer.stop();
  const restartedConsumer = await launch({ ROLE: 'consumer', DB_PATH: consumerPath, PORT: port });
  const replay = await jsonRequest(`${restartedConsumer.url}/events`, event);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { id: event.id, duplicate: true });
  assert.deepEqual(await state(restartedConsumer), { orders: 0, pending: 0, total: 3 });
});
