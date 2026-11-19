import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addValue, compareSlots, mergeSlots, validSignature, validValueBody } from '../model.mts';
import type { Slots } from '../model.mts';
import { compareSources, sourceOrigins } from '../compare.mts';
import { databasePath } from '../signature.mts';
import { SignatureStore } from '../store.mts';
import { jsonRequest, startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { emptySlots, expectedAlgorithm, expectedOverlap, leftSlots, rightSlots, unionSlots, signatureWire } from './vectors.mts';

function sketch(...values: string[]): Slots {
  return values.reduce<Slots>((slots, value) => addValue(slots, value).slots, emptySlots);
}

test('unit: each SHA-256 row has its own minimum and the literal overlap matches only row 2', () => {
  const a = sketch('v0', 'v1');
  const b = sketch('v1', 'v2');
  assert.deepEqual(a, leftSlots);
  assert.deepEqual(b, rightSlots);
  assert.deepEqual(compareSlots(a, b), expectedOverlap);
});

test('unit: union matches the raw union and is associative, commutative, and idempotent', () => {
  const c = sketch('v2', 'v63');
  assert.deepEqual(mergeSlots(leftSlots, rightSlots), unionSlots);
  assert.deepEqual(mergeSlots(rightSlots, leftSlots), unionSlots);
  assert.deepEqual(mergeSlots(leftSlots, leftSlots), leftSlots);
  assert.deepEqual(mergeSlots(mergeSlots(leftSlots, rightSlots), c), sketch('v0', 'v1', 'v2', 'v63'));
  assert.deepEqual(mergeSlots(leftSlots, mergeSlots(rightSlots, c)), unionSlots);
});

test('unit: duplicate, reordered, and unseen non-improving values leave the minima unchanged', () => {
  const initialized = addValue(emptySlots, 'v1');
  assert.equal(initialized.changed, true);
  const improved = addValue(initialized.slots, 'v0');
  assert.deepEqual(improved, {changed: true, slots: leftSlots});
  assert.deepEqual(sketch('v2', 'v0', 'v1', 'v2', 'v0'), unionSlots);
  assert.deepEqual(addValue(unionSlots, 'v0'), {changed: false, slots: unionSlots});
  assert.deepEqual(addValue(unionSlots, 'v63'), {changed: false, slots: unionSlots});
});

test('unit: empty comparisons and replayed identical signatures follow the specified conventions', () => {
  assert.deepEqual(compareSlots(emptySlots, emptySlots), {
    algorithm: expectedAlgorithm, matches: 8, similarity: 1, unionSlots: emptySlots,
  });
  const oneEmpty = {algorithm: expectedAlgorithm, matches: 0, similarity: 0, unionSlots: leftSlots};
  assert.deepEqual(compareSlots(leftSlots, emptySlots), oneEmpty);
  assert.deepEqual(compareSlots(emptySlots, leftSlots), oneEmpty);
  assert.deepEqual(compareSlots(leftSlots, sketch('v1', 'v1', 'v0')), {
    algorithm: expectedAlgorithm, matches: 8, similarity: 1, unionSlots: leftSlots,
  });
});

test('unit: only hashes at the same index can match', () => {
  const shifted = [...leftSlots.slice(1), leftSlots[0]];
  assert.equal(compareSlots(leftSlots, shifted).matches, 0);
});

test('unit: no same-row collisions across the fixed domain but overlap can yield zero matches', () => {
  const domain = Array.from({length: 256}, (_, i) => `v${i}`);
  const singles = domain.map(value => sketch(value));
  // Minima of disjoint nonempty subsets must come from different values.
  for (let row = 0; row < 8; row++) {
    const priorities = singles.map(slots => slots[row]);
    assert.ok(priorities.every(priority => typeof priority === 'string'));
    assert.equal(new Set(priorities).size, 256);
  }
  assert.equal(compareSlots(sketch(...domain.slice(0, 128)), sketch(...domain.slice(128))).matches, 0);
  assert.equal(compareSlots(sketch('v0', 'v2'), sketch('v0', 'v3')).matches, 0);
});

test('unit: value bodies accept only canonical v0 through v255 with the exact field', () => {
  for (const value of ['v0', 'v9', 'v10', 'v99', 'v100', 'v255']) assert.ok(validValueBody({value}));
  for (const body of [null, [], false, 1, 'v0', {}, {value: 'v0', extra: true}, {value: null},
    {value: ['v0']}, {value: {toString: null}}, {value: 0}, {value: true}, {value: 'v00'},
    {value: 'v01'}, {value: 'v256'}, {value: 'v-1'}, {value: 'V1'}, {value: 'v1\n'}]) {
    assert.equal(validValueBody(body), false);
  }
});

test('unit: upstream signatures require the exact identity, algorithm, fields, and eight homogeneous slots', () => {
  const valid = {id: 'a', algorithm: expectedAlgorithm, slots: leftSlots};
  assert.ok(validSignature(valid, 'a'));
  assert.ok(validSignature({...valid, id: 'b', slots: emptySlots}, 'b'));
  for (const body of [null, [], false, 1, 'signature', {}, {...valid, extra: 0}, {...valid, id: 'b'},
    {...valid, id: {toString: null}}, {...valid, algorithm: 'wrong'}, {...valid, algorithm: null},
    {...valid, slots: null}, {...valid, slots: {}}, {...valid, slots: leftSlots.slice(1)},
    {...valid, slots: [...leftSlots, leftSlots[0]]}, {...valid, slots: [null, ...leftSlots.slice(1)]},
    ...[leftSlots[0].toUpperCase(), 'g'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), true, [],
      {toString: null}].map(value => ({...valid, slots: [value, ...leftSlots.slice(1)]})),
  ]) assert.equal(validSignature(body, 'a'), false);
});

