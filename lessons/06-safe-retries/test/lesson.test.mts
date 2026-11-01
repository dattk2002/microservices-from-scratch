import assert from 'node:assert/strict';
import test from 'node:test';
import { retry, type RetryOptions } from '../retry.mts';

function fixture(overrides: Partial<RetryOptions> = {}) {
  let now = 0;
  const waits: number[] = [];
  const options: RetryOptions = {
    maxAttempts: 4, baseMs: 10, capMs: 25, deadline: 1000, permitted: true,
    now: () => now, rng: () => 0.5,
    sleep: async ms => { waits.push(ms); now += ms; }, ...overrides,
  };
  return { options, waits, advance: (ms: number) => { now += ms; } };
}
test('unit: exponential full jitter is capped and attempts include the first call', async () => {
  const f = fixture(); let calls = 0;
  const result = await retry(async () => { calls++; return { status: 503 }; }, f.options);
  assert.equal(calls, 4);
  assert.equal(result.status, 503);
  assert.deepEqual(f.waits, [5, 10, 12]);
});
test('unit: two transient failures then success stop without an extra sleep', async () => {
  const f = fixture(); let calls = 0;
  const result = await retry(async () => ({ status: ++calls < 3 ? 503 : 200 }), f.options);
  assert.equal(result.status, 200); assert.equal(calls, 3); assert.deepEqual(f.waits, [5, 10]);
});
test('unit: unsafe operations and permanent statuses are never retried', async () => {
  for (const [permitted, status] of [[false, 503], [true, 400], [true, 409], [true, 501]] as const) {
    const f = fixture({ permitted }); let calls = 0;
    await retry(async () => { calls++; return { status }; }, f.options);
    assert.equal(calls, 1); assert.deepEqual(f.waits, []);
  }
});
test('unit: deadline includes operation time, backoff and scheduler overshoot', async () => {
  const f = fixture({ deadline: 9 }); let calls = 0;
  await assert.rejects(retry(async () => { calls++; f.advance(4); return { status: 503 }; }, f.options), /deadline/);
  assert.equal(calls, 1); assert.deepEqual(f.waits, []);
  const g = fixture({ deadline: 10, sleep: async () => { g.advance(20); } });
  calls = 0;
  await assert.rejects(retry(async () => { calls++; return { status: 503 }; }, g.options), /deadline/);
  assert.equal(calls, 1);
});
test('unit: expired deadline starts no operation; late success is rejected', async () => {
  const f = fixture({ deadline: 0 }); let calls = 0;
  await assert.rejects(retry(async () => { calls++; return { status: 200 }; }, f.options), /deadline/);
  assert.equal(calls, 0);
  const g = fixture({ deadline: 10 });
  await assert.rejects(retry(async () => { g.advance(10); return { status: 200 }; }, g.options), /deadline/);
});
test('unit: arbitrary exceptions do not imply a transient failure', async () => {
  const f = fixture(); let calls = 0;
  await assert.rejects(retry(async () => { calls++; throw new Error('programming error'); }, f.options), /programming error/);
  assert.equal(calls, 1);
});
test('unit: invalid configuration and RNG fail explicitly', async () => {
  for (const overrides of [{ maxAttempts: 0 }, { maxAttempts: 1.5 }, { baseMs: -1 }, { capMs: Infinity }, { deadline: NaN }]) {
    await assert.rejects(retry(async () => ({ status: 200 }), fixture(overrides).options), /configuration/);
  }
  await assert.rejects(retry(async () => ({ status: 503 }), fixture({ rng: () => 1 }).options), /RNG/);
});

