import test from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../store.mts';

test('unit: phase guards and retirement drain prevent destructive early contract', () => {
  const c = new Catalog(':memory:');
  try {
    assert.throws(() => c.contract(), /phase/);
    c.write('old', 1, 'Trà sen');
    c.expand();
    assert.throws(() => c.contract(), /phase/);
    c.batch(10);
    assert.throws(() => c.contract(), /retire/);
    const ticket = c.admit(2, 'Cà phê');
    c.retire();
    assert.throws(() => c.admit(3, 'Bánh'), /retired/);
    assert.equal(c.complete(ticket), 2);
    c.contract();
    assert.equal(c.read('new', 2), 'Cà phê');
    assert.throws(() => c.write('old', 1, 'stale'), /contract/);
    assert.throws(() => c.read('old', 1), /contract/);
  } finally { c.close(); }
});

test('unit: bounded atomic backfill resumes after interruption and preserves old writes', () => {
  const c = new Catalog(':memory:');
  try {
    for (let id = 1; id <= 5; id++) c.write('old', id, `Tên ${id}`);
    c.expand();
    assert.throws(() => c.batch(0), /batch/);
    assert.throws(() => c.batch(101), /batch/);
    assert.throws(() => c.batch(2, true), /interrupted/);
    assert.equal(c.status().cursor, 0);
    assert.equal(c.copied(), 0);
    assert.equal(c.batch(2).cursor, 2);
    c.write('old', 1, 'Đổi sau cursor');
    c.write('old', 4, 'Đổi trước cursor');
    c.write('old', 8, 'Thêm trong backfill');
    while (c.status().phase === 'expanded') c.batch(2);
    for (const id of [1, 2, 3, 4, 5, 8]) assert.equal(c.read('old', id), c.read('new', id));
    assert.equal(c.read('new', 1), 'Đổi sau cursor');
    assert.equal(c.read('new', 4), 'Đổi trước cursor');
    assert.throws(() => c.contract(), /retire/);
    c.retire(); c.contract();
    c.write('new', 9, 'Tên mới');
    assert.equal(c.read('new', 9), 'Tên mới');
  } finally { c.close(); }
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

const exec = promisify(execFile);
test('unit: all modules import silently with deliberately invalid runtime configuration', async () => {
  const modules = ['old', 'new', 'control', 'service', 'store'].map(name => new URL(`../${name}.mts`, import.meta.url).href);
  const result = await exec(process.execPath, ['--input-type=module', '-e',
    `for (const url of ${JSON.stringify(modules)}) await import(url);`], {
    env: {PATH: process.env.PATH ?? '', PORT: 'invalid', HOST: 'not a host', CATALOG_DB: '/unwritable/missing/catalog.sqlite'},
    timeout: 5000,
  });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

async function get(url: string) {
  return fetch(url, {signal: AbortSignal.timeout(5000)});
}
async function post(url: string, body: unknown, status = 200) {
  const response = await jsonRequest(url, body);
  assert.equal(response.status, status, `${url}: ${await response.clone().text()}`);
  return response;
}
async function expectName(service: RunningService, id: number, name: string) {
  const response = await get(`${service.url}/products/${id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {id, name});
}

test('integration: separate Catalog binaries preserve concurrent writes, resume, drain and restart after contract', {timeout: 30000}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'catalog-migration-'));
  const env = {CATALOG_DB: join(dir, 'catalog.sqlite')};
  const running: RunningService[] = [];
  const launch = async (role: string) => {
    const service = await startService(new URL(`../${role}.mts`, import.meta.url), env);
    running.push(service);
    return service;
  };
  try {
    const old = await launch('old');
    const modern = await launch('new');
    let control = await launch('control');
    for (let id = 1; id <= 5; id++) await post(`${old.url}/products`, {id, name: `Trà ${id}`});
    await expectName(modern, 1, 'Trà 1');
    await post(`${control.url}/contract`, {}, 409);
    await post(`${control.url}/expand`, {});
    await post(`${control.url}/retire`, {}, 409);
    await expectName(modern, 5, 'Trà 5'); // fallback before backfill
    // Durable admission is the barrier: this old write cannot apply until complete/drain.
    const admitted = await post(`${old.url}/admit`, {id: 1, name: 'Trà sen sau cursor'}, 202);
    const ticket: unknown = (await admitted.json() as {ticket: unknown}).ticket;
    assert.equal(typeof ticket, 'number');
    await post(`${control.url}/batch`, {size: 2});
    await post(`${old.url}/complete`, {ticket});
    await expectName(modern, 1, 'Trà sen sau cursor');
    // Real overlapping requests: whichever transaction wins, trigger/backfill preserve name.
    await Promise.all([
      post(`${control.url}/batch`, {size: 1}),
      post(`${old.url}/products`, {id: 5, name: 'Cà phê đồng thời'}),
    ]);
    await expectName(modern, 5, 'Cà phê đồng thời');
    const before = await (await get(`${control.url}/status`)).json();
    await post(`${control.url}/batch`, {size: 1, interrupt: true}, 500);
    assert.deepEqual(await (await get(`${control.url}/status`)).json(), before);
    await control.stop();
    control = await launch('control');
    assert.deepEqual(await (await get(`${control.url}/status`)).json(), before);
    // The committed cursor is 3: two bounded batches finish rows 4/5 then EOF.
    await post(`${control.url}/batch`, {size: 1});
    await post(`${control.url}/batch`, {size: 1});
    await post(`${control.url}/batch`, {size: 1});
    await post(`${control.url}/contract`, {}, 409); // ready, but writer gate still open
    await post(`${modern.url}/products`, {id: 6, name: 'Tên từ phiên bản mới'});
    await expectName(old, 6, 'Tên từ phiên bản mới');
    // An uncompleted old command is durable even if its admitting process dies.
    const pending = await post(`${old.url}/admit`, {id: 7, name: 'Ghi cần drain'}, 202);
    const pendingTicket: unknown = (await pending.json() as {ticket: unknown}).ticket;
    await old.stop();
    const restartedOld = await launch('old');
    const drained = await post(`${control.url}/retire`, {});
    assert.deepEqual(await drained.json(), {phase: 'ready', cursor: 5, retired: true, pending: 0});
    await expectName(modern, 7, 'Ghi cần drain');
    await post(`${restartedOld.url}/products`, {id: 8, name: 'Hợp lệ nhưng bị chặn'}, 409);
    await post(`${restartedOld.url}/admit`, {id: 8, name: 'Hợp lệ nhưng bị chặn'}, 409);
    await post(`${restartedOld.url}/complete`, {ticket: pendingTicket}); // receipt, no second write
    await post(`${control.url}/contract`, {});
    assert.equal((await get(`${restartedOld.url}/products/1`)).status, 409);
    await post(`${restartedOld.url}/products`, {id: 1, name: 'Không được ghi'}, 409);
    await modern.stop(); await control.stop(); await restartedOld.stop();
    const afterRestart = await launch('new');
    const incompatible = await launch('old');
    assert.equal((await get(`${incompatible.url}/status`)).status, 409);
    for (const [id, name] of [[1, 'Trà sen sau cursor'], [2, 'Trà 2'], [3, 'Trà 3'], [4, 'Trà 4'], [5, 'Cà phê đồng thời'], [6, 'Tên từ phiên bản mới'], [7, 'Ghi cần drain']] as const) {
      await expectName(afterRestart, id, name);
    }
    await post(`${afterRestart.url}/products`, {id: 8, name: 'Sau contract'});
    await expectName(afterRestart, 8, 'Sau contract');
  } finally {
    try { await Promise.all(running.map(service => service.stop())); }
    finally { await rm(dir, {recursive: true, force: true}); }
  }
});

test('unit: retirement drains a bounded full queue and replay cannot overwrite later new writes', () => {
  const c = new Catalog(':memory:');
  try {
    c.expand(); c.batch(1);
    const tickets = Array.from({length: 32}, (_, i) => c.admit(i + 1, `Đã nhận ${i + 1}`));
    assert.throws(() => c.admit(33, 'Quá tải'), /capacity/);
    assert.equal(c.status().pending, 32);
    c.retire();
    assert.equal(c.status().pending, 0);
    for (let id = 1; id <= 32; id++) assert.equal(c.read('new', id), `Đã nhận ${id}`);
    c.write('new', 1, 'Ghi mới hơn');
    assert.equal(c.complete(tickets[0]!), 1);
    assert.equal(c.read('new', 1), 'Ghi mới hơn');
    c.contract();
    assert.throws(() => c.complete(tickets[0]!), /contract/);
    assert.equal(c.read('new', 1), 'Ghi mới hơn');
  } finally { c.close(); }
});
