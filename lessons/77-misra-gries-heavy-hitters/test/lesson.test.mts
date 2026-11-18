import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { jsonRequest, startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { parseEvent, parseOrigins, parseSummary } from '../protocol.mts';
import { pull, readSummary } from '../query.mts';
import { StreamStore } from '../store.mts';
import { addKey, emptySummary, mergeSummaries } from '../summary.mts';

const streamEntry = new URL('../stream.mts', import.meta.url);
const queryEntry = new URL('../query.mts', import.meta.url);
const fixtureEntry = new URL('./fixture.mts', import.meta.url);
const execFileAsync = promisify(execFile);

function execNode(args: string[], env: NodeJS.ProcessEnv, timeout = 5000) {
  return execFileAsync(process.execPath, ['--v8-pool-size=1', ...args], {
    encoding: 'utf8', timeout, killSignal: 'SIGKILL', env,
  });
}

test('unit: a fourth distinct key cancels all three unit counters and the next key can survive', () => {
  let summary = emptySummary('a');
  for (const key of ['k0', 'k1', 'k2', 'k3']) summary = addKey(summary, key);
  assert.deepEqual(summary, {
    id: 'a', algorithm: 'mg3-v1', total: 4, dropped: 1, counters: [],
  });

  summary = addKey(addKey(summary, 'k0'), 'k0');
  assert.deepEqual(summary, {
    id: 'a', algorithm: 'mg3-v1', total: 6, dropped: 1, counters: [{ key: 'k0', count: 2 }],
  });
});

test('unit: cancellation decrements larger counters without losing their residual counts', () => {
  const keys = ['k2', 'k10', 'k0', 'k2', 'k10', 'k10', 'k3'];
  const summary = keys.reduce(addKey, emptySummary('b'));
  assert.deepEqual(summary, {
    id: 'b', algorithm: 'mg3-v1', total: 7, dropped: 1,
    counters: [{ key: 'k10', count: 2 }, { key: 'k2', count: 1 }],
  });
});

const aKeys = ['k0', 'k1', 'k2', 'k5', ...copies('k0', 7), ...copies('k1', 3), ...copies('k2', 2)];
const bKeys = ['k0', 'k3', 'k4', 'k6', 'k0', 'k3', 'k4', 'k6',
  ...copies('k0', 5), ...copies('k3', 4), ...copies('k4', 3)];
const weightedResult = {
  total: 36, dropped: 6,
  candidates: [{ key: 'k0', lower: 9, upper: 15 }, { key: 'k3', lower: 1, upper: 7 }],
};

function copies(key: string, count: number): string[] {
  return Array.from({ length: count }, () => key);
}

function assertBounds(result: typeof weightedResult, keys: string[]): void {
  assert.equal(result.total, keys.length);
  for (let i = 0; i < 32; i++) {
    const key = `k${i}`;
    const exact = keys.filter(actual => actual === key).length;
    const candidate = result.candidates.find(item => item.key === key);
    assert.ok(exact >= (candidate?.lower ?? 0), `lower bound for ${key}`);
    assert.ok(exact <= (candidate?.upper ?? result.dropped), `upper bound for ${key}`);
    if (exact > keys.length / 4) assert.ok(candidate, `missing heavy hitter ${key}`);
  }
}

test('unit: weighted compression subtracts from every active key and can leave aggregate slack', () => {
  const a = aKeys.reduce(addKey, emptySummary('a'));
  const b = bKeys.reduce(addKey, emptySummary('b'));
  assert.deepEqual(a, {
    id: 'a', algorithm: 'mg3-v1', total: 16, dropped: 1,
    counters: [{ key: 'k0', count: 7 }, { key: 'k1', count: 3 }, { key: 'k2', count: 2 }],
  });
  assert.deepEqual(b, {
    id: 'b', algorithm: 'mg3-v1', total: 20, dropped: 2,
    counters: [{ key: 'k0', count: 5 }, { key: 'k3', count: 4 }, { key: 'k4', count: 3 }],
  });

  // Five keys drop to four after subtracting 2, then to two after subtracting 1.
  const result = mergeSummaries(a, b);
  assert.deepEqual(result, weightedResult);
  assert.equal(result.candidates.reduce((sum, item) => sum + item.lower, 0) + 4 * result.dropped, 34);
  assertBounds(result, [...aKeys, ...bKeys]);
});

test('unit: empty summaries contribute zero and a single source preserves its counts', () => {
  const a = emptySummary('a');
  const b = emptySummary('b');
  assert.deepEqual(mergeSummaries(a, b), { total: 0, dropped: 0, candidates: [] });
  const keys = ['k0', 'k1', 'k2', 'k3', 'k2', 'k10'];
  const result = {
    total: 6, dropped: 1,
    candidates: [{ key: 'k10', lower: 1, upper: 2 }, { key: 'k2', lower: 1, upper: 2 }],
  };
  assert.deepEqual(mergeSummaries(keys.reduce(addKey, a), b), result);
  assert.deepEqual(mergeSummaries(a, keys.reduce(addKey, b)), result);
});

test('unit: event validation requires exactly two canonical strings', () => {
  assert.deepEqual(parseEvent({ id: 'a123456789012345', key: 'k31' }), {
    id: 'a123456789012345', key: 'k31',
  });
  for (const body of [
    null, [], true, 'k0', { id: 'a' }, { id: 'a', key: 'k0', extra: true },
    { id: { toString: null }, key: 'k0' }, { id: 'a', key: { toString: null } },
    { id: 0, key: 'k0' }, { id: '', key: 'k0' }, { id: 'A', key: 'k0' },
    { id: 'a1234567890123456', key: 'k31' }, { id: 'a\n', key: 'k0' },
    { id: 'a', key: 'k32' }, { id: 'a', key: 'k01' }, { id: 'a', key: 'k0\n' },
  ]) {
    assert.equal(parseEvent(body), undefined, JSON.stringify(body));
  }
});

test('unit: source summary requires exact schema, sorted counters and equality of mass', () => {
  const valid = {
    id: 'a', algorithm: 'mg3-v1', total: 9, dropped: 1,
    counters: [{ key: 'k10', count: 2 }, { key: 'k2', count: 3 }],
  };
  assert.deepEqual(parseSummary(valid, 'a'), valid);
  assert.deepEqual(parseSummary(emptySummary('b'), 'b'), emptySummary('b'));
  assert.equal(parseSummary(valid, 'b'), undefined);
  for (const payload of [
    null, [], 9, { ...valid, extra: 1 }, { ...valid, algorithm: 'mg4-v1' },
    { ...valid, total: 10 }, { ...valid, total: 8 }, { ...valid, total: '9' },
    { ...valid, total: 68, counters: [], dropped: 17 },
    { ...valid, total: 65, counters: [{ key: 'k0', count: 65 }], dropped: 0 },
    { ...valid, total: 5, dropped: 0.5, counters: [{ key: 'k0', count: 3 }] },
    { ...valid, dropped: -1 }, { ...valid, counters: {} },
    { ...valid, counters: [...valid.counters].reverse() },
    { ...valid, counters: [{ key: 'k10', count: 2 }, { key: 'k10', count: 3 }] },
    { ...valid, counters: [{ key: 'k32', count: 5 }] },
    { ...valid, counters: [{ key: 'k0', count: '5' }] },
    { ...valid, counters: [{ key: 'k0', count: 0 }, { key: 'k1', count: 5 }] },
    { ...valid, counters: [{ key: 'k0', count: 5, extra: false }] },
    { ...valid, counters: [{ key: 'k0', count: 1 }, { key: 'k1', count: 1 },
      { key: 'k2', count: 1 }, { key: 'k3', count: 2 }] },
  ]) {
    assert.equal(parseSummary(payload, 'a'), undefined, JSON.stringify(payload));
  }
});

test('unit: only distinct normalized HTTP origins on 127.0.0.1 are accepted', () => {
  assert.deepEqual(parseOrigins('http://127.0.0.1:080/', 'http://127.0.0.1:9012/'), {
    a: 'http://127.0.0.1', b: 'http://127.0.0.1:9012',
  });
  assert.throws(() => parseOrigins('http://127.0.0.1:080/', 'http://127.0.0.1'),
    /distinct/);
  for (const invalid of [
    undefined, 'https://127.0.0.1', 'http://localhost', 'http://127.0.0.2',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://@127.0.0.1',
    'http://127.0.0.1/a/..', 'http://127.0.0.1?', 'http://127.0.0.1#',
  ]) {
    assert.throws(() => parseOrigins(invalid, 'http://127.0.0.1:9012'));
  }
});

test('unit: a failed summary write rolls back its receipt and the event can be retried', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const store = new StreamStore(db, 'a');
    const first = { id: 'first', key: 'k1' };
    assert.deepEqual(store.append(first), { id: 'first', duplicate: false });
    assert.deepEqual(store.append(first), { id: 'first', duplicate: true });
    assert.throws(() => store.append({ ...first, key: 'k2' }), { code: 'id_conflict' });

    db.exec(`CREATE TEMP TRIGGER fail_summary BEFORE UPDATE ON summary
      BEGIN SELECT RAISE(ABORT, 'forced summary failure'); END`);
    const second = { id: 'second', key: 'k2' };
    assert.throws(() => store.append(second), /forced summary failure/);
    assert.deepEqual(store.summary(), {
      id: 'a', algorithm: 'mg3-v1', total: 1, dropped: 0, counters: [{ key: 'k1', count: 1 }],
    });
    db.exec('DROP TRIGGER fail_summary');
    assert.deepEqual(store.append(second), { id: 'second', duplicate: false });
    assert.deepEqual(store.append(second), { id: 'second', duplicate: true });
    assert.deepEqual(store.summary(), {
      id: 'a', algorithm: 'mg3-v1', total: 2, dropped: 0,
      counters: [{ key: 'k1', count: 1 }, { key: 'k2', count: 1 }],
    });
  } finally {
    db.close();
  }
});

