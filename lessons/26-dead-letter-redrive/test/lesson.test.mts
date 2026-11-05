import assert from 'node:assert/strict';
import { test } from 'node:test';

test('unit: quarantine, finite retry/redrive budgets, immutable payload and fenced leases', async () => {
  const module = await import('../store.mts').catch(() => null);
  assert.ok(module, 'durable queue implementation must exist');
  let now = 100;
  const q = new module.Queue(':memory:', () => now, 3, 10);
  try {
    q.admit('bad', { amount: 7, format: 'legacy' });
    q.admit('good', { amount: 3, format: 'current' });
    const a = q.claim(); assert.ok(a);
    assert.equal(q.finish(a.id, a.token!, 'arbitrary'), false);
    assert.equal(q.finish(a.id, a.token!, 'poison'), true);
    assert.equal(q.get('bad').state, 'dead');
    assert.equal(q.redrive('bad', 0), true);
    assert.equal(q.redrive('bad', 0), false);
    const b = q.claim(); assert.ok(b);
    now = 110;
    assert.equal(q.finish(b.id, b.token!, 'ok'), false);
    const c = q.claim(); assert.ok(c); assert.notEqual(c.token, b.token);
    assert.equal(q.finish(c.id, c.token!, 'transient'), true);
    const dead = q.get('bad');
    assert.equal(dead.state, 'dead'); assert.equal(dead.attempts, 3);
    assert.equal(dead.cycleAttempts, 2); assert.equal(dead.reason, 'attempts_exhausted');
    assert.deepEqual(JSON.parse(dead.payload), { amount: 7, format: 'legacy' });
    assert.equal(q.redrive('bad', 1), true);
    const d = q.claim(); assert.ok(d); q.finish(d.id, d.token!, 'poison');
    assert.equal(q.redrive('bad', 2), false);
    const valid = q.claim(); assert.ok(valid); assert.equal(valid.id, 'good');
    assert.equal(q.finish(valid.id, valid.token!, 'ok'), true);
    q.admit('last', { amount: 1, format: 'current' });
    assert.throws(() => q.admit('overflow', { amount: 1, format: 'current' }), /capacity/);
    assert.throws(() => q.admit('invalid', { amount: -1, format: 'current' }), /payload/);
  } finally { q.close(); }
});

test('unit: sink atomically binds operation identity to payload and deduplicates effects', async () => {
  const module = await import('../store.mts').catch(() => null);
  assert.ok(module, 'sink implementation must exist');
  const s = new module.Sink(':memory:');
  try {
    const payload = { amount: 8, format: 'current' };
    assert.equal(s.apply('op', payload), true);
    assert.equal(s.apply('op', payload), false);
    assert.throws(() => s.apply('op', { amount: 9, format: 'current' }), /conflict/);
    assert.equal(s.total(), 8);
  } finally { s.close(); }
});

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import type { TestContext } from 'node:test';

test('unit: all entrypoints import silently despite invalid runtime configuration', () => {
  for (const entry of ['owner.mts', 'consumer.mts', 'sink.mts']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', 'await import(process.argv[1])', new URL(`../${entry}`, import.meta.url).href], {
      encoding: 'utf8', timeout: 2500,
      env: { PORT: 'invalid', HOST: 'invalid', DB_PATH: '/not-accessible/missing/db', OWNER_URL: 'invalid', SINK_URL: 'invalid', CAPACITY: 'invalid', LEASE_MS: 'invalid' },
    });
    assert.equal(child.status, 0, `${entry}: ${child.error?.message ?? child.stderr}`);
    assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  }
});

test('unit: validation, canonical fingerprints, expired final attempt and active redrive protection', async () => {
  const { Queue, Sink } = await import('../store.mts');
  let now = 0;
  const q = new Queue(':memory:', () => now, 5, 10); const s = new Sink(':memory:');
  try {
    for (const value of [{ amount: 0, format: 'current' }, { amount: 1, format: 'unknown' }, { amount: 1, format: 'current', extra: true }, { amount: '1', format: 'current' }, { amount: 1, format: ['current'] }, null]) {
      assert.throws(() => q.admit('valid', value)); assert.throws(() => s.apply('valid', value));
    }
    assert.throws(() => q.admit('bad/id', { amount: 1, format: 'current' }));
    q.admit('x', { amount: 1, format: 'current' });
    assert.throws(() => q.admit('x', { amount: 1, format: 'current' }), /already/);
    const a = q.claim(); assert.ok(a); assert.equal(q.redrive('x', 0), false);
    now = 10; const b = q.claim(); assert.ok(b); assert.equal(b.attempts, 2);
    assert.equal(q.finish('x', a.token!, 'ok'), false);
    now = 20; assert.equal(q.claim(), undefined);
    assert.equal(q.get('x').state, 'dead'); assert.equal(q.get('x').reason, 'attempts_exhausted');
    assert.equal(s.apply('x', { format: 'current', amount: 1 }), true);
    assert.equal(s.apply('x', { amount: 1, format: 'current' }), false);
  } finally { q.close(); s.close(); }
});

