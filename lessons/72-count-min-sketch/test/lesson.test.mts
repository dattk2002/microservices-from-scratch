import test from 'node:test';
import assert from 'node:assert/strict';
import { positions, emptyCells, increment, merge, estimate, validSnapshot, event, exact } from '../protocol.mts';
import type { Snapshot } from '../protocol.mts';

function fixture(id: 'a' | 'b' = 'a'): Snapshot {
  return { id, version: 0, total: 0, cells: Array.from({ length: 3 }, () => Array<number>(16).fill(0)) };
}

test('unit: golden row-specific SHA256 positions select the documented cells', () => {
  assert.deepEqual(positions('k0'), [4, 10, 15]);
  assert.deepEqual(positions('k1'), [15, 10, 7]);
  assert.deepEqual(positions('k2'), [4, 6, 7]);
  assert.deepEqual(positions('k5'), [11, 4, 15]);
  assert.deepEqual(positions('k31'), [7, 10, 1]);
});

test('unit: collisions overestimate absent keys; minimum after matrix addition sketches concatenation', () => {
  const a = emptyCells(), b = emptyCells(), concatenated = emptyCells();
  increment(a, 'k2', 2); increment(a, 'k1', 3); increment(b, 'k5', 4);
  increment(concatenated, 'k2', 2); increment(concatenated, 'k1', 3); increment(concatenated, 'k5', 4);
  const sum = merge(a, b);
  assert.deepEqual(sum, concatenated);
  assert.deepEqual(sum[0], [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 3]);
  assert.deepEqual(sum[1], [0, 0, 0, 0, 4, 0, 2, 0, 0, 0, 3, 0, 0, 0, 0, 0]);
  assert.deepEqual(sum[2], [0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 4]);
  assert.equal(estimate(sum, 'k0'), 2); // absent, but all three addressed cells collide
  assert.equal(estimate(sum, 'k2'), 2); // neither max(2,2,5) nor their sum
  assert.equal(estimate(sum, 'k1'), 3);
  assert.equal(estimate(sum, 'k5'), 4);
  assert.equal(estimate(sum, 'k3'), 0);
  for (let i = 0; i < 32; i++) {
    const key = `k${i}`, frequency = key === 'k2' ? 2 : key === 'k1' ? 3 : key === 'k5' ? 4 : 0;
    assert.ok(estimate(sum, key) >= frequency, key);
  }
  assert.equal(a[0]?.[11], 0); // merging must not mutate a source snapshot
  assert.deepEqual(emptyCells(), fixture().cells);
});

test('unit: snapshot schema rejects inconsistent matrices, identities and primitive types', () => {
  const zero = fixture();
  assert.equal(validSnapshot(zero, 'a'), true);
  const one = { id: 'a', version: 1, total: 9, cells: Array.from({ length: 3 }, () => [9, ...Array<number>(15).fill(0)]) };
  assert.equal(validSnapshot(one, 'a'), true);
  const full = { ...one, version: 64, total: 576, cells: Array.from({ length: 3 }, () => [576, ...Array<number>(15).fill(0)]) };
  assert.equal(validSnapshot(full, 'a'), true);
  for (const body of [null, [], true, 1, 'x', {}, { ...zero, id: 'b' }, { ...zero, id: {} }, { ...zero, extra: 1 },
    { ...zero, version: '0' }, { ...zero, version: -1 }, { ...zero, version: 65 }, { ...zero, version: 1 },
    { ...zero, total: '0' }, { ...zero, total: 1 }, { ...one, total: 10 }, { ...full, total: 577 },
    { ...zero, cells: null }, { ...zero, cells: {} }, { ...zero, cells: zero.cells.slice(1) },
    { ...zero, cells: [...zero.cells, zero.cells[0]] }, { ...zero, cells: [[], [], []] },
    { ...zero, cells: [Array(17).fill(0), ...zero.cells.slice(1)] },
    ...[-1, 0.5, '0', null, 577, NaN, Infinity].map(n => ({ ...zero, cells: [[n, ...Array(15).fill(0)], ...zero.cells.slice(1)] })),
    { ...one, cells: [[8, ...Array(15).fill(0)], ...one.cells.slice(1)] }]) {
    assert.equal(validSnapshot(body, 'a'), false, JSON.stringify(body));
  }
});

