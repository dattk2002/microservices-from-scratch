import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import { fields, jsonBody, openWire, wire } from './wire.mts';
import type { WireResponse } from './wire.mts';

const originEntry = new URL('../origin.mts', import.meta.url);
const observerEntry = new URL('../observer.mts', import.meta.url);
const peerEntry = new URL('./peer.mts', import.meta.url);
const media = ['content-type', 'application/json'];

type Defer = (cleanup: () => void | Promise<void>) => void;

function cleanupStack(t: TestContext): Defer {
  const actions: Array<() => void | Promise<void>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const action of actions.reverse()) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Integration cleanup failed');
  });
  return action => { actions.push(action); };
}

async function privatePath(defer: Defer): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'revision-document-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'document.sqlite');
}

function expectError(reply: WireResponse, status: number, code: string): void {
  assert.equal(reply.status, status);
  assert.deepEqual(jsonBody(reply), { error: { code, message: code } });
}

function expectSnapshot(reply: WireResponse, revision: number, value: number): void {
  assert.equal(reply.status, 200);
  assert.deepEqual(jsonBody(reply), { revision, value });
}

function expectEmpty(reply: WireResponse): void {
  assert.equal(reply.status, 204);
  assert.equal(reply.body.byteLength, 0);
  for (const name of ['content-type', 'content-length', 'transfer-encoding']) {
    assert.deepEqual(fields(reply, name), [], name);
  }
}

async function waitForWaiting(origin: string, count: number, budget = 1000): Promise<void> {
  const deadline = performance.now() + budget;
  let actual: unknown;
  do {
    const response = await wire(origin, '/stats');
    assert.equal(response.status, 200);
    actual = jsonBody(response);
    if (performance.now() >= deadline) break;
    if (typeof actual === 'object' && actual !== null && 'waiting' in actual && actual.waiting === count) {
      assert.deepEqual(actual, { waiting: count });
      return;
    }
    await sleep(2);
  } while (performance.now() < deadline);
  assert.fail(`Did not observe waiting=${count} within ${budget}ms. Last stats ${JSON.stringify(actual)}`);
}

function put(origin: string, value: number) {
  return wire(origin, '/document', { method: 'PUT', headers: media, body: JSON.stringify({ value }) });
}

test('integration: observer parks, wakes on a commit and returns an empty response at the park deadline', async t => {
  const defer = cleanupStack(t);
  const dbPath = await privatePath(defer);
  const origin = await startService(originEntry, { DB_PATH: dbPath });
  defer(origin.stop);
  const observer = await startService(observerEntry, { ORIGIN_ORIGIN: origin.url, DB_PATH: '/nonexistent/observer.sqlite' });
  defer(observer.stop);

  expectSnapshot(await wire(origin.url, '/document'), 0, 0);
  expectError(await wire(observer.url, '/changes?after=1'), 409, 'future_revision');
  const pending = openWire(observer.url, '/changes?after=0');
  defer(pending.abort);
  await waitForWaiting(origin.url, 1);
  expectSnapshot(await put(origin.url, 0), 0, 0);
  await waitForWaiting(origin.url, 1);
  expectSnapshot(await put(origin.url, 21), 1, 21);
  expectSnapshot(await pending.reply, 1, 21);
  expectSnapshot(await wire(origin.url, '/document'), 1, 21);

  const started = performance.now();
  expectEmpty(await wire(observer.url, '/changes?after=1'));
  assert.ok(performance.now() - started >= 240, 'the origin must wait before returning 204');
  expectEmpty(await wire(origin.url, '/changes?after=1'));
  await waitForWaiting(origin.url, 0);

  expectSnapshot(await put(origin.url, 22), 2, 22);
  expectSnapshot(await put(origin.url, 23), 3, 23);
  expectSnapshot(await wire(observer.url, '/changes?after=0'), 3, 23);
  await origin.stop();
  const restarted = await startService(originEntry, { DB_PATH: dbPath });
  defer(restarted.stop);
  expectSnapshot(await wire(restarted.url, '/document'), 3, 23);
});

test('integration: disconnect and observer shutdown release the origin slot before the park deadline', async t => {
  const defer = cleanupStack(t);
  const dbPath = await privatePath(defer);
  const origin = await startService(originEntry, { DB_PATH: dbPath });
  defer(origin.stop);
  const observer = await startService(observerEntry, { ORIGIN_ORIGIN: origin.url });
  defer(observer.stop);

  const disconnectDeadline = performance.now() + 180;
  const pending = openWire(observer.url, '/changes?after=0');
  defer(pending.abort);
  await waitForWaiting(origin.url, 1);
  pending.abort();
  await assert.rejects(pending.reply, /disconnected/);
  await waitForWaiting(origin.url, 0, disconnectDeadline - performance.now());

  const shutdownDeadline = performance.now() + 180;
  const next = openWire(observer.url, '/changes?after=0');
  defer(next.abort);
  await waitForWaiting(origin.url, 1);
  const interrupted = assert.rejects(next.reply);
  const released = waitForWaiting(origin.url, 0, shutdownDeadline - performance.now());
  await Promise.all([released, interrupted, observer.stop()]);

  const replacement = await startService(observerEntry, { ORIGIN_ORIGIN: origin.url });
  defer(replacement.stop);
  const held = openWire(replacement.url, '/changes?after=0');
  defer(held.abort);
  await waitForWaiting(origin.url, 1);
  await origin.stop();
  expectError(await held.reply, 502, 'upstream_failure');
});

