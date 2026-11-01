import assert from 'node:assert/strict';
import test from 'node:test';
import { CircuitBreaker, CircuitOpenError } from '../breaker.mts';

function fixture(maxProbes = 1) {
  let now = 0;
  const breaker = new CircuitBreaker({ threshold: 2, cooldownMs: 100, maxProbes, now: () => now });
  return { breaker, advance: (ms: number) => { now += ms; } };
}
const good = async () => ({ status: 200 });
const bad = async () => ({ status: 503 });
function pending() {
  let finish!: (value: { status: number }) => void;
  const promise = new Promise<{ status: number }>(resolve => { finish = resolve; });
  return { promise, finish };
}
test('unit: consecutive failures open; rejection invokes no dependency until exact cooldown', async () => {
  const f = fixture();
  await f.breaker.run(bad);
  assert.equal(f.breaker.state, 'closed');
  await f.breaker.run(bad);
  assert.equal(f.breaker.state, 'open');
  let calls = 0;
  const op = async () => { calls++; return { status: 200 }; };
  f.advance(99);
  await assert.rejects(f.breaker.run(op), CircuitOpenError);
  assert.equal(calls, 0);
  f.advance(1);
  await f.breaker.run(op);
  assert.equal(calls, 1);
  assert.equal(f.breaker.state, 'closed');
});
test('unit: healthy 4xx resets consecutive failures; thrown transport errors count', async () => {
  const f = fixture();
  await f.breaker.run(bad);
  await f.breaker.run(async () => ({ status: 404 }));
  await assert.rejects(f.breaker.run(async () => { throw new Error('transport'); }), /transport/);
  assert.equal(f.breaker.state, 'closed');
  await f.breaker.run(bad);
  assert.equal(f.breaker.state, 'open');
});
test('unit: half-open bounds concurrent probes and waits for all successful probes', async () => {
  const f = fixture(2);
  await f.breaker.run(bad); await f.breaker.run(bad); f.advance(100);
  const a = pending(); const b = pending();
  const first = f.breaker.run(() => a.promise); const second = f.breaker.run(() => b.promise);
  assert.equal(f.breaker.state, 'half-open');
  await assert.rejects(f.breaker.run(good), CircuitOpenError);
  a.finish({ status: 200 }); await first;
  assert.equal(f.breaker.state, 'half-open');
  b.finish({ status: 200 }); await second;
  assert.equal(f.breaker.state, 'closed');
});
test('unit: failed probe reopens for a full cooldown and stale success cannot close it', async () => {
  const f = fixture(2);
  await f.breaker.run(bad); await f.breaker.run(bad); f.advance(100);
  const old = pending(); const late = f.breaker.run(() => old.promise);
  await f.breaker.run(bad);
  old.finish({ status: 200 }); await late;
  assert.equal(f.breaker.state, 'open');
  f.advance(99); await assert.rejects(f.breaker.run(good), CircuitOpenError);
  f.advance(1); await f.breaker.run(good);
  assert.equal(f.breaker.state, 'closed');
});
test('unit: late closed-call failure cannot poison a recovered generation', async () => {
  const f = fixture(); const old = pending(); const late = f.breaker.run(() => old.promise);
  await f.breaker.run(bad); await f.breaker.run(bad); f.advance(100);
  await f.breaker.run(good);
  old.finish({ status: 503 }); await late;
  await f.breaker.run(bad);
  assert.equal(f.breaker.state, 'closed');
});
test('unit: configuration rejects invalid limits', () => {
  for (const config of [{ threshold: 0 }, { cooldownMs: -1 }, { maxProbes: 1.5 }, { cooldownMs: Infinity }]) {
    assert.throws(() => new CircuitBreaker({ threshold: 2, cooldownMs: 100, maxProbes: 1, now: () => 0, ...config }), /configuration/);
  }
});

test('unit: completed probe slots are not replenished while a batch is pending', async () => {
  const f = fixture(2);
  await f.breaker.run(bad); await f.breaker.run(bad); f.advance(100);
  const a = pending(); const b = pending();
  const first = f.breaker.run(() => a.promise); const second = f.breaker.run(() => b.promise);
  a.finish({ status: 200 }); await first;
  await assert.rejects(f.breaker.run(good), CircuitOpenError);
  b.finish({ status: 200 }); await second;
});
test('unit: thrown half-open probe reopens and does not leak admission', async () => {
  const f = fixture();
  await f.breaker.run(bad); await f.breaker.run(bad); f.advance(100);
  await assert.rejects(f.breaker.run(async () => { throw new Error('timeout'); }), /timeout/);
  assert.equal(f.breaker.state, 'open');
  await assert.rejects(f.breaker.run(good), CircuitOpenError);
  f.advance(100); await f.breaker.run(good);
  assert.equal(f.breaker.state, 'closed');
});