const runNode = promisify(execFile);
const signatureEntry = new URL('../signature.mts', import.meta.url);
const compareEntry = new URL('../compare.mts', import.meta.url);
const upstreamEntry = new URL('./upstream.mts', import.meta.url);
const childOptions = {
  timeout: 5000, killSignal: 'SIGKILL', env: {PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1'},
} satisfies ExecFileOptions;

test('unit: both entrypoints import silently in a real child process even with invalid configuration', async () => {
  const script = [signatureEntry, compareEntry].map(url => `await import(${JSON.stringify(url.href)})`).join('\n');
  const {stdout, stderr} = await runNode(process.execPath, ['--v8-pool-size=1', '--input-type=module', '--eval', script], {
    ...childOptions,
    env: {...childOptions.env, SET_ID: 'bad-id', PORT: '-1', DB_PATH: ':memory:',
      SOURCE_A_ORIGIN: 'not-an-origin', SOURCE_B_ORIGIN: 'not-an-origin'},
  });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('unit: the DB_PATH setting requires a private disk filename', () => {
  assert.equal(databasePath('data/a.sqlite'), 'data/a.sqlite');
  for (const path of [undefined, '', ':memory:', 'file::memory:', 'file:lesson80?mode=memory&cache=shared',
    'file:lesson80.sqlite?mode=ro', 'FILE:lesson80.sqlite']) {
    assert.throws(() => databasePath(path), /DB_PATH must name a private SQLite file/, path);
  }
});

test('unit: failed signature writes preserve the original SQLite error and leave the minima unchanged', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const store = new SignatureStore(db, 'a');
    assert.deepEqual(store.snapshot(), {id: 'a', algorithm: expectedAlgorithm, slots: emptySlots});
    assert.deepEqual(store.add('v1'), {changed: true});
    const before = store.snapshot();
    for (const action of ['ABORT', 'ROLLBACK']) {
      db.exec(`CREATE TRIGGER reject_write AFTER UPDATE ON signature BEGIN SELECT RAISE(${action}, 'injected'); END`);
      assert.throws(() => store.add('v0'), {message: 'injected'});
      assert.deepEqual(store.snapshot(), before);
      db.exec('DROP TRIGGER reject_write');
    }
    assert.deepEqual(store.add('v0'), {changed: true});
    assert.deepEqual(new SignatureStore(db, 'a').snapshot(), {id: 'a', algorithm: expectedAlgorithm, slots: leftSlots});
    assert.throws(() => new SignatureStore(db, 'b'), /identity mismatch/);
    db.exec("UPDATE signature SET algorithm='unknown'");
    assert.throws(() => new SignatureStore(db, 'a'), /algorithm mismatch/);
  } finally {
    db.close();
  }
});

test('unit: origins normalize before rejecting duplicate endpoints and reject URL components outside the contract', () => {
  assert.deepEqual(sourceOrigins('http://127.0.0.1:080/', 'http://127.0.0.1:8002/'),
    ['http://127.0.0.1', 'http://127.0.0.1:8002']);
  assert.throws(() => sourceOrigins('http://127.0.0.1:080', 'http://127.0.0.1/'), /distinct/);
  for (const bad of [undefined, 'invalid', 'https://127.0.0.1', 'http://localhost:80', 'http://127.0.0.1:0',
    'http://user@127.0.0.1:80', 'http://127.0.0.1/path', 'http://127.0.0.1/?', 'http://127.0.0.1/#',
    'http://127.0.0.1:65536']) {
    assert.throws(() => sourceOrigins(bad, 'http://127.0.0.1:8002'));
    assert.throws(() => sourceOrigins('http://127.0.0.1:8002', bad));
  }
});

const origins = ['http://127.0.0.1:8001', 'http://127.0.0.1:8002'] as const;
const aSignature = {id: 'a', algorithm: expectedAlgorithm, slots: leftSlots};
const bSignature = {id: 'b', algorithm: expectedAlgorithm, slots: rightSlots};
const upstreamFailure = {status: 502, code: 'upstream_failure', message: 'upstream_failure'};

test('unit: compare uses both fixed paths under one signal and disallows redirects', async () => {
  const requests: {url: string; signal: AbortSignal | null | undefined; redirect: string | undefined}[] = [];
  const fetcher: typeof fetch = async (url, options) => {
    requests.push({url: String(url), signal: options?.signal, redirect: options?.redirect});
    return Response.json(String(url) === origins[0] + '/signature' ? aSignature : bSignature);
  };
  assert.deepEqual(await compareSources(origins, fetcher), expectedOverlap);
  assert.deepEqual(requests.map(request => request.url).sort(), origins.map(origin => origin + '/signature'));
  assert.deepEqual(requests.map(request => request.redirect), ['error', 'error']);
  const [first, second] = requests;
  assert.ok(first?.signal);
  assert.equal(first.signal, second?.signal);
});

test('unit: compare accepts valid JSON at 8192 bytes and rejects the same signature at 8193 bytes', async () => {
  const atLimit = signatureWire(8192);
  const overLimit = signatureWire(8193);
  assert.deepEqual(JSON.parse(atLimit), aSignature);
  assert.deepEqual(JSON.parse(overLimit), aSignature);
  const fetchWithWire = (wire: string): typeof fetch => async url => String(url) === origins[0] + '/signature'
    ? new Response(wire, {headers: {'content-type': 'application/json'}})
    : Response.json(bSignature);
  assert.deepEqual(await compareSources(origins, fetchWithWire(atLimit)), expectedOverlap);
  await assert.rejects(compareSources(origins, fetchWithWire(overLimit)), upstreamFailure);
});

test('unit: comparison rejects non-identity encodings even when fetch exposes valid decoded JSON', async () => {
  const fetchWithEncoding = (encoding: string): typeof fetch => async url => String(url) === origins[0] + '/signature'
    ? Response.json(aSignature, {headers: {'content-encoding': encoding}})
    : Response.json(bSignature);
  assert.deepEqual(await compareSources(origins, fetchWithEncoding('IdEnTiTy')), expectedOverlap);
  for (const encoding of ['gzip', 'br', 'identity, gzip', '']) {
    await assert.rejects(compareSources(origins, fetchWithEncoding(encoding)), upstreamFailure);
  }
});

test('unit: comparison rejects invalid or oversized Content-Length with otherwise valid JSON', async () => {
  for (const length of ['8193', '-1', '1, 1', 'abc']) {
    const fetcher: typeof fetch = async url => String(url) === origins[0] + '/signature'
      ? Response.json(aSignature, {headers: {'content-length': length}})
      : Response.json(bSignature);
    await assert.rejects(compareSources(origins, fetcher), upstreamFailure);
  }
});

test('unit: reading a late valid body rejects at 500 ms even before the abort timer runs', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let now = 1000;
  context.mock.method(performance, 'now', () => now);
  for (const elapsed of [499, 500]) {
    now = 1000;
    let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
    const bytes = new TextEncoder().encode(JSON.stringify(bSignature));
    const body = new ReadableStream<Uint8Array>({
      start(controller) { producer = controller; },
    });
    const fetcher: typeof fetch = async url => String(url) === origins[0] + '/signature'
      ? Response.json(aSignature)
      : new Response(body, {headers: {'content-type': 'application/json'}});
    const comparison = compareSources(origins, fetcher);
    await new Promise<void>(resolve => setImmediate(resolve));
    now += elapsed;
    assert.ok(producer);
    producer.enqueue(bytes);
    producer.close();
    if (elapsed === 499) assert.deepEqual(await comparison, expectedOverlap);
    else await assert.rejects(comparison, upstreamFailure);
  }
});

