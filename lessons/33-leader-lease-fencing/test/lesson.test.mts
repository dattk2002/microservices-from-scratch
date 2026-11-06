import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { LeaseStore, FencedSink } from '../state.mts';

// Removing the strict expiry comparison would let a paused holder renew at expiry.
test('unit: exact expiry permits takeover and forbids renew or release', () => {
  const db = new DatabaseSync(':memory:'); let now = 100;
  try {
    const lease = new LeaseStore(db, () => now);
    assert.deepEqual(lease.acquire('alpha', 10), {holder: 'alpha', generation: 1, expiresAt: 110});
    assert.equal(lease.acquire('beta', 10), null);
    now = 110;
    assert.equal(lease.renew('alpha', 1, 10), null);
    assert.equal(lease.release('alpha', 1), false);
    assert.deepEqual(lease.acquire('beta', 10), {holder: 'beta', generation: 2, expiresAt: 120});
    assert.equal(lease.renew('alpha', 1, 10), null);
    assert.equal(lease.release('alpha', 1), false);
    assert.equal(lease.release('beta', 2), true);
    assert.equal(lease.acquire('alpha', 10)?.generation, 3);
  } finally { db.close(); }
});

test('unit: conditional grants share SQLite state and generation survives store restart', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const first = new LeaseStore(db, () => 10);
    const second = new LeaseStore(db, () => 10);
    assert.equal(first.acquire('a', 5)?.generation, 1);
    assert.equal(second.acquire('b', 5), null);
    assert.equal(second.release('a', 1), true);
    assert.equal(new LeaseStore(db, () => 10).acquire('b', 5)?.generation, 2);
  } finally { db.close(); }
});

// Removing fencing before receipt lookup would let an old duplicate bypass the barrier.
test('unit: sink fences only after newer activation, deduplicates and binds payload', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const sink = new FencedSink(db, 2);
    assert.deepEqual(sink.write(1, 'one', 'A'), {generation: 1, duplicate: false, applied: 1});
    assert.equal(sink.write(1, 'one', 'A').duplicate, true);
    assert.throws(() => sink.write(1, 'one', 'B'), /conflict/);
    assert.equal(sink.write(2, 'one', 'A').duplicate, true);
    assert.throws(() => sink.write(1, 'one', 'A'), /fenced/);
    assert.equal(sink.write(2, 'two', 'B').applied, 2);
    assert.throws(() => sink.write(3, 'three', 'C'), /capacity/);
    const restarted = new FencedSink(db, 2);
    assert.equal(restarted.write(2, 'two', 'B').applied, 2);
    assert.throws(() => restarted.write(1, 'four', 'D'), /fenced/);
  } finally { db.close(); }
});

test('unit: invalid primitive inputs cannot become identities, leases or writes', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const lease = new LeaseStore(db, () => 100);
    assert.throws(() => lease.acquire('', 10));
    assert.throws(() => lease.acquire('x'.repeat(49), 10));
    assert.throws(() => lease.acquire('a', 0));
    assert.throws(() => lease.acquire('a', 10001));
    const sink = new FencedSink(db, 1);
    assert.throws(() => sink.write(0, 'ok', 'A'));
    assert.throws(() => sink.write(1, 'ok', '\ud800'));
    assert.throws(() => sink.write(1, 'ok', 'a'.repeat(257)));
    assert.equal(sink.write(1, 'x'.repeat(48), '\u0000'.repeat(256)).applied, 1);
    assert.throws(() => sink.write(2, 'next', 'B'), /capacity/);
    assert.equal(sink.write(1, 'x'.repeat(48), '\u0000'.repeat(256)).duplicate, true);
  } finally { db.close(); }
});

import { Worker } from '../worker.mts';
import { HttpError } from '../../../lib/http.mts';

test('unit: normal worker renews before writing and rejects malformed upstream grants', async () => {
  const calls: string[] = [];
  let malformed = false;
  let expired = false;
  const worker = new Worker('alpha', 100, async (target, path, body) => {
    calls.push(`${target}${path}`);
    if (path === '/renew' && expired) throw new HttpError(409, 'not_current', 'expired');
    if (target === 'coordinator') return {holder: 'alpha', generation: malformed ? '1' : 1, expiresAt: 200};
    assert.deepEqual(body, {generation: 1, id: 'export', payload: 'row'});
    return {generation: 1, duplicate: false, applied: 1};
  });
  malformed = true;
  await assert.rejects(worker.execute('acquire', {}));
  await assert.rejects(worker.execute('write', {id: 'export', payload: 'row'}));
  assert.deepEqual(calls, ['coordinator/acquire']);
  malformed = false;
  await worker.execute('acquire', {});
  assert.deepEqual(await worker.execute('write', {id: 'export', payload: 'row'}), {generation: 1, duplicate: false, applied: 1});
  assert.deepEqual(calls.slice(-2), ['coordinator/renew', 'sink/write']);
  expired = true;
  await assert.rejects(worker.execute('write', {id: 'export', payload: 'row'}));
  assert.equal(calls.at(-1), 'coordinator/renew');
  await assert.rejects(worker.execute('stale-write', {id: 'export', payload: 'row'}));
  assert.deepEqual(await worker.execute('stale-write', {id: 'export', payload: 'row'}, true), {generation: 1, duplicate: false, applied: 1});
  assert.equal(calls.at(-1), 'sink/write');
  await assert.rejects(worker.execute(['acquire'], {}));
});

