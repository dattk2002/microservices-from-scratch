import assert from 'node:assert/strict';
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from 'node:test';
import { DatabaseSync } from "node:sqlite";
import { parseEvent, parsePercentile, parseSnapshot, sourceOrigins } from "../contracts.mts";
import { HistogramStore } from "../store.mts";
import { readQuantile } from "../query.mts";
import { startService } from "../../../test/support.mts";
import type { RunningService } from "../../../test/support.mts";
import { binIndex, mergeBins, quantile } from '../quantiles.mts';

test('unit: global p50 ranks all observations instead of averaging local medians', () => {
  const a = [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; // [1, 1, 1]
  const b = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]; // [1024]
  assert.deepEqual(quantile(a, b, 50), { total: 4, rank: 2, bin: 0, estimate: 4 / 3 });
});

test('unit: exact powers of two start new bins and each preceding integer stays below', () => {
  const boundaries = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
  assert.deepEqual(boundaries.map(binIndex), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(boundaries.slice(1).map(value => binIndex(value - 1)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

function countBins(values: readonly number[]): number[] {
  const bins = Array<number>(11).fill(0);
  for (const value of values) {
    const index = binIndex(value);
    bins[index] = (bins[index] ?? 0) + 1;
  }
  return bins;
}

test('unit: merged bin counts equal binning the concatenated stream', () => {
  const a = [1, 3, 4, 7, 8, 511, 512];
  const b = [3, 4, 255, 256, 1023, 1024, 1024];
  const combined = mergeBins(countBins(a), countBins(b));
  assert.deepEqual(combined, [1, 2, 3, 1, 0, 0, 0, 1, 2, 2, 2]);
  assert.deepEqual(combined, countBins([...a, ...b]));
});

test('unit: empty, p0, p100 and a cumulative boundary use nearest rank', () => {
  const empty = countBins([]);
  assert.deepEqual(quantile(empty, empty, 90), { total: 0, rank: null, bin: null, estimate: null });
  const a = countBins([3, 1024, 7]);
  const b = countBins([3, 8]);
  assert.deepEqual(quantile(a, b, 0), { total: 5, rank: 1, bin: 1, estimate: 8 / 3 });
  assert.deepEqual(quantile(a, b, 40), { total: 5, rank: 2, bin: 1, estimate: 8 / 3 });
  assert.deepEqual(quantile(a, b, 41), { total: 5, rank: 3, bin: 2, estimate: 16 / 3 });
  assert.deepEqual(quantile(a, b, 100), { total: 5, rank: 5, bin: 10, estimate: 4096 / 3 });
});

test('unit: every returned representative stays within relative error 1/3 of the exact sorted sample', () => {
  const ranges = [
    [1, 1], [2, 3], [4, 7], [8, 15], [16, 31], [32, 63],
    [64, 127], [128, 255], [256, 511], [512, 1023], [1024, 1024],
  ];
  // Cycle through all 1024 admissible values in uneven shards, testing every percentile.
  for (let start = 1; start <= 1024; start += 37) {
    const samples = Array.from({ length: Math.min(37, 1025 - start) }, (_, i) => start + i);
    const a = countBins(samples.slice(5).reverse());
    const b = countBins(samples.slice(0, 5));
    for (let p = 0; p <= 100; p++) {
      const result = quantile(a, b, p);
      const expectedRank = p === 0 ? 1 : Math.floor((p * samples.length + 99) / 100);
      assert.equal(result.rank, expectedRank);
      const actual = samples[expectedRank - 1];
      assert.ok(actual !== undefined && result.bin !== null && result.estimate !== null);
      const range = ranges[result.bin];
      assert.ok(range);
      assert.ok(actual >= (range[0] ?? Infinity) && actual <= (range[1] ?? -Infinity));
      // Allow floating-point representation of thirds at the mathematical bound.
      assert.ok(Math.abs(result.estimate - actual) / actual <= 1 / 3 + Number.EPSILON);
    }
  }
});

function error(code: string) {
  return { error: { code, message: code } };
}

const emptyBins = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const validA = { id: 'a', algorithm: 'log2-harmonic-v1', total: 3, bins: [3, ...emptyBins.slice(1)] };

test('unit: event schema accepts only bounded integers and lowercase ASCII receipt IDs', () => {
  assert.deepEqual(parseEvent({ id: 'a', value: 1 }), { id: 'a', value: 1 });
  assert.deepEqual(parseEvent({ id: 'a123456789012345', value: 1024 }), { id: 'a123456789012345', value: 1024 });
  for (const body of [null, [], 3, false, 'x', {}, { id: 'a' }, { id: 'a', value: 1, extra: 1 }]) {
    assert.throws(() => parseEvent(body), { status: 400, code: 'invalid_request' });
  }
  for (const id of ['', 'a'.repeat(17), 'A', 'é', 'a\n', 'a-b', { toString: null }]) {
    assert.throws(() => parseEvent({ id, value: 2 }), { status: 400, code: 'invalid_request' });
  }
  for (const value of [0, -1, 1025, 1.5, '1', true, null, [], { toString: null }]) {
    assert.throws(() => parseEvent({ id: 'a', value }), { status: 400, code: 'invalid_request' });
  }
});

test('unit: percentile accepts only the sole canonical decimal parameter', () => {
  assert.equal(parsePercentile('?p=0'), 0);
  assert.equal(parsePercentile('?p=9'), 9);
  assert.equal(parsePercentile('?p=100'), 100);
  for (const search of ['', '?p=', '?p=00', '?p=101', '?p=-0', '?p=+1', '?p=1.0', '?p=1e1',
    '?p=1&p=1', '?p=1&extra=0', '?p=1&', '?p=%31', '?%70=1', '?q=20', '?p=1\n']) {
    assert.throws(() => parsePercentile(search), { status: 400, code: 'invalid_request' });
  }
});

test('unit: snapshots require exact identity, algorithm and eleven bounded counts summing to total', () => {
  assert.deepEqual(parseSnapshot(validA, 'a'), validA);
  for (const body of [null, [], true, 5, 'snapshot', { ...validA, extra: 1 },
    { ...validA, id: 'b' }, { ...validA, id: { toString: null } }, { ...validA, algorithm: 'log2-other' },
    { ...validA, total: 2 }, { ...validA, total: '3' }, { ...validA, total: 65, bins: [64, 1, ...emptyBins.slice(2)] },
    { ...validA, bins: {} }, { ...validA, bins: [3] }, { ...validA, bins: [...validA.bins, 0] },
    { ...validA, bins: ['3', ...emptyBins.slice(1)] }, { ...validA, bins: [3.5, -0.5, ...emptyBins.slice(2)] },
    { ...validA, bins: [-1, 4, ...emptyBins.slice(2)] }, { ...validA, bins: [65, -62, ...emptyBins.slice(2)] }]) {
    assert.throws(() => parseSnapshot(body, 'a'), { status: 502, code: 'upstream_failure' });
  }
});

test('unit: origin config normalizes loopback URLs before comparing them', () => {
  assert.deepEqual(sourceOrigins('http://127.0.0.1:80/', 'http://127.0.0.1:4321'), {
    a: 'http://127.0.0.1', b: 'http://127.0.0.1:4321',
  });
  assert.throws(() => sourceOrigins('http://127.0.0.1:80/', 'http://127.0.0.1'), /distinct/);
  for (const bad of [undefined, '', 'https://127.0.0.1:4321', 'http://localhost:4321', 'http://127.0.0.2:4321',
    'http://127.0.0.1:4321/path', 'http://127.0.0.1:4321?', 'http://127.0.0.1:4321#',
    'http://user@127.0.0.1:4321', 'http://127.0.0.1:0']) {
    assert.throws(() => sourceOrigins('http://127.0.0.1:4322', bad), /loopback/);
  }
});

test('unit: receipts stay idempotent at capacity and conflicts leave counts unchanged', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new HistogramStore(db, 'a');
    assert.deepEqual(store.snapshot(), { id: 'a', algorithm: 'log2-harmonic-v1', total: 0, bins: emptyBins });
    assert.deepEqual(store.record({ id: 'x', value: 1 }), { id: 'x', duplicate: false });
    for (let i = 0; i < 63; i++) store.record({ id: `item${i}`, value: 1024 });
    assert.deepEqual(store.record({ id: 'x', value: 1 }), { id: 'x', duplicate: true });
    assert.throws(() => store.record({ id: 'x', value: 2 }), { status: 409, code: 'id_conflict' });
    assert.throws(() => store.record({ id: 'overflow', value: 2 }), { status: 429, code: 'capacity' });
    assert.deepEqual(store.snapshot(), { id: 'a', algorithm: 'log2-harmonic-v1', total: 64, bins: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 63] });
  } finally {
    db.close();
  }
});

test('unit: a failed bin increment rolls back the receipt so a retry can write both', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new HistogramStore(db, 'b');
    db.exec(`CREATE TRIGGER reject_increment BEFORE UPDATE ON histogram_bins
      BEGIN SELECT RAISE(ABORT, 'test bin failure'); END;`);
    const sample = { id: 'x', value: 8 };
    assert.throws(() => store.record(sample), /test bin failure/);
    db.exec('DROP TRIGGER reject_increment');
    assert.deepEqual(store.snapshot(), { id: 'b', algorithm: 'log2-harmonic-v1', total: 0, bins: emptyBins });
    assert.deepEqual(store.record(sample), { id: 'x', duplicate: false });
    assert.deepEqual(store.snapshot(), { id: 'b', algorithm: 'log2-harmonic-v1', total: 1, bins: [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] });
  } finally {
    db.close();
  }
});