test('unit: the shared timer cancels incomplete JSON at 500 ms despite ongoing chunks', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { producer = controller; },
    cancel() { cancelled = true; },
  });
  const fetcher: typeof fetch = async url => String(url) === origins[0] + '/signature'
    ? new Response(body, {headers: {'content-type': 'application/json'}})
    : Response.json(bSignature);
  const finished = assert.rejects(compareSources(origins, fetcher), upstreamFailure).then(() => true);
  try {
    assert.ok(producer);
    const bytes = new TextEncoder().encode(JSON.stringify(aSignature));
    producer.enqueue(bytes.subarray(0, 32));
    for (const [gap, offset] of [[150, 32], [150, 64], [150, 96], [49, 128]] as const) {
      await new Promise<void>(resolve => setImmediate(resolve));
      context.mock.timers.tick(gap);
      assert.equal(cancelled, false);
      producer.enqueue(bytes.subarray(offset, offset + 32));
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    context.mock.timers.tick(1);
    assert.equal(await Promise.race([finished, new Promise(resolve => setImmediate(resolve, false))]), true);
    assert.equal(cancelled, true);
  } finally {
    if (!cancelled) producer?.close();
    await Promise.allSettled([finished]);
  }
});

test('unit: crossing the byte cap cancels an open body before EOF or the deadline', async context => {
  context.mock.timers.enable({apis: ['setTimeout']});
  const wire = signatureWire(8193);
  assert.deepEqual(JSON.parse(wire), aSignature);
  const bytes = new TextEncoder().encode(wire);
  let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 8192));
      controller.enqueue(bytes.subarray(8192));
      producer = controller;
    },
    cancel() { cancelled = true; },
  });
  const fetcher: typeof fetch = async url => String(url) === origins[0] + '/signature'
    ? new Response(body, {headers: {'content-type': 'application/json'}})
    : Response.json(bSignature);
  const rejection = assert.rejects(compareSources(origins, fetcher), upstreamFailure).then(() => true);
  try {
    assert.equal(await Promise.race([rejection, new Promise(resolve => setImmediate(resolve, false))]), true);
    assert.equal(cancelled, true);
  } finally {
    if (!cancelled) producer?.close();
    await Promise.allSettled([rejection]);
  }
});