test('unit: events require exact noncoerced fields with bounded IDs, keys and positive weights', () => {
  assert.deepEqual(event({ id: 'a1', key: 'k31', weight: 9 }), { id: 'a1', key: 'k31', weight: 9 });
  for (const body of [null, [], false, 1, 'x', {}, { id: 'a', key: 'k0', weight: 1, extra: 1 },
    ...['', 'A', 'x-1', 'é', 'a'.repeat(17), null, [], { toString: null }, 1].map(id => ({ id, key: 'k0', weight: 1 })),
    ...['k00', 'k32', 'k-1', 'k1/', null, {}, 1].map(key => ({ id: 'a', key, weight: 1 })),
    ...[0, -1, 10, 1.5, '1', null, {}, NaN, Infinity].map(weight => ({ id: 'a', key: 'k0', weight }))]) {
    assert.throws(() => event(body), { status: 400, code: 'invalid_request', message: 'invalid_request' });
  }
});

import { SketchStore } from '../store.mts';
import { configuredOrigins, normalizeOrigin, readEstimate } from '../aggregate.mts';
import { spawnSync } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';

async function withDatabase(run: (db: DatabaseSync) => void): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try { run(db); } finally { db.close(); }
}

test('unit: durable receipts replay exactly, reject conflict and enforce capacity without mutation', async () => {
  await withDatabase(db => {
    const store = new SketchStore(db, 'a');
    assert.deepEqual(store.snapshot(), fixture());
    assert.deepEqual(store.accept({ id: 'one', key: 'k2', weight: 2 }), { id: 'one', duplicate: false });
    const first = store.snapshot();
    assert.equal(first.version, 1); assert.equal(first.total, 2); assert.equal(estimate(first.cells, 'k2'), 2);
    assert.deepEqual(store.accept({ id: 'one', key: 'k2', weight: 2 }), { id: 'one', duplicate: true });
    for (const body of [{ id: 'one', key: 'k1', weight: 2 }, { id: 'one', key: 'k2', weight: 3 }]) {
      assert.throws(() => store.accept(body), { status: 409, code: 'id_conflict', message: 'id_conflict' });
      assert.deepEqual(store.snapshot(), first);
    }
    for (let i = 1; i < 64; i++) store.accept({ id: `e${i}`, key: 'k2', weight: 9 });
    const full = store.snapshot();
    assert.equal(full.version, 64); assert.equal(full.total, 569); assert.equal(estimate(full.cells, 'k2'), 569);
    assert.throws(() => store.accept({ id: 'new', key: 'k1', weight: 1 }), { status: 429, code: 'capacity', message: 'capacity' });
    assert.deepEqual(store.accept({ id: 'one', key: 'k2', weight: 2 }), { id: 'one', duplicate: true });
    assert.throws(() => store.accept({ id: 'one', key: 'k2', weight: 1 }), { status: 409, code: 'id_conflict' });
    assert.deepEqual(store.snapshot(), full);
    assert.throws(() => new SketchStore(db, 'b'), /identity mismatch/);
    assert.deepEqual(new SketchStore(db, 'a').snapshot(), full);
  });
});

test('unit: all 64 maximum-weight events reach 576 without saturation or negative updates', async () => {
  await withDatabase(db => {
    const store = new SketchStore(db, 'b');
    for (let i = 0; i < 64; i++) store.accept({ id: `e${i}`, key: 'k31', weight: 9 });
    const snapshot = store.snapshot();
    assert.equal(snapshot.total, 576); assert.equal(snapshot.version, 64);
    assert.equal(estimate(snapshot.cells, 'k31'), 576); assert.equal(validSnapshot(snapshot, 'b'), true);
    for (const weight of [0, -1, 10, '1', null, { toString: null }]) assert.throws(() => store.accept({ id: 'bad', key: 'k31', weight }), { status: 400 });
    assert.deepEqual(store.snapshot(), snapshot);
  });
});

