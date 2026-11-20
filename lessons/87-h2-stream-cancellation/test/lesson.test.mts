import assert from 'node:assert/strict';
import { connectWorker } from '../client.mts';
import { FastEnd } from '../fast-end.mts';
import { Socket } from 'node:net';
import { boundSessionDrain } from '../worker.mts';
import { deferred } from '../deferred.mts';
import { execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { promisify } from 'node:util';
import { startService } from '../../../test/support.mts';
import { readRequest, readResponse, sendHeaders, workerOrigin } from '../protocol.mts';
import { assertH2, h2Client, h2Request, http1, sendOnlyTrailers, smallHeaders, startFinDelayingProxy, startFixture } from './peers.mts';
import type { Mode } from './peers.mts';
import { constants } from 'node:http2';
import { setImmediate as nextTurn, setTimeout as pause } from 'node:timers/promises';
import { test } from 'node:test';
import { createDemoRunner } from '../demo.mts';
import type { DemoSession, StreamEvents } from '../demo.mts';

const { NGHTTP2_CANCEL, NGHTTP2_NO_ERROR, NGHTTP2_REFUSED_STREAM } = constants;
const okHeaders = [':status', '200', 'content-type', 'application/json; charset=utf-8'];
const upstreamFailure = { status: 502, code: 'upstream_failure' };

test('unit: only a complete DATA or HEADERS frame ending the registered fast stream proves EOF', () => {
  for (const frameType of [0, 1]) {
    const fast = new FastEnd();
    fast.track(3);
    // An unrelated stream ends. The following DATA contains a frame-shaped payload.
    fast.observe(Buffer.from('000000000100000001000009000000000003000000000100000003', 'hex'));
    assert.equal(fast.ended, false);
    const frame = Buffer.from([0, 0, 2, frameType, 1, 0, 0, 0, 3, 97, 98]);
    for (const byte of frame.subarray(0, -1)) {
      fast.observe(Buffer.from([byte]));
      assert.equal(fast.ended, false);
    }
    fast.observe(frame.subarray(-1));
    assert.equal(fast.ended, true);
  }
});

test('unit: a reset seals fast without proof of EOF, including when later bytes share the read', () => {
  const fast = new FastEnd();
  fast.track(3);
  fast.observe(Buffer.from('00000403000000000300000000000000000100000003', 'hex'));
  assert.equal(fast.ended, false);
});

test('unit: GOAWAY bounds physical socket drain even if the session closes first', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = new EventEmitter();
  const socket = new Socket();
  t.after(() => socket.destroy());
  boundSessionDrain(session, socket);
  t.mock.timers.tick(2000);
  assert.equal(socket.destroyed, false);
  session.emit('goaway');
  session.emit('close');
  t.mock.timers.tick(999);
  assert.equal(socket.destroyed, false);
  session.emit('goaway');
  t.mock.timers.tick(1);
  assert.equal(socket.destroyed, true);
});

class FakeStream {
  readonly events: StreamEvents;
  readonly resets: number[] = [];
  closed = false;

  constructor(events: StreamEvents) {
    this.events = events;
  }

  close(code: number) {
    this.resets.push(code);
    this.closed = true;
  }

  peerClose(code: number) {
    this.closed = true;
    this.events.close(code);
  }

  completeFast() {
    this.events.headers(okHeaders, false);
    this.events.data(Buffer.from('{"value":"ok"}'));
    this.events.end();
    this.peerClose(NGHTTP2_NO_ERROR);
  }
}

class FakeSession implements DemoSession {
  readonly paths: string[] = [];
  readonly streams = new Map<string, FakeStream>();
  readonly lifetime = deferred<void>();
  readonly closed = this.lifetime.promise;
  destroyed = false;
  deferClose = false;

  open(path: '/slow' | '/fast', events: StreamEvents) {
    this.paths.push(path);
    const stream = new FakeStream(events);
    this.streams.set(path, stream);
    return stream;
  }

  stream(path: string) {
    const stream = this.streams.get(path);
    assert.ok(stream, `expected an open ${path} stream`);
    return stream;
  }

  destroy() {
    this.destroyed = true;
    if (!this.deferClose) this.lifetime.resolve();
  }
}