test('unit: a non-success status, wrong media type, or wrong schema on either side fails the comparison', async () => {
  for (const [index, signature] of [aSignature, bSignature].entries()) {
    for (const invalid of [
      () => Response.json(signature, {status: 429}),
      () => Response.json({error: {code: 'internal_error', message: 'internal_error'}}, {status: 404}),
      () => new Response(JSON.stringify(signature), {headers: {'content-type': 'text/plain'}}),
      () => Response.json({...signature, id: index === 0 ? 'b' : 'a'}),
      () => Response.json({...signature, algorithm: 'different'}),
      () => Response.json({...signature, extra: 1}),
      () => Response.json([signature]),
      () => Response.json(42),
    ]) {
      const fetcher: typeof fetch = async url => String(url) === origins[index] + '/signature' ? invalid()
        : Response.json(index === 0 ? bSignature : aSignature);
      await assert.rejects(compareSources(origins, fetcher), upstreamFailure);
    }
  }
});

async function expectResponse(response: Response, status: number, expected: unknown): Promise<void> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(body, expected);
}

function get(url: string): Promise<Response> {
  return fetch(url, {signal: AbortSignal.timeout(5000)});
}

function errorBody(code: string): {error: {code: string; message: string}} {
  return {error: {code, message: code}};
}