const jsonHeaders = { 'content-type': 'application/json' };
const validA = {
  id: 'a', algorithm: 'mg3-v1', total: 2, dropped: 0, counters: [{ key: 'k10', count: 2 }],
};

function paddedSummary(size: number): string {
  const wire = JSON.stringify(validA);
  return wire + ' '.repeat(size - Buffer.byteLength(wire));
}

test('unit: the upstream wire limit accepts 8192 bytes and cancels oversize before EOF', async () => {
  const controller = new AbortController();
  const { signal } = controller;
  const limit = paddedSummary(8192);
  const oversize = paddedSummary(8193);
  assert.deepEqual(JSON.parse(oversize), validA);
  assert.equal(Buffer.byteLength(oversize), 8193);
  assert.deepEqual(await readSummary(new Response(limit, { headers: jsonHeaders }), 'a', signal), validA);

  const waitingForEof = deferred();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) {
      stream.enqueue(Buffer.from(limit));
      stream.enqueue(Buffer.from(oversize.slice(limit.length)));
    },
    pull() { waitingForEof.resolve(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const pending = readSummary(new Response(body, { headers: jsonHeaders }), 'a', signal);
  try {
    await Promise.race([
      assert.rejects(pending, /exceeds 8192 bytes/),
      waitingForEof.promise.then(() => assert.fail('reader waited for EOF after crossing the byte limit')),
    ]);
    assert.equal(cancelled, true);
  } finally {
    controller.abort();
    await pending.catch(() => {});
  }
});

test('unit: decoded JSON is accepted only with absent or identity content encoding', async () => {
  const signal = new AbortController().signal;
  const wire = JSON.stringify(validA);
  const response = (encoding: string) => new Response(wire, {
    headers: { ...jsonHeaders, 'content-encoding': encoding },
  });
  assert.deepEqual(await readSummary(response('IdEnTiTy'), 'a', signal), validA);
  // Fetch can expose decoded JSON even when the encoding header still says gzip.
  for (const encoding of ['gzip', 'br', 'identity, identity', '']) {
    await assert.rejects(readSummary(response(encoding), 'a', signal), `encoding ${JSON.stringify(encoding)}`);
  }
});

test('unit: invalid or oversized declared upstream lengths are rejected before reading the body', async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await readSummary(new Response(paddedSummary(8192), {
    headers: { ...jsonHeaders, 'content-length': '8192' },
  }), 'a', signal), validA);
  for (const length of ['8193', '-1', '92.5', '92, 92', '']) {
    let read = false;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(stream) {
        read = true;
        stream.enqueue(Buffer.from(JSON.stringify(validA)));
        stream.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = new Response(body, { headers: { ...jsonHeaders, 'content-length': length } });
    await assert.rejects(readSummary(response, 'a', signal), `declared length ${JSON.stringify(length)}`);
    assert.equal(read, false);
    assert.equal(cancelled, true);
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

for (const elapsed of [499, 500]) {
  test(`unit: a fragmented valid fetch completed at ${elapsed} ms uses the original deadline`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let now = 1000;
    t.mock.method(performance, 'now', () => now);
    const reading = deferred();
    const finish = deferred();
    const wire = JSON.stringify(validA);
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(Buffer.from(wire.slice(0, 1))); },
      async pull(stream) {
        reading.resolve();
        await finish.promise;
        stream.enqueue(Buffer.from(wire.slice(1)));
        stream.close();
      },
    }, { highWaterMark: 0 });
    const origins = parseOrigins('http://127.0.0.1:9011', 'http://127.0.0.1:9012');
    t.mock.method(globalThis, 'fetch', async (url: string) => new Response(
      url === origins.a + '/summary' ? body : JSON.stringify(emptySummary('b')), { headers: jsonHeaders },
    ));

    const pending = pull(origins);
    try {
      await Promise.race([
        reading.promise,
        pending.then(() => assert.fail('query completed before reaching the second chunk')),
      ]);
    } finally {
      // Leave the mocked abort timer unadvanced to model a delayed callback.
      now += elapsed;
      finish.resolve();
    }
    if (elapsed === 499) {
      assert.deepEqual(await pending, {
        total: 2, dropped: 0, candidates: [{ key: 'k10', lower: 2, upper: 2 }],
      });
    } else {
      await assert.rejects(pending, { status: 502, code: 'upstream_failure' });
    }
  });
}