function harness(now?: () => number) {
  const sessions: FakeSession[] = [];
  const run = createDemoRunner(() => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  }, now);
  return { sessions, run };
}

test('unit: closes only slow with CANCEL and waits for both slow close and fast EOF', async () => {
  const { sessions, run } = harness();
  let done = false;
  const result = run(new AbortController().signal);
  void result.then(() => { done = true; }, () => {});
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.ok(session);
  assert.deepEqual(session.paths, ['/slow']);
  const slow = session.stream('/slow');
  slow.events.headers(okHeaders, false);
  await nextTurn();

  assert.deepEqual(session.paths, ['/slow', '/fast']);
  const fast = session.stream('/fast');
  assert.deepEqual(slow.resets, [NGHTTP2_CANCEL]);
  assert.deepEqual(fast.resets, []);
  assert.equal(fast.closed, false);
  assert.equal(session.destroyed, false);
  fast.completeFast();
  await nextTurn();
  assert.equal(done, false);
  slow.peerClose(NGHTTP2_CANCEL);
  assert.deepEqual(await result, { fast: 'ok', cancelled: true });
  assert.equal(session.destroyed, true);
});

test('unit: a normal slow close is not local cancellation', async () => {
  const { sessions, run } = harness();
  const result = assert.rejects(run(new AbortController().signal), upstreamFailure);
  const [session] = sessions;
  assert.ok(session);
  const slow = session.stream('/slow');
  slow.events.headers(okHeaders, false);
  slow.events.end();
  slow.peerClose(NGHTTP2_NO_ERROR);
  await result;
  assert.deepEqual(slow.resets, []);
  assert.deepEqual(session.paths, ['/slow']);
});

test('unit: a fast reset cannot become success even when slow closes with CANCEL', async () => {
  const { sessions, run } = harness();
  const result = assert.rejects(run(new AbortController().signal), upstreamFailure);
  const [session] = sessions;
  assert.ok(session);
  const slow = session.stream('/slow');
  slow.events.headers(okHeaders, false);
  await nextTurn();
  slow.peerClose(NGHTTP2_CANCEL);
  session.stream('/fast').peerClose(NGHTTP2_REFUSED_STREAM);
  await result;
  assert.equal(session.destroyed, true);
});

test('unit: completion at the deadline fails even if the timeout callback has not run', async () => {
  let time = 100;
  const { sessions, run } = harness(() => time);
  const result = assert.rejects(run(new AbortController().signal), upstreamFailure);
  const [session] = sessions;
  assert.ok(session);
  const slow = session.stream('/slow');
  slow.events.headers(okHeaders, false);
  await nextTurn();
  slow.peerClose(NGHTTP2_CANCEL);
  time = 600;
  session.stream('/fast').completeFast();
  await result;
  assert.equal(session.destroyed, true);
});

test('unit: busy admission holds a permit until the aborted session has closed', async () => {
  const { sessions, run } = harness();
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const results = controllers.map(({ signal }) => assert.rejects(run(signal), upstreamFailure));
  try {
    assert.equal(sessions.length, 4);
    const [first] = sessions;
    assert.ok(first);
    first.deferClose = true;
    await assert.rejects(run(new AbortController().signal), { status: 503, code: 'busy' });
    controllers[0]?.abort();
    await results[0];
    assert.equal(first.destroyed, true);
    await assert.rejects(run(new AbortController().signal), { status: 503, code: 'busy' });
    first.lifetime.resolve();
    await nextTurn();

    const another = new AbortController();
    const attempted = assert.rejects(run(another.signal), upstreamFailure);
    another.abort();
    await attempted;
    assert.equal(sessions.length, 5);
  } finally {
    for (const session of sessions) session.lifetime.resolve();
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(results);
  }
});

for (const [name, interrupt] of [
  ['END_STREAM headers', (stream: FakeStream) => stream.events.headers(okHeaders, true)],
  ['DATA before reset', (stream: FakeStream) => {
    stream.events.headers(okHeaders, false);
    stream.events.data(Buffer.from('unexpected'));
  }],
  ['trailers before reset', (stream: FakeStream) => {
    stream.events.headers(okHeaders, false);
    stream.events.extraHeaders();
  }],
] as const) {
  test(`unit: rejects slow ${name} without recording cancellation`, async () => {
    const { sessions, run } = harness();
    const result = assert.rejects(run(new AbortController().signal), upstreamFailure);
    const [session] = sessions;
    assert.ok(session);
    const slow = session.stream('/slow');
    interrupt(slow);
    await result;
    assert.deepEqual(slow.resets, []);
    assert.deepEqual(session.paths, ['/slow']);
  });
}

