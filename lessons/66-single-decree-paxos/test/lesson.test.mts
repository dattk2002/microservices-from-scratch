import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { AcceptorStore, ProposerStore } from '../store.mts';
import { Proposer } from '../engine.mts';
import type { Exchange } from '../engine.mts';

const targets = { a: 'http://127.0.0.1:41001', b: 'http://127.0.0.1:41002', c: 'http://127.0.0.1:41003' };

test('unit: ballot 2 requested blue adopts red accepted by a,b at ballot 1 through b,c promises', async () => {
  const databases: DatabaseSync[] = [];
  try {
    const memory = () => { const db = new DatabaseSync(':memory:'); databases.push(db); return db; };
    const a = new AcceptorStore(memory(), 'a');
    const b = new AcceptorStore(memory(), 'b');
    const c = new AcceptorStore(memory(), 'c');
    a.accept(1, 'red'); b.accept(1, 'red');
    const send: Exchange = async (origin, path, body) => {
      if (origin === targets.a) throw new Error('a is down');
      const acceptor = origin === targets.b ? b : c;
      return { status: 200, body: path === '/prepare' ? acceptor.prepare(body.ballot) : acceptor.accept(body.ballot, body.value ?? 'blue') };
    };
    const store = new ProposerStore(memory(), targets);
    const result = await new Proposer(store, send).propose(2, 'blue');
    assert.deepEqual(result, { ballot: 2, requested: 'blue', value: 'red', phase: 'chosen' });
    assert.deepEqual(store.get(2), result);
  } finally { for (const db of databases.reverse()) db.close(); }
});

import { HttpError } from '../../../lib/http.mts';
import { origins, request, reply, semanticError } from '../protocol.mts';
import type { Id } from '../protocol.mts';

function fault(status: number, code: string) {
  return (error: unknown) => error instanceof HttpError && error.status === status && error.code === code;
}
async function cluster(work: (s: ProposerStore, replicas: Record<Id, AcceptorStore>, db: DatabaseSync) => Promise<void>) {
  const databases: DatabaseSync[] = [];
  try {
    const memory = () => { const db = new DatabaseSync(':memory:'); databases.push(db); return db; };
    const replicas = { a: new AcceptorStore(memory(), 'a'), b: new AcceptorStore(memory(), 'b'), c: new AcceptorStore(memory(), 'c') };
    const db = memory();
    await work(new ProposerStore(db, targets), replicas, db);
  } finally { for (const db of databases.reverse()) db.close(); }
}
function local(replicas: Record<Id, AcceptorStore>): Exchange {
  return async (origin, path, body) => {
    const id = (['a', 'b', 'c'] as const).find(id => targets[id] === origin);
    assert.ok(id);
    const r = replicas[id];
    return { status: 200, body: path === '/prepare' ? r.prepare(body.ballot) : r.accept(body.ballot, body.value ?? 'blue') };
  };
}

test('unit: durable promise survives reconstruction and every rejection leaves state intact', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let a = new AcceptorStore(db, 'a');
    a.accept(1, 'red'); a.prepare(3);
    const before = a.state();
    a = new AcceptorStore(db, 'a');
    assert.deepEqual(a.state(), before);
    assert.equal(a.prepare(2).ok, false);
    assert.equal(a.accept(2, 'blue').ok, false);
    assert.throws(() => a.accept(1, 'blue'), fault(409, 'ballot_conflict'));
    assert.deepEqual(a.state(), before);
    assert.throws(() => new AcceptorStore(db, 'b'), /identity/);
    assert.equal(a.prepare(3).ok, true);
    a.accept(3, 'red');
    assert.throws(() => a.accept(3, 'blue'), fault(409, 'ballot_conflict'));
    assert.deepEqual(a.accept(3, 'red').accepted, { ballot: 3, value: 'red' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get()?.n, 1);
  } finally { db.close(); }
});