test('unit: worker bounds command admission while a real command awaits upstream', async () => {
  let finish: (value: unknown) => void = () => { throw new Error('not started'); };
  const worker = new Worker('alpha', 10, async () => new Promise((resolve) => { finish = resolve; }));
  const first = worker.execute('acquire', {});
  await assert.rejects(worker.execute('acquire', {}), (error: unknown) => error instanceof HttpError && error.status === 429);
  finish({holder: 'alpha', generation: 1, expiresAt: 10});
  assert.deepEqual(await first, {holder: 'alpha', generation: 1, expiresAt: 10});
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { object, grant, receipt } from '../state.mts';

// Invalid settings must remain unread on import; exit=0 alone is insufficient.
test('unit: all entrypoints import silently with deliberately invalid runtime configuration', async () => {
  const entries = ['coordinator.mts', 'sink.mts', 'worker.mts'].map((name) => new URL(`../${name}`, import.meta.url).href);
  const {stdout, stderr} = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `for (const url of ${JSON.stringify(entries)}) await import(url);`], {
    timeout: 3000,
    env: {PATH: process.env.PATH ?? '', PORT: 'invalid', HOST: 'invalid', DB_PATH: '/unwritable/no.sqlite',
      HOLDER: '!', COORDINATOR_URL: 'invalid', SINK_URL: 'invalid', TEACHING_CONTROLS: 'invalid', LEASE_MS: 'invalid'},
  });
  assert.equal(stdout, ''); assert.equal(stderr, '');
});

async function fixture(run: (start: (name: string, env?: Record<string, string>) => Promise<RunningService>, dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'leader-fencing-'));
  const services: RunningService[] = [];
  try {
    await run(async (name, env = {}) => {
      const service = await startService(new URL(`../${name}.mts`, import.meta.url), env);
      services.push(service); return service;
    }, dir);
  } finally {
    const stopped = await Promise.allSettled(services.toReversed().map((service) => service.stop()));
    await rm(dir, {recursive: true, force: true});
    const failures = stopped.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'Child cleanup failed');
  }
}
async function post(service: RunningService, path: string, body: unknown, status = 200): Promise<unknown> {
  const response = await jsonRequest(service.url + path, body);
  const value: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  return value;
}
function errorCode(value: unknown): unknown { return object(object(value).error).code; }

test('integration: two independent workers, takeover barrier, fencing and durable restarts', async () => {
  await fixture(async (start, dir) => {
    const coordinatorEnv = {DB_PATH: join(dir, 'coordinator.sqlite'), TEACHING_CONTROLS: '1'};
    const sinkEnv = {DB_PATH: join(dir, 'sink.sqlite')};
    let coordinator = await start('coordinator', coordinatorEnv);
    let sink = await start('sink', sinkEnv);
    const workerEnv = {COORDINATOR_URL: coordinator.url, SINK_URL: sink.url, TEACHING_CONTROLS: '1', LEASE_MS: '10000'};
    const a = await start('worker', {...workerEnv, HOLDER: 'alpha'});
    const b = await start('worker', {...workerEnv, HOLDER: 'beta'});
    const outcomes = await Promise.all([jsonRequest(a.url + '/acquire', {}), jsonRequest(b.url + '/acquire', {})]);
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
    const winnerIndex = outcomes[0]?.status === 200 ? 0 : 1;
    const firstReply = outcomes[winnerIndex];
    assert.ok(firstReply);
    const first = grant(await firstReply.json());
    assert.equal(first.generation, 1);
    const old = winnerIndex === 0 ? a : b;
    const next = winnerIndex === 0 ? b : a;
    assert.equal(receipt(await post(old, '/write', {id: 'daily-export', payload: 'batch-1'})).applied, 1);
    assert.equal(receipt(await post(old, '/write', {id: 'daily-export', payload: 'batch-1'})).duplicate, true);
    // This awaited response is an explicit expiry barrier, not a sleep race.
    await post(coordinator, '/teaching/advance', {ms: 10001});
    const second = grant(await post(next, '/acquire', {}));
    assert.equal(second.generation, 2);
    assert.equal(errorCode(await post(coordinator, '/renew', {...first, ttl: 10000}, 409)), 'not_current');
    assert.equal(errorCode(await post(coordinator, '/release', first, 409)), 'not_current');
    await post(old, '/write', {id: 'normal-expired', payload: 'blocked'}, 409);
    // New lease already exists, but sink has NOT seen generation 2 yet.
    assert.equal(receipt(await post(old, '/teaching/stale-write', {id: 'late-before-fence', payload: 'possible'})).applied, 2);
    assert.equal(receipt(await post(next, '/write', {id: 'new-export', payload: 'batch-2'})).applied, 3);
    // New sink write above is the observable fencing activation barrier.
    await post(old, '/teaching/stale-write', {id: 'late-after-fence', payload: 'blocked'}, 409);
    await post(old, '/teaching/stale-write', {id: 'daily-export', payload: 'batch-1'}, 409);
    assert.equal(receipt(await post(next, '/write', {id: 'daily-export', payload: 'batch-1'})).duplicate, true);
    assert.equal(errorCode(await post(sink, '/write', {generation: 2, id: 'daily-export', payload: 'different'}, 409)), 'conflict');

    const coordinatorPort = new URL(coordinator.url).port;
    await coordinator.stop();
    coordinator = await start('coordinator', {...coordinatorEnv, PORT: coordinatorPort});
    await post(coordinator, '/acquire', {holder: 'third', ttl: 10000}, 409);
    assert.equal(grant(await post(next, '/renew', {})).generation, 2);
    await post(next, '/release', {});
    assert.equal(grant(await post(next, '/acquire', {})).generation, 3);
    const sinkPort = new URL(sink.url).port;
    await sink.stop();
    sink = await start('sink', {...sinkEnv, PORT: sinkPort});
    assert.deepEqual(receipt(await post(next, '/write', {id: 'new-export', payload: 'batch-2'})), {generation: 3, duplicate: true, applied: 3});
    assert.equal(errorCode(await post(sink, '/write', {generation: 2, id: 'new-export', payload: 'batch-2'}, 409)), 'fenced');
  });
});