const validB = { id: 'b', algorithm: 'log2-harmonic-v1', total: 1, bins: [...emptyBins.slice(1), 1] };
const median = { total: 4, rank: 2, bin: 0, estimate: 4 / 3 };
const config = { a: 'http://127.0.0.1:13078', b: 'http://127.0.0.1:13079' };

test('unit: aggregation requires a valid snapshot from each fixed source', async () => {
  const good: typeof fetch = async input => Response.json(input === config.a + '/snapshot' ? validA : validB);
  assert.deepEqual(await readQuantile(config, 50, good), median);
  const badReplies = [
    Response.json(validB, { status: 503 }),
    Response.json({ error: { code: 'not_found', message: 'not_found' } }, { status: 404 }),
    Response.json({ error: { code: 'internal_error', message: 'internal_error' } }, { status: 404 }),
    Response.json(null, { status: 404 }),
    Response.json({ ...validB, total: 2 }),
  ];
  for (const bad of badReplies) {
    const upstream: typeof fetch = async input => input === config.a + '/snapshot' ? Response.json(validA) : bad;
    await assert.rejects(readQuantile(config, 50, upstream), { status: 502, code: 'upstream_failure' });
  }
});

test('unit: the upstream byte cap accepts 8192 bytes and rejects 8193 with the same schema', async () => {
  const encoded = JSON.stringify(validB);
  for (const size of [8192, 8193]) {
    const wire = encoded.padEnd(size, ' ');
    assert.equal(Buffer.byteLength(wire), size);
    assert.deepEqual(parseSnapshot(JSON.parse(wire), 'b'), validB);
    const upstream: typeof fetch = async input => input === config.a + '/snapshot'
      ? Response.json(validA) : new Response(wire, { headers: { 'content-type': 'application/json' } });
    if (size === 8192) assert.deepEqual(await readQuantile(config, 50, upstream), median);
    else await assert.rejects(readQuantile(config, 50, upstream), { status: 502, code: 'upstream_failure' });
  }
});