test('unit: exact request and reply schemas reject primitives, extras and impossible states', () => {
  for (const body of [null, [], 2, true, 'red', {}, { ballot: '1' }, { ballot: 0 }, { ballot: 17 }, { ballot: 1.5 }, { ballot: { toString: null } }, { ballot: 1, extra: true }]) {
    assert.throws(() => request(body, false), fault(400, 'invalid_body'));
  }
  for (const value of [null, [], {}, { toString: null }, true, 1, 'green']) {
    assert.throws(() => request({ ballot: 1, value }, true), fault(400, 'invalid_body'));
  }
  assert.deepEqual(request({ ballot: 16, value: 'blue' }, true), { ballot: 16, value: 'blue' });
  assert.throws(() => request({ ballot: 1, value: 'blue', origin: targets.a }, true), fault(400, 'invalid_body'));
  const good = { id: 'a', ballot: 2, promised: 2, ok: true, accepted: { ballot: 1, value: 'red' } };
  assert.equal(reply(good, 'a', 2, '/prepare'), true);
  for (const bad of [null, [], 1, { ...good, extra: 1 }, { ...good, id: 'b' }, { ...good, ballot: 1 }, { ...good, ok: 1 }, { ...good, promised: 1 }, { ...good, accepted: [] }, { ...good, accepted: { ballot: 3, value: 'red' } }, { ...good, accepted: { ballot: 1, value: 'red', extra: 0 } }]) {
    assert.equal(reply(bad, 'a', 2, '/prepare'), false);
  }
  assert.equal(reply(good, 'a', 2, '/accept', 'red'), false);
  assert.equal(reply({ ...good, accepted: { ballot: 2, value: 'blue' } }, 'a', 2, '/accept', 'red'), false);
  assert.equal(semanticError({ error: { code: 'ballot_conflict', message: 'ballot_conflict' } }), true);
  for (const bad of [null, [], 'error', { error: { code: 'internal_error', message: 'internal_error' } }, { error: { code: 'ballot_conflict', message: 'wrong' } }, { error: { code: 'ballot_conflict', message: 'ballot_conflict', extra: 1 } }]) assert.equal(semanticError(bad), false);
});

test('unit: origins are normalized, distinct, loopback only and bound to persistent proposer identity', async () => {
  assert.deepEqual(origins(targets.a + '/', targets.b, targets.c), targets);
  for (const raw of [undefined, 'https://127.0.0.1:1', 'http://example.com', targets.a + '/path', 'http://user@127.0.0.1:1', targets.a + '?x=1']) assert.throws(() => origins(raw, targets.b, targets.c));
  assert.throws(() => origins(targets.a, targets.a + '/', targets.c), /distinct/);
  await cluster(async (store, _r, db) => {
    store.create(1, 'red');
    assert.equal(new ProposerStore(db, targets).get(1).requested, 'red');
    assert.throws(() => new ProposerStore(db, { ...targets, c: 'http://127.0.0.1:41004' }), /identity/);
    assert.throws(() => store.get(2), fault(404, 'unknown_ballot'));
    assert.throws(() => store.create(1, 'blue'), fault(409, 'ballot_conflict'));
    for (let b = 2; b <= 16; b++) store.create(b, 'blue');
    assert.equal(db.prepare('SELECT count(*) AS n FROM records').get()?.n, 16);
    assert.throws(() => store.create(17, 'red'), fault(400, 'invalid_body'));
  });
});

test('unit: duplicate or foreign identities and stale ballots never make a quorum', async () => {
  await cluster(async (store) => {
    for (const mode of ['duplicate', 'stale', 'malformed'] as const) {
      let accepts = 0;
      const send: Exchange = async (origin, path, body) => {
        if (path === '/accept') accepts++;
        return { status: 200, body: { id: mode === 'duplicate' ? 'a' : origin === targets.a ? 'a' : 'foreign', ballot: mode === 'stale' ? body.ballot - 1 : body.ballot, promised: body.ballot, ok: mode === 'malformed' ? 'true' : true, accepted: null } };
      };
      const b = mode === 'duplicate' ? 1 : mode === 'stale' ? 2 : 3;
      await assert.rejects(new Proposer(store, send).propose(b, 'blue'), fault(502, 'upstream_failure'));
      assert.equal(accepts, 0);
      assert.deepEqual(store.get(b), { ballot: b, requested: 'blue', value: null, phase: 'preparing' });
    }
  });
});