test('unit: SQLite abort after receipt insertion rolls back both receipt and cells and releases transaction', async () => {
  await withDatabase(db => {
    const store = new SketchStore(db, 'a');
    assert.deepEqual(store.accept({ id: 'seed', key: 'k0', weight: 1 }), { id: 'seed', duplicate: false });
    const before = store.snapshot();
    db.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON sketch BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    assert.throws(() => store.accept({ id: 'retry', key: 'k1', weight: 3 }), /injected_failure/);
    assert.deepEqual(store.snapshot(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM receipts').get()?.n, 1);
    db.exec('DROP TRIGGER fail_update');
    assert.deepEqual(store.accept({ id: 'retry', key: 'k1', weight: 3 }), { id: 'retry', duplicate: false });
    assert.equal(store.snapshot().total, 4);
  });
});

const aOrigin = 'http://127.0.0.1:18072', bOrigin = 'http://127.0.0.1:18073';
function populated(): [Snapshot, Snapshot] {
  // Independently hand-constructed colliding streams: a={k2:2,k1:3}, b={k5:4}.
  return [
    { id: 'a', version: 2, total: 5, cells: [
      [0,0,0,0,2,0,0,0,0,0,0,0,0,0,0,3],
      [0,0,0,0,0,0,2,0,0,0,3,0,0,0,0,0],
      [0,0,0,0,0,0,0,5,0,0,0,0,0,0,0,0]] },
    { id: 'b', version: 1, total: 4, cells: [
      [0,0,0,0,0,0,0,0,0,0,0,4,0,0,0,0],
      [0,0,0,0,4,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4]] }
  ];
}

test('unit: aggregation reads both sources once per query without retaining additive state', async () => {
  const calls: string[] = [], [a, b] = populated();
  const upstream: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    const url = String(input); calls.push(url);
    assert.ok(url === aOrigin + '/snapshot' || url === bOrigin + '/snapshot');
    return Response.json(url === aOrigin + '/snapshot' ? a : b);
  };
  for (let i = 0; i < 3; i++) assert.deepEqual(await readEstimate(aOrigin, bOrigin, 'k0', upstream), { key: 'k0', estimate: 2, total: 9 });
  assert.equal(calls.filter(u => u === aOrigin + '/snapshot').length, 3);
  assert.equal(calls.filter(u => u === bOrigin + '/snapshot').length, 3);
  assert.deepEqual(await readEstimate(aOrigin, bOrigin, 'k2', upstream), { key: 'k2', estimate: 2, total: 9 });
  const empty: typeof fetch = async input => Response.json(fixture(String(input).startsWith(aOrigin) ? 'a' : 'b'));
  assert.deepEqual(await readEstimate(aOrigin, bOrigin, 'k31', empty), { key: 'k31', estimate: 0, total: 0 });
  for (const k of [null, [], {}, 1, 'k00', 'k32']) await assert.rejects(readEstimate(aOrigin, bOrigin, k, empty), { status: 400 });
});

test('unit: both sources require complete valid snapshots with the configured identity', async () => {
  for (const branch of ['a', 'b']) {
    const good = fixture(branch === 'a' ? 'a' : 'b');
    for (const bad of [null, [], false, 1, 'x', {}, { ...good, extra: 1 }, { ...good, id: branch === 'a' ? 'b' : 'a' },
      { ...good, cells: [[], [], []] }, { ...good, total: 1 }, { ...good, version: '0' },
      { ...good, cells: [[1, ...Array(15).fill(0)], ...good.cells.slice(1)] }]) {
      const upstream: typeof fetch = async input => Response.json(String(input).startsWith(branch === 'a' ? aOrigin : bOrigin) ? bad : fixture(branch === 'a' ? 'b' : 'a'));
      await assert.rejects(readEstimate(aOrigin, bOrigin, 'k0', upstream), { status: 502, code: 'upstream_failure' });
    }
    for (const status of [201, 404, 409, 422, 429, 500, 503]) {
      for (const body of [good, null, [], { error: { code: 'internal_error', message: 'internal_error' } }]) {
        const upstream: typeof fetch = async input => String(input).startsWith(branch === 'a' ? aOrigin : bOrigin)
          ? Response.json(body, { status }) : Response.json(fixture(branch === 'a' ? 'b' : 'a'));
        await assert.rejects(readEstimate(aOrigin, bOrigin, 'k0', upstream), { status: 502 });
      }
    }
  }
});

test('unit: upstream media, malformed UTF8/JSON and valid oversized JSON are rejected on either source', async () => {
  for (const branch of ['a', 'b']) for (const mode of ['media', 'json', 'utf8', 'oversize', 'chunked']) {
    const upstream: typeof fetch = async input => {
      const id = String(input).startsWith(aOrigin) ? 'a' : 'b';
      if (id !== branch) return Response.json(fixture(id));
      const wire = JSON.stringify(fixture(id)) + (mode === 'oversize' || mode === 'chunked' ? ' '.repeat(8192) : ''); // valid schema; isolate each failure
      const bytes = mode === 'utf8' ? Buffer.from([0xff]) : Buffer.from(mode === 'json' ? '{' : wire);
      const data = mode === 'chunked' ? new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.subarray(0, 40)); c.enqueue(bytes.subarray(40)); c.close(); } }) : bytes;
      return new Response(data, { headers: { 'content-type': mode === 'media' ? 'text/plain' : 'application/json' } });
    };
    await assert.rejects(readEstimate(aOrigin, bOrigin, 'k0', upstream), { status: 502 });
  }
  await assert.rejects(readEstimate(aOrigin, bOrigin, 'k0', async () => { throw new Error('transport'); }), { status: 502 });
});

