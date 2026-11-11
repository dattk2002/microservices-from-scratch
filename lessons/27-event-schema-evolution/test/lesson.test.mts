import { test } from 'node:test';
import assert from 'node:assert/strict';
import { object, upcast } from '../model.mts';
const v1 = { id: 'sale_a', position: 1, revision: 1, payload: { orderId: 'order_a', resourceVersion: 7, totalCents: 150 } };
const v2 = { id: 'sale_b', position: 2, revision: 2, payload: { orderId: 'order_b', resourceVersion: 3, amount: { amountMinor: 150, currency: 'USD' } } };
test('unit: both revisions converge deterministically without mutating input', () => {
  const before = structuredClone(v1);
  assert.deepEqual(upcast(v1), { id: 'sale_a', position: 1, orderId: 'order_a', resourceVersion: 7, amountMinor: 150, currency: 'USD' });
  assert.deepEqual(upcast(v1), upcast(v1)); assert.deepEqual(v1, before);
  assert.equal(upcast(v2).amountMinor, 150);
});
test('unit: reject malformed payload, unsafe integers, unknown revisions and non-string enums', () => {
  for (const value of [null, [], { ...v1, revision: 3 }, { ...v1, position: 0 }, { ...v1, payload: { ...v1.payload, totalCents: Number.MAX_SAFE_INTEGER + 1 } }, { ...v1, payload: { ...v1.payload, totalCents: '150' } }, { ...v2, payload: { ...v2.payload, amount: { amountMinor: 1, currency: ['USD'] } } }, { ...v2, payload: { ...v2.payload, amount: { amountMinor: 1, currency: {} } } }]) assert.throws(() => upcast(value));
  assert.throws(() => upcast(v2, 'legacy'));
});
import { Projection } from '../store.mts';
test('unit: SQLite atomic effect fingerprint checkpoint and conflict', () => {
 const db = new Projection(':memory:');
 try {
  assert.equal(db.apply(v1), true); assert.equal(db.apply(v1), false);
  assert.throws(() => db.apply({ ...v1, payload: { ...v1.payload, totalCents: 151 } }));
  assert.throws(() => db.apply(v2, 'legacy'));
  assert.deepEqual(db.state(), { checkpoint: 1, totalMinor: 150, count: 1 });
  assert.equal(db.apply(v2), true);
  assert.deepEqual(db.state(), { checkpoint: 2, totalMinor: 300, count: 2 });
 } finally { db.close(); }
});
import { History } from '../store.mts';
import { profile } from '../model.mts';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
test('unit: bounded immutable history, strict profile and failed records preserve progress', () => {
 const h = new History(':memory:'); const p = new Projection(':memory:');
 try {
  h.append(v1); const before = h.page(0); assert.throws(() => h.append(v1));
  assert.deepEqual(h.page(0), before);
  for (const currency of [null, 1, ['USD'], { toString: 'USD' }]) assert.throws(() => h.append({ ...v2, payload: { ...v2.payload, amount: { amountMinor: 150, currency } } }));
  for (const x of [[], {}, 1, null]) assert.throws(() => profile(x));
  p.apply(v1);
  for (const event of [{ ...v2, revision: 3 }, { ...v2, payload: { ...v2.payload, amount: { amountMinor: -1, currency: 'USD' } } }, { ...v2, position: 3 }]) {
   assert.throws(() => p.apply(event)); assert.deepEqual(p.state(), { checkpoint: 1, totalMinor: 150, count: 1 });
  }
  for (let i = 2; i <= 100; i++) h.append({ ...v1, id: 'sale_' + i, position: i });
  assert.equal(h.page(0).length, 10); assert.throws(() => h.append({ ...v1, id: 'full', position: 101 }));
 } finally { h.close(); p.close(); }
});
test('unit: entrypoints import silently despite invalid runtime configuration', async () => {
 const urls = ['owner.mts', 'consumer.mts'].map(x => new URL('../' + x, import.meta.url).href);
 const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `for (const u of ${JSON.stringify(urls)}) await import(u);`], { env: { PATH: process.env.PATH ?? '', PORT: 'bad', DB_PATH: '/unusable/db', PROFILE: 'bad', OWNER_URL: 'bad' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; let err = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  child.stdout.on('data', (b: Buffer) => { out += b.toString(); }); child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
  child.once('error', reject); child.once('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
 });
 assert.deepEqual(result, { code: 0, out: '', err: '' });
});
async function get(service: RunningService, path: string): Promise<unknown> {
 const r = await fetch(service.url + path, { signal: AbortSignal.timeout(2000) }); assert.equal(r.status, 200); return r.json();
}
test('integration: mixed history, legacy barrier, restart upgrade, dedup and conflicting identity', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'schema-')); const services: RunningService[] = [];
 try {
  const owner = await startService(new URL('../owner.mts', import.meta.url), { DB_PATH: join(dir, 'owner.db') }); services.push(owner);
  for (const event of [v1, v2]) assert.equal((await jsonRequest(owner.url + '/events', event)).status, 201);
  const before = await get(owner, '/events');
  for (const currency of [['USD'], {}]) assert.equal((await jsonRequest(owner.url + '/events', { ...v2, id: 'invalid', position: 3, payload: { ...v2.payload, amount: { amountMinor: 150, currency } } })).status, 422);
  const env = { DB_PATH: join(dir, 'consumer.db'), OWNER_URL: owner.url, TEACHING_CONTROLS: '1' };
  const legacy = await startService(new URL('../consumer.mts', import.meta.url), { ...env, PROFILE: 'legacy' }); services.push(legacy);
  assert.equal((await jsonRequest(legacy.url + '/sync', {})).status, 422);
  assert.deepEqual(await get(legacy, '/state'), { checkpoint: 1, totalMinor: 150, count: 1 });
  await legacy.stop();
  const current = await startService(new URL('../consumer.mts', import.meta.url), env); services.push(current);
  assert.equal((await jsonRequest(current.url + '/sync', {})).status, 200);
  assert.deepEqual(await get(current, '/state'), { checkpoint: 2, totalMinor: 300, count: 2 });
  assert.deepEqual(await (await jsonRequest(current.url + '/teaching/deliver', v1)).json(), { applied: false });
  const conflict = await jsonRequest(current.url + '/teaching/deliver', { ...v1, payload: { ...v1.payload, totalCents: 151 } });
  assert.equal(conflict.status, 422); assert.equal(object(object(await conflict.json()).error).code, 'identity_conflict');
  assert.equal((await jsonRequest(current.url + '/sync', {})).status, 200);
  assert.deepEqual(await get(current, '/state'), { checkpoint: 2, totalMinor: 300, count: 2 });
  assert.deepEqual(await get(owner, '/events'), before);
 } finally { for (const s of services.reverse()) await s.stop(); await rm(dir, { recursive: true, force: true }); }
});
for (const kind of ['unknown', 'malformed']) test('integration: valid envelopes around ' + kind + ' history stop checkpoint', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'schema-bad-')); const services: RunningService[] = [];
 try {
  const owner = await startService(new URL('../owner.mts', import.meta.url), { DB_PATH: join(dir, 'o.db'), TEACHING_CONTROLS: '1' }); services.push(owner);
  const bad = kind === 'unknown' ? { ...v2, revision: 3 } : { ...v2, payload: { ...v2.payload, amount: { amountMinor: '150', currency: 'USD' } } };
  for (const e of [v1, bad, { ...v1, id: 'sale_c', position: 3 }]) assert.equal((await jsonRequest(owner.url + '/teaching/raw', e)).status, 201);
  const consumer = await startService(new URL('../consumer.mts', import.meta.url), { DB_PATH: join(dir, 'c.db'), OWNER_URL: owner.url }); services.push(consumer);
  for (let i = 0; i < 2; i++) {
   const response = await jsonRequest(consumer.url + '/sync', {}); assert.equal(response.status, 422);
   assert.equal(object(object(await response.json()).error).code, kind === 'unknown' ? 'unsupported_revision' : 'integer');
   assert.deepEqual(await get(consumer, '/state'), { checkpoint: 1, totalMinor: 150, count: 1 });
  }
 } finally { for (const s of services.reverse()) await s.stop(); await rm(dir, { recursive: true, force: true }); }
});