import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
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
  return { upstream, client };
}
async function get(service: RunningService, path = '/quote') {
  return fetch(`${service.url}${path}`, { signal: AbortSignal.timeout(5000) });
}
async function expectQuote(client: RunningService, status: number, body: unknown) {
  const response = await get(client);
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), body);
  return response;
}
async function waitForState(client: RunningService, state: string) {
  const deadline = performance.now() + 3000;
  do {
    const response = await get(client, '/state');
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'state' in body && body.state === state) return;
    await sleep(10);
  } while (performance.now() < deadline);
  assert.fail(`State ${state} was not observed`);
}
test('integration: open rejects quickly without downstream traffic; successful probe restores service', async t => {
  const { upstream, client } = await setup(t, {}, { COOLDOWN_MS: '1500', TIMEOUT_MS: '3000' });
  await expectQuote(client, 503, { error: 'quote_unavailable' });
  const opening = await expectQuote(client, 503, { error: 'quote_unavailable' });
  assert.equal(opening.headers.get('x-circuit-state'), 'open');
  const started = performance.now();
  for (let i = 0; i < 3; i++) {
    const response = await expectQuote(client, 503, { error: 'circuit_open' });
    assert.equal(response.headers.get('x-circuit-state'), 'open');
  }
  assert.ok(performance.now() - started < 1000, 'rejection should not wait for the 3000ms upstream deadline');
  assert.deepEqual(await (await get(upstream, '/state')).json(), { calls: 2 });
  await sleep(1550);
  const recovered = await expectQuote(client, 200, { priceCents: 125 });
  assert.equal(recovered.headers.get('x-circuit-state'), 'closed');
  await expectQuote(client, 200, { priceCents: 125 });
  assert.deepEqual(await (await get(upstream, '/state')).json(), { calls: 4 });
});
test('integration: slow half-open probe excludes concurrent traffic', async t => {
  const { upstream, client } = await setup(t,
    { FAIL_FIRST: '1', DELAY_MS: '800' },
    { FAILURE_THRESHOLD: '1', COOLDOWN_MS: '100', TIMEOUT_MS: '3000', MAX_PROBES: '1' });
  await expectQuote(client, 503, { error: 'quote_unavailable' });
  await sleep(150);
  // Attach an outcome handler immediately so cleanup cannot leave an unhandled rejection.
  const probe = expectQuote(client, 200, { priceCents: 125 });
  const settled = probe.then(value => ({ value }), (error: unknown) => ({ error }));
  await waitForState(client, 'half-open');
  await expectQuote(client, 503, { error: 'circuit_open' });
  const result = await settled;
  if ('error' in result) throw result.error;
  assert.equal(result.value.headers.get('x-circuit-state'), 'closed');
  assert.deepEqual(await (await get(upstream, '/state')).json(), { calls: 2 });
});
test('integration: timeout counts as failure and next request is rejected before upstream', async t => {
  const { upstream, client } = await setup(t, { FAIL_FIRST: '0', DELAY_MS: '1500' },
    { FAILURE_THRESHOLD: '1', TIMEOUT_MS: '200', COOLDOWN_MS: '10000' });
  await expectQuote(client, 504, { error: 'upstream_timeout' });
  await expectQuote(client, 503, { error: 'circuit_open' });
  assert.deepEqual(await (await get(upstream, '/state')).json(), { calls: 1 });
});
test('integration: persistent failed probe reopens instead of admitting normal traffic', async t => {
  const { upstream, client } = await setup(t, { FAIL_FIRST: '100' },
    { FAILURE_THRESHOLD: '1', COOLDOWN_MS: '1000' });
  await expectQuote(client, 503, { error: 'quote_unavailable' });
  await sleep(1050);
  const probe = await expectQuote(client, 503, { error: 'quote_unavailable' });
  assert.equal(probe.headers.get('x-circuit-state'), 'open');
  await expectQuote(client, 503, { error: 'circuit_open' });
  assert.deepEqual(await (await get(upstream, '/state')).json(), { calls: 2 });
});
