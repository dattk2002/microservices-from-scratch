import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { HttpError } from '../../../lib/http.mts';
import { jsonRequest, startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { add, emptyMoments, merge, summarize } from '../statistics.mts';
import { origins, parseEvent, parseSnapshot, privateDatabaseFile } from '../protocol.mts';
import type { Snapshot, SourceId } from '../protocol.mts';
import { aggregate } from '../query.mts';
import { MomentsStore } from '../store.mts';
import type { Moments } from '../statistics.mts';
import { compressedWire, sizedWire, validSnapshot } from './fixture.mts';

test('unit: unequal shard sizes weight the mean and include the between-shard variance', () => {
  // A=[0], B=[10,10,10]. The within-shard variance is zero in both.
  const a = { n: 1, mean: 0, m2: 0 };
  const b = { n: 3, mean: 10, m2: 0 };
  assert.deepEqual(summarize(merge(a, b)), {
    n: 4, mean: 7.5, populationVariance: 18.75, sampleVariance: 25,
  });
});

function accumulate(values: number[]): Moments {
  return values.reduce(add, emptyMoments);
}

function near(actual: number | null, expected: number, tolerance = 1e-12): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

test('unit: Welford preserves small spread near the upper value bound', () => {
  const values = [999999998, 999999999, 1000000000];
  const result = summarize(accumulate(values));
  assert.equal(result.n, 3);
  assert.equal(result.mean, 999999999);
  near(result.populationVariance, 2 / 3);
  near(result.sampleVariance, 1);
});

test('unit: partitioned and direct statistics agree with independent squared deviations', () => {
  // For [0,2,4,4,10], mean=4 and squared deviations are 16,4,0,0,36.
  for (const state of [
    accumulate([0, 2, 4, 4, 10]),
    merge(accumulate([0, 2, 4, 4]), accumulate([10])),
    merge(accumulate([10]), accumulate([0, 2, 4, 4])),
  ]) {
    const result = summarize(state);
    assert.equal(result.n, 5);
    near(result.mean, 4);
    near(result.populationVariance, 11.2);
    near(result.sampleVariance, 14);
  }
});

test('unit: empty, singleton and constant streams use the defined denominators', () => {
  const single = accumulate([42]);
  assert.deepEqual(summarize(merge(emptyMoments, emptyMoments)), {
    n: 0, mean: null, populationVariance: null, sampleVariance: null,
  });
  for (const state of [merge(emptyMoments, single), merge(single, emptyMoments)]) {
    assert.deepEqual(summarize(state), { n: 1, mean: 42, populationVariance: 0, sampleVariance: null });
  }
  assert.deepEqual(summarize(merge(single, accumulate([42, 42]))), {
    n: 3, mean: 42, populationVariance: 0, sampleVariance: 0,
  });
});

function failure(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof HttpError && error.status === status && error.code === code && error.message === code;
}

test('unit: source snapshots require exact identity, fields, primitive types and canonical moments', () => {
  const good = { id: 'a', algorithm: 'welford-v1', n: 2, mean: 5, m2: 50 };
  assert.deepEqual(parseSnapshot(good, 'a'), good);
  assert.deepEqual(parseSnapshot({ ...good, n: 0, mean: 0, m2: 0 }, 'a'), {
    ...good, n: 0, mean: 0, m2: 0,
  });
  assert.deepEqual(parseSnapshot({ ...good, n: 1, m2: 0 }, 'a'), { ...good, n: 1, m2: 0 });
  for (const invalid of [
    null, [], false, 1, 'x', {}, { ...good, extra: true }, { ...good, id: 'b' },
    { ...good, algorithm: 'sum-v1' }, { ...good, n: '2' }, { ...good, n: Infinity },
    { ...good, n: -1 }, { ...good, n: 2.5 }, { ...good, n: 65 }, { ...good, mean: NaN },
    { ...good, mean: Infinity }, { ...good, mean: -1 }, { ...good, mean: 1e9 + 1 },
    { ...good, mean: { toString: null } }, { ...good, m2: '50' }, { ...good, m2: null },
    { ...good, m2: Infinity }, { ...good, m2: -1 }, { ...good, m2: 3e18 },
    { ...good, n: 0, m2: 0 }, { ...good, n: 0, mean: 0, m2: 1 },
    { ...good, n: -0, mean: 0, m2: 0 }, { ...good, n: 0, mean: -0, m2: 0 },
    { ...good, n: 0, mean: 0, m2: -0 }, { ...good, n: 1 }, { ...good, n: 1, m2: -0 },
  ]) {
    assert.throws(() => parseSnapshot(invalid, 'a'), failure(502, 'upstream_failure'));
  }
});

test('unit: a singleton snapshot requires an integer observation', () => {
  assert.throws(() => parseSnapshot({ ...validSnapshot('a'), mean: 0.5 }, 'a'),
    failure(502, 'upstream_failure'));
});

test('unit: a snapshot at either endpoint of the event domain has zero spread', () => {
  for (const mean of [0, 1e9]) {
    const constant = { ...validSnapshot('a'), n: 2, mean };
    assert.deepEqual(parseSnapshot(constant, 'a'), constant);
    assert.throws(() => parseSnapshot({ ...constant, m2: 1 }, 'a'), failure(502, 'upstream_failure'));
  }
});

test('unit: zero spread requires an integer mean while a varying stream may have a fractional mean', () => {
  const varying = { ...validSnapshot('a'), n: 2, mean: 0.5, m2: 0.5 };
  assert.deepEqual(parseSnapshot(varying, 'a'), varying);
  assert.throws(() => parseSnapshot({ ...varying, m2: 0 }, 'a'), failure(502, 'upstream_failure'));
});

test('unit: events enforce the exact request schema without coercion', () => {
  for (const valid of [{ id: '0', value: 0 }, { id: 'abcdefghijklmn12', value: 1e9 }]) {
    assert.deepEqual(parseEvent(valid), valid);
  }
  for (const invalid of [
    null, [], true, 1, 'x', {}, { id: 'e' }, { value: 1 }, { id: 'e', value: 1, extra: true },
    { id: '', value: 1 }, { id: 'A', value: 1 }, { id: 'é', value: 1 }, { id: 'a-1', value: 1 },
    { id: '12345678901234567', value: 1 }, { id: { toString: null }, value: 1 },
    { id: 'e', value: { toString: null } }, { id: 'e', value: '1' }, { id: 'e', value: null },
    { id: 'e', value: -1 }, { id: 'e', value: 1.5 }, { id: 'e', value: 1e9 + 1 },
    { id: 'e', value: Infinity },
  ]) {
    assert.throws(() => parseEvent(invalid), failure(400, 'invalid_request'));
  }
});

test('unit: origins normalize before rejecting duplicates and require loopback HTTP', () => {
  const b = 'http://127.0.0.1:1235';
  assert.deepEqual(origins('http://127.0.0.1:01234/', b), { a: 'http://127.0.0.1:1234', b });
  for (const invalid of [
    undefined, 'https://127.0.0.1:1234', 'http://localhost:1234', 'http://127.0.0.2:1234',
    'http://127.0.0.1:0', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234/?',
    'http://127.0.0.1:1234/#', 'http://user@127.0.0.1:1234',
  ]) {
    assert.throws(() => origins(invalid, b), /loopback HTTP origin/);
  }
  assert.throws(() => origins(b, `${b}/`), /distinct/);
  assert.throws(() => origins('http://127.0.0.1:80/', 'http://127.0.0.1'), /distinct/);
});

test('unit: entrypoint configuration requires a persistent database file', () => {
  assert.equal(privateDatabaseFile('source.db'), 'source.db');
  for (const path of [undefined, '', '   ', ':memory:', 'file::memory:']) {
    assert.throws(() => privateDatabaseFile(path), /Private DB_PATH file required/);
  }
});

test('unit: receipts consume capacity once and the existing ID takes precedence', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const store = new MomentsStore(db, 'a');
    for (let i = 0; i < 64; i++) {
      assert.deepEqual(store.accept({ id: `e${i}`, value: 7 }), { id: `e${i}`, duplicate: false });
    }
    assert.deepEqual(store.accept({ id: 'e0', value: 7 }), { id: 'e0', duplicate: true });
    assert.throws(() => store.accept({ id: 'e0', value: 8 }), failure(409, 'id_conflict'));
    assert.throws(() => store.accept({ id: 'e64', value: 7 }), failure(429, 'capacity'));
    assert.deepEqual(store.snapshot(), { id: 'a', algorithm: 'welford-v1', n: 64, mean: 7, m2: 0 });
    assert.throws(() => new MomentsStore(db, 'b'), /identity mismatch/i);
    assert.deepEqual(new MomentsStore(db, 'a').snapshot(), store.snapshot());
  } finally {
    db.close();
  }
});