test('unit: one 500ms budget includes all response bodies and never waits for a stuck cancel', async () => {
  const upstream: typeof fetch = async input => {
    if (String(input).startsWith(aOrigin)) return Response.json(fixture());
    return new Response(new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(Buffer.from('{')); }, cancel() { return new Promise<void>(() => {}); }
    }), { headers: { 'content-type': 'application/json' } });
  };
  const start = performance.now();
  await assert.rejects(readEstimate(aOrigin, bOrigin, 'k0', upstream), { status: 502 });
  assert.ok(performance.now() - start >= 450); assert.ok(performance.now() - start < 1200);
});

test('unit: startup normalizes and separates loopback sources from each other and listener', () => {
  assert.equal(normalizeOrigin(aOrigin + '/'), aOrigin);
  assert.deepEqual(configuredOrigins(aOrigin + '/', bOrigin, undefined, 0), [aOrigin, bOrigin]);
  for (const origin of ['https://127.0.0.1:8', 'http://localhost:8', 'http://127.0.0.1:0', 'http://user@127.0.0.1:8', aOrigin + '/path', aOrigin + '?x=1', aOrigin + '#x']) assert.throws(() => normalizeOrigin(origin));
  assert.throws(() => configuredOrigins(aOrigin, aOrigin + '/', undefined, 0), /distinct/);
  assert.throws(() => configuredOrigins('http://127.0.0.1:80', 'http://127.0.0.1/', undefined, 0), /distinct/);
  assert.throws(() => configuredOrigins(aOrigin, bOrigin, undefined, 18072), /distinct/);
  assert.throws(() => configuredOrigins(aOrigin, bOrigin, '0.0.0.0', 0));
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { validateHost } from '../protocol.mts';

test('unit: entrypoints import silently without reading invalid environment or loading SQLite', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../sketch.mts', import.meta.url).href)}); await import(${JSON.stringify(new URL('../aggregate.mts', import.meta.url).href)});`
  ], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', DB_PATH: '', SKETCH_ID: '!', HOST: 'invalid', PORT: 'invalid', SOURCE_A_ORIGIN: 'invalid', SOURCE_B_ORIGIN: 'invalid' }, timeout: 3000 });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, ''); assert.equal(child.stderr, '');
  for (const host of ['0.0.0.0', 'localhost', '::1', {}, null, 1]) assert.throws(() => validateHost(host));
  assert.doesNotThrow(() => validateHost(undefined)); assert.doesNotThrow(() => validateHost('127.0.0.1'));
});

