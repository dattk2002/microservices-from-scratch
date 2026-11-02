import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Buckets, validClient } from '../bucket.mts';

test('unit: initial burst, exact refill boundary and rounded retry delay', () => {
  let now = 0;
  const buckets = new Buckets({ capacity: 2, refillMs: 1501, maxClients: 2, idleMs: 4000 }, () => now);
  assert.deepEqual(buckets.take('alice'), { kind: 'allowed' });
  assert.deepEqual(buckets.take('alice'), { kind: 'allowed' });
  assert.deepEqual(buckets.take('alice'), { kind: 'limited', retryAfter: 2 });
  now = 501;
  assert.deepEqual(buckets.take('alice'), { kind: 'limited', retryAfter: 1 });
  now = 1500;
  assert.deepEqual(buckets.take('alice'), { kind: 'limited', retryAfter: 1 });
  now = 1501;
  assert.deepEqual(buckets.take('alice'), { kind: 'allowed' });
  now = 100000;
  assert.equal(buckets.take('alice').kind, 'allowed');
  assert.equal(buckets.take('alice').kind, 'allowed');
  assert.equal(buckets.take('alice').kind, 'limited');
});

test('unit: isolated clients and full table cannot reset depleted quota', () => {
  let now = 0;
  const buckets = new Buckets({ capacity: 2, refillMs: 1000, maxClients: 2, idleMs: 1 }, () => now);
  assert.equal(buckets.take('alice').kind, 'allowed');
  assert.equal(buckets.take('alice').kind, 'allowed');
  assert.equal(buckets.take('bob').kind, 'allowed');
  now = 999;
  assert.equal(buckets.take('carol').kind, 'full');
  assert.equal(buckets.take('alice').kind, 'limited');
  now = 1000;
  // Bob is full and idle; Alice still has only one token.
  assert.equal(buckets.take('carol').kind, 'allowed');
  assert.equal(buckets.take('alice').kind, 'allowed');
  assert.equal(buckets.take('alice').kind, 'limited');
});

test('unit: validates bounded IDs and all configuration fields', () => {
  for (const id of ['', 'Alice', 'a,b', 'a b', 'a\n', 'a'.repeat(33), undefined]) assert.equal(validClient(id), false);
  for (const id of ['a', 'alice-01', 'a_b', 'a'.repeat(32)]) assert.equal(validClient(id), true);
  const config = { capacity: 2, refillMs: 1000, maxClients: 2, idleMs: 1000 };
  for (const field of ['capacity', 'refillMs', 'maxClients', 'idleMs'] as const) {
    for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => new Buckets({ ...config, [field]: value }, () => 0));
    }
  }
  const buckets = new Buckets(config, () => 0);
  assert.throws(() => buckets.take('INVALID'));
});

test('unit: idle expiry requires full refill and idle threshold together', () => {
  let now = 0;
  const buckets = new Buckets({ capacity: 1, refillMs: 100, maxClients: 1, idleMs: 1000 }, () => now);
  assert.equal(buckets.take('alice').kind, 'allowed');
  now = 100;
  assert.equal(buckets.take('bob').kind, 'full');
  now = 999;
  assert.equal(buckets.take('bob').kind, 'full');
  now = 1000;
  assert.equal(buckets.take('bob').kind, 'allowed');
  assert.equal(buckets.take('alice').kind, 'full');
});

test('unit: clock rejects backwards and nonfinite readings', () => {
  let now = 10;
  const buckets = new Buckets({ capacity: 1, refillMs: 1000, maxClients: 1, idleMs: 1000 }, () => now);
  buckets.take('alice');
  for (const value of [9, NaN, Infinity, -1]) {
    now = value;
    assert.throws(() => buckets.take('alice'), /Clock/);
  }
  now = 10;
  assert.equal(buckets.take('alice').kind, 'limited');
});

import { startGateway } from '../gateway.mts';

