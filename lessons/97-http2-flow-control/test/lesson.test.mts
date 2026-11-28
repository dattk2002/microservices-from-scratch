import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { request } from 'node:http';
import { constants, createServer } from 'node:http2';
import type { ClientHttp2Session } from 'node:http2';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';
import { DIGEST, LENGTH, gate, h2Body, listenFixture, open, peer, pull, sourceFixture } from './fixtures.mts';
import { pump } from '../pump.mts';
import { TRANSFER_MS, deadline, timeout } from '../protocol.mts';

test('unit: fixture cleanup prevents a pending bind from becoming a listener', async () => {
  const startup = new AbortController();
  const cleanups: Array<() => void | Promise<void>> = [];
  let finishBind = () => {};
  const events = new EventEmitter();
  const server = Object.assign(events, {
    listening: false,
    listen({ signal }: { signal?: AbortSignal }) {
      assert.equal(cleanups.length, 1, 'cleanup must be registered before listen');
      finishBind = () => {
        if (signal?.aborted) return;
        this.listening = true;
        events.emit('listening');
      };
    },
  });
  const ready = listenFixture(server, (cleanup) => cleanups.push(cleanup), startup.signal);
  const rejected = assert.rejects(ready, { name: 'AbortError' });
  startup.abort();
  await rejected;
  for (const cleanup of cleanups) await cleanup();
  finishBind();
  assert.equal(server.listening, false);
});

test('unit: the transfer elapsed guard expires at exactly 2000 ms', (t) => {
  let now = 100;
  t.mock.method(performance, 'now', () => now);
  const operation = deadline(TRANSFER_MS);
  try {
    now = 2099;
    operation.check();
    now = 2100;
    assert.throws(() => operation.check(), (error) => error === timeout);
  } finally {
    operation.dispose();
  }
});

function source() {
  let reads = 0;
  return {
    get reads() { return reads; },
    *[Symbol.iterator]() {
      reads++;
      yield Buffer.from('ab');
      reads++;
      yield Buffer.from('cd');
    },
  };
}

test('unit: false write blocks the next read and one drain resumes the pump', async () => {
  const input = source();
  const writes: string[] = [];
  const drain = gate();
  const waiting = gate();
  const done = pump(input, (chunk) => {
    writes.push(chunk.toString());
    return writes.length > 1;
  }, () => {
    waiting.resolve();
    return drain.promise;
  }, 4, new AbortController().signal);
  await Promise.race([waiting.promise, done]);
  assert.deepEqual(writes, ['ab']);
  assert.equal(input.reads, 1);
  drain.resolve();
  assert.equal(await done, 4);
  assert.deepEqual(writes, ['ab', 'cd']);
});

test('unit: cancellation interrupts a pending drain without consuming more input', async () => {
  const input = source();
  const controller = new AbortController();
  const waiting = gate();
  const drain = gate();
  const done = pump(input, () => false, () => {
    waiting.resolve();
    return drain.promise;
  }, 4, controller.signal);
  await Promise.race([waiting.promise, done]);
  controller.abort(new Error('caller disconnected'));
  await assert.rejects(done, /caller disconnected/);
  drain.resolve();
  assert.equal(input.reads, 1);
});

test('unit: a chunk crossing the exact byte cap never reaches the writer', async () => {
  const writes: string[] = [];
  await assert.rejects(pump(source(), (chunk) => {
    writes.push(chunk.toString());
    return true;
  }, async () => {}, 3, new AbortController().signal), /byte limit/);
  assert.deepEqual(writes, ['ab']);
});

test('integration: cancelling fixture startup leaves no loopback listener', async (t) => {
  const server = createServer();
  const startup = new AbortController();
  let listened = false;
  server.once('listening', () => { listened = true; });
  const ready = listenFixture(server, (cleanup) => t.after(cleanup), startup.signal);
  const rejected = assert.rejects(ready, { name: 'AbortError' });
  startup.abort();
  await rejected;
  await nextTurn();
  assert.equal(listened, false);
  assert.equal(server.address(), null);
});

async function gateway(t: TestContext, providerOrigin: string) {
  const service = await startService(new URL('../gateway.mts', import.meta.url), { PROVIDER_ORIGIN: providerOrigin });
  t.after(service.stop);
  return service.url;
}

async function provider(t: TestContext) {
  const service = await startService(new URL('../provider.mts', import.meta.url));
  t.after(service.stop);
  return service.url;
}

function digest(body: Buffer) {
  return createHash('sha256').update(body).digest('hex');
}

function decode(body: Buffer): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
}

async function providerStats(session: ClientHttp2Session) {
  const result = await h2Body(open(session, '/stats'));
  assert.equal(result.status, 200);
  const value = decode(result.body);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['active', 'backpressureWaits', 'blocked', 'generatedBytes', 'sessions']);
  assert.ok('active' in value && typeof value.active === 'number');
  assert.ok('sessions' in value && typeof value.sessions === 'number');
  assert.ok('backpressureWaits' in value && typeof value.backpressureWaits === 'number');
  assert.ok('blocked' in value && typeof value.blocked === 'number');
  assert.ok('generatedBytes' in value && typeof value.generatedBytes === 'number');
  return { active: value.active, sessions: value.sessions, blocked: value.blocked, generatedBytes: value.generatedBytes };
}