function request(service: RunningService, path: string, body?: unknown) {
  return fetch(service.url + path, { signal: AbortSignal.timeout(2000), ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
}
async function data(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  const value: unknown = await response.json();
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
async function setup(t: TestContext, lease = '3000', controls = '1') {
  const dir = await mkdtemp(join(tmpdir(), 'dlq-redrive-'));
  const services: RunningService[] = [];
  t.after(async () => { try { await Promise.all(services.map(s => s.stop())); } finally { await rm(dir, { recursive: true, force: true }); } });
  async function start(entry: string, file: string, env: Record<string, string> = {}) {
    const s = await startService(new URL(`../${entry}.mts`, import.meta.url), { DB_PATH: join(dir, file + '.sqlite'), TEACHING_CONTROLS: controls, ...env }); services.push(s); return s;
  }
  const owner = await start('owner', 'owner', { LEASE_MS: lease });
  const sink = await start('sink', 'sink');
  const consumer = await start('consumer', 'consumer', { OWNER_URL: owner.url, SINK_URL: sink.url });
  assert.equal(new Set([owner.child.pid, sink.child.pid, consumer.child.pid]).size, 3);
  const admit = (id: string, format: string, amount = 7) => request(owner, '/messages', { id, payload: { amount, format } }).then(r => data(r, 202));
  const step = () => request(consumer, '/step', {}).then(r => data(r));
  const inspect = (id: string) => request(owner, '/messages/' + id).then(r => data(r));
  return { owner, sink, consumer, start, admit, step, inspect };
}

test('integration: non-string completion outcomes cannot consume an active claim', async t => {
  const f = await setup(t);
  await f.admit('strict-outcome', 'current');
  const claim = await data(await request(f.owner, '/claim', {}));
  assert.ok(claim.message !== null && typeof claim.message === 'object');
  const message = Object.fromEntries(Object.entries(claim.message));
  assert.equal(typeof message.token, 'string');
  for (const outcome of [['ok'], ['poison'], ['transient']]) {
    await data(await request(f.owner, '/finish', {
      id: 'strict-outcome', token: message.token, outcome,
    }), 400);
    assert.equal((await f.inspect('strict-outcome')).state, 'running');
  }
  await data(await request(f.owner, '/finish', {
    id: 'strict-outcome', token: message.token, outcome: 'ok',
  }));
  assert.equal((await f.inspect('strict-outcome')).state, 'done');
});

test('integration: poison isolation, inspection, restart, conditional redrive and explicit durable handler fix', async t => {
  const f = await setup(t);
  const original = await f.admit('legacy-invoice', 'legacy');
  await f.admit('current-invoice', 'current', 3);
  assert.equal((await f.step()).state, 'dead');
  assert.equal((await f.step()).state, 'done');
  const dead = await f.inspect('legacy-invoice');
  assert.equal(dead.reason, 'unsupported_format'); assert.equal(dead.attempts, 1);
  const dlq = await data(await request(f.owner, '/dead'));
  assert.ok(Array.isArray(dlq.messages)); assert.equal(dlq.messages.length, 1);
  const redrive = { id: 'legacy-invoice', expectedRedrives: 0 };
  const replies = await Promise.all([request(f.owner, '/redrive', redrive), request(f.owner, '/redrive', redrive)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.step()).state, 'dead'); // Redrive alone does not repair the handler.
  await data(await request(f.owner, '/redrive', redrive), 409);
  await data(await request(f.consumer, '/teaching/fix', {}));
  await data(await request(f.owner, '/redrive', { id: 'legacy-invoice', expectedRedrives: 1 }));
  assert.equal((await f.step()).state, 'done');
  const done = await f.inspect('legacy-invoice');
  assert.equal(done.id, original.id); assert.equal(done.payload, original.payload);
  assert.equal(done.attempts, 3); assert.equal(done.redrives, 2);
  assert.equal((await data(await request(f.sink, '/total'))).total, 10);
  await f.owner.stop(); await f.sink.stop(); await f.consumer.stop();
  const owner = await f.start('owner', 'owner'); const sink = await f.start('sink', 'sink');
  assert.deepEqual(await data(await request(owner, '/messages/legacy-invoice')), done);
  assert.equal((await data(await request(sink, '/total'))).total, 10);
  const consumer = await f.start('consumer', 'consumer', { OWNER_URL: owner.url, SINK_URL: sink.url });
  await data(await request(owner, '/messages', { id: 'after-restart', payload: { amount: 2, format: 'legacy' } }), 202);
  assert.equal((await data(await request(consumer, '/step', {}))).state, 'done'); // Fix persisted in consumer-owned DB.
});

test('integration: transient budget persists in DLQ; valid failure fixtures, limits and controls disabled', async t => {
  const f = await setup(t, '3000', '0');
  await f.admit('retryable', 'transient');
  assert.equal((await f.step()).state, 'queued'); assert.equal((await f.step()).state, 'dead');
  const exhausted = await f.inspect('retryable');
  assert.equal(exhausted.reason, 'attempts_exhausted'); assert.equal(exhausted.attempts, 2);
  await f.owner.stop(); await f.consumer.stop();
  const owner = await f.start('owner', 'owner');
  assert.deepEqual(await data(await request(owner, '/messages/retryable')), exhausted);
  await data(await request(f.sink, '/teaching/lose-next', {}), 404);
  const consumer = await f.start('consumer', 'consumer', { OWNER_URL: owner.url, SINK_URL: f.sink.url });
  await data(await request(consumer, '/teaching/fix', {}), 404);
  await data(await request(owner, '/finish', { id: 'retryable', token: 'valid-stale-token', outcome: 'ok' }), 409);
  await data(await request(owner, '/redrive', { id: 'retryable', expectedRedrives: 0 }));
  await data(await request(owner, '/redrive', { id: 'retryable', expectedRedrives: 0 }), 409);
  await data(await request(owner, '/messages', { id: 'invalid-payload', payload: { amount: 1, format: 'unknown' } }), 400);
  await data(await request(owner, '/messages', { id: 'retryable', payload: { amount: 1, format: 'current' } }), 409);
  await data(await request(consumer, '/step', { batch: 100 }), 400);
  const limited = await f.start('owner', 'limited', { CAPACITY: '1' });
  await data(await request(limited, '/messages', { id: 'one', payload: { amount: 1, format: 'current' } }), 202);
  await data(await request(limited, '/messages', { id: 'two', payload: { amount: 1, format: 'current' } }), 429);
  const huge = await request(limited, '/messages', { id: 'oversized', payload: { amount: 1, format: 'current' }, padding: 'x'.repeat(9000) });
  await data(huge, 413);
});

test('integration: lost sink response and duplicate delivery cannot double-apply; payload conflict survives restart', async t => {
  const f = await setup(t);
  await f.admit('transfer', 'current', 11);
  await data(await request(f.sink, '/teaching/lose-next', {}));
  assert.equal((await f.step()).state, 'queued');
  assert.equal((await data(await request(f.sink, '/total'))).total, 11);
  await f.sink.stop();
  const sink = await f.start('sink', 'sink');
  await f.consumer.stop();
  const consumer = await f.start('consumer', 'consumer', { OWNER_URL: f.owner.url, SINK_URL: sink.url });
  assert.equal((await data(await request(consumer, '/step', {}))).state, 'done');
  const duplicate = { id: 'transfer', payload: { amount: 11, format: 'current' } };
  const duplicates = await Promise.all([request(sink, '/apply', duplicate), request(sink, '/apply', duplicate)]);
  for (const r of duplicates) assert.equal((await data(r)).applied, false);
  await data(await request(sink, '/apply', { id: 'transfer', payload: { amount: 12, format: 'current' } }), 409);
  assert.equal((await data(await request(sink, '/total'))).total, 11);
});

test('integration: lease expiry fences stale completion and redrive cannot reset active work', async t => {
  const f = await setup(t, '500');
  await f.admit('leased', 'current');
  const first = await data(await request(f.owner, '/claim', {}));
  assert.ok(first.message && typeof first.message === 'object' && 'token' in first.message);
  const oldToken = first.message.token;
  await data(await request(f.owner, '/redrive', { id: 'leased', expectedRedrives: 0 }), 409);
  // Deterministic observation barrier: each iteration observes owner state; bounded by a deadline.
  let replacement: Record<string, unknown> | undefined;
  const deadline = performance.now() + 2000;
  while (!replacement) {
    const reply = await data(await request(f.owner, '/claim', {}));
    if (reply.message && typeof reply.message === 'object') replacement = Object.fromEntries(Object.entries(reply.message));
    else { assert.ok(performance.now() < deadline); await new Promise<void>(r => setTimeout(r, 10)); }
  }
  assert.notEqual(replacement.token, oldToken); assert.equal(replacement.id, 'leased');
  await data(await request(f.owner, '/finish', { id: 'leased', token: oldToken, outcome: 'ok' }), 409);
  await data(await request(f.sink, '/apply', { id: 'leased', payload: { amount: 7, format: 'current' } }));
  await data(await request(f.owner, '/finish', { id: 'leased', token: replacement.token, outcome: 'ok' }));
  assert.equal((await f.inspect('leased')).attempts, 2);
});