test('unit: accepts a single UTF-8 parameter and rejects ambiguous representations', () => {
  assert.equal(readResponse([':status', '200', 'content-type', 'Application/JSON ; charset = "UTF-8"']), undefined);
  for (const invalid of [
    ['content-type', 'application/json;'],
    ['content-type', 'application/json; charset="utf-8'],
    ['content-type', 'application/json; charset=utf-8; charset=utf-8'],
    ['content-type', 'application/json, application/json'],
    ['content-type', 'application/json', 'content-encoding', 'identity, identity'],
    ['content-type', 'application/json', 'content-encoding', 'gzip'],
    ['content-type', 'application/json', 'content-length', '8193'],
  ]) {
    assert.throws(() => readResponse([':status', '200', ...invalid]), upstreamFailure);
  }
});

test('unit: validates late raw duplicates and the UTF-8 size of full header lists', () => {
  const raw = [...okHeaders, ...Object.entries(smallHeaders()).flat()];
  assert.equal(readResponse(raw), undefined);
  assert.throws(() => readResponse([...raw, 'content-type', 'application/json']), { code: 'invalid_headers' });
  // 33 bytes of overhead for x, two bytes per é, and 42 bytes for :status.
  assert.doesNotThrow(() => sendHeaders({ ':status': '200', x: 'é'.repeat(4058) }, 'response'));
  assert.throws(() => sendHeaders({ ':status': '200', x: 'é'.repeat(4060) }, 'response'), { code: 'headers_too_large' });
});

test('unit: rejects invalid pseudo-fields and non-loopback worker origins', () => {
  const request = [':method', 'GET', ':scheme', 'http', ':authority', '127.0.0.1:3087', ':path', '/fast'];
  assert.equal(readRequest(request).path, '/fast');
  for (const [key, value] of [
    [':method', 'G ET'], [':scheme', 'https'], [':authority', 'localhost:3087'],
    [':authority', '127.0.0.1:65536'], [':path', 'http://127.0.0.1/fast'], [':path', '/fast#x'],
  ] as const) {
    const modified = request.map((part, i) => i % 2 !== 0 && request[i - 1] === key ? value : part);
    assert.throws(() => readRequest(modified), { code: 'invalid_headers' });
  }
  assert.equal(workerOrigin('http://127.0.0.1:3087/').origin, 'http://127.0.0.1:3087');
  for (const invalid of [
    'https://127.0.0.1', 'http://localhost:3087', 'http://127.0.0.1@localhost',
    'http://127.0.0.1:65536', 'http://127.0.0.1:0', 'http://127.0.0.1/?',
    'http://127.0.0.1/#', 'http://127.0.0.1/other',
  ]) {
    assert.throws(() => workerOrigin(invalid), { message: 'Invalid WORKER_ORIGIN' });
  }
});

const workerEntry = new URL('../worker.mts', import.meta.url);
const gatewayEntry = new URL('../gateway.mts', import.meta.url);
const envelope = (code: string) => ({ error: { code, message: code } });

test('unit: importing both entrypoints is silent with invalid startup configuration', async () => {
  const probe = [workerEntry, gatewayEntry].map((entry) => `await import(${JSON.stringify(entry.href)})`).join('\n');
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath, ['--v8-pool-size=1', '--input-type=module', '-e', probe],
    { env: { PATH: process.env.PATH ?? '', PORT: 'invalid', WORKER_ORIGIN: 'invalid', UV_THREADPOOL_SIZE: '1' }, timeout: 5000 },
  );
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('integration: gateway and worker run independently and another fast stream survives on one direct session', async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  const gateway = await startService(gatewayEntry, { WORKER_ORIGIN: worker.url });
  t.after(gateway.stop);

  const reply = await http1(gateway.url);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { fast: 'ok', cancelled: true });

  const session = h2Client(t, worker.url);
  await once(session, 'remoteSettings');
  assert.equal(session.remoteSettings.maxConcurrentStreams, 2);
  assert.equal(session.remoteSettings.maxHeaderListSize, 8192);
  const slow = h2Request(session, '/slow');
  const headers = await slow.first;
  assert.ok(headers);
  assert.equal(headers.headers[':status'], 200);
  assert.equal(headers.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(headers.endStream, false);

  const fast = h2Request(session, '/fast');
  slow.stream.close(NGHTTP2_CANCEL);
  assert.equal((await slow.closed).rstCode, NGHTTP2_CANCEL);
  await assertH2(fast, 200, { value: 'ok' });
  assert.equal(session.closed, false);
  await assertH2(h2Request(session, '/fast'), 200, { value: 'ok' });
});