test('integration: maximal escaped payload, valid JSON byte overflow and finite receipts', async () => {
  await fixture(async (start, dir) => {
    const sink = await start('sink', {DB_PATH: join(dir, 'sink.sqlite')});
    const legal = {generation: Number.MAX_SAFE_INTEGER, id: 'x'.repeat(48), payload: '\u0000'.repeat(256)};
    assert.equal(receipt(await post(sink, '/write', legal)).applied, 1);
    // Same schema/identity/payload/generation; only trailing JSON whitespace exceeds the byte gate.
    const serialized = JSON.stringify(legal);
    const oversized = serialized + ' '.repeat(8193 - Buffer.byteLength(serialized));
    const response = await fetch(sink.url + '/write', {method: 'POST', headers: {'content-type': 'application/json'}, body: oversized, signal: AbortSignal.timeout(5000)});
    assert.equal(response.status, 413);
    assert.equal(errorCode(await response.json()), 'body_too_large');
    // Without the byte gate this would be a successful duplicate, not another failure.
    for (const invalid of [
      {...legal, generation: '9007199254740991'}, {...legal, id: ['valid']},
      {...legal, payload: 1}, {...legal, payload: '\ud800'}, {...legal, payload: 'x'.repeat(257)},
    ]) await post(sink, '/write', invalid, 400);
    for (let index = 1; index < 128; index++) await post(sink, '/write', {generation: legal.generation, id: `record-${index}`, payload: 'row'});
    assert.equal(errorCode(await post(sink, '/write', {generation: legal.generation, id: 'overflow', payload: 'row'}, 507)), 'capacity');
    assert.deepEqual(receipt(await post(sink, '/write', legal)), {generation: legal.generation, duplicate: true, applied: 128});
  });
});

test('integration: teaching controls disabled and lease failures use otherwise valid inputs', async () => {
  await fixture(async (start, dir) => {
    const coordinator = await start('coordinator', {DB_PATH: join(dir, 'coordinator.sqlite')});
    const sink = await start('sink', {DB_PATH: join(dir, 'sink.sqlite')});
    const worker = await start('worker', {COORDINATOR_URL: coordinator.url, SINK_URL: sink.url, HOLDER: 'normal', LEASE_MS: '10000'});
    await post(worker, '/acquire', {});
    assert.equal(errorCode(await post(coordinator, '/teaching/advance', {ms: 10001}, 404)), 'not_found');
    assert.equal(errorCode(await post(worker, '/teaching/stale-write', {id: 'valid', payload: 'row'}, 404)), 'not_found');
    await post(worker, '/write', {id: 'valid', payload: 'row'});
    assert.equal(errorCode(await post(coordinator, '/renew', {holder: 'other', generation: 1, ttl: 10000}, 409)), 'not_current');
    assert.equal(errorCode(await post(coordinator, '/release', {holder: 'normal', generation: 2}, 409)), 'not_current');
    await post(coordinator, '/acquire', {holder: 'x'.repeat(48), ttl: 10000}, 409);
    await post(coordinator, '/acquire', {holder: ['normal'], ttl: 10000}, 400);
    await post(coordinator, '/acquire', {holder: 'other', ttl: '10000'}, 400);
    await post(worker, '/release', {});
    assert.equal(grant(await post(coordinator, '/acquire', {holder: 'x'.repeat(48), ttl: 10000})).generation, 2);
  });
});