test('integration: eight origin waiters leave local reads and immediately satisfiable polls available', async t => {
  const defer = cleanupStack(t);
  const dbPath = await privatePath(defer);
  const origin = await startService(originEntry, { DB_PATH: dbPath });
  defer(origin.stop);
  expectSnapshot(await put(origin.url, 7), 1, 7);

  const calls = Array.from({ length: 8 }, () => {
    const call = openWire(origin.url, '/changes?after=1');
    defer(call.abort);
    return call;
  });
  await waitForWaiting(origin.url, 8);
  expectError(await wire(origin.url, '/changes?after=1'), 503, 'busy');
  expectSnapshot(await wire(origin.url, '/document'), 1, 7);
  expectSnapshot(await wire(origin.url, '/changes?after=0'), 1, 7);
  expectError(await wire(origin.url, '/changes?after=2'), 409, 'future_revision');
  const first = calls[0];
  assert.ok(first);
  first.abort();
  await assert.rejects(first.reply, /disconnected/);
  await waitForWaiting(origin.url, 7);
  const next = openWire(origin.url, '/changes?after=1');
  defer(next.abort);
  await waitForWaiting(origin.url, 8);
  expectSnapshot(await put(origin.url, 8), 2, 8);
  for (const call of [...calls.slice(1), next]) expectSnapshot(await call.reply, 2, 8);
  await waitForWaiting(origin.url, 0);
});

test('integration: revision 16 permits no-op writes and rejects further changes', async t => {
  const defer = cleanupStack(t);
  const dbPath = await privatePath(defer);
  const origin = await startService(originEntry, { DB_PATH: dbPath });
  defer(origin.stop);
  for (let revision = 1; revision <= 16; revision++) {
    expectSnapshot(await put(origin.url, revision), revision, revision);
  }
  expectSnapshot(await put(origin.url, 16), 16, 16);
  expectError(await put(origin.url, 99), 409, 'revision_exhausted');
  expectSnapshot(await wire(origin.url, '/document'), 16, 16);
  expectSnapshot(await wire(origin.url, '/changes?after=0'), 16, 16);
  expectEmpty(await wire(origin.url, '/changes?after=16'));
});

test('integration: corrupt SQLite startup fails without publishing readiness', async t => {
  const defer = cleanupStack(t);
  const dbPath = await privatePath(defer);
  await writeFile(dbPath, Buffer.alloc(1024, 42));
  await assert.rejects(async () => {
    const origin = await startService(originEntry, { DB_PATH: dbPath });
    defer(origin.stop);
  }, /not a database/i);
});

test('integration: origin routes require exact methods, query and representation', async t => {
  const defer = cleanupStack(t);
  const dbPath = await privatePath(defer);
  const origin = await startService(originEntry, { DB_PATH: dbPath });
  defer(origin.stop);

  expectError(await wire(origin.url, '/other'), 404, 'not_found');
  expectError(await wire(origin.url, '/other', { headers: ['expect', 'example'] }), 404, 'not_found');
  for (const { path, allowed } of [
    { path: '/document', allowed: 'GET, PUT' },
    { path: '/stats', allowed: 'GET' },
    { path: '/changes?after=0', allowed: 'GET' },
  ]) {
    const reply = await wire(origin.url, path, { method: 'POST' });
    expectError(reply, 405, 'method_not_allowed');
    assert.deepEqual(fields(reply, 'allow'), [allowed]);
  }
  for (const path of ['/document?', '/stats?x=1', '/changes', '/changes?after=01', '/changes?after=0&after=0',
    '/changes?after=0&x=1', '/changes?after=17', '/changes?after=%30']) {
    expectError(await wire(origin.url, path), 400, 'invalid_query');
  }
  for (const path of ['/document', '/stats', '/changes?after=0']) {
    expectError(await wire(origin.url, path, { headers: ['content-length', '1'], body: 'x' }), 400, 'invalid_body');
  }
  const payload = '{"value":24}';
  const paddedHeaders = Array.from({ length: 1050 }, () => ['x', 'x']).flat();
  for (const headers of [[], ['content-type', 'application/json; charset=latin1'],
    ['content-type', 'application/json;'], [...media, 'content-encoding', 'gzip'],
    [...media, 'content-encoding', 'identity, identity'],
    [...media, 'content-encoding', 'identity', ...paddedHeaders, 'Content-Encoding', 'identity'],
    [...media, ...paddedHeaders, 'Content-Type', 'application/json']]) {
    expectError(await wire(origin.url, '/document', { method: 'PUT', headers, body: payload }),
      415, 'unsupported_media_type');
  }
  for (const body of ['{', Buffer.from([0x22, 0xc0, 0xaf, 0x22])]) {
    expectError(await wire(origin.url, '/document', { method: 'PUT', headers: media, body }), 400, 'invalid_json');
  }
  for (const body of ['null', '[]', 'true', '{}', '{"value":{"toString":null}}', '{"value":101}', '{"value":2,"extra":true}']) {
    expectError(await wire(origin.url, '/document', { method: 'PUT', headers: media, body }), 400, 'invalid_body');
  }
  const padded = payload.padStart(8192, ' ');
  expectError(await wire(origin.url, '/document', {
    method: 'PUT', headers: [...media, 'transfer-encoding', 'chunked'], body: ' ' + padded,
  }), 413, 'body_too_large');
  expectSnapshot(await wire(origin.url, '/document', {
    method: 'PUT', headers: ['Content-Type', 'APPLICATION/JSON ; CHARSET="UTF-8"', 'content-encoding', 'identity'],
    body: padded,
  }), 1, 24);

  const partial = openWire(origin.url, '/document', {
    method: 'PUT', headers: [...media, 'content-length', '50'], body: '{"value":25', leaveOpen: true,
  });
  defer(partial.abort);
  expectError(await partial.reply, 408, 'body_timeout');
  expectSnapshot(await wire(origin.url, '/document'), 1, 24);
});