test('unit: differing values tied at highest accepted ballot invalidate the promise quorum', async () => {
  await cluster(async (store) => {
    let accepts = 0;
    const send: Exchange = async (origin, path, body) => {
      if (path === '/accept') accepts++;
      const id = origin === targets.a ? 'a' : origin === targets.b ? 'b' : 'c';
      return { status: 200, body: { id, ballot: body.ballot, promised: body.ballot, ok: true, accepted: id === 'c' ? null : { ballot: 1, value: id === 'a' ? 'red' : 'blue' } } };
    };
    await assert.rejects(new Proposer(store, send).propose(2, 'blue'), fault(502, 'upstream_failure'));
    assert.equal(accepts, 0);
    assert.equal(store.get(2).value, null);
  });
});

test('unit: one acceptance is uncertain, adopted value is durable before send, retry and chosen replay are safe', async () => {
  await cluster(async (store, replicas, db) => {
    const actual = local(replicas);
    let lose = true; const calls: string[] = [];
    const send: Exchange = async (origin, path, body, signal) => {
      calls.push(path);
      if (path === '/accept') {
        const durable = new ProposerStore(db, targets).get(body.ballot);
        assert.equal(durable.phase, 'accepting');
        assert.equal(durable.value, body.value);
        if (lose && origin === targets.c) throw new Error('c unavailable before accepting');
        const result = await actual(origin, path, body, signal);
        if (lose && origin === targets.b) throw new Error('reply lost AFTER persistent acceptance');
        return result;
      }
      return actual(origin, path, body, signal);
    };
    let proposer = new Proposer(store, send);
    await assert.rejects(proposer.propose(1, 'red'), fault(502, 'upstream_failure'));
    assert.equal(store.get(1).phase, 'accepting');
    assert.deepEqual(replicas.b.state().accepted, { ballot: 1, value: 'red' });
    lose = false;
    proposer = new Proposer(new ProposerStore(db, targets), send);
    const chosen = await proposer.propose(1, 'red');
    assert.equal(chosen.phase, 'chosen');
    const n = calls.length;
    assert.deepEqual(await proposer.propose(1, 'red'), chosen);
    assert.equal(calls.length, n);
    await assert.rejects(proposer.propose(1, 'blue'), fault(409, 'ballot_conflict'));
    assert.equal((await proposer.propose(2, 'blue')).value, 'red');
  });
});

test('unit: one actual acceptance cannot be reported chosen', async () => {
  await cluster(async (store, replicas) => {
    const actual = local(replicas);
    const send: Exchange = async (origin, path, body, signal) => {
      if (path === '/accept' && origin !== targets.a) throw new Error('down');
      return actual(origin, path, body, signal);
    };
    await assert.rejects(new Proposer(store, send).propose(1, 'blue'), fault(502, 'upstream_failure'));
    assert.equal(store.get(1).phase, 'accepting');
    assert.equal(replicas.b.state().accepted, null);
  });
});

test('unit: wrong accept values and unexpected semantic error codes cannot count as acceptances', async () => {
  await cluster(async (store, replicas) => {
    const actual = local(replicas);
    for (let b = 1; b <= 3; b++) {
      const send: Exchange = async (origin, path, body, signal) => {
        if (path === '/prepare' || origin === targets.a) return actual(origin, path, body, signal);
        if (b === 1) return { status: 409, body: { error: { code: 'internal_error', message: 'internal_error' } } };
        if (b === 2) return { status: 409, body: { error: { code: 'ballot_conflict', message: 'ballot_conflict' } } };
        return { status: 200, body: { id: origin === targets.b ? 'b' : 'c', ballot: b, promised: b, ok: true, accepted: { ballot: b, value: body.value === 'red' ? 'blue' : 'red' } } };
      };
      await assert.rejects(new Proposer(store, send).propose(b, 'red'), fault(502, 'upstream_failure'));
      assert.equal(store.get(b).phase, 'accepting');
    }
  });
});

test('unit: one total 500ms deadline spans prepares, accepts and complete replies', async () => {
  await cluster(async (store, replicas) => {
    let now = 0; const signals = new Set<AbortSignal>(); let calls = 0;
    const actual = local(replicas);
    const send: Exchange = async (origin, path, body, signal) => {
      signals.add(signal); calls++; now += 110;
      return actual(origin, path, body, signal);
    };
    await assert.rejects(new Proposer(store, send, () => now).propose(1, 'red'), fault(502, 'upstream_failure'));
    assert.equal(signals.size, 1);
    assert.equal(calls, 5);
    assert.equal(store.get(1).phase, 'accepting');
  });
});

