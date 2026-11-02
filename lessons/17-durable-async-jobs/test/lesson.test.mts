import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

test('unit: importing entrypoints does not start services or read runtime configuration', () => {
  for (const entry of ['api.mts', 'worker.mts']) {
    const child = spawnSync(process.execPath, [
      '--input-type=module', '--eval', 'await import(process.argv[1]);',
      new URL(`../${entry}`, import.meta.url).href,
    ], {
      encoding: 'utf8', timeout: 2000,
      env: { DB_PATH: ':memory:', PORT: 'invalid', CAPACITY: 'invalid', POLL_MS: 'invalid' },
    });
    assert.equal(child.status, 0, `${entry}: ${child.error?.message ?? child.stderr}`);
    assert.equal(child.stdout, '', `${entry} must not announce a listener on import`);
    assert.equal(child.stderr, '', `${entry} must not initialize runtime resources on import`);
  }
});

test('unit: durable transitions, exact lease boundary, fencing, retry exhaustion and admission', async () => {
  const module = await import('../store.mts').catch(() => null);
  assert.ok(module, 'job store must exist');
  let now = 100;
  const store = new module.Store(':memory:', 2, 2, 10, () => now);
  try {
    const id = store.admit(5, false);
    assert.equal(store.get(id)?.state, 'queued');
    const a = store.claim(); assert.ok(a);
    assert.equal(a.attempt, 1);
    assert.equal(store.claim(), undefined);
    now = 109; assert.equal(store.claim(), undefined);
    now = 110;
    assert.equal(store.finish(id, a.token, true, 15), false);
    const b = store.claim(); assert.ok(b);
    assert.notEqual(a.token, b.token);
    assert.equal(store.finish(id, a.token, true, 15), false);
    assert.equal(store.finish(id, b.token, true, 99), false);
    assert.equal(store.finish(id, b.token, true, 15), true);
    assert.equal(store.get(id)?.result, 15);
    assert.equal(store.finish(id, b.token, false), false);
    const bad = store.admit(3, true);
    const c = store.claim(); assert.ok(c);
    assert.equal(store.finish(bad, c.token, false), true);
    assert.equal(store.get(bad)?.state, 'queued');
    const d = store.claim(); assert.ok(d);
    now = 120; assert.equal(store.claim(), undefined);
    assert.equal(store.get(bad)?.state, 'failed');
    assert.equal(store.get(bad)?.attempt, 2);
    assert.throws(() => store.admit(1, false), /capacity/);
    assert.throws(() => store.admit(-1, false), /input/);
  } finally { store.close(); }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

function request(service: RunningService, path: string, payload?: unknown) {
  return fetch(`${service.url}${path}`, { signal: AbortSignal.timeout(2000),
    ...(payload === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }) });
}
async function data(response: Response, expected = 200): Promise<Record<string, unknown>> {
  assert.equal(response.status, expected);
  const value: unknown = await response.json();
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
async function barrier(read: () => Promise<Record<string, unknown>>, predicate: (value: Record<string, unknown>) => boolean) {
  const end = performance.now() + 6000;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    assert.ok(performance.now() < end, `barrier deadline: ${JSON.stringify(value)}`);
    await new Promise<void>(r => setTimeout(r, 15));
  }
}
async function setup(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'durable-jobs-'));
  const services: RunningService[] = [];
  t.after(async () => { try { await Promise.all(services.map(s => s.stop())); } finally { await rm(dir, { recursive: true, force: true }); } });
  const db = join(dir, 'owner.sqlite');
  async function api() {
    const service = await startService(new URL('../api.mts', import.meta.url), { DB_PATH: db, LEASE_MS: '1200', ATTEMPTS: '2', CAPACITY: '10' });
    services.push(service); return service;
  }
  const owner = await api();
  async function worker(hold = false) {
    const service = await startService(new URL('../worker.mts', import.meta.url), { OWNER_URL: owner.url, TEST_CONTROLS: '1', HOLD: hold ? '1' : '0', POLL_MS: '20' });
    services.push(service);
    assert.notEqual(service.child.pid, owner.child.pid);
    return service;
  }
  async function admit(n: number, fail = false) {
    const response = await request(owner, '/jobs', { n, fail });
    assert.equal(response.headers.get('retry-after'), '1');
    const location = response.headers.get('location'); assert.ok(location);
    const job = await data(response, 202); assert.equal(job.state, 'queued');
    return location;
  }
  return { owner, worker, admit, api };
}
async function active(worker: RunningService) {
  const stats = await barrier(() => request(worker, '/stats').then(r => data(r)), s => s.active !== null);
  const claim = stats.active;
  assert.ok(typeof claim === 'object' && claim !== null && 'id' in claim && typeof claim.id === 'string' && 'token' in claim && typeof claim.token === 'string');
  return { id: claim.id, token: claim.token };
}