async function until<T>(read: () => T | Promise<T>, ready: (value: T) => boolean, milliseconds = 1000) {
  const end = performance.now() + milliseconds;
  do {
    const value = await read();
    if (ready(value)) return value;
    await delay(10);
  } while (performance.now() < end);
  throw new Error('condition did not become true before deadline');
}

async function stableBlocked(session: ClientHttp2Session, expected: number) {
  let previous = 0;
  let stable = 0;
  return until(() => providerStats(session), (value) => {
    stable = value.blocked === expected && value.generatedBytes === previous ? stable + 1 : 0;
    previous = value.generatedBytes;
    return stable >= 3;
  });
}

test('integration: separate processes deliver the documented bytes and digest', async (t) => {
  const source = await provider(t);
  const origin = await gateway(t, source);
  const result = await pull(t, origin).done;
  assert.equal(result.status, 200);
  assert.equal(result.complete, true);
  assert.equal(result.body.length, LENGTH);
  assert.equal(digest(result.body), DIGEST);
});

test('integration: measured h2 backpressure stalls one stream while its sibling completes', async (t) => {
  const origin = await provider(t);
  const session = peer(t, origin);
  const paused = open(session, '/blob');
  paused.pause();
  const blocked = await stableBlocked(session, 1);
  assert.ok(blocked.generatedBytes > 0 && blocked.generatedBytes < LENGTH);
  const sibling = await h2Body(open(session, '/blob'), LENGTH);
  assert.equal(sibling.status, 200);
  assert.equal(sibling.body.length, LENGTH);
  assert.equal(digest(sibling.body), DIGEST);
  const afterSibling = await until(() => providerStats(session), (value) => value.active === 1);
  assert.equal(afterSibling.active, 1);
  assert.equal(afterSibling.blocked, 1);
  assert.equal(afterSibling.generatedBytes, blocked.generatedBytes + LENGTH);
  // The response event has already fired. Consume the existing readable body.
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of paused) {
    assert.ok(Buffer.isBuffer(chunk));
    bytes += chunk.length;
    assert.ok(bytes <= LENGTH);
    chunks.push(chunk);
  }
  assert.equal(bytes, LENGTH);
  assert.equal(digest(Buffer.concat(chunks)), DIGEST);
});

test('integration: provider caps sessions and streams without generating bytes for rejections', async (t) => {
  const origin = await provider(t);
  const first = peer(t, origin);
  const second = peer(t, origin);
  const third = peer(t, origin, 4096);
  const extra = Array.from({ length: 5 }, () => peer(t, origin));
  await Promise.all([first, second, third, ...extra].map((session) =>
    once(session, 'remoteSettings', { signal: AbortSignal.timeout(1000) })));
  assert.equal((await providerStats(third)).sessions, 8);
  const ninth = peer(t, origin);
  open(ninth, '/blob');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ninth session stayed open')), 300);
    ninth.once('close', () => { clearTimeout(timer); resolve(); });
  });

  assert.equal((await providerStats(third)).generatedBytes, 0);

  const hold = (session: ClientHttp2Session) => Array.from({ length: 4 }, () => {
    const stream = open(session, '/blob');
    stream.pause();
    return stream;
  });
  const firstStreams = hold(first);
  const firstBlocked = await stableBlocked(third, 4);
  const localBusy = await h2Body(open(first, '/blob'));
  assert.equal(localBusy.status, 503);
  assert.deepEqual(decode(localBusy.body), { error: { code: 'busy', message: 'busy' } });
  assert.equal((await providerStats(third)).generatedBytes, firstBlocked.generatedBytes);

  const secondStreams = hold(second);
  const allBlocked = await stableBlocked(third, 8);
  assert.equal(allBlocked.active, 8);
  const globalBusy = await h2Body(open(third, '/blob'));
  assert.equal(globalBusy.status, 503);
  assert.deepEqual(decode(globalBusy.body), { error: { code: 'busy', message: 'busy' } });
  assert.equal((await providerStats(third)).generatedBytes, allBlocked.generatedBytes);
  for (const stream of [...firstStreams, ...secondStreams]) stream.close(constants.NGHTTP2_CANCEL);
  await until(() => providerStats(third), (value) => value.active === 0);
  assert.equal(digest((await h2Body(open(third, '/blob'), LENGTH)).body), DIGEST);
});

test('integration: a disconnected HTTP/1 caller cancels provider work and releases a gateway slot', async (t) => {
  const fixture = await sourceFixture(t);
  fixture.use('no-head');
  const origin = await gateway(t, fixture.origin);
  const caller = request(origin + '/blob', { agent: false, signal: AbortSignal.timeout(3500) });
  t.after(() => caller.destroy());
  caller.on('error', () => {});
  caller.end();
  await until(() => fixture.active, (value) => value === 1);
  caller.destroy();
  await until(() => fixture.active, (value) => value === 0);
  await until(async () => decode((await pull(t, origin, '/stats').done).body),
    (value) => value !== null && typeof value === 'object' && 'active' in value && value.active === 0);
  fixture.use('valid');
  assert.equal(digest((await pull(t, origin).done).body), DIGEST);
});