test('integration: gateway returns exact HTTP/1 errors and sees a late duplicate within 8192 bytes', async (t) => {
  const fixture = await startFixture(t);
  const gateway = await startService(gatewayEntry, { WORKER_ORIGIN: fixture.origin });
  t.after(gateway.stop);
  const authority = new URL(gateway.url).host;

  for (const [path, method, status, code] of [
    ['/missing', 'GET', 404, 'not_found'],
    ['/demo', 'POST', 405, 'method_not_allowed'],
    ['/demo?', 'GET', 400, 'invalid_query'],
    ['/demo?one=two', 'GET', 400, 'invalid_query'],
  ] as const) {
    const reply = await http1(gateway.url, path, method);
    assert.equal(reply.status, status);
    assert.deepEqual(reply.body, envelope(code));
    assert.equal(reply.allow, status === 405 ? 'GET' : undefined);
  }
  const body = await http1(gateway.url, '/demo', 'GET', ['Host', authority, 'Content-Length', '1'], 'x');
  assert.equal(body.status, 400);
  assert.deepEqual(body.body, envelope('invalid_body'));
  const filled = Array.from({ length: 1100 }, () => ['X', 'x']).flat();
  const single = ['Host', authority, 'Content-Encoding', 'identity', ...filled];
  const duplicate = await http1(gateway.url, '/demo', 'GET', [...single, 'Content-Encoding', 'identity']);
  assert.equal(duplicate.status, 400);
  assert.deepEqual(duplicate.body, envelope('invalid_headers'));
  assert.equal(fixture.observations.length, 0);
  const baseline = await http1(gateway.url, '/demo', 'GET', single);
  assert.equal(baseline.status, 200);
});

test('integration: worker validates HTTP/2 pseudo-fields, EOF, bodies and trailers', async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  const session = h2Client(t, worker.url);

  await assertH2(h2Request(session, '/other'), 404, envelope('not_found'));
  await assertH2(h2Request(session, '/fast?'), 400, envelope('invalid_query'));
  await assertH2(h2Request(session, '/fast', { headers: { ':method': 'POST' } }),
    405, envelope('method_not_allowed'), 'GET');
  await assertH2(h2Request(session, '/fast', { headers: { ':authority': 'example.invalid' } }),
    400, envelope('invalid_headers'));
  await assertH2(h2Request(session, '/fast', { headers: { 'content-encoding': 'gzip' } }),
    400, envelope('invalid_body'));
  await assertH2(h2Request(session, '/fast', { headers: smallHeaders() }), 200, { value: 'ok' });
  await assertH2(h2Request(session, '/fast', { headers: { ...smallHeaders(), Expect: ['one', 'two'] } }),
    400, envelope('invalid_headers'));

  const empty = h2Request(session, '/fast', { endStream: false });
  await assertH2(h2Request(session, '/fast'), 200, { value: 'ok' });
  assert.equal(empty.initial(), undefined);
  empty.stream.end();
  await assertH2(empty, 200, { value: 'ok' });

  const body = h2Request(session, '/slow', { endStream: false });
  await assertH2(h2Request(session, '/fast'), 200, { value: 'ok' });
  assert.equal(body.initial(), undefined);
  body.stream.end('x');
  await assertH2(body, 400, envelope('invalid_body'));

  const trailers = h2Request(session, '/fast', { endStream: false, waitForTrailers: true });
  sendOnlyTrailers(trailers.stream);
  await assertH2(trailers, 400, envelope('invalid_body'));

  const stalled = h2Request(session, '/fast', { endStream: false });
  await assertH2(stalled, 408, envelope('body_timeout'));
  await assertH2(h2Request(session, '/fast'), 200, { value: 'ok' });
});