test('unit: the deadline timer cancels a stalled body at 500 ms including header latency', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let waitingForBody = () => {};
  const bodyRead = new Promise<void>(resolve => { waitingForBody = resolve; });
  let cancelled = false;
  const upstream: typeof fetch = async input => {
    if (input === config.a + '/snapshot') return Response.json(validA);
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    const body = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(Buffer.from('{'));
      },
      pull() {
        waitingForBody();
      },
      cancel() {
        cancelled = true;
      },
    }, { highWaterMark: 0 });
    return new Response(body, { headers: { 'content-type': 'application/json' } });
  };

  const rejected = assert.rejects(readQuantile(config, 50, upstream), { status: 502, code: 'upstream_failure' });
  try {
    t.mock.timers.tick(300);
    assert.equal(await Promise.race([bodyRead.then(() => true), rejected.then(() => false)]), true);
    t.mock.timers.tick(199);
    assert.equal(cancelled, false);
    t.mock.timers.tick(1);
    assert.equal(cancelled, true);
    await rejected;
  } finally {
    t.mock.timers.runAll();
  }
});

for (const elapsed of [499, 500, 575]) {
  test(`unit: a valid final body chunk at ${elapsed} ms with the abort callback still pending`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const startedAt = 1000;
    let now = startedAt;
    t.mock.method(performance, 'now', () => now);
    let abortedAtCompletion: boolean | undefined;
    const upstream: typeof fetch = async (input, init) => {
      if (input === config.a + '/snapshot') return Response.json(validA);
      const encoded = JSON.stringify(validB);
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(Buffer.from(encoded.slice(0, 1)));
        },
        pull(stream) {
          now = startedAt + elapsed;
          abortedAtCompletion = init?.signal?.aborted;
          stream.enqueue(Buffer.from(encoded.slice(1)));
          stream.close();
        },
      }, { highWaterMark: 0 });
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    };

    const result = readQuantile(config, 50, upstream);
    if (elapsed < 500) assert.deepEqual(await result, median);
    else await assert.rejects(result, { status: 502, code: 'upstream_failure' });
    assert.equal(abortedAtCompletion, false);
  });
}

