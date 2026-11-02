import assert from 'node:assert/strict';
import test from 'node:test';
import { action } from '../model.mts';

test('unit: recovery repeats pending forward intent and failed compensation', () => {
  assert.equal(action('reserving'), 'reserve');
  assert.equal(action('charging'), 'charge');
  assert.equal(action('compensating'), 'release');
  assert.equal(action('compensation_failed'), 'release');
  assert.equal(action('completed'), 'done');
  assert.equal(action('cancelled'), 'done');
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mts';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: durable deduplication survives reopen and rejects changed payload', t => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-unit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'inventory.sqlite');
  const first = new Store(path);
  assert.equal(first.effect('a', false, 'reserve'), 'reserved');
  first.close();
  const second = new Store(path);
  t.after(() => second.close());
  assert.equal(second.effect('a', false, 'reserve'), 'reserved');
  assert.throws(() => second.effect('a', true, 'reserve'), /ID reused/);
  assert.equal(second.effect('a', false, 'release'), 'released');
  assert.equal(second.effect('a', false, 'release'), 'released');
  assert.equal(second.effect('a', false, 'reserve'), 'released');
  assert.equal(second.db.prepare('SELECT count(*) AS n FROM effects').get()?.n, 1);
});

test('unit: saga intent persists and a different request cannot reuse its ID', t => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-intent-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'saga.sqlite');
  const first = new Store(path);
  first.create('a', true); first.set('a', 'compensation_failed'); first.close();
  const reopened = new Store(path);
  t.after(() => reopened.close());
  assert.equal(reopened.order('a')?.state, 'compensation_failed');
  assert.throws(() => reopened.create('a', false), /different payload/);
});

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}
async function effects(service: RunningService): Promise<unknown> {
  const response = await fetch(`${service.url}/state`, { signal: AbortSignal.timeout(1500) });
  assert.equal(response.status, 200); return response.json();
}
for (const refusal of [false, true]) {
  test(`integration: ${refusal ? 'payment refusal compensates reservation' : 'success and idempotent replay'}`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'saga-http-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const inventory = await startService(new URL('../participant.mts', import.meta.url), { DB_PATH: join(dir, 'i.sqlite') });
    t.after(inventory.stop);
    const payment = await startService(new URL('../participant.mts', import.meta.url), { ROLE: 'payment', DB_PATH: join(dir, 'p.sqlite') });
    t.after(payment.stop);
    const saga = await startService(new URL('../orchestrator.mts', import.meta.url), {
      DB_PATH: join(dir, 's.sqlite'), INVENTORY_URL: inventory.url, PAYMENT_URL: payment.url,
    });
    t.after(saga.stop);
    for (let n = 0; n < 2; n++) {
      const response = await jsonRequest(`${saga.url}/sagas`, { id: 'order-12', refusal });
      assert.equal(response.status, 200);
      assert.equal((await body(response)).state, refusal ? 'cancelled' : 'completed');
    }
    assert.deepEqual(await effects(inventory), [{ id: 'order-12', refusal: Number(refusal), state: refusal ? 'released' : 'reserved' }]);
    assert.deepEqual(await effects(payment), [{ id: 'order-12', refusal: Number(refusal), state: refusal ? 'refused' : 'charged' }]);
    assert.equal((await jsonRequest(`${saga.url}/sagas`, { id: 'order-12', refusal: !refusal })).status, 409);
  });
}

test('integration: failed compensation survives orchestrator restart and explicit recovery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inventoryEnv = { DB_PATH: join(dir, 'i.sqlite') };
  const broken = await startService(new URL('../participant.mts', import.meta.url), { ...inventoryEnv, FAIL_RELEASE: '1' });
  t.after(broken.stop);
  const payment = await startService(new URL('../participant.mts', import.meta.url), { ROLE: 'payment', DB_PATH: join(dir, 'p.sqlite') });
  t.after(payment.stop);
  const env = { DB_PATH: join(dir, 's.sqlite'), INVENTORY_URL: broken.url, PAYMENT_URL: payment.url };
  const first = await startService(new URL('../orchestrator.mts', import.meta.url), env);
  t.after(first.stop);
  const request = { id: 'order-retry', refusal: true };
  const failed = await jsonRequest(`${first.url}/sagas`, request);
  assert.equal(failed.status, 202);
  assert.equal((await body(failed)).state, 'compensation_failed');
  assert.deepEqual(await effects(broken), [{ id: request.id, refusal: 1, state: 'reserved' }]);
  await first.stop(); await broken.stop();
  const fixed = await startService(new URL('../participant.mts', import.meta.url), inventoryEnv);
  t.after(fixed.stop);
  const restarted = await startService(new URL('../orchestrator.mts', import.meta.url), { ...env, INVENTORY_URL: fixed.url });
  t.after(restarted.stop);
  const persisted = await fetch(`${restarted.url}/sagas/${request.id}`, { signal: AbortSignal.timeout(1500) });
  assert.equal((await body(persisted)).state, 'compensation_failed');
  const recovered = await jsonRequest(`${restarted.url}/recover`, request);
  assert.equal(recovered.status, 200); assert.equal((await body(recovered)).state, 'cancelled');
  assert.deepEqual(await effects(fixed), [{ id: request.id, refusal: 1, state: 'released' }]);
});

test('integration: restart replays forward intent after remote effect before acknowledgement', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'saga-window-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const inventory = await startService(new URL('../participant.mts', import.meta.url), { DB_PATH: join(dir, 'i.sqlite') });
  t.after(inventory.stop);
  const payment = await startService(new URL('../participant.mts', import.meta.url), { ROLE: 'payment', DB_PATH: join(dir, 'p.sqlite') });
  t.after(payment.stop);
  const env = { DB_PATH: join(dir, 's.sqlite'), INVENTORY_URL: inventory.url, PAYMENT_URL: payment.url };
  const first = await startService(new URL('../orchestrator.mts', import.meta.url), env);
  t.after(first.stop); await first.stop();
  // Deterministic crash-window fixture: local charging intent, remote charge committed,
  // but no local acknowledgement. No live process shares this SQLite owner.
  const store = new Store(env.DB_PATH);
  store.create('window', false); store.set('window', 'charging'); store.close();
  const payload = { id: 'window', refusal: false };
  assert.equal((await jsonRequest(`${inventory.url}/reserve`, payload)).status, 200);
  assert.equal((await jsonRequest(`${payment.url}/charge`, payload)).status, 200);
  const restarted = await startService(new URL('../orchestrator.mts', import.meta.url), env);
  t.after(restarted.stop);
  assert.equal((await body(await jsonRequest(`${restarted.url}/recover`, payload))).state, 'completed');
  assert.deepEqual(await effects(payment), [{ id: 'window', refusal: 0, state: 'charged' }]);
});