test('unit: a failed receipt insertion rolls back the moments update and allows retry', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const store = new MomentsStore(db, 'b');
    assert.deepEqual(store.snapshot(), { id: 'b', algorithm: 'welford-v1', n: 0, mean: 0, m2: 0 });
    store.accept({ id: 'first', value: 2 });
    const before = { id: 'b', algorithm: 'welford-v1', n: 1, mean: 2, m2: 0 };
    assert.deepEqual(store.snapshot(), before);
    db.exec(`CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts
      WHEN NEW.id = 'retry' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    assert.throws(() => store.accept({ id: 'retry', value: 6 }), /injected failure/);
    assert.deepEqual(store.snapshot(), before);
    db.exec('DROP TRIGGER fail_receipt');
    assert.deepEqual(store.accept({ id: 'retry', value: 6 }), { id: 'retry', duplicate: false });
    assert.deepEqual(store.snapshot(), { id: 'b', algorithm: 'welford-v1', n: 2, mean: 4, m2: 8 });
  } finally {
    db.close();
  }
});

const sourceEntry = new URL('../moments.mts', import.meta.url);
const queryEntry = new URL('../query.mts', import.meta.url);
const fixtureEntry = new URL('./fixture.mts', import.meta.url);
const unequal = { n: 4, mean: 7.5, populationVariance: 18.75, sampleVariance: 25 };

test('unit: entrypoint imports exit silently even with invalid environment', async () => {
  const script = `await import(${JSON.stringify(sourceEntry.href)}); await import(${JSON.stringify(queryEntry.href)});`;
  const output = await promisify(execFile)(process.execPath, ['--v8-pool-size=1', '--input-type=module', '-e', script], {
    timeout: 3000,
    killSignal: 'SIGKILL',
    env: {
      PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1', NODE_OPTIONS: '--warnings',
      HOST: 'invalid', PORT: 'invalid', MOMENTS_ID: 'invalid', DB_PATH: ':memory:',
      SOURCE_A_ORIGIN: 'invalid', SOURCE_B_ORIGIN: 'also invalid',
    },
  });
  assert.equal(output.stdout, '');
  assert.equal(output.stderr, '');
});

const fixtureOrigins = { a: 'http://127.0.0.1:1234', b: 'http://127.0.0.1:1235' };
const upstreamFailure = failure(502, 'upstream_failure');
const jsonHeaders = { 'content-type': 'application/json' };

test('unit: query accepts at most 8192 bytes of complete schema-valid JSON per source', async () => {
  const ids: SourceId[] = ['a', 'b'];
  const atLimit = { a: sizedWire('a', 8192), b: sizedWire('b', 8192) };
  const overLimit = { a: sizedWire('a', 8193), b: sizedWire('b', 8193) };
  for (const id of ids) {
    assert.equal(Buffer.byteLength(atLimit[id]), 8192);
    assert.equal(Buffer.byteLength(overLimit[id]), 8193);
    assert.deepEqual(JSON.parse(atLimit[id]), validSnapshot(id));
    assert.deepEqual(JSON.parse(overLimit[id]), validSnapshot(id));
  }
  const fetchWire = (wires: Record<SourceId, string>): typeof fetch => async url => {
    const id = url === fixtureOrigins.a + '/snapshot' ? 'a' : 'b';
    return new Response(wires[id], { headers: jsonHeaders });
  };
  assert.deepEqual(await aggregate(fixtureOrigins, fetchWire(atLimit)), unequal);
  for (const id of ids) {
    await assert.rejects(aggregate(fixtureOrigins, fetchWire({ ...atLimit, [id]: overLimit[id] })), upstreamFailure);
  }
});

test('unit: query rejects encoded snapshots even when fetch has decoded valid JSON within the limit', async () => {
  for (const id of ['a', 'b'] as const) {
    const compressed = compressedWire(id);
    assert.ok(compressed.byteLength > 8192);
    const decoded = gunzipSync(compressed);
    assert.equal(decoded.byteLength, 8192);
    assert.deepEqual(JSON.parse(decoded.toString()), validSnapshot(id));
  }
  const fetchEncoded = (encoding: string): typeof fetch => async url => {
    if (url === fixtureOrigins.b + '/snapshot') return Response.json(validSnapshot('b'));
    return new Response(sizedWire('a', 8192), {
      headers: { ...jsonHeaders, 'content-encoding': encoding },
    });
  };
  assert.deepEqual(await aggregate(fixtureOrigins, fetchEncoded('IdEnTiTy')), unequal);
  for (const encoding of ['gZiP', 'identity, gzip', '']) {
    await assert.rejects(aggregate(fixtureOrigins, fetchEncoded(encoding)), upstreamFailure);
  }
});

test('unit: query rejects invalid or oversize Content-Length before reading a snapshot', async () => {
  const fetchLength = (length: string): typeof fetch => async url => {
    if (url === fixtureOrigins.b + '/snapshot') return Response.json(validSnapshot('b'));
    return new Response(sizedWire('a', 8192), {
      headers: { ...jsonHeaders, 'content-length': length },
    });
  };
  assert.deepEqual(await aggregate(fixtureOrigins, fetchLength('8192')), unequal);
  for (const length of ['8193', '8e3', '-1', '', '8192, 8192']) {
    await assert.rejects(aggregate(fixtureOrigins, fetchLength(length)), upstreamFailure);
  }
});

test('unit: the shared deadline cancels an incomplete snapshot at 500 ms across headers and body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const fetcher: typeof fetch = async (url) => {
    if (url === fixtureOrigins.a + '/snapshot') return Response.json(validSnapshot('a'));
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    const wire = JSON.stringify(validSnapshot('b'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(wire.slice(0, 1)));
        timer = setTimeout(() => {
          controller.enqueue(Buffer.from(wire.slice(1)));
          controller.close();
        }, 350);
      },
      cancel() {
        cancelled = true;
        clearTimeout(timer);
      },
    });
    return new Response(stream, { headers: jsonHeaders });
  };
  const result = aggregate(fixtureOrigins, fetcher).catch((error: unknown) => error);
  t.mock.timers.tick(300);
  await nextTurn();
  t.mock.timers.tick(199);
  await nextTurn();
  const cancelledAt499 = cancelled;
  t.mock.timers.tick(1);
  await nextTurn();
  const cancelledAt500 = cancelled;
  t.mock.timers.tick(150);
  await nextTurn();
  assert.equal(cancelledAt499, false, 'the partial body is still eligible at 499 ms');
  assert.equal(cancelledAt500, true, 'the partial body is cancelled at 500 ms');
  assert.ok(upstreamFailure(await result));
});

test('unit: a valid body finishing at or after 500 ms fails before the abort timer can fire', async t => {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const elapsed of [499, 500, 501]) {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const result = aggregate(fixtureOrigins, async url =>
      url === fixtureOrigins.a + '/snapshot' ? Response.json(validSnapshot('a'))
        : new Response(readable, { headers: jsonHeaders }));
    await nextTurn();
    now += elapsed;
    await writer.write(Buffer.from(JSON.stringify(validSnapshot('b'))));
    await writer.close();
    if (elapsed < 500) {
      assert.deepEqual(await result, unequal);
    } else {
      await assert.rejects(result, upstreamFailure, `valid snapshot completed at ${elapsed} ms`);
    }
  }
});

function errorBody(code: string) {
  return { error: { code, message: code } };
}

async function request(base: string, path: string, expected: number, init?: RequestInit): Promise<unknown> {
  const response = await fetch(base + path, { ...init, signal: AbortSignal.timeout(3000) });
  const body: unknown = await response.json();
  assert.equal(response.status, expected, `${init?.method ?? 'GET'} ${path} returned ${JSON.stringify(body)}`);
  return body;
}

function post(base: string, path: string, expected: number, body: unknown): Promise<unknown> {
  return request(base, path, expected, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function acquire(services: RunningService[], file: URL, env: Record<string, string>): Promise<RunningService> {
  const service = await startService(file, env);
  services.push(service);
  return service;
}

async function stopAll(services: RunningService[]): Promise<void> {
  const results = await Promise.allSettled(services.map(service => service.stop()));
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}

test('integration: independent sources persist receipts and moments and the query reads both on every call', async () => {
  const services: RunningService[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'mergeable-variance-79-'));
  try {
    const aEnv = { MOMENTS_ID: 'a', DB_PATH: join(dir, 'a.db') };
    const bEnv = { MOMENTS_ID: 'b', DB_PATH: join(dir, 'b.db') };
    let a = await acquire(services, sourceEntry, aEnv);
    const b = await acquire(services, sourceEntry, bEnv);
    let query = await acquire(services, queryEntry, { SOURCE_A_ORIGIN: a.url + '/', SOURCE_B_ORIGIN: b.url });

    assert.deepEqual(await request(a.url, '/snapshot', 200), {
      id: 'a', algorithm: 'welford-v1', n: 0, mean: 0, m2: 0,
    });
    assert.deepEqual(await request(query.url, '/statistics', 200), {
      n: 0, mean: null, populationVariance: null, sampleVariance: null,
    });

    for (const data of [
      null, [], false, 0, 'event', {}, { id: 'event' }, { id: 'event', value: 0, extra: true },
      { id: { toString: null }, value: 0 }, { id: 'Event', value: 0 }, { id: 'event', value: { toString: null } },
      { id: 'event', value: '0' }, { id: 'event', value: -1 }, { id: 'event', value: 1.5 },
    ]) {
      assert.deepEqual(await post(a.url, '/events', 400, data), errorBody('invalid_request'));
    }
    assert.deepEqual(await request(a.url, '/events', 400, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }), errorBody('invalid_json'));
    assert.deepEqual(await request(query.url, '/statistics?source=http://caller.example', 400), errorBody('invalid_request'));
    assert.deepEqual(await post(query.url, '/statistics', 405, {}), errorBody('method_not_allowed'));
    assert.deepEqual(await request(a.url, '/events', 405), errorBody('method_not_allowed'));

    const zero = { id: 'same', value: 0 };
    // Parallel submissions must commit one observation, even if a retry arrives before its response.
    const statuses = await Promise.all([zero, zero].map(async event => {
      const response = await jsonRequest(a.url + '/events', event);
      const body: unknown = await response.json();
      assert.deepEqual(body, { id: 'same', duplicate: response.status === 200 });
      return response.status;
    }));
    assert.deepEqual(statuses.sort(), [200, 201]);
    assert.deepEqual(await request(query.url, '/statistics', 200), {
      n: 1, mean: 0, populationVariance: 0, sampleVariance: null,
    });

    for (const id of ['same', 'b1', 'b2']) {
      assert.deepEqual(await post(b.url, '/events', 201, { id, value: 10 }), { id, duplicate: false });
    }
    assert.deepEqual(await request(b.url, '/snapshot', 200), validSnapshot('b'));
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await request(query.url, '/statistics', 200), unequal);
    }
    assert.deepEqual(await post(a.url, '/events', 409, { ...zero, value: 1 }), errorBody('id_conflict'));
    assert.deepEqual(await request(query.url, '/statistics', 200), unequal);

    // A real SQL error after the moments update must undo it and leave the ID retryable.
    const { DatabaseSync } = await import('node:sqlite');
    const admin = new DatabaseSync(aEnv.DB_PATH);
    try {
      admin.exec(`CREATE TRIGGER fail_http_receipt BEFORE INSERT ON receipts
        WHEN NEW.id = 'retry' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
      assert.deepEqual(await post(a.url, '/events', 500, { id: 'retry', value: 10 }), errorBody('internal_error'));
      assert.deepEqual(await request(a.url, '/snapshot', 200), validSnapshot('a'));
      admin.exec('DROP TRIGGER fail_http_receipt');
    } finally {
      admin.close();
    }

    const retried = { id: 'retry', value: 10 };
    const persisted = { id: 'a', algorithm: 'welford-v1', n: 2, mean: 5, m2: 50 };
    const mergedAfterRetry = { n: 5, mean: 8, populationVariance: 16, sampleVariance: 20 };
    assert.deepEqual(await post(a.url, '/events', 201, retried), { id: 'retry', duplicate: false });
    assert.deepEqual(await request(a.url, '/snapshot', 200), persisted);
    assert.deepEqual(await request(query.url, '/statistics', 200), mergedAfterRetry);

    await a.stop();
    assert.deepEqual(await request(query.url, '/statistics', 502), errorBody('upstream_failure'));
    await query.stop();
    await assert.rejects(acquire(services, sourceEntry, { ...aEnv, MOMENTS_ID: 'b' }), /identity mismatch/i);
    a = await acquire(services, sourceEntry, aEnv);
    query = await acquire(services, queryEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url });
    assert.deepEqual(await request(a.url, '/snapshot', 200), persisted);
    assert.deepEqual(await post(a.url, '/events', 200, zero), { id: 'same', duplicate: true });
    assert.deepEqual(await post(a.url, '/events', 200, retried), { id: 'retry', duplicate: true });
    assert.deepEqual(await request(query.url, '/statistics', 200), mergedAfterRetry);
  } finally {
    try {
      await stopAll(services);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('integration: fixed upstreams fail closed on invalid status, schema, body, deadline and redirect', async () => {
  const services: RunningService[] = [];
  try {
    const b = await acquire(services, fixtureEntry, { FIXTURE_ID: 'b' });
    const a = await acquire(services, fixtureEntry, { FIXTURE_ID: 'a', REDIRECT_ORIGIN: b.url });
    const query = await acquire(services, queryEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url });
    assert.deepEqual(await request(query.url, '/statistics', 200), unequal);
    await assert.rejects(acquire(services, queryEntry, {
      SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: a.url + '/',
    }), /distinct/);

    for (const body of [null, [], false, { mode: { toString: null } }, { mode: 'ok', extra: true }]) {
      assert.deepEqual(await post(a.url, '/mode', 400, body), errorBody('invalid_request'));
    }

    for (const peer of [a, b]) {
      await post(peer.url, '/mode', 200, { mode: 'at-limit' });
      assert.deepEqual(await request(query.url, '/statistics', 200), unequal);
      for (const mode of [
        'null', 'array', 'primitive', 'extra', 'wrong-id', 'wrong-algorithm', 'number-type',
        'empty-inconsistent', 'singleton-inconsistent', 'singleton-fractional', 'zero-mean-spread',
        'negative', 'nonfinite', 'too-many',
        'status-snapshot', 'unexpected-code', 'error-array', 'media', 'malformed', 'invalid-utf8',
        'disconnect', 'oversize', 'gzip',
      ]) {
        await post(peer.url, '/mode', 200, { mode });
        assert.deepEqual(await request(query.url, '/statistics', 502), errorBody('upstream_failure'), mode);
      }
      await post(peer.url, '/mode', 200, { mode: 'ok' });
    }

    await post(a.url, '/mode', 200, { mode: 'redirect' });
    assert.deepEqual(await request(query.url, '/statistics', 502), errorBody('upstream_failure'));
    // The destination is a distinct reachable origin. Read its counter before changing any mode.
    assert.deepEqual(await request(b.url, '/received', 200), { received: 0 });

    for (const mode of ['slow-body', 'slow-chain']) {
      await post(a.url, '/mode', 200, { mode });
      const started = performance.now();
      assert.deepEqual(await request(query.url, '/statistics', 502), errorBody('upstream_failure'), mode);
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 400 && elapsed < 1500, `elapsed ${elapsed} ms in ${mode}`);
    }
    await post(a.url, '/mode', 200, { mode: 'ok' });
    assert.deepEqual(await request(query.url, '/statistics', 200), unequal);
  } finally {
    await stopAll(services);
  }
});