test('integration: worker caps sessions and slow expires without closing its connection', async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  const clients = Array.from({ length: 4 }, () => h2Client(t, worker.url));
  await Promise.all(clients.map((session) => assertH2(h2Request(session, '/fast'), 200, { value: 'ok' })));
  const excess = h2Client(t, worker.url);
  const refused = h2Request(excess, '/fast');
  assert.equal(await refused.first, undefined);
  await refused.closed;

  const first = clients[0];
  assert.ok(first);
  const started = performance.now();
  const slow = h2Request(first, '/slow');
  assert.equal((await slow.first)?.headers[':status'], 200);
  assert.equal((await slow.closed).rstCode, NGHTTP2_CANCEL);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `slow CANCEL arrived after ${elapsed} ms`);
  assert.equal(first.closed, false);
  await assertH2(h2Request(first, '/fast'), 200, { value: 'ok' });
});

test('integration: worker admits a healthy session after four peers drain with GOAWAY', async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  const sessions = Array.from({ length: 4 }, () => h2Client(t, worker.url));
  await Promise.all(sessions.map(session => assertH2(h2Request(session, '/fast'), 200, { value: 'ok' })));
  await Promise.all(sessions.map(session => new Promise<void>(resolve => session.close(resolve))));
  const next = h2Client(t, worker.url);
  await assertH2(h2Request(next, '/fast'), 200, { value: 'ok' });
});

test('integration: worker recovers session capacity when graceful peers delay TCP FIN', { timeout: 10_000 }, async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  const proxy = await startFinDelayingProxy(t, Number(new URL(worker.url).port));
  const sessions = Array.from({ length: 4 }, () => h2Client(t, proxy.origin));
  await Promise.all(sessions.map(session => assertH2(h2Request(session, '/fast'), 200, { value: 'ok' })));
  assert.equal(proxy.workerSockets.length, 4);

  async function directFast(signal: AbortSignal) {
    const session = h2Client(t, worker.url);
    try {
      const fast = h2Request(session, '/fast', { signal });
      if (await fast.first === undefined) return false;
      await assertH2(fast, 200, { value: 'ok' });
      return true;
    } finally {
      session.destroy();
    }
  }

  const admission = AbortSignal.timeout(1500);
  assert.equal(await directFast(admission), false, 'the four proxied sessions hold all worker permits');
  assert.equal(admission.aborted, false, 'worker did not promptly refuse the excess session');
  const recoveryMs = 2200;
  const deadline = performance.now() + recoveryMs;
  const recovery = AbortSignal.timeout(recoveryMs);
  for (const session of sessions) session.close();

  while (performance.now() < deadline) {
    if (await directFast(recovery)) {
      assert.ok(performance.now() < deadline, 'worker admission exceeded the drain deadline');
      assert.ok(proxy.workerSockets.every(socket => !socket.writableEnded), 'the proxy must still hold back every FIN');
      return;
    }
    await pause(25);
  }
  assert.fail(`worker did not recover a session permit within ${recoveryMs} ms with TCP FIN withheld`);
});

for (const mode of ['slow-data', 'slow-trailers'] as const) {
  test(`integration: HTTP/2 adapter delivers ${mode} before local cancellation`, { timeout: 3000 }, async (t) => {
    const fixture = await startFixture(t);
    fixture.setMode(mode);
    const observed = deferred<string[]>();
    const session = connectWorker(new URL(fixture.origin))(() => observed.reject(new Error('session failed')));
    t.after(() => session.destroy());
    const sequence: string[] = [];
    const slow = session.open('/slow', {
      headers(raw, ended) {
        try {
          readResponse(raw);
          assert.equal(ended, false);
          sequence.push('headers');
        } catch (error) {
          observed.reject(error);
        }
      },
      data(chunk) { observed.resolve([...sequence, chunk.toString()]); },
      extraHeaders() { observed.resolve([...sequence, 'trailers']); },
      end() { observed.reject(new Error('slow ended before observed event')); },
      close() { observed.reject(new Error('slow closed before observed event')); },
      error() { observed.reject(new Error('slow stream error')); },
    });
    assert.deepEqual(await observed.promise, ['headers', mode === 'slow-data' ? 'unexpected' : 'trailers']);
    if (!slow.closed) slow.close(NGHTTP2_CANCEL);
  });
}

