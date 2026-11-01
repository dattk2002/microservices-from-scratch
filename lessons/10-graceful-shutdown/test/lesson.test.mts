import assert from 'node:assert/strict';
import test from 'node:test';
import { Lifecycle } from '../lifecycle.mts';

test('unit: draining rejects admissions but preserves accepted work until completion', () => {
  const lifecycle = new Lifecycle();
  assert.equal(lifecycle.ready, true);
  const finish = lifecycle.admit();
  assert.ok(finish);
  assert.equal(lifecycle.active, 1);
  lifecycle.drain();
  assert.equal(lifecycle.ready, false);
  assert.equal(lifecycle.state, 'draining');
  assert.equal(lifecycle.admit(), undefined);
  assert.equal(lifecycle.active, 1);
  assert.equal(lifecycle.stop(), false);
  finish();
  finish();
  assert.equal(lifecycle.active, 0, 'release is idempotent');
  assert.equal(lifecycle.stop(), true);
  assert.equal(lifecycle.state, 'stopped');
  assert.equal(lifecycle.admit(), undefined);
});

test('unit: duplicate drain and forced stop never reopen admission', () => {
  const lifecycle = new Lifecycle();
  assert.equal(lifecycle.stop(), false, 'must drain before graceful stop');
  const finish = lifecycle.admit();
  assert.ok(finish);
  lifecycle.drain();
  lifecycle.drain();
  assert.equal(lifecycle.active, 1);
  assert.equal(lifecycle.stop(true), true);
  lifecycle.drain();
  assert.equal(lifecycle.state, 'stopped');
  finish();
  assert.equal(lifecycle.active, 0);
  assert.equal(lifecycle.ready, false);
});

import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

async function setup(t: TestContext, env: Record<string, string> = {}) {
  const service = await startService(new URL('../service.mts', import.meta.url), env);
  t.after(() => service.stop());
  return service;
}
function get(service: RunningService, path: string) {
  return fetch(`${service.url}${path}`, { signal: AbortSignal.timeout(5000) });
}
async function waitForDraining(service: RunningService) {
  const until = performance.now() + 2000;
  while (performance.now() < until) {
    const response = await get(service, '/ready');
    const body: unknown = await response.json();
    if (response.status === 503) {
      assert.deepEqual(body, { ready: false, state: 'draining', active: 1 });
      return;
    }
    await delay(10);
  }
  assert.fail('readiness did not become false');
}
async function signalAndWait(service: RunningService, check: () => Promise<void>) {
  // Register before signalling; cleanup SIGKILL must not masquerade as successful exit.
  const exited = once(service.child, 'exit', { signal: AbortSignal.timeout(6000) });
  void exited.catch(() => {});
  assert.equal(service.child.kill('SIGTERM'), true);
  await check();
  return exited;
}

test('integration: SIGTERM drains admitted work, rejects new work and exits normally', { timeout: 10000 }, async t => {
  const service = await setup(t, { WORK_MS: '1500', DRAIN_MS: '300', SHUTDOWN_MS: '4000' });
  const ready = await get(service, '/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { ready: true, state: 'ready', active: 0 });
  const admitted = await get(service, '/work');
  assert.equal(admitted.status, 200); // flushHeaders synchronizes admission, no arbitrary startup sleep.
  const body = admitted.json();
  void body.catch(() => {});
  const exit = await signalAndWait(service, async () => {
    await waitForDraining(service);
    const live = await get(service, '/live');
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { live: true });
    const rejected = await get(service, '/work');
    assert.equal(rejected.status, 503);
    assert.equal(rejected.headers.get('retry-after'), '1');
    assert.deepEqual(await rejected.json(), { error: 'draining' });
    service.child.kill('SIGTERM'); // repeated signals do not shorten the deadline or kill accepted work.
    assert.deepEqual(await body, { result: 'completed' });
  });
  assert.deepEqual(exit, [0, null]);
});

test('integration: deadline aborts unfinished response and exits with failure', { timeout: 10000 }, async t => {
  const service = await setup(t, { WORK_MS: '10000', DRAIN_MS: '100', SHUTDOWN_MS: '600' });
  const admitted = await get(service, '/work');
  assert.equal(admitted.status, 200);
  const interrupted = assert.rejects(admitted.text());
  const started = performance.now();
  const exit = await signalAndWait(service, async () => { await interrupted; });
  assert.deepEqual(exit, [1, null]);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 450 && elapsed < 3000, `bounded deadline took ${elapsed}ms`);
});

test('integration: idle SIGTERM exits after propagation window without waiting for deadline', { timeout: 10000 }, async t => {
  const service = await setup(t, { DRAIN_MS: '200', SHUTDOWN_MS: '4000' });
  const started = performance.now();
  const exit = await signalAndWait(service, async () => {});
  assert.deepEqual(exit, [0, null]);
  assert.ok(performance.now() - started < 2500);
});

test('integration: method and route contracts are explicit', { timeout: 10000 }, async t => {
  const service = await setup(t);
  const missing = await get(service, '/missing');
  assert.equal(missing.status, 404);
  await missing.arrayBuffer();
  const wrongMethod = await fetch(`${service.url}/work`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  await wrongMethod.arrayBuffer();
});
