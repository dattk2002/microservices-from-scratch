import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { constants } from 'node:http2';
import { promisify } from 'node:util';
import { fixture, halfOpenPeer, lateEof, modes, retire } from './fixture.mts';
import { httpCall, latch, service, within } from './support.mts';
import { DATA, GOAWAY, HEADERS, wire } from './wire.mts';
import { test } from 'node:test';
import { callDeadline, Drain, expired, selectSession } from '../core.mts';
import { ResponseEnd } from '../response-end.mts';

test('unit: drain freezes admission, cutoff and deadline on the first signal', () => {
  const drain = new Drain();
  assert.equal(drain.accept(1), true);
  assert.equal(drain.accept(5), true);
  assert.equal(drain.release(5), true);
  assert.equal(drain.begin(100), true);
  assert.equal(drain.begin(120), false);
  assert.equal(drain.accept(7), false);
  assert.equal(drain.cutoff, 5);
  assert.equal(drain.deadline, 850);
  assert.equal(drain.active, 1);
});

test('unit: each admitted stream releases exactly once', () => {
  const drain = new Drain();
  assert.equal(drain.accept(3), true);
  assert.equal(drain.accept(3), false);
  assert.equal(drain.release(7), false);
  assert.equal(drain.release(3), true);
  assert.equal(drain.release(3), false);
  assert.equal(drain.active, 0);
});

test('unit: select a reusable session past retired entries', () => {
  const open = { state: 'open' } as const;
  assert.equal(selectSession([{ state: 'draining' }, { state: 'closed' }, open]), open);
  assert.equal(selectSession([{ state: 'draining' }]), undefined);
});

test('unit: expiry includes the exact monotonic deadline', () => {
  assert.equal(expired(500, 499.99), false);
  assert.equal(expired(500, 500), true);
  assert.equal(expired(500, 501), true);
});

test('unit: fragmented END_STREAM is attributed to its own stream and reset is no EOF', () => {
  const peer = new ResponseEnd();
  peer.track(1);
  peer.track(3);
  const final = Buffer.from('0000010001000000037d', 'hex');
  peer.observe(final.subarray(0, 8));
  assert.equal(peer.complete(3), false);
  peer.observe(final.subarray(8, 9));
  assert.equal(peer.complete(3), false);
  peer.observe(final.subarray(9));
  assert.equal(peer.complete(3), true);
  assert.equal(peer.complete(1), false);
  peer.observe(Buffer.from('00000403000000000300000000', 'hex'));
  assert.equal(peer.complete(3), false);
  peer.forget(3);
});

test('unit: an open session without capacity is skipped', () => {
  const full = { state: 'open', free: false } as const;
  const idle = { state: 'open', free: true } as const;
  assert.equal(selectSession([full, idle], (entry) => entry.free), idle);
});