async function peerCount(peer: string): Promise<number> {
  const reply = await wire(peer, '/stats');
  assert.equal(reply.status, 200);
  const stats = jsonBody(reply);
  assert.ok(typeof stats === 'object' && stats !== null && 'count' in stats && typeof stats.count === 'number');
  return stats.count;
}

test('integration: observer validates one fixed peer response through its complete HTTP message', async t => {
  const defer = cleanupStack(t);
  const destination = await startService(peerEntry);
  defer(destination.stop);
  const peer = await startService(peerEntry, { REDIRECT_ORIGIN: destination.url });
  defer(peer.stop);
  assert.notEqual(peer.url, destination.url);
  const observer = await startService(observerEntry, { ORIGIN_ORIGIN: peer.url });
  defer(observer.stop);

  const unknown = await wire(observer.url, '/document');
  expectError(unknown, 404, 'not_found');
  expectError(await wire(observer.url, '/document', { headers: ['expect', 'example'] }), 404, 'not_found');
  const wrongMethod = await wire(observer.url, '/changes?after=1', { method: 'POST' });
  expectError(wrongMethod, 405, 'method_not_allowed');
  assert.deepEqual(fields(wrongMethod, 'allow'), ['GET']);
  expectError(await wire(observer.url, '/changes?after=1&after=1'), 400, 'invalid_query');
  expectError(await wire(observer.url, '/changes?after=1', { headers: ['content-length', '1'], body: 'x' }),
    400, 'invalid_body');
  assert.equal(await peerCount(peer.url), 0);

  let attempts = 0;
  async function exercise(mode: string, after = 1): Promise<WireResponse> {
    assert.equal((await wire(peer.url, `/mode/${mode}`)).status, 200);
    const reply = await wire(observer.url, `/changes?after=${after}`);
    const stats = await wire(peer.url, '/stats');
    assert.equal(stats.status, 200);
    assert.deepEqual(jsonBody(stats), {
      count: ++attempts,
      lastRequest: `GET /changes?after=${after} HTTP/1.1`,
      lastEncoding: 'identity',
      lateTerminals: 0,
    }, mode);
    return reply;
  }

  for (const mode of ['valid', 'close-delimited', 'chunked', 'bounded']) {
    expectSnapshot(await exercise(mode), 2, 42);
  }
  expectEmpty(await exercise('empty'));
  expectError(await exercise('future'), 409, 'future_revision');
  expectError(await exercise('future', 0), 502, 'upstream_failure');
  expectError(await exercise('busy'), 503, 'busy');

  for (const mode of ['empty-type', 'empty-length', 'empty-transfer', 'future-wrong-code', 'busy-wrong-code',
    'future-wrong-message', 'busy-array', 'future-null', 'busy-extra', 'same', 'schema-extra', 'revision-range',
    'value-range', 'primitive', 'malformed', 'non-utf8', 'bad-media', 'bad-coding', 'duplicate-late',
    'duplicate-coding', 'duplicate-length', 'trailer-media', 'big-headers', 'oversized', 'truncated',
    'premature-close', 'retry421']) {
    const reply = await exercise(mode);
    assert.equal(reply.status, 502, mode);
    expectError(reply, 502, 'upstream_failure');
  }

  for (const mode of ['late-header', 'late-eof']) {
    const start = performance.now();
    expectError(await exercise(mode), 502, 'upstream_failure');
    assert.ok(performance.now() - start >= 450, mode);
  }

  assert.equal(await peerCount(destination.url), 0);
  const redirected = await exercise('redirect');
  assert.equal(await peerCount(destination.url), 0, 'redirect destination received a request');
  expectError(redirected, 502, 'upstream_failure');
  expectSnapshot(await exercise('valid'), 2, 42);
});