test('unit: gateway validates environment before listening', async () => {
  for (const [key, value] of [
    ['CAPACITY', '0'], ['REFILL_MS', '1.5'], ['MAX_CLIENTS', '10001'], ['IDLE_MS', '-1'],
    ['DEADLINE_MS', '0'], ['DOWNSTREAM_URL', 'https://localhost:4411'],
    ['DOWNSTREAM_URL', 'http://user:pass@localhost:4411'], ['DOWNSTREAM_URL', 'http://localhost:4411/work'],
  ] as const) {
    const old = process.env[key];
    process.env[key] = value;
    try { await assert.rejects(startGateway()); }
    finally { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
  }
});

import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

async function setup(t: TestContext, settings: Record<string, string> = {}) {
  const services: RunningService[] = [];
  t.after(async () => { await Promise.all(services.map(service => service.stop())); });
  const downstream = await startService(new URL('../downstream.mts', import.meta.url));
  services.push(downstream);
  const gateway = await startService(new URL('../gateway.mts', import.meta.url), {
    DOWNSTREAM_URL: downstream.url, CAPACITY: '2', REFILL_MS: '3600000',
    MAX_CLIENTS: '2', IDLE_MS: '86400000', ...settings,
  });
  services.push(gateway);
  assert.notEqual(gateway.child.pid, downstream.child.pid);
  return { downstream, gateway };
}
function request(service: RunningService, path: string, client?: string, method = 'GET') {
  return fetch(`${service.url}${path}`, {
    method, headers: client === undefined ? {} : { 'x-demo-client': client }, signal: AbortSignal.timeout(5000),
  });
}
async function count(service: RunningService, expected: number) {
  const response = await request(service, '/stats');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { entered: expected });
}
async function admitted(service: RunningService, client: string) {
  const response = await request(service, '/work', client);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'ok' });
}

test('integration: exact burst, rejection before forwarding, isolation and bounded client table', async t => {
  const { gateway, downstream } = await setup(t);
  await admitted(gateway, 'alice');
  await admitted(gateway, 'alice');
  for (let i = 0; i < 3; i++) {
    const response = await request(gateway, '/work', 'alice');
    assert.equal(response.status, 429);
    assert.match(response.headers.get('retry-after') ?? '', /^[1-9][0-9]*$/);
    assert.deepEqual(await response.json(), { error: { code: 'rate_limited' } });
  }
  await count(downstream, 2);
  await admitted(gateway, 'bob');
  await admitted(gateway, 'bob');
  const bob = await request(gateway, '/work', 'bob');
  assert.equal(bob.status, 429); await bob.arrayBuffer();
  const full = await request(gateway, '/work', 'carol');
  assert.equal(full.status, 503);
  assert.deepEqual(await full.json(), { error: { code: 'client_table_full' } });
  const stillLimited = await request(gateway, '/work', 'alice');
  assert.equal(stillLimited.status, 429); await stillLimited.arrayBuffer();
  await count(downstream, 4);
});

test('integration: invalid IDs, routes, methods and queries neither forward nor allocate quota', async t => {
  const { gateway, downstream } = await setup(t, { MAX_CLIENTS: '1' });
  for (const client of [undefined, 'Alice', 'a,b', 'a b', 'a'.repeat(33)]) {
    const response = await request(gateway, '/work', client);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('retry-after'), null);
    await response.arrayBuffer();
  }
  for (const [path, method, status] of [['/other', 'GET', 404], ['/work?x=1', 'GET', 400], ['/work', 'POST', 405]] as const) {
    const response = await request(gateway, path, 'alice', method);
    assert.equal(response.status, status);
    if (status === 405) assert.equal(response.headers.get('allow'), 'GET');
    await response.arrayBuffer();
  }
  await count(downstream, 0);
  await admitted(gateway, 'alice');
  await admitted(gateway, 'alice');
  await count(downstream, 2);
});

test('integration: honoring Retry-After permits work after refill in real processes', async t => {
  const { gateway, downstream } = await setup(t, { CAPACITY: '1', REFILL_MS: '1200' });
  await admitted(gateway, 'alice');
  const limited = await request(gateway, '/work', 'alice');
  assert.equal(limited.status, 429);
  const retry = limited.headers.get('retry-after');
  assert.match(retry ?? '', /^[1-9][0-9]*$/);
  assert.ok(Number(retry) <= 2);
  await limited.arrayBuffer();
  await count(downstream, 1);
  await delay(Number(retry) * 1000);
  await admitted(gateway, 'alice');
  await count(downstream, 2);
});