test('integration: instrumented peer sees two GETs, RST CANCEL only on slow and fast completion', async (t) => {
  const fixture = await startFixture(t);
  const gateway = await startService(gatewayEntry, { WORKER_ORIGIN: fixture.origin });
  t.after(gateway.stop);
  const reply = await http1(gateway.url);
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { fast: 'ok', cancelled: true });
  assert.equal(fixture.observations.length, 1);
  const [session] = fixture.observations;
  assert.ok(session);
  await session.closed;
  assert.deepEqual(session.streams.map(({ path, method, initialEnd }) => ({ path, method, initialEnd })), [
    { path: '/slow', method: 'GET', initialEnd: true },
    { path: '/fast', method: 'GET', initialEnd: true },
  ]);
  assert.equal(session.streams[0]?.rstCode, NGHTTP2_CANCEL);
  assert.equal(session.streams[1]?.rstCode, NGHTTP2_NO_ERROR);
  assert.equal(session.streams[1]?.finished, true);
});

test('integration: malformed and incomplete HTTP/2 exchanges fail without a second attempt', async (t) => {
  const fixture = await startFixture(t);
  const gateway = await startService(gatewayEntry, { WORKER_ORIGIN: fixture.origin });
  t.after(gateway.stop);
  const cases: [Mode, string[]][] = [
    ['slow-end', ['/slow']],
    ['goaway', ['/slow']],
    ['slow-stall', ['/slow']],
    ['fast-stall', ['/slow', '/fast']],
    ['staggered-stall', ['/slow', '/fast']],
    ['fast-reset', ['/slow', '/fast']],
    ['fast-reset-no-error', ['/slow', '/fast']],
    ['fast-421', ['/slow', '/fast']],
    ['fast-error', ['/slow', '/fast']],
    ['fast-trailers', ['/slow', '/fast']],
    ['fast-shape', ['/slow', '/fast']],
    ['fast-json', ['/slow', '/fast']],
    ['fast-media', ['/slow', '/fast']],
    ['fast-utf8', ['/slow', '/fast']],
    ['fast-size', ['/slow', '/fast']],
  ];
  for (const [mode, paths] of cases) {
    const before = fixture.observations.length;
    fixture.setMode(mode);
    const started = performance.now();
    const reply = await http1(gateway.url);
    const elapsed = performance.now() - started;
    if (mode === 'staggered-stall') assert.ok(elapsed < 760, `demo took ${elapsed} ms`);
    if (mode === 'slow-stall' || mode === 'fast-stall') {
      assert.ok(elapsed < 1250, `${mode} took ${elapsed} ms`);
    }
    assert.equal(reply.status, 502, mode);
    assert.deepEqual(reply.body, envelope('upstream_failure'), mode);
    assert.equal(fixture.observations.length, before + 1, mode);
    const session = fixture.observations[before];
    assert.ok(session);
    await session.closed;
    assert.deepEqual(session.streams.map(({ path }) => path), paths, mode);
  }
  fixture.setMode('success');
  assert.equal((await http1(gateway.url)).status, 200);
});

test('integration: a fifth gateway demo receives busy without dialing the worker', async (t) => {
  const fixture = await startFixture(t);
  fixture.setMode('hold-slow');
  const gateway = await startService(gatewayEntry, { WORKER_ORIGIN: fixture.origin });
  t.after(gateway.stop);

  const admitted = Promise.all(Array.from({ length: 4 }, () => http1(gateway.url)));
  void admitted.catch(() => {});
  try {
    // The test continues when all four slow HEADERS have reached the fixture.
    await fixture.fourSlow;
    const busy = await http1(gateway.url);
    assert.equal(busy.status, 503);
    assert.deepEqual(busy.body, envelope('busy'));
    assert.equal(fixture.observations.length, 4);
  } finally {
    fixture.releaseSlow();
  }
  for (const reply of await admitted) {
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { fast: 'ok', cancelled: true });
  }
});