test('integration: gateway admits at most eight dependencies and health stays independent', async (t) => {
  const fixture = await sourceFixture(t);
  fixture.use('no-head');
  const origin = await gateway(t, fixture.origin);
  const inflight = Array.from({ length: 8 }, () => pull(t, origin).done);
  await until(() => fixture.active, (value) => value === 8);
  const excess = await pull(t, origin).done;
  assert.equal(excess.status, 503);
  assert.deepEqual(decode(excess.body), { error: { code: 'busy', message: 'busy' } });
  assert.equal(fixture.requests, 8);
  assert.equal((await pull(t, origin, '/health').done).status, 200);
  for (const result of await Promise.all(inflight)) {
    assert.equal(result.status, 504);
    assert.deepEqual(decode(result.body), { error: { code: 'upstream_timeout', message: 'upstream_timeout' } });
  }
  fixture.use('valid');
  assert.equal(digest((await pull(t, origin).done).body), DIGEST);
});

test('integration: bad completion signals never produce a full HTTP/1 body', async (t) => {
  const fixture = await sourceFixture(t);
  const origin = await gateway(t, fixture.origin);
  for (const mode of ['truncate', 'oversized'] as const) {
    fixture.use(mode);
    const result = await pull(t, origin).done;
    if (result.status === 200) {
      assert.equal(result.complete, false, mode);
      assert.ok(result.body.length < LENGTH, mode);
    } else {
      assert.equal(result.status, 502, mode);
      assert.deepEqual(decode(result.body), { error: { code: 'upstream_failure', message: 'upstream_failure' } });
    }
  }

  for (const mode of ['missing', 'wrong', 'duplicate'] as const) {
    fixture.use(mode);
    const result = await pull(t, origin).done;
    assert.equal(result.status, 200, mode);
    assert.equal(result.complete, false, mode);
    assert.equal(result.body.length, LENGTH - 1, mode);
  }

  for (const mode of ['reset', 'no-error-reset'] as const) {
    fixture.use(mode);
    const pending = pull(t, origin);
    await pending.prefix();
    await until(() => fixture.canReset, Boolean);
    const resetAt = performance.now();
    fixture.reset();
    const result = await pending.done;
    assert.equal(result.status, 200, mode);
    assert.equal(result.complete, false, mode);
    assert.equal(result.body.length, LENGTH - 1, mode);
    assert.ok(performance.now() - resetAt < 1000, mode);
  }

  fixture.use('stall');
  const started = performance.now();
  const pending = pull(t, origin);
  await pending.prefix();
  const result = await pending.done;
  const elapsed = performance.now() - started;
  assert.equal(result.status, 200);
  assert.equal(result.complete, false);
  assert.equal(result.body.length, LENGTH - 1);
  assert.ok(elapsed >= 1800 && elapsed < 2400, `elapsed: ${elapsed}ms`);

  fixture.use('valid');
  const recovered = await pull(t, origin).done;
  assert.equal(recovered.complete, true);
  assert.equal(recovered.body.length, LENGTH);
  assert.equal(digest(recovered.body), DIGEST);
});

test('integration: metadata cannot substitute for a trailer and redirects cannot reach another origin', async (t) => {
  const fixture = await sourceFixture(t);
  const destination = await sourceFixture(t);
  const origin = await gateway(t, fixture.origin);
  for (const mode of ['initial-only', 'redirect', 'misdirected', 'coding'] as const) {
    const before = fixture.requests;
    fixture.use(mode, destination.origin);
    const result = await pull(t, origin).done;
    assert.equal(destination.requests, 0, mode);
    assert.equal(fixture.requests, before + 1, mode);
    assert.equal(result.status, 502, mode);
    assert.deepEqual(decode(result.body), { error: { code: 'upstream_failure', message: 'upstream_failure' } });
  }
});

test('integration: gateway local HTTP/1 routes reject methods, queries, bodies and duplicate metadata', async (t) => {
  const fixture = await sourceFixture(t);
  const origin = await gateway(t, fixture.origin);
  const cases = [
    { path: '/health?x=1', status: 400, code: 'invalid_request' },
    { path: '/missing', status: 404, code: 'not_found' },
    { path: '/health', method: 'POST', status: 405, code: 'method_not_allowed' },
    { path: '/health', headers: ['Host', new URL(origin).host, 'Content-Length', '4'], status: 400, code: 'invalid_request' },
    { path: '/health', headers: ['Host', new URL(origin).host, 'Content-Type', 'text/plain', 'Content-Type', 'application/json'], status: 400, code: 'invalid_request' },
  ];
  for (const { path, status, code, ...options } of cases) {
    const result = await pull(t, origin, path, options).done;
    assert.equal(result.status, status);
    assert.deepEqual(decode(result.body), { error: { code, message: code } });
    if (status === 405) assert.equal(result.allow, 'GET');
  }
  assert.equal(fixture.requests, 0);
});