test('unit: mean-dependent variance bounds reject impossible snapshots without rejecting integer streams', () => {
  for (const m2 of [51, 1e18]) {
    assert.throws(() => parseSnapshot({ id: 'a', algorithm: 'welford-v1', n: 2, mean: 5, m2 }, 'a'), { status: 502, code: 'upstream_failure' });
  }
  assert.deepEqual(parseSnapshot({ id: 'a', algorithm: 'welford-v1', n: 2, mean: 5, m2: 50 }, 'a'), { id: 'a', algorithm: 'welford-v1', n: 2, mean: 5, m2: 50 });
  for (let n = 1; n <= 64; n += 1) {
    for (const [base, outlier] of [[0, 1], [1000000000, 999999999], [0, 1000000000], [1000000000, 0]]) {
      assert.ok(base !== undefined && outlier !== undefined);
      for (const outlierFirst of [true, false]) {
        const values: number[] = Array.from({ length: n }, (): number => base);
        values[outlierFirst ? 0 : n - 1] = outlier;
        const state: Moments = values.reduce<Moments>((moments, value) => add(moments, value), emptyMoments);
        const snapshot: Snapshot = { id: 'a', algorithm: 'welford-v1', ...state };
        assert.deepEqual(parseSnapshot(snapshot, 'a'), snapshot);
      }
    }
  }
});