test('unit: aborting while reading an upstream summary cancels its stalled body', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(Buffer.from('{')); },
    cancel() { cancelled = true; },
  });
  const response = new Response(body, { headers: jsonHeaders });
  const pending = readSummary(response, 'a', controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('unit: an import probe timeout kills a child that handles SIGTERM', async () => {
  await assert.rejects(execNode(['--eval', `
    process.on('SIGTERM', () => {});
    require('node:fs').writeSync(1, 'ready\\n');
    setTimeout(() => process.exit(0), 1800);
  `], { PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1' }, 1000), {
    signal: 'SIGKILL', stdout: 'ready\n', stderr: '',
  });
});

test('unit: importing both entrypoints with invalid environment is silent and exits', async () => {
  const result = await execNode([
    '--input-type=module', '--eval',
    'for (const url of process.argv.slice(1)) await import(url);',
    streamEntry.href, queryEntry.href,
  ], {
    PATH: process.env.PATH ?? '', HOST: 'invalid', PORT: 'invalid', STREAM_ID: 'invalid',
    DB_PATH: '', SOURCE_A_ORIGIN: 'invalid', SOURCE_B_ORIGIN: 'invalid', UV_THREADPOOL_SIZE: '1',
  });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

type Starter = typeof startService;

async function withServices(run: (start: Starter) => Promise<void>): Promise<void> {
  const services: RunningService[] = [];
  const start: Starter = async (entry, env) => {
    const service = await startService(entry, env);
    services.push(service);
    return service;
  };
  try {
    await run(start);
  } finally {
    const stops = await Promise.allSettled(services.map(service => service.stop()));
    for (const stop of stops) if (stop.status === 'rejected') throw stop.reason;
  }
}

async function get(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(4000) });
}

async function expectJson(response: Response, status: number, body: unknown): Promise<void> {
  const actual: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(actual));
  assert.deepEqual(actual, body);
}

function expectError(response: Response, status: number, code: string): Promise<void> {
  return expectJson(response, status, { error: { code, message: code } });
}

async function appendKeys(origin: string, keys: string[], firstId = 0): Promise<void> {
  for (const [index, key] of keys.entries()) {
    const id = String(firstId + index);
    await expectJson(await jsonRequest(origin + '/events', { id, key }), 201, { id, duplicate: false });
  }
}

async function expectStartupFailure(
  entry: URL, env: Record<string, string>, stderr: RegExp,
): Promise<void> {
  await assert.rejects(execNode([fileURLToPath(entry)], {
    PATH: process.env.PATH ?? '', PORT: '0', HOST: '127.0.0.1', UV_THREADPOOL_SIZE: '1', ...env,
  }), { code: 1, stdout: '', stderr });
}

test('integration: independent streams merge over HTTP and each read replaces the previous computation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg77-merge-'));
  try {
    await withServices(async start => {
      const a = await start(streamEntry, { STREAM_ID: 'a', DB_PATH: join(dir, 'a.db') });
      const b = await start(streamEntry, { STREAM_ID: 'b', DB_PATH: join(dir, 'b.db') });
      const query = await start(queryEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url });
      await expectJson(await get(a.url + '/summary'), 200, {
        id: 'a', algorithm: 'mg3-v1', total: 0, dropped: 0, counters: [],
      });
      await expectJson(await get(query.url + '/heavy'), 200, { total: 0, dropped: 0, candidates: [] });

      // IDs are local to each source. Each stream receives the same initial IDs.
      await Promise.all([appendKeys(a.url, aKeys), appendKeys(b.url, bKeys)]);
      const response = await get(query.url + '/heavy');
      assert.equal(response.status, 200);
      const actual: unknown = await response.json();
      assert.deepEqual(actual, weightedResult);
      // assert.deepEqual narrows actual to the hand-checked response shape.
      assertBounds(actual, [...aKeys, ...bKeys]);
      await expectJson(await get(query.url + '/heavy'), 200, weightedResult);

      await appendKeys(a.url, ['k0'], aKeys.length);
      await expectJson(await get(query.url + '/heavy'), 200, {
        total: 37, dropped: 6,
        candidates: [{ key: 'k0', lower: 10, upper: 16 }, { key: 'k3', lower: 1, upper: 7 }],
      });
      await b.stop();
      await expectError(await get(query.url + '/heavy'), 502, 'upstream_failure');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('integration: immutable receipts survive restart and check replay and conflict before capacity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mg77-store-'));
  try {
    await withServices(async start => {
      const env = { STREAM_ID: 'a', DB_PATH: join(dir, 'stream.db') };
      const service = await start(streamEntry, env);
      const events = service.url + '/events';
      for (const body of [null, [], 42, 'event', { id: '0', key: 'k0', extra: 1 },
        { id: { toString: null }, key: 'k0' }, { id: '0', key: { toString: null } }]) {
        await expectError(await jsonRequest(events, body), 400, 'invalid_request');
      }
      await appendKeys(service.url, ['k0', 'k1', 'k2', 'k3', ...copies('k0', 60)]);
      const full = {
        id: 'a', algorithm: 'mg3-v1', total: 64, dropped: 1, counters: [{ key: 'k0', count: 60 }],
      };
      await expectJson(await jsonRequest(events, { id: '1', key: 'k1' }), 200, { id: '1', duplicate: true });
      await expectError(await jsonRequest(events, { id: '1', key: 'k0' }), 409, 'id_conflict');
      await expectError(await jsonRequest(events, { id: '64', key: 'k0' }), 429, 'capacity');
      await expectJson(await get(service.url + '/summary'), 200, full);
      await service.stop();

      await expectStartupFailure(streamEntry, { ...env, STREAM_ID: 'b' }, /Stream identity mismatch/);
      const restarted = await start(streamEntry, env);
      await expectJson(await get(restarted.url + '/summary'), 200, full);
      await expectJson(await jsonRequest(restarted.url + '/events', { id: '1', key: 'k1' }), 200,
        { id: '1', duplicate: true });
      // A leaked receipt from the rejected write would return 200 here.
      await expectError(await jsonRequest(restarted.url + '/events', { id: '64', key: 'k0' }), 429, 'capacity');
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('integration: equivalent source origins fail at startup before readiness', async () => {
  await expectStartupFailure(queryEntry, {
    SOURCE_A_ORIGIN: 'http://127.0.0.1:080/', SOURCE_B_ORIGIN: 'http://127.0.0.1',
  }, /Source origins must be distinct/);
});

async function setMode(service: RunningService, mode: string): Promise<void> {
  await expectJson(await jsonRequest(service.url + '/mode', { mode }), 200, { mode });
}

test('integration: upstream status, schema, wire budget, total deadline and redirect containment', async () => {
  await withServices(async start => {
    const sink = await start(fixtureEntry, { FIXTURE_ROLE: 'sink' });
    const a = await start(fixtureEntry, { FIXTURE_ROLE: 'a', REDIRECT_ORIGIN: sink.url });
    const b = await start(fixtureEntry, { FIXTURE_ROLE: 'b', REDIRECT_ORIGIN: sink.url });
    assert.equal(new Set([sink.url, a.url, b.url]).size, 3);
    const query = await start(queryEntry, { SOURCE_A_ORIGIN: a.url + '/', SOURCE_B_ORIGIN: b.url });
    const heavy = query.url + '/heavy';
    const expected = { total: 4, dropped: 0, candidates: [{ key: 'k10', lower: 4, upper: 4 }] };

    await expectJson(await get(heavy), 200, expected);
    await expectError(await get(heavy + '?source=http%3A%2F%2F127.0.0.1'), 400, 'invalid_request');
    for (const mode of [
      'primitive', 'null', 'array', 'extra', 'identity', 'algorithm', 'slack', 'counter-extra',
      'status404', 'status503', 'internal-code', 'media', 'json', 'utf8', 'disconnect',
    ]) {
      await setMode(a, mode);
      await expectError(await get(heavy), 502, 'upstream_failure');
    }

    await setMode(a, 'fast-body');
    await expectJson(await get(heavy), 200, expected);
    for (const mode of ['slow-body', 'slow-stages']) {
      await setMode(a, mode);
      const started = performance.now();
      await expectError(await get(heavy), 502, 'upstream_failure');
      assert.ok(performance.now() - started >= 450, `${mode} rejected before the body deadline`);
    }

    await setMode(a, 'limit');
    await expectJson(await get(heavy), 200, expected);
    await setMode(a, 'oversize');
    const oversized = await get(a.url + '/summary');
    assert.equal(oversized.status, 200);
    const wire = await oversized.text();
    assert.equal(Buffer.byteLength(wire), 8193);
    assert.deepEqual(JSON.parse(wire), validA);
    await expectError(await get(heavy), 502, 'upstream_failure');

    await setMode(a, 'oversize-gzip');
    const compressed = await get(a.url + '/summary');
    assert.equal(compressed.headers.get('content-encoding'), 'gzip');
    assert.equal(compressed.headers.get('content-length'), null);
    await expectJson(compressed, 200, validA);
    await expectError(await get(heavy), 502, 'upstream_failure');

    await setMode(a, 'redirect');
    await expectError(await get(heavy), 502, 'upstream_failure');
    await expectJson(await get(sink.url + '/stats'), 200, { received: 0 });

    await setMode(a, 'ok');
    await setMode(b, 'identity');
    await expectError(await get(heavy), 502, 'upstream_failure');
    await setMode(b, 'ok');
    await expectJson(await get(heavy), 200, expected);
  });
});


test('unit: a never-ending body is cancelled at exactly 500 ms before EOF', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const config = parseOrigins('http://127.0.0.1:9011', 'http://127.0.0.1:9012');
  const signals: AbortSignal[] = [];
  const release: Array<() => void> = [];
  let cancelled = 0;
  const fetcher: typeof fetch = async (_input, options) => {
    assert.ok(options?.signal);
    signals.push(options.signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{'));
        release.push(() => controller.close());
      },
      cancel() { cancelled += 1; },
    });
    return new Response(body, { headers: jsonHeaders });
  };
  t.mock.method(globalThis, 'fetch', fetcher);
  const pending = pull(config);
  try {
    await nextTurn();
    assert.equal(signals.length, 2);
    t.mock.timers.tick(499);
    assert.equal(signals.every(signal => !signal.aborted), true);
    assert.equal(cancelled, 0);
    t.mock.timers.tick(1);
    assert.equal(signals.every(signal => signal.aborted), true);
    await assert.rejects(pending, { status: 502, code: 'upstream_failure' });
    assert.equal(cancelled, 2);
  } finally {
    for (const close of release) { try { close(); } catch { /* Already cancelled. */ } }
    await pending.catch(() => {});
  }
});