test('unit: snapshot responses accept identity coding and reject other content encodings', async () => {
  const upstream = (encoding: string): typeof fetch => async input => input === config.a + '/snapshot'
    ? Response.json(validA)
    // Fetch exposes the decoded bytes while keeping the original Content-Encoding header.
    : Response.json(validB, { headers: { 'content-encoding': encoding } });
  assert.deepEqual(await readQuantile(config, 50, upstream('IdEnTiTy')), median);
  for (const encoding of ['gzip', 'identity, gzip', '']) {
    await assert.rejects(readQuantile(config, 50, upstream(encoding)), { status: 502, code: 'upstream_failure' });
  }
});

test('unit: snapshot responses reject invalid or oversized declared content lengths', async () => {
  const wire = JSON.stringify(validB);
  const upstream = (length: string): typeof fetch => async input => input === config.a + '/snapshot'
    ? Response.json(validA) : new Response(wire, {
      headers: { 'content-type': 'application/json', 'content-length': length },
    });
  assert.deepEqual(await readQuantile(config, 50, upstream(String(Buffer.byteLength(wire)))), median);
  for (const length of ['8193', '-1', '1.5', '1, 1', '']) {
    await assert.rejects(readQuantile(config, 50, upstream(length)), { status: 502, code: 'upstream_failure' });
  }
});

const sourceEntry = new URL('../histogram.mts', import.meta.url);
const queryEntry = new URL('../query.mts', import.meta.url);
const fixtureEntry = new URL('./fixture.mts', import.meta.url);