async function request(base: string, path: string, status = 200, method = 'GET', data?: unknown): Promise<unknown> {
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(3000),
    ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
  });
  const body: unknown = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(body)}`);
  return body;
}
async function stopAll(services: RunningService[]): Promise<void> {
  const results = await Promise.allSettled(services.map(service => service.stop()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
const sourceEntry = new URL('../sketch.mts', import.meta.url);
const aggregateEntry = new URL('../aggregate.mts', import.meta.url);
const fixtureEntry = new URL('./fixture.mts', import.meta.url);
const envelope = (code: string) => ({ error: { code, message: code } });

test('integration: three processes merge current snapshots, never inflate reads, persist identity and receipts on restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'count-min-72-'));
  const services: RunningService[] = [];
  try {
    const aEnv = { DB_PATH: join(directory, 'a.db'), SKETCH_ID: 'a' };
    let a = await startService(sourceEntry, aEnv); services.push(a);
    const b = await startService(sourceEntry, { DB_PATH: join(directory, 'b.db'), SKETCH_ID: 'b' }); services.push(b);
    let aggregate = await startService(aggregateEntry, { SOURCE_A_ORIGIN: a.url + '/', SOURCE_B_ORIGIN: b.url }); services.push(aggregate);
    assert.deepEqual(await request(a.url, '/snapshot'), fixture('a'));
    assert.deepEqual(await request(b.url, '/snapshot'), fixture('b'));
    assert.deepEqual(await request(aggregate.url, '/estimate/k0'), { key: 'k0', estimate: 0, total: 0 });
    assert.deepEqual(await request(a.url, '/events', 201, 'POST', { id: 'one', key: 'k2', weight: 2 }), { id: 'one', duplicate: false });
    await request(a.url, '/events', 201, 'POST', { id: 'two', key: 'k1', weight: 3 });
    await request(b.url, '/events', 201, 'POST', { id: 'three', key: 'k5', weight: 4 });
    const [expectedA, expectedB] = populated();
    assert.deepEqual(await request(a.url, '/snapshot'), expectedA);
    assert.deepEqual(await request(b.url, '/snapshot'), expectedB);
    for (let i = 0; i < 4; i++) assert.deepEqual(await request(aggregate.url, '/estimate/k0'), { key: 'k0', estimate: 2, total: 9 });
    assert.deepEqual(await request(aggregate.url, '/estimate/k2'), { key: 'k2', estimate: 2, total: 9 });
    assert.deepEqual(await request(a.url, '/events', 200, 'POST', { id: 'one', key: 'k2', weight: 2 }), { id: 'one', duplicate: true });
    assert.deepEqual(await request(a.url, '/events', 409, 'POST', { id: 'one', key: 'k2', weight: 1 }), envelope('id_conflict'));
    assert.deepEqual(await request(a.url, '/snapshot'), expectedA);
    // IDs are local receipts, not a cross-source deduplication mechanism.
    for (const source of [a, b]) await request(source.url, '/events', 201, 'POST', { id: 'same', key: 'k3', weight: 1 });
    assert.deepEqual(await request(aggregate.url, '/estimate/k3'), { key: 'k3', estimate: 2, total: 11 });
    const before = await request(a.url, '/snapshot');
    await aggregate.stop(); await a.stop();
    await assert.rejects(startService(sourceEntry, { ...aEnv, SKETCH_ID: 'b' }), /identity mismatch/);
    a = await startService(sourceEntry, aEnv); services.push(a);
    assert.deepEqual(await request(a.url, '/snapshot'), before);
    assert.deepEqual(await request(a.url, '/events', 200, 'POST', { id: 'one', key: 'k2', weight: 2 }), { id: 'one', duplicate: true });
    aggregate = await startService(aggregateEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url }); services.push(aggregate);
    assert.deepEqual(await request(aggregate.url, '/estimate/k3'), { key: 'k3', estimate: 2, total: 11 });
    for (let i = 3; i < 64; i++) await request(a.url, '/events', 201, 'POST', { id: `e${i}`, key: 'k31', weight: 9 });
    const full = await request(a.url, '/snapshot');
    assert.ok(validSnapshot(full, 'a')); assert.equal(full.version, 64); assert.equal(full.total, 555);
    assert.deepEqual(await request(a.url, '/events', 429, 'POST', { id: 'new', key: 'k0', weight: 1 }), envelope('capacity'));
    await request(a.url, '/events', 200, 'POST', { id: 'one', key: 'k2', weight: 2 });
    await request(a.url, '/events', 409, 'POST', { id: 'one', key: 'k1', weight: 2 });
    assert.deepEqual(await request(a.url, '/snapshot'), full);
  } finally { try { await stopAll(services); } finally { await rm(directory, { recursive: true, force: true }); } }
});

test('integration: exact public schemas, canonical keys and errors reject malformed client inputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'count-min-schema-'));
  const services: RunningService[] = [];
  try {
    const a = await startService(sourceEntry, { DB_PATH: join(directory, 'a.db'), SKETCH_ID: 'a' }); services.push(a);
    // Invalid queries must fail before the aggregate attempts either upstream.
    const aggregate = await startService(aggregateEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: 'http://127.0.0.1:1' }); services.push(aggregate);
    for (const data of [null, [], false, 1, 'x', {}, { id: 'a', key: 'k0' }, { id: 'a', key: 'k0', weight: 1, extra: 1 },
      ...['A', '', 'a'.repeat(17), 1, { toString: null }].map(id => ({ id, key: 'k0', weight: 1 })),
      ...['k00', 'k32', {}, null].map(key => ({ id: 'a', key, weight: 1 })),
      ...[0, -1, 10, 1.5, '1', null, {}, { toString: null }].map(weight => ({ id: 'a', key: 'k0', weight }))]) {
      assert.deepEqual(await request(a.url, '/events', 400, 'POST', data), envelope('invalid_request'));
    }
    assert.deepEqual(await request(a.url, '/snapshot'), fixture());
    for (const path of ['/estimate/k00', '/estimate/k32', '/estimate/%6b0', '/estimate/k0?url=http://example.com', '/estimate/k0?x=1&x=2']) await request(aggregate.url, path, 400);
    await request(a.url, '/snapshot?x=1', 400);
    await request(a.url, '/events?x=1', 400, 'POST', { id: 'a', key: 'k0', weight: 1 });
    for (const [base, path] of [[a.url, '/snapshot'], [a.url, '/events'], [aggregate.url, '/estimate/k0']]) {
      assert.ok(base && path);
      assert.deepEqual(await request(base, path, 405, 'DELETE'), envelope('method_not_allowed'));
    }
    const malformed = await fetch(a.url + '/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{', signal: AbortSignal.timeout(3000) });
    assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), envelope('invalid_json'));
    const oversized = await fetch(a.url + '/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', key: 'k0', weight: 1 }) + ' '.repeat(8192), signal: AbortSignal.timeout(3000) });
    assert.equal(oversized.status, 413); assert.deepEqual(await oversized.json(), envelope('body_too_large'));
    const media = await fetch(a.url + '/events', { method: 'POST', body: '{}', signal: AbortSignal.timeout(3000) });
    assert.equal(media.status, 415); assert.deepEqual(await media.json(), envelope('unsupported_media_type'));
    await assert.rejects(startService(aggregateEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: a.url + '/' }), /distinct/);
  } finally { try { await stopAll(services); } finally { await rm(directory, { recursive: true, force: true }); } }
});

test('integration: either upstream fails closed on schema, status, redirects, oversized wire and full-body deadline', async () => {
  const services: RunningService[] = [];
  try {
    const sink = await startService(fixtureEntry, { FIXTURE_ROLE: 'sink' }); services.push(sink);
    const a = await startService(fixtureEntry, { SKETCH_ID: 'a', REDIRECT_ORIGIN: sink.url }); services.push(a);
    const b = await startService(fixtureEntry, { SKETCH_ID: 'b', REDIRECT_ORIGIN: sink.url }); services.push(b);
    const aggregate = await startService(aggregateEntry, { SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url }); services.push(aggregate);
    const mode = (source: RunningService, name: string) => request(source.url, '/mode', 200, 'POST', { mode: name });
    for (const bad of [null, [], true, 1, 'x', {}, { mode: 1 }, { mode: { toString: null } }, { mode: 'ok', extra: 1 }]) await request(a.url, '/mode', 400, 'POST', bad);
    for (const source of [a, b]) {
      for (const variant of ['null', 'array', 'primitive', 'extra', 'identity', 'dimensions', 'rowsum', 'version', 'cell', 'total',
        'status404', 'status409', 'status422', 'status429', 'status503', 'error-primitive', 'error-array', 'error-extra', 'unexpected-code',
        'oversize', 'chunked-oversize', 'error-oversize', 'media', 'utf8', 'json', 'disconnect']) {
        await mode(source, variant);
        assert.deepEqual(await request(aggregate.url, '/estimate/k0', 502), envelope('upstream_failure'));
      }
      await mode(source, 'escaped');
      assert.deepEqual(await request(aggregate.url, '/estimate/k0'), { key: 'k0', estimate: 0, total: 0 });
      await mode(source, 'redirect');
      await request(aggregate.url, '/estimate/k0', 502);
      // Inspect the reachable distinct destination BEFORE resetting any fixture.
      assert.deepEqual(await request(sink.url, '/stats'), { received: 0 });
      await mode(source, 'ok');
    }
    for (const variant of ['slow-headers', 'slow-body', 'error-slow-body', 'slow-stages']) {
      await mode(b, variant);
      const start = performance.now();
      await request(aggregate.url, '/estimate/k0', 502);
      const elapsed = performance.now() - start;
      assert.ok(elapsed >= 450 && elapsed < 1100, `${variant}: ${elapsed}ms`);
    }
    await mode(b, 'ok');
    assert.deepEqual(await request(aggregate.url, '/estimate/k0'), { key: 'k0', estimate: 0, total: 0 });
  } finally { await stopAll(services); }
});