import type { TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
async function setup(t: TestContext, upstreamEnv: Record<string, string> = {}, clientEnv: Record<string, string> = {}) {
  const services: RunningService[] = [];
  t.after(async () => { await Promise.all(services.map(service => service.stop())); });
  const upstream = await startService(new URL('../upstream.mts', import.meta.url), upstreamEnv);
  services.push(upstream);
  const client = await startService(new URL('../client.mts', import.meta.url), { UPSTREAM_URL: upstream.url, ...clientEnv });
  services.push(client);
  assert.notEqual(upstream.child.pid, client.child.pid);
  return { client, state: async () => (await fetch(`${upstream.url}/state`, { signal: AbortSignal.timeout(5000) })).json() as Promise<unknown> };
}
function call(client: RunningService, path: string, key?: string) {
  return fetch(`${client.url}${path}`, {
    method: path === '/quote' ? 'GET' : 'POST',
    headers: key === undefined ? {} : { 'idempotency-key': key },
    signal: AbortSignal.timeout(5000),
  });
}
test('integration: safe GET fails twice then succeeds on exactly the third attempt', async t => {
  const env = await setup(t);
  const response = await call(env.client, '/quote');
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-attempts'), '3');
  assert.deepEqual(await response.json(), { priceCents: 125 });
  assert.deepEqual(await env.state(), { get: 3, unsafe: 0, protected: 0, effects: 0 });
});
test('integration: persistent transient failure exhausts exactly the configured attempts', async t => {
  const env = await setup(t, { FAIL_FIRST: '100' }, { MAX_ATTEMPTS: '2' });
  const response = await call(env.client, '/quote');
  assert.equal(response.status, 503); assert.equal(response.headers.get('x-attempts'), '2');
  await response.text();
  assert.deepEqual(await env.state(), { get: 2, unsafe: 0, protected: 0, effects: 0 });
});
test('integration: arbitrary POST is attempted once despite transient failure', async t => {
  const env = await setup(t);
  const response = await call(env.client, '/unsafe', 'a-header-does-not-create-a-contract');
  assert.equal(response.status, 503); assert.equal(response.headers.get('x-attempts'), '1');
  await response.text();
  assert.deepEqual(await env.state(), { get: 0, unsafe: 1, protected: 0, effects: 1 });
});
test('integration: protected POST retries the same committed command with only one effect', async t => {
  const env = await setup(t);
  const response = await call(env.client, '/protected', 'checkout-06');
  assert.equal(response.status, 201); assert.equal(response.headers.get('x-attempts'), '3');
  assert.deepEqual(await response.json(), { reservation: 'reservation-1' });
  const replay = await call(env.client, '/protected', 'checkout-06');
  assert.equal(replay.status, 201); assert.equal(replay.headers.get('x-attempts'), '1');
  assert.deepEqual(await replay.json(), { reservation: 'reservation-1' });
  assert.deepEqual(await env.state(), { get: 0, unsafe: 0, protected: 4, effects: 1 });
});
test('integration: missing idempotency key is rejected before any upstream attempt', async t => {
  const env = await setup(t);
  const response = await call(env.client, '/protected');
  assert.equal(response.status, 400); await response.text();
  assert.deepEqual(await env.state(), { get: 0, unsafe: 0, protected: 0, effects: 0 });
});
test('integration: permanent status stops after the first attempt', async t => {
  const env = await setup(t, { FAIL_STATUS: '400' });
  const response = await call(env.client, '/quote');
  assert.equal(response.status, 400); assert.equal(response.headers.get('x-attempts'), '1');
  await response.text();
  assert.deepEqual(await env.state(), { get: 1, unsafe: 0, protected: 0, effects: 0 });
});
test('integration: slow upstream obeys overall deadline without another attempt', async t => {
  const env = await setup(t, { DELAY_MS: '1500' }, { BUDGET_MS: '500' });
  const response = await call(env.client, '/quote');
  assert.equal(response.status, 504); assert.equal(response.headers.get('x-attempts'), '1');
  assert.deepEqual(await response.json(), { error: 'deadline_exceeded' });
  assert.deepEqual(await env.state(), { get: 1, unsafe: 0, protected: 0, effects: 0 });
});