test('unit: both entrypoint imports stay silent and inert with invalid environment', async () => {
  const script = [sourceEntry, queryEntry].map(entry => `await import(${JSON.stringify(entry.href)});`).join('\n');
  const result = await promisify(execFile)(process.execPath, ['--v8-pool-size=1', '--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 5000,
    killSignal: 'SIGKILL',
    env: {
      PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1', HOST: 'bad', PORT: 'bad',
      HISTOGRAM_ID: 'bad', DB_PATH: '', SOURCE_A_ORIGIN: 'bad', SOURCE_B_ORIGIN: 'bad',
    },
  });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

async function launch(services: RunningService[], entry: URL, env: Record<string, string>): Promise<RunningService> {
  const service = await startService(entry, env);
  services.push(service);
  return service;
}

async function stopAll(services: readonly RunningService[]): Promise<void> {
  const results = await Promise.allSettled(services.map(service => service.stop()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

async function request(base: string, path: string, status = 200, data?: unknown): Promise<unknown> {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(3000),
    ...(data === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(body)}`);
  return body;
}

test('integration: three processes merge disjoint streams and preserve receipts across source restart', async () => {
  const services: RunningService[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'quantiles-78-'));
  try {
    const aEnv = { HISTOGRAM_ID: 'a', DB_PATH: join(dir, 'a.db') };
    const bEnv = { HISTOGRAM_ID: 'b', DB_PATH: join(dir, 'b.db') };
    let a = await launch(services, sourceEntry, aEnv);
    const b = await launch(services, sourceEntry, bEnv);
    let q = await launch(services, queryEntry, { SOURCE_A_ORIGIN: a.url + '/', SOURCE_B_ORIGIN: b.url });
    await assert.rejects(launch(services, queryEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: a.url + '/' }), /distinct/);

    assert.deepEqual(await request(a.url, '/snapshot'), { ...validA, total: 0, bins: emptyBins });
    assert.deepEqual(await request(q.url, '/quantile?p=0'), { total: 0, rank: null, bin: null, estimate: null });
    for (const body of [null, [], 3, true, 'bad', { id: { toString: null }, value: 1 },
      { id: 'x', value: { toString: null } }, { id: 'x', value: '1' }, { id: 'x', value: 1, extra: 0 }]) {
      assert.deepEqual(await request(a.url, '/events', 400, body), error('invalid_request'));
    }
    for (const query of ['', '?p=00', '?p=101', '?p=1&p=2', '?p=50&source=http://127.0.0.1', '?p=%35%30']) {
      assert.deepEqual(await request(q.url, '/quantile' + query, 400), error('invalid_request'));
    }

    const replay = { id: 'shared', value: 1 };
    assert.deepEqual(await request(a.url, '/events', 201, replay), { id: 'shared', duplicate: false });
    assert.deepEqual(await request(a.url, '/events', 200, replay), { id: 'shared', duplicate: true });
    assert.deepEqual(await request(a.url, '/events', 409, { ...replay, value: 2 }), error('id_conflict'));
    for (const id of ['x', 'y']) await request(a.url, '/events', 201, { id, value: 1 });
    await request(b.url, '/events', 201, { id: 'shared', value: 1024 });
    assert.deepEqual(await request(a.url, '/snapshot'), validA);
    assert.deepEqual(await request(b.url, '/snapshot'), validB);
    for (let read = 0; read < 3; read++) assert.deepEqual(await request(q.url, '/quantile?p=50'), median);
    assert.deepEqual(await request(q.url, '/quantile?p=0'), { ...median, rank: 1 });
    assert.deepEqual(await request(q.url, '/quantile?p=100'), { total: 4, rank: 4, bin: 10, estimate: 4096 / 3 });

    await a.stop();
    assert.deepEqual(await request(q.url, '/quantile?p=50', 502), error('upstream_failure'));
    await q.stop();
    await assert.rejects(launch(services, sourceEntry, { ...aEnv, HISTOGRAM_ID: 'b' }), /identity mismatch/i);
    a = await launch(services, sourceEntry, aEnv);
    q = await launch(services, queryEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url });
    assert.deepEqual(await request(q.url, '/quantile?p=50'), median);
    assert.deepEqual(await request(a.url, '/events', 200, replay), { id: 'shared', duplicate: true });

    for (let i = 0; i < 61; i++) await request(a.url, '/events', 201, { id: `more${i}`, value: 2 });
    assert.deepEqual(await request(a.url, '/events', 429, { id: 'overflow', value: 2 }), error('capacity'));
    assert.deepEqual(await request(a.url, '/events', 200, replay), { id: 'shared', duplicate: true });
    assert.deepEqual(await request(a.url, '/events', 409, { ...replay, value: 2 }), error('id_conflict'));
    assert.deepEqual(await request(a.url, '/snapshot'), { ...validA, total: 64, bins: [3, 61, ...emptyBins.slice(2)] });
    assert.deepEqual(await request(q.url, '/quantile?p=50'), { total: 65, rank: 33, bin: 1, estimate: 8 / 3 });
  } finally {
    try {
      await stopAll(services);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('integration: upstream failures reject complete aggregations and redirects never reach a distinct origin', async () => {
  const services: RunningService[] = [];
  try {
    const b = await launch(services, fixtureEntry, { FIXTURE_ID: 'b' });
    const a = await launch(services, fixtureEntry, { FIXTURE_ID: 'a', REDIRECT_ORIGIN: b.url });
    const q = await launch(services, queryEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url });
    assert.deepEqual(await request(q.url, '/quantile?p=50'), median);
    for (const bad of [null, [], 1, { mode: { toString: null } }, { mode: 'ok', extra: 1 }]) {
      assert.deepEqual(await request(a.url, '/mode', 400, bad), error('invalid_request'));
    }
    await request(a.url, '/mode', 200, { mode: 'fragmented' });
    assert.deepEqual(await request(q.url, '/quantile?p=50'), median);

    for (const mode of ['array', 'null', 'primitive', 'extra', 'wrong-id', 'wrong-algorithm', 'wrong-total',
      'count-type', 'status404', 'unexpected-code', 'status503', 'wrong-media', 'malformed', 'invalid-utf8',
      'disconnect', 'oversize', 'gzip', 'slow-body', 'redirect']) {
      await request(a.url, '/mode', 200, { mode });
      if (mode === 'oversize') {
        const response = await fetch(a.url + '/snapshot', { signal: AbortSignal.timeout(3000) });
        const wire = await response.text();
        assert.equal(response.status, 200);
        assert.equal(Buffer.byteLength(wire), 8193);
        assert.deepEqual(JSON.parse(wire), validA);
      }
      if (mode === 'gzip') {
        const response = await fetch(a.url + '/snapshot', { signal: AbortSignal.timeout(3000) });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-encoding'), 'gzip');
        const length = Number(response.headers.get('content-length'));
        assert.ok(length > 0 && length <= 8192);
        assert.deepEqual(await response.json(), validA);
      }
      assert.deepEqual(await request(q.url, '/quantile?p=50', 502), error('upstream_failure'), mode);
      if (mode === 'redirect') assert.deepEqual(await request(b.url, '/stats'), { received: 0 });
    }
    await request(a.url, '/mode', 200, { mode: 'ok' });
    await request(b.url, '/mode', 200, { mode: 'extra' });
    assert.deepEqual(await request(q.url, '/quantile?p=50', 502), error('upstream_failure'));
    await request(b.url, '/mode', 200, { mode: 'ok' });
    assert.deepEqual(await request(q.url, '/quantile?p=50'), median);
  } finally {
    await stopAll(services);
  }
});