test('unit: entrypoint imports exit silently without starting either service', async () => {
  const worker = new URL('../worker.mts', import.meta.url).href;
  const gateway = new URL('../gateway.mts', import.meta.url).href;
  const result = await promisify(execFile)(process.execPath, [
    '--v8-pool-size=1', '--input-type=module', '-e',
    `await import(${JSON.stringify(worker)}); await import(${JSON.stringify(gateway)});`,
  ], { timeout: 3000, maxBuffer: 8192 });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

const ok = { result: 'done' };
const json = 'application/json; charset=utf-8';
const error = (code: string) => ({ error: { code, message: code } });
const reply = (status: number, body: unknown, allow?: string) => ({ status, type: json, allow, body });

test('integration: SIGTERM drains admitted worker work and closes admission', async (t) => {
  const worker = await service(t, 'worker', { WORK_MS: '300' });
  const gateway = await service(t, 'gateway', { WORKER_PORT: String(worker.port) });
  const monitor = await wire(t, worker.port);
  const work = httpCall(gateway.port);
  void work.catch(() => {});
  await within(worker.firstWork, 'gateway work started in worker');

  await monitor.work(1);
  const prefix = await monitor.until((frame) => frame.type === DATA && frame.id === 1, 'direct stream prefix');
  assert.equal(prefix.flags & 1, 0);
  assert.equal(prefix.body.toString(), '{"result":');
  assert.equal(worker.child.kill('SIGTERM'), true);
  const goaway = await monitor.until((frame) => frame.type === GOAWAY, 'worker GOAWAY');
  assert.equal(goaway.body.readUInt32BE(4), constants.NGHTTP2_NO_ERROR);
  assert.equal(goaway.body.readUInt32BE(0) & 0x7fff_ffff, 1);
  // This deliberately exercises an in-flight HEADERS race on the wire,
  // bypassing the HTTP/2 client's local post-GOAWAY admission check.
  assert.equal(monitor.frames.some((frame) => frame.type === DATA && (frame.flags & 1) !== 0), false);
  await monitor.work(3);
  await monitor.pingBarrier();
  assert.equal(monitor.frames.some((frame) => frame.type === DATA && (frame.flags & 1) !== 0), false);

  const afterSignal = httpCall(gateway.port);
  void afterSignal.catch(() => {});
  await monitor.until((frame) => frame.type === DATA && frame.id === 1 && (frame.flags & 1) !== 0,
    'admitted stream END_STREAM');
  assert.deepEqual(await within(worker.exited, 'worker exit'), { code: 0, signal: null });
  await within(monitor.closed, 'worker closed draining TCP connection');
  assert.equal(monitor.frames.some((frame) => frame.id === 3 && frame.type === HEADERS), false);
  assert.equal(worker.workStarts(), 2);
  assert.equal(worker.workFinishesAtExit(), 2);
  assert.deepEqual(await work, reply(200, ok));
  assert.deepEqual(await afterSignal, reply(502, error('upstream_failure')));
  assert.deepEqual(await httpCall(gateway.port, { path: '/health' }), reply(200, { status: 'ok' }));
});

test('integration: worker force closes a flow-controlled HTTP/2 session by the drain deadline', async (t) => {
  const worker = await service(t, 'worker');
  // A bare or partial preface can be closed gracefully by Node when there
  // are no streams. Keep a second socket alive with a zero remaining window.
  const partial = await wire(t, worker.port, { partial: true });
  const held = await wire(t, worker.port, { window: Buffer.byteLength('{"result":') });
  await held.work(1);
  const prefix = await held.until((frame) => frame.type === DATA && frame.id === 1, 'flow-controlled prefix');
  assert.equal(prefix.body.toString(), '{"result":');
  assert.equal(prefix.flags & 1, 0);
  const start = performance.now();
  assert.equal(worker.child.kill('SIGTERM'), true);
  const [closedAt, exit] = await within(Promise.all([held.closed, worker.exited, partial.closed]),
    'forced TCP close and clean worker exit', 1250);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.ok(closedAt - start >= 650 && closedAt - start < 900, `socket closed after ${closedAt - start} ms`);
  assert.equal(held.frames.some((frame) => frame.type === DATA && (frame.flags & 1) !== 0), false);
  assert.equal(worker.workStarts(), 1);
});

test('integration: valid JSON with a 700 ms EOF is cancelled by the 500 ms total deadline', async (t) => {
  const peer = await fixture(t);
  const gateway = await service(t, 'gateway', { WORKER_PORT: String(peer.port) });
  const late = lateEof();
  peer.change(late.handle);
  assert.deepEqual(await httpCall(gateway.port), reply(504, error('upstream_timeout')));
  assert.equal(peer.connections(), 1);
  assert.equal(peer.seen.length, 1);
  const stream = await peer.until(1);
  await within(stream.closed, 'deadline cancelled before the scheduled EOF');
  assert.equal(stream.getReset(), constants.NGHTTP2_CANCEL);
  assert.equal(late.sentEnd(), false);
});

test('integration: GOAWAY keeps admitted streams and caps the live pool at two sessions', async (t) => {
  const peer = await fixture(t);
  const gateway = await service(t, 'gateway', { WORKER_PORT: String(peer.port) });
  const firstAck = latch();
  const secondAck = latch();
  const acknowledgements = [firstAck, secondAck];
  const finish: Array<() => void> = [];
  peer.change((stream, session) => {
    const ack = acknowledgements[finish.length];
    assert.ok(ack);
    finish.push(retire(stream, session, ack));
  });
  const first = httpCall(gateway.port);
  void first.catch(() => {});
  await within(firstAck.promise, 'first session retired');
  const second = httpCall(gateway.port);
  void second.catch(() => {});
  await within(secondAck.promise, 'second session retired');
  assert.deepEqual(await httpCall(gateway.port), reply(503, error('busy')));
  assert.equal(peer.connections(), 2);
  assert.deepEqual(peer.seen.map((call) => call.session), [1, 2]);
  for (const end of finish) end();
  assert.deepEqual(await Promise.all([first, second]), [reply(200, ok), reply(200, ok)]);
});

test('integration: a reset on a retired session does not replay the operation', async (t) => {
  const peer = await fixture(t);
  const gateway = await service(t, 'gateway', { WORKER_PORT: String(peer.port) });
  const generation = latch();
  let reset = () => {};
  peer.change((stream, session) => {
    retire(stream, session, generation);
    reset = () => stream.close(2);
  });
  const failed = httpCall(gateway.port);
  void failed.catch(() => {});
  await within(generation.promise, 'failed stream session retired');
  reset();
  assert.deepEqual(await failed, reply(502, error('upstream_failure')));
  assert.equal(peer.connections(), 1);
  assert.equal(peer.seen.length, 1);
  peer.change(modes.success);
  assert.deepEqual(await httpCall(gateway.port), reply(200, ok));
  assert.deepEqual(peer.seen.map((call) => call.session), [1, 2]);
});

test('integration: invalid upstream responses and an absent final EOF make one attempt each', async (t) => {
  const peer = await fixture(t);
  let destinationHits = 0;
  const destination = createServer((_req, res) => { destinationHits++; res.end(); });
  t.after(async () => {
    const closed = new Promise<void>((resolve) => destination.close(() => resolve()));
    destination.closeAllConnections();
    await within(closed, 'redirect destination cleanup');
  });
  await within(new Promise<void>((resolve, reject) => {
    destination.once('error', reject);
    destination.listen(0, '127.0.0.1', resolve);
  }), 'redirect destination readiness');
  const address = destination.address();
  assert.ok(address && typeof address !== 'string');
  const gateway = await service(t, 'gateway', { WORKER_PORT: String(peer.port) });
  const redirectsTo = `http://127.0.0.1:${address.port}/work`;
  const cases = [
    ['REFUSED_STREAM', modes.refused], ['421', modes.misdirected], ['nonzero RST after data', modes.nonzeroReset],
    ['zero RST without END_STREAM', modes.zeroReset], ['truncated', modes.truncated], ['wrong key', modes.extraKey],
    ['wrong type', modes.invalidType], ['oversize valid JSON', modes.large], ['invalid UTF-8', modes.invalidUtf8],
    ['invalid media', modes.invalidMedia], ['unsupported coding', modes.encoded],
    ['redirect', (stream: Parameters<typeof modes.success>[0]) => modes.redirect(stream, redirectsTo)],
  ] as const;
  assert.deepEqual(await httpCall(gateway.port), reply(200, ok));
  for (const [label, mode] of cases) {
    const before = peer.seen.length;
    peer.change(mode);
    assert.deepEqual(await httpCall(gateway.port), reply(502, error('upstream_failure')), label);
    assert.equal(peer.seen.length, before + 1, label);
    assert.equal(peer.connections(), 1, label);
    assert.equal(destinationHits, 0, label);
  }
  peer.change(modes.slowEof);
  const before = peer.seen.length;
  assert.deepEqual(await httpCall(gateway.port), reply(504, error('upstream_timeout')));
  assert.equal(peer.seen.length, before + 1);
  assert.equal(peer.connections(), 1);
  const held = await peer.until(before + 1);
  await within(held.closed, 'deadline cancelled the stalled stream');
  assert.equal(held.getReset(), 8);
});

test('integration: disconnect cancels one call, eight held calls leave health available', async (t) => {
  const peer = await fixture(t);
  const gateway = await service(t, 'gateway', { WORKER_PORT: String(peer.port) });
  assert.deepEqual(await httpCall(gateway.port), reply(200, ok));
  peer.change(modes.slowEof);
  const abort = new AbortController();
  const cancelled = httpCall(gateway.port, { signal: abort.signal });
  const rejected = assert.rejects(cancelled, { code: 'ABORT_ERR' });
  const cancelledStream = await peer.until(2);
  abort.abort();
  await rejected;
  await within(cancelledStream.closed, 'disconnect propagated to h2');
  assert.equal(cancelledStream.getReset(), 8);

  const calls = Array.from({ length: 8 }, () => httpCall(gateway.port));
  const results = Promise.all(calls);
  void results.catch(() => {});
  await peer.until(10);
  assert.deepEqual(await httpCall(gateway.port), reply(503, error('busy')));
  assert.deepEqual(await httpCall(gateway.port, { path: '/health' }), reply(200, { status: 'ok' }));
  assert.equal(peer.seen.length, 10);
  assert.equal(peer.connections(), 1);
  assert.equal(gateway.child.kill('SIGTERM'), true);
  for (const result of await results) assert.deepEqual(result, reply(504, error('upstream_timeout')));
  assert.deepEqual(await within(gateway.exited, 'gateway exit'), { code: 0, signal: null });
  for (const stream of peer.seen.slice(2)) await within(stream.closed, 'shutdown stream cleanup');
});

test('integration: HTTP/1 validates routes, framing and raw duplicate representation headers', async (t) => {
  const peer = await fixture(t);
  const gateway = await service(t, 'gateway', { WORKER_PORT: String(peer.port) });
  assert.deepEqual(await httpCall(gateway.port, { path: '/missing' }), reply(404, error('not_found')));
  assert.deepEqual(await httpCall(gateway.port, { path: '/health?x=1' }), reply(400, error('invalid_query')));
  assert.deepEqual(await httpCall(gateway.port, { method: 'POST' }), reply(405, error('method_not_allowed'), 'GET'));
  assert.deepEqual(await httpCall(gateway.port, { method: 'HEAD' }), reply(405, undefined, 'GET'));
  assert.deepEqual(await httpCall(gateway.port, {
    headers: { 'content-length': '1' }, body: 'x',
  }), reply(400, error('invalid_body')));
  assert.deepEqual(await httpCall(gateway.port, {
    headers: { 'content-type': ['application/json', 'application/json'] },
  }), reply(400, error('invalid_headers')));
  assert.deepEqual(await httpCall(gateway.port, {
    headers: { 'transfer-encoding': 'chunked' },
  }), reply(400, error('invalid_body')));
  assert.equal(peer.seen.length, 0);
});


test('unit: reset is terminal even when a later END_STREAM shares the same TCP read', () => {
  for (const code of [0, 2]) {
    const peer = new ResponseEnd();
    peer.track(3);
    const reset = Buffer.from('00000403000000000300000000', 'hex');
    reset.writeUInt32BE(code, 9);
    const lateEnd = Buffer.from('000000000100000003', 'hex');
    peer.observe(Buffer.concat([reset, lateEnd]));
    assert.equal(peer.complete(3), false);
    peer.observe(lateEnd);
    assert.equal(peer.complete(3), false);
    peer.forget(3);
  }
});


test('integration: gateway forces a half-open peer closed at the drain deadline', async t => {
  const peer = await halfOpenPeer(t);
  const gateway = await service(t, 'gateway', {WORKER_PORT: String(peer.port)});
  const response = httpCall(gateway.port);
  void response.catch(() => {});
  await within(peer.started, 'upstream request reached half-open peer');
  const exitTimed = gateway.exited.then(exit => ({exit, at: performance.now()}));
  const start = performance.now();
  assert.equal(gateway.child.kill('SIGTERM'), true);
  assert.deepEqual(await response, reply(504, error('upstream_timeout')));
  assert.equal(gateway.child.exitCode, null, 'peer survives ordinary500ms stream cancellation');
  const {exit, at} = await within(exitTimed, 'gateway force deadline', 1000);
  assert.deepEqual(exit, {code: 0, signal: null});
  assert.ok(at - start >= 650 && at - start < 900, `gateway exited after ${at - start}ms`);
  assert.equal(peer.resets(), 1, 'ordinary request cancellation happened before forced process exit');
});


test('unit: the production call budget expires exactly500ms after admission', () => {
  const deadline = callDeadline(100);
  assert.equal(deadline, 600);
  assert.equal(expired(deadline, 599.99), false);
  assert.equal(expired(deadline, 600), true);
  assert.equal(callDeadline(1.25), 501.25);
});