async function stopServices(services: RunningService[]): Promise<void> {
  const results = await Promise.allSettled(services.map(service => service.stop()));
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
  }
}

async function checkBoundedStore(path: string): Promise<void> {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(row => row.name), ['signature']);
    assert.deepEqual(db.prepare('PRAGMA table_info(signature)').all().map(row => row.name),
      ['singleton', 'id', 'algorithm', 'slots']);
    const rows = db.prepare('SELECT id, algorithm, slots FROM signature').all();
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.ok(row && typeof row.slots === 'string');
    const slots: unknown = JSON.parse(row.slots);
    assert.ok(validSignature({id: row.id, algorithm: row.algorithm, slots}, 'a'));
    assert.deepEqual(slots, sketch(...Array.from({length: 67}, (_, i) => `v${i}`)));
  } finally {
    db.close();
  }
}

test('integration: three real processes compare overlapping sets across a restart and keep constant-size SQLite state', async () => {
  const services: RunningService[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'minhash-'));
  try {
    await assert.rejects(runNode(process.execPath, ['--v8-pool-size=1', fileURLToPath(signatureEntry)], {
      ...childOptions, env: {...childOptions.env, HOST: '127.0.0.1', PORT: '-1', SET_ID: 'a', DB_PATH: 'file::memory:'},
    }), {code: 1, stdout: '', stderr: /DB_PATH must name a private SQLite file/});
    const path = join(dir, 'a.sqlite');
    const config = {SET_ID: 'a', DB_PATH: path};
    const a = await startService(signatureEntry, config);
    services.push(a);
    const b = await startService(signatureEntry, {SET_ID: 'b', DB_PATH: join(dir, 'b.sqlite')});
    services.push(b);
    const compare = await startService(compareEntry, {SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url});
    services.push(compare);

    const similarity = compare.url + '/similarity';
    await expectResponse(await get(similarity), 200,
      {algorithm: expectedAlgorithm, matches: 8, similarity: 1, unionSlots: emptySlots});
    await expectResponse(await get(similarity + '?source=http://elsewhere'), 400, errorBody('invalid_request'));
    await expectResponse(await jsonRequest(similarity, {}), 405, errorBody('method_not_allowed'));
    for (const body of [null, [], true, 0, 'v0', {value: 'v0', extra: 1}, {value: {toString: null}},
      {value: 'v01'}, {value: 'v256'}]) {
      await expectResponse(await jsonRequest(a.url + '/values', body), 400, errorBody('invalid_request'));
    }
    await expectResponse(await get(a.url + '/signature'), 200, {...aSignature, slots: emptySlots});

    for (const [value, changed] of [['v0', true], ['v1', true], ['v1', false]] as const) {
      await expectResponse(await jsonRequest(a.url + '/values', {value}), 200, {changed});
    }
    await expectResponse(await get(similarity), 200,
      {algorithm: expectedAlgorithm, matches: 0, similarity: 0, unionSlots: leftSlots});
    for (const value of ['v2', 'v1']) {
      await expectResponse(await jsonRequest(b.url + '/values', {value}), 200, {changed: true});
    }
    await expectResponse(await get(a.url + '/signature'), 200, aSignature);
    await expectResponse(await get(b.url + '/signature'), 200, bSignature);
    await expectResponse(await get(similarity), 200, expectedOverlap);

    await a.stop();
    await assert.rejects(runNode(process.execPath, ['--v8-pool-size=1', fileURLToPath(signatureEntry)], {
      ...childOptions, env: {...childOptions.env, HOST: '127.0.0.1', PORT: '0', SET_ID: 'b', DB_PATH: path},
    }), {code: 1, stdout: '', stderr: /identity mismatch/});

    const restarted = await startService(signatureEntry, {...config, PORT: new URL(a.url).port});
    services.push(restarted);
    assert.equal(restarted.url, a.url);
    await expectResponse(await get(restarted.url + '/signature'), 200, aSignature);
    await expectResponse(await jsonRequest(restarted.url + '/values', {value: 'v0'}), 200, {changed: false});
    // v63 was never sent to A and cannot lower any of its eight minima.
    await expectResponse(await jsonRequest(restarted.url + '/values', {value: 'v63'}), 200, {changed: false});
    for (let repetition = 0; repetition < 3; repetition++) {
      await expectResponse(await get(similarity), 200, expectedOverlap);
    }

    for (let i = 2; i < 67; i++) {
      const response = await jsonRequest(restarted.url + '/values', {value: `v${i}`});
      const body: unknown = await response.json();
      assert.equal(response.status, 200);
      assert.ok(body && typeof body === 'object' && 'changed' in body && typeof body.changed === 'boolean');
      assert.deepEqual(body, {changed: body.changed});
    }
    await checkBoundedStore(path);
  } finally {
    try { await stopServices(services); }
    finally { await rm(dir, {recursive: true, force: true}); }
  }
});