test('unit: concurrent work returns busy and original ballot request remains immutable', async () => {
  await cluster(async (store, replicas) => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const actual = local(replicas);
    const send: Exchange = async (origin, path, body, signal) => { await gate; return actual(origin, path, body, signal); };
    const proposer = new Proposer(store, send);
    const pending = proposer.propose(1, 'red');
    try {
      await assert.rejects(proposer.propose(1, 'red'), fault(503, 'busy'));
      await assert.rejects(proposer.propose(1, 'blue'), fault(409, 'ballot_conflict'));
      await assert.rejects(proposer.propose(2, 'red'), fault(503, 'busy'));
      assert.throws(() => store.get(2), fault(404, 'unknown_ballot'));
    } finally { release?.(); await pending; }
  });
});

import { spawnSync } from 'node:child_process';
import { boundedJson } from '../transport.mts';

test('unit: imports are silent and inert even with invalid environment', () => {
  const entry = new URL('../acceptor.mts', import.meta.url).href;
  const proposer = new URL('../proposer.mts', import.meta.url).href;
  const fixture = new URL('./fixture.mts', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(entry)}); await import(${JSON.stringify(proposer)}); await import(${JSON.stringify(fixture)});`], {
    env: { PATH: process.env.PATH ?? '', PORT: 'invalid', DB_PATH: '/does/not/exist', REPLICA_ID: 'invalid', A_ORIGIN: 'invalid' }, encoding: 'utf8', timeout: 3000,
  });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
});

test('unit: upstream wire byte limit admits escaped valid JSON and rejects oversize otherwise-valid documents', async () => {
  const signal = new AbortController().signal;
  const value = { id: 'a', ballot: 1, promised: 1, ok: true, accepted: { ballot: 1, value: 'red' } };
  // Escape decoded string TOKENS only: booleans, null and numbers remain valid JSON.
  const escaped = JSON.stringify(value).replace(/"(?:[^"\\]|\\.)*"/g, token => {
    const decoded: unknown = JSON.parse(token); assert.equal(typeof decoded, 'string');
    if (typeof decoded !== 'string') throw new Error('Expected token');
    return '"' + [...decoded].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '"';
  });
  assert.deepEqual(JSON.parse(escaped), value);
  const response = (body: string) => new Response(body, { headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await boundedJson(response(escaped), signal), value);
  const padded = JSON.stringify(value).padEnd(8193, ' ');
  assert.deepEqual(JSON.parse(padded), value);
  await assert.rejects(boundedJson(response(padded), signal), /8192/);
  const error = { error: { code: 'ballot_conflict', message: 'ballot_conflict' } };
  const errorWire = JSON.stringify(error).padEnd(8193, ' ');
  assert.deepEqual(JSON.parse(errorWire), error);
  await assert.rejects(boundedJson(new Response(errorWire, { status: 409, headers: { 'content-type': 'application/json' } }), signal), /8192/);
  assert.deepEqual(await boundedJson(response(JSON.stringify(value).padEnd(8192, ' ')), signal), value);
  await assert.rejects(boundedJson(new Response('true'), signal), /Expected JSON/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(boundedJson(response(escaped), controller.signal), { name: 'AbortError' });
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  const body: unknown = await r.json(); return { status: r.status, body };
}
async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const r = await jsonRequest(url, body); const value: unknown = await r.json(); return { status: r.status, body: value };
}
function port(service: RunningService) { return new URL(service.url).port; }

test('integration: three durable processes preserve chosen red across acceptor and proposer restarts; minority is inspectable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'paxos66-'));
  const services: RunningService[] = [];
  try {
    const start = async (entry: 'acceptor' | 'proposer', env: Record<string, string>) => {
      const s = await startService(new URL(`../${entry}.mts`, import.meta.url), env); services.push(s); return s;
    };
    const aEnv = { REPLICA_ID: 'a', DB_PATH: join(dir, 'a.sqlite') };
    const bEnv = { REPLICA_ID: 'b', DB_PATH: join(dir, 'b.sqlite') };
    const cEnv = { REPLICA_ID: 'c', DB_PATH: join(dir, 'c.sqlite') };
    const a = await start('acceptor', aEnv);
    let b = await start('acceptor', bEnv);
    let c = await start('acceptor', cEnv);
    const cPort = port(c); await c.stop();
    const pEnv = { A_ORIGIN: a.url, B_ORIGIN: b.url, C_ORIGIN: c.url, DB_PATH: join(dir, 'p.sqlite') };
    let p = await start('proposer', pEnv);
    const first = { ballot: 1, requested: 'red', value: 'red', phase: 'chosen' };
    assert.deepEqual(await post(p.url + '/propose', { ballot: 1, value: 'red' }), { status: 200, body: first });
    assert.deepEqual(await get(p.url + '/attempts/1'), { status: 200, body: first });
    await p.stop();
    c = await start('acceptor', { ...cEnv, PORT: cPort });
    p = await start('proposer', pEnv);
    assert.deepEqual(await post(p.url + '/propose', { ballot: 2, value: 'blue' }), { status: 200, body: { ballot: 2, requested: 'blue', value: 'red', phase: 'chosen' } });
    assert.deepEqual(await get(c.url + '/state'), { status: 200, body: { id: 'c', promised: 2, accepted: { ballot: 2, value: 'red' } } });
    assert.equal((await post(b.url + '/prepare', { ballot: 4 })).status, 200);
    const bPort = port(b); await b.stop();
    b = await start('acceptor', { ...bEnv, PORT: bPort });
    const before = await get(b.url + '/state');
    assert.deepEqual(before.body, { id: 'b', promised: 4, accepted: { ballot: 2, value: 'red' } });
    for (const path of ['/prepare', '/accept']) {
      const result = await post(b.url + path, path === '/prepare' ? { ballot: 1 } : { ballot: 1, value: 'blue' });
      assert.deepEqual(result, { status: 200, body: { id: 'b', ballot: 1, promised: 4, ok: false, accepted: { ballot: 2, value: 'red' } } });
    }
    assert.equal((await post(b.url + '/accept', { ballot: 2, value: 'blue' })).status, 409);
    assert.deepEqual(await get(b.url + '/state'), before);
    for (const body of [null, [], true, 1, 'red', {}, { ballot: '1', value: 'red' }, { ballot: 1, value: { toString: null } }, { ballot: 1, value: 'red', extra: 1 }]) {
      assert.equal((await post(p.url + '/propose', body)).status, 400);
      assert.equal((await post(b.url + '/accept', body)).status, 400);
    }
    for (const body of [null, [], true, 1, {}, { ballot: '1' }, { ballot: 0 }, { ballot: 17 }, { ballot: { toString: null } }, { ballot: 2, value: 'red' }]) assert.equal((await post(b.url + '/prepare', body)).status, 400);
    const invalidJson = await fetch(b.url + '/accept', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{', signal: AbortSignal.timeout(3000) });
    assert.equal(invalidJson.status, 400); assert.deepEqual(await invalidJson.json(), { error: { code: 'invalid_body', message: 'invalid_body' } });
    assert.equal((await get(p.url + '/attempts/16')).status, 404);
    assert.equal((await get(p.url + '/attempts/1x')).status, 400);
    assert.equal((await post(p.url + '/propose', { ballot: 1, value: 'blue' })).status, 409);
    await b.stop(); await c.stop();
    assert.deepEqual(await post(p.url + '/propose', { ballot: 1, value: 'red' }), { status: 200, body: first });
    assert.equal((await post(p.url + '/propose', { ballot: 3, value: 'blue' })).status, 502);
    const minority = { status: 200, body: { ballot: 3, requested: 'blue', value: null, phase: 'preparing' } };
    assert.deepEqual(await get(p.url + '/attempts/3'), minority);
    await p.stop(); p = await start('proposer', pEnv);
    assert.deepEqual(await get(p.url + '/attempts/3'), minority);
    // Configuration mismatch must exit before readiness, without touching the old promise.
    await assert.rejects(start('acceptor', { ...bEnv, REPLICA_ID: 'c' }), /identity/);
    await p.stop();
    await assert.rejects(start('proposer', { ...pEnv, C_ORIGIN: a.url }), /distinct/);
    await assert.rejects(start('proposer', { ...pEnv, A_ORIGIN: c.url, C_ORIGIN: a.url }), /identity/);
  } finally {
    try { for (const service of services.reverse()) await service.stop(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
});

async function adversary(work: (p: RunningService, fixture: RunningService, restart: () => Promise<RunningService>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'paxos66-wire-'));
  const services: RunningService[] = [];
  try {
    const fixture = await startService(new URL('./fixture.mts', import.meta.url)); services.push(fixture);
    const topology = await get(fixture.url + '/topology');
    assert.equal(topology.status, 200);
    assert.ok(typeof topology.body === 'object' && topology.body !== null && 'b' in topology.body && 'c' in topology.body && 'sink' in topology.body);
    assert.equal(typeof topology.body.b, 'string'); assert.equal(typeof topology.body.c, 'string');
    if (typeof topology.body.b !== 'string' || typeof topology.body.c !== 'string' || typeof topology.body.sink !== 'string') throw new Error('Bad topology');
    assert.notEqual(topology.body.sink, fixture.url);
    assert.notEqual(topology.body.sink, topology.body.b);
    assert.notEqual(topology.body.sink, topology.body.c);
    assert.equal((await get(topology.body.sink + '/health')).status, 200);
    const env = { A_ORIGIN: fixture.url, B_ORIGIN: topology.body.b, C_ORIGIN: topology.body.c, DB_PATH: join(dir, 'p.sqlite') };
    let p = await startService(new URL('../proposer.mts', import.meta.url), env); services.push(p);
    const restart = async () => { await p.stop(); p = await startService(new URL('../proposer.mts', import.meta.url), env); services.push(p); return p; };
    await work(p, fixture, restart);
  } finally {
    try { for (const service of services.reverse()) await service.stop(); }
    finally { await rm(dir, { recursive: true, force: true }); }
  }
}
async function mode(fixture: RunningService, mode: string, stage: '/prepare' | '/accept') {
  assert.equal((await post(fixture.url + '/control', { mode, stage })).status, 200);
}
function statsBody(value: unknown) {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  assert.ok('sink' in value && 'prepares' in value && 'accepts' in value && 'states' in value);
  assert.equal(typeof value.sink, 'number');
  return value;
}

test('integration: malformed promises never produce an accept, including foreign ids, stale ballots and schema-invalid JSON', async () => {
  await adversary(async (p, f) => {
    for (const bad of [null, [], true, 1, { mode: { toString: null }, stage: '/prepare' }, { mode: 'valid', stage: '/prepare', extra: 1 }]) assert.equal((await post(f.url + '/control', bad)).status, 400);
    let b = 0;
    for (const name of ['null', 'array', 'primitive', 'extra', 'duplicate', 'stale', 'wrong-field', 'unexpected-error', 'invalid-error', 'oversize', 'invalid-json', 'content-type']) {
      b++; await mode(f, name, '/prepare');
      assert.equal((await post(p.url + '/propose', { ballot: b, value: 'blue' })).status, 502, name);
      assert.deepEqual(await get(p.url + `/attempts/${b}`), { status: 200, body: { ballot: b, requested: 'blue', value: null, phase: 'preparing' } });
      const stats = statsBody((await get(f.url + '/stats')).body);
      assert.deepEqual(stats.accepts, { a: 0, b: 0, c: 0 });
    }
    await mode(f, 'escaped', '/prepare');
    assert.equal((await post(p.url + '/propose', { ballot: 13, value: 'blue' })).status, 200);
  });
});

test('integration: invalid acceptances and redirects cannot be counted; reachable redirect sink sees zero requests', async () => {
  await adversary(async (p, f) => {
    let b = 0;
    for (const name of ['null', 'array', 'primitive', 'extra', 'duplicate', 'stale', 'wrong-value', 'unexpected-error', 'invalid-error', 'conflict', 'oversize', 'invalid-json', 'content-type', 'redirect']) {
      b++; await mode(f, name, '/accept');
      assert.equal((await post(p.url + '/propose', { ballot: b, value: 'red' })).status, 502, name);
      // Inspect sink BEFORE another control operation; fixture counters never reset either.
      const stats = statsBody((await get(f.url + '/stats')).body);
      assert.equal(stats.sink, 0);
      assert.deepEqual(await get(p.url + `/attempts/${b}`), { status: 200, body: { ballot: b, requested: 'red', value: 'red', phase: 'accepting' } });
    }
    await mode(f, 'redirect', '/prepare');
    assert.equal((await post(p.url + '/propose', { ballot: 15, value: 'blue' })).status, 502);
    assert.equal(statsBody((await get(f.url + '/stats')).body).sink, 0);
    await mode(f, 'escaped', '/accept');
    assert.deepEqual(await post(p.url + '/propose', { ballot: 16, value: 'blue' }), { status: 200, body: { ballot: 16, requested: 'blue', value: 'red', phase: 'chosen' } });
  });
});

test('integration: lost acceptance replies survive proposer restart and retry the same durable adopted value', async () => {
  await adversary(async (p, f, restart) => {
    await mode(f, 'lost', '/accept');
    assert.equal((await post(p.url + '/propose', { ballot: 1, value: 'red' })).status, 502);
    assert.deepEqual(await get(p.url + '/attempts/1'), { status: 200, body: { ballot: 1, requested: 'red', value: 'red', phase: 'accepting' } });
    const stats = statsBody((await get(f.url + '/stats')).body);
    assert.deepEqual(stats.states, { a: { id: 'a', promised: 1, accepted: { ballot: 1, value: 'red' } }, b: { id: 'b', promised: 1, accepted: { ballot: 1, value: 'red' } }, c: { id: 'c', promised: 1, accepted: null } });
    p = await restart();
    await mode(f, 'valid', '/accept');
    const result = { status: 200, body: { ballot: 1, requested: 'red', value: 'red', phase: 'chosen' } };
    assert.deepEqual(await post(p.url + '/propose', { ballot: 1, value: 'red' }), result);
    const before = await get(f.url + '/stats');
    assert.deepEqual(await post(p.url + '/propose', { ballot: 1, value: 'red' }), result);
    assert.deepEqual(await get(f.url + '/stats'), before);
  });
});

test('integration: full-body timeout is bounded, in-flight work is busy, and phases share one budget', async () => {
  await adversary(async (p, f) => {
    await mode(f, 'hang', '/prepare');
    const started = performance.now();
    const pending = post(p.url + '/propose', { ballot: 1, value: 'red' });
    // Synchronize with the fixture having written headers and a complete JSON value,
    // but not HTTP end-of-body; no sleeps and no background polling loop in services.
    try {
      let reached = false;
      const until = performance.now() + 2000;
      while (performance.now() < until) {
        const stats = statsBody((await get(f.url + '/stats')).body);
        if (typeof stats.prepares === 'object' && stats.prepares !== null && 'b' in stats.prepares && typeof stats.prepares.b === 'number' && stats.prepares.b > 0) { reached = true; break; }
      }
      assert.equal(reached, true);
      assert.equal((await post(p.url + '/propose', { ballot: 1, value: 'red' })).status, 503);
      assert.equal((await post(p.url + '/propose', { ballot: 1, value: 'blue' })).status, 409);
      assert.equal((await pending).status, 502);
      assert.ok(performance.now() - started < 2000, 'body deadline must finish independently of a never-ending upstream body');
    } finally { await pending; }
    await mode(f, 'hang', '/accept');
    assert.equal((await post(p.url + '/propose', { ballot: 2, value: 'red' })).status, 502);
    assert.deepEqual(await get(p.url + '/attempts/2'), { status: 200, body: { ballot: 2, requested: 'red', value: 'red', phase: 'accepting' } });
    await mode(f, 'delay', '/prepare');
    // Each complete response takes 150ms; resetting a 500ms budget at each hop
    // would incorrectly let all six requests complete and report chosen.
    assert.equal((await post(p.url + '/propose', { ballot: 3, value: 'red' })).status, 502);
    const attempt = await get(p.url + '/attempts/3');
    assert.ok(typeof attempt.body === 'object' && attempt.body !== null && 'phase' in attempt.body);
    assert.notEqual(attempt.body.phase, 'chosen');
  });
});