test('integration: 202 precedes computation, bounded polling, explicit result and inspectable terminal failure', async t => {
  const { owner, worker, admit } = await setup(t);
  const path = await admit(10);
  assert.equal((await data(await request(owner, path))).state, 'queued');
  await data(await request(owner, `${path}/result`), 409);
  const runner = await worker(true);
  await active(runner);
  assert.equal((await data(await request(owner, path))).state, 'running');
  await data(await request(runner, '/release', {}));
  await barrier(() => request(owner, path).then(r => data(r)), j => j.state === 'succeeded');
  assert.deepEqual(await data(await request(owner, `${path}/result`)), { sum: 55 });
  const bad = await admit(4, true);
  const failed = await barrier(() => request(owner, bad).then(r => data(r)), j => j.state === 'failed');
  assert.equal(failed.attempt, 2); assert.equal(failed.error, 'computation_failed');
  await data(await request(owner, `${bad}/result`), 409);
  assert.equal((await data(await request(owner, bad))).state, 'failed');
  await data(await request(owner, '/jobs', { n: 10001 }), 400);
});

test('integration: competing workers hold distinct claims, expired completion is fenced after reclaim', async t => {
  const { owner, worker, admit } = await setup(t);
  const path = await admit(20);
  const first = await worker(true); const old = await active(first);
  const second = await worker(true);
  const next = await active(second); // Barrier waits for lease expiry and actual reclamation.
  assert.equal(next.id, old.id); assert.notEqual(next.token, old.token);
  await data(await request(owner, `${path}/complete`, { token: old.token, success: true, result: 210 }), 409);
  await data(await request(second, '/release', {}));
  await barrier(() => request(owner, path).then(r => data(r)), j => j.state === 'succeeded');
  await data(await request(first, '/release', {}));
  await barrier(() => request(first, '/stats').then(r => data(r)), s => s.stale === 1);
  assert.equal((await data(await request(owner, path))).attempt, 2);
});

test('integration: killed worker recovers after lease, owner restart preserves accepted and completed jobs', async t => {
  const { owner, worker, admit, api } = await setup(t);
  const path = await admit(8);
  const victim = await worker(true); const claim = await active(victim);
  const exited = once(victim.child, 'exit'); victim.child.kill('SIGKILL'); await exited;
  const recovery = await worker(true); const replacement = await active(recovery);
  assert.equal(replacement.id, claim.id); assert.notEqual(replacement.token, claim.token);
  await data(await request(owner, `${path}/complete`, { token: claim.token, success: true, result: 36 }), 409);
  await data(await request(recovery, '/release', {}));
  await barrier(() => request(owner, path).then(r => data(r)), j => j.state === 'succeeded');
  await recovery.stop();
  const queued = await admit(2);
  await owner.stop();
  const restarted = await api();
  assert.equal((await data(await request(restarted, queued))).state, 'queued');
  assert.deepEqual(await data(await request(restarted, `${path}/result`)), { sum: 36 });
});

test('integration: simultaneous workers cannot own the same unexpired job', async t => {
  const { owner, worker, admit } = await setup(t);
  const a = await admit(6); const b = await admit(7);
  const [one, two] = await Promise.all([worker(true), worker(true)]);
  const [x, y] = await Promise.all([active(one), active(two)]);
  assert.notEqual(x.id, y.id);
  assert.deepEqual(new Set([`/jobs/${x.id}`, `/jobs/${y.id}`]), new Set([a, b]));
  for (const path of [a, b]) {
    const state = await data(await request(owner, path));
    assert.equal(state.state, 'running'); assert.equal(state.attempt, 1);
  }
  await Promise.all([request(one, '/release', {}).then(r => data(r)), request(two, '/release', {}).then(r => data(r))]);
  for (const path of [a, b]) await barrier(() => request(owner, path).then(r => data(r)), j => j.state === 'succeeded');
});