test('integration: comparison rejects invalid upstreams, contains redirects, and bounds the entire JSON body', async () => {
  const services: RunningService[] = [];
  try {
    const b = await startService(upstreamEntry, {FIXTURE_ID: 'b'});
    services.push(b);
    const a = await startService(upstreamEntry, {FIXTURE_ID: 'a', REDIRECT_TO: b.url + '/redirect-target'});
    services.push(a);
    const compare = await startService(compareEntry, {SOURCE_A_ORIGIN: a.url, SOURCE_B_ORIGIN: b.url});
    services.push(compare);
    const similarity = compare.url + '/similarity';
    await expectResponse(await get(similarity), 200, expectedOverlap);
    await expectResponse(await jsonRequest(a.url + '/mode', {mode: {toString: null}}), 400, errorBody('invalid_request'));

    for (const mode of ['id', 'algorithm', 'extra', 'primitive', 'partial-null', 'malformed', 'status', 'oversize', 'gzip']) {
      await expectResponse(await jsonRequest(a.url + '/mode', {mode}), 200, {mode});
      await expectResponse(await get(similarity), 502, errorBody('upstream_failure'));
    }
    await expectResponse(await jsonRequest(a.url + '/mode', {mode: 'at-limit'}), 200, {mode: 'at-limit'});
    await expectResponse(await get(similarity), 200, expectedOverlap);
    await expectResponse(await jsonRequest(a.url + '/mode', {mode: 'oversize-open'}), 200, {mode: 'oversize-open'});
    await expectResponse(await get(similarity), 502, errorBody('upstream_failure'));
    await expectResponse(await get(a.url + '/oversize-cancellation'), 200, {cancelledBeforeMoreData: true});

    await expectResponse(await jsonRequest(a.url + '/mode', {mode: 'redirect'}), 200, {mode: 'redirect'});
    await expectResponse(await get(similarity), 502, errorBody('upstream_failure'));
    await expectResponse(await get(b.url + '/redirect-hits'), 200, {hits: 0});

    for (const mode of ['split', 'slow-body']) {
      await expectResponse(await jsonRequest(a.url + '/mode', {mode}), 200, {mode});
      if (mode === 'split') await expectResponse(await get(similarity), 200, expectedOverlap);
      else await expectResponse(await get(similarity), 502, errorBody('upstream_failure'));
    }

    await a.stop();
    await expectResponse(await get(similarity), 502, errorBody('upstream_failure'));
  } finally {
    await stopServices(services);
  }
});
