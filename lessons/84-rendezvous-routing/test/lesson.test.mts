import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as afterIO } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../../lib/http.mts';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { MembershipStore } from '../membership.mts';
import { isKey } from '../protocol.mts';
import { fetchLookup, memberOrigins } from '../upstream.mts';
import { test } from 'node:test';
import { ownerFor, scoreFor } from '../placement.mts';
import type { Member } from '../placement.mts';

test('unit: removing b preserves surviving owners and moves the keys b owned', () => {
  const fixtures = [
    { key: 'k0', before: 'b', after: 'a' },
    { key: 'k1', before: 'b', after: 'c' },
    { key: 'k2', before: 'a', after: 'a' },
    { key: 'k4', before: 'c', after: 'c' },
  ];
  for (const { key, before, after } of fixtures) {
    assert.equal(ownerFor(key, ['a', 'b', 'c']), before, key);
    assert.equal(ownerFor(key, ['a', 'c']), after, key);
  }
});

test('unit: SHA-256 scores and winners match literal golden vectors', () => {
  assert.equal(scoreFor('k0', 'a'), '48fabdc6d2dbe176c62cead45408344858f8e440538a67bb37ef9119a9191936');
  assert.equal(scoreFor('k9', 'a'), '036ec2115af8fdd9eea8e4c78a0acbc3232c6beff496cfd1342158e02ac917e4');
  for (const [key, expected] of [['k3', 'a'], ['k4', 'c'], ['k9', 'b'], ['k11', 'b']]) {
    assert.ok(key);
    assert.equal(ownerFor(key, ['a', 'b', 'c']), expected);
  }
});

const permutations: readonly (readonly Member[])[] = [
  ['a', 'b', 'c'], ['a', 'c', 'b'], ['b', 'a', 'c'],
  ['b', 'c', 'a'], ['c', 'a', 'b'], ['c', 'b', 'a'],
];

function oracle(key: string, members: readonly Member[]): Member {
  const ranked = members.map(member => ({
    member, digest: createHash('sha256').update(Buffer.from([key, member].join(':'), 'utf8')).digest(),
  })).sort((left, right) =>
    Buffer.compare(right.digest, left.digest) || left.member.charCodeAt(0) - right.member.charCodeAt(0));
  const first = ranked[0];
  assert.ok(first);
  return first.member;
}

test('unit: every canonical key agrees with a sorted byte-score oracle across membership changes', () => {
  const members = ['a', 'b', 'c'] satisfies Member[];
  for (let i = 0; i < 64; i++) {
    const key = `k${i}`;
    const full = oracle(key, members);
    for (const order of permutations) assert.equal(ownerFor(key, order), full, key);
    for (const removed of members) {
      const pair = members.filter(member => member !== removed);
      const reduced = ownerFor(key, pair);
      assert.equal(reduced, oracle(key, pair), key);
      assert.equal(ownerFor(key, [...pair].reverse()), reduced, key);
      assert.equal(reduced !== full, full === removed, key);
      const added = ownerFor(key, [...pair, removed]);
      assert.equal(added, full, key);
      assert.equal(added !== reduced, added === removed, key);
      for (const survivor of pair) {
        assert.equal(ownerFor(key, [survivor]), oracle(key, [survivor]), key);
        assert.equal(reduced !== survivor, reduced === pair.find(member => member !== survivor), key);
      }
    }
  }
});

test('unit: equal highest scores choose the ASCII-smallest member independent of enumeration', () => {
  for (const order of permutations) {
    assert.equal(ownerFor('k5', order, () => 'f'.repeat(64)), 'a');
    assert.equal(ownerFor('k5', order, (_key, member) => (member === 'a' ? '0' : 'f').repeat(64)), 'b');
  }
});

test('unit: modulo can move a surviving owner when b is removed', () => {
  const key = 'k2';
  const hash = BigInt('0x' + createHash('sha256').update(key).digest('hex'));
  assert.equal(['a', 'b', 'c'][Number(hash % 3n)], 'c');
  assert.equal(['a', 'c'][Number(hash % 2n)], 'a');
  assert.equal(ownerFor(key, ['a', 'b', 'c']), ownerFor(key, ['a', 'c']));
});

test('unit: route keys are exactly k0 through k63', () => {
  for (let i = 0; i < 64; i++) assert.equal(isKey(`k${i}`), true);
  for (const key of ['k64', 'k00', 'k01', 'K1', 'k-1', 'k1\n', '%6B1', 'k1/', null, 1, { toString: null }]) {
    assert.equal(isKey(key), false, JSON.stringify(key));
  }
});

function httpError(status: number, code: string) {
  return (error: unknown): boolean =>
    error instanceof HttpError && error.status === status && error.code === code && error.message === code;
}

async function withDb(run: (db: DatabaseSync) => void): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    run(db);
  } finally {
    db.close();
  }
}

test('unit: membership rejects invalid input without changing the committed snapshot', async () => {
  await withDb(db => {
    const store = new MembershipStore(db);
    const invalid = [
      null, [], 'a', 4, true, {}, { members: ['a'], extra: true },
      { members: [] }, { members: ['a', 'a'] }, { members: ['d'] },
      { members: ['a', 'b', 'c', 'a'] }, { members: 'abc' }, { members: null },
      { members: [0] }, { members: [{ toString: null }] },
    ];
    for (const body of invalid) {
      assert.throws(() => store.update(body), httpError(400, 'invalid_membership'), JSON.stringify(body));
      assert.deepEqual(store.read(), { revision: 0, members: ['a', 'b', 'c'] });
    }
  });
});

test('unit: membership sorts input and increments only for actual changes through revision 16', async () => {
  await withDb(db => {
    const store = new MembershipStore(db);
    assert.deepEqual(store.update({ members: ['c', 'a', 'b'] }), { revision: 0, members: ['a', 'b', 'c'] });
    const first = store.update({ members: ['c', 'a'] });
    assert.deepEqual(first, { revision: 1, members: ['a', 'c'] });
    assert.deepEqual(store.update({ members: ['a', 'c'] }), first);
    for (let revision = 2; revision <= 16; revision++) {
      const members = revision % 2 === 0 ? ['b'] : ['a', 'c'];
      assert.deepEqual(store.update({ members }), { revision, members });
    }
    assert.deepEqual(store.update({ members: ['b'] }), { revision: 16, members: ['b'] });
    assert.throws(() => store.update({ members: ['a'] }), httpError(409, 'revision_exhausted'));
    assert.deepEqual(store.read(), { revision: 16, members: ['b'] });
  });
});

test('unit: reopening SQLite retains the committed membership and revision', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'rendezvous-unit-'));
  try {
    const path = join(dir, 'membership.sqlite');
    const first = new DatabaseSync(path);
    try {
      const store = new MembershipStore(first);
      store.update({ members: ['c'] });
      store.update({ members: ['c', 'b'] });
    } finally {
      first.close();
    }
    const second = new DatabaseSync(path);
    try {
      const store = new MembershipStore(second);
      assert.deepEqual(store.read(), { revision: 2, members: ['b', 'c'] });
      assert.deepEqual(store.update({ members: ['a'] }), { revision: 3, members: ['a'] });
    } finally {
      second.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unit: a late SQLite statement failure rolls back membership and revision together', async () => {
  await withDb(db => {
    const store = new MembershipStore(db);
    store.update({ members: ['c', 'b'] });
    // SQLite FAIL preserves earlier changes of the statement until the transaction is rolled back.
    db.exec(`
      CREATE TRIGGER reject_update AFTER UPDATE ON membership
      BEGIN SELECT RAISE(FAIL, 'injected write failure'); END;
    `);
    assert.throws(() => store.update({ members: ['a'] }), /injected write failure/);
    assert.deepEqual(store.read(), { revision: 1, members: ['b', 'c'] });
    db.exec('DROP TRIGGER reject_update');
    assert.deepEqual(store.update({ members: ['a'] }), { revision: 2, members: ['a'] });
  });
});

const loopback = 'http://127.0.0.1:8123';

test('unit: all configured origins are normalized and collisions are rejected', () => {
  assert.deepEqual(memberOrigins('HTTP://127.0.0.1:08123/', 'http://127.0.0.1:80/', 'http://127.0.0.1:8125'), {
    a: loopback, b: 'http://127.0.0.1', c: 'http://127.0.0.1:8125',
  });
  assert.equal(memberOrigins(loopback, 'http://127.0.0.1:06000/', 'http://127.0.0.1:8125').b, 'http://127.0.0.1:6000');
  assert.throws(() => memberOrigins(loopback, 'http://127.0.0.1:08123/', 'http://127.0.0.1:8125'), /distinct/);
  assert.throws(() => memberOrigins(loopback, 'http://127.0.0.1', 'HTTP://127.0.0.1:80/'), /distinct/);
  for (const invalid of [
    undefined, 'https://127.0.0.1:8124', 'http://localhost:8124', 'http://127.1:8124',
    'http://0x7f000001:8124', 'http://127.0.0.2:8124', 'http://127.0.0.1:0',
    'http://127.0.0.1:65536', 'http://user@127.0.0.1:8124', 'http://127.0.0.1:8124/?',
    'http://127.0.0.1:8124/#', 'http://127.0.0.1:8124/x', 'http://127.0.0.1:8124\n',
  ]) {
    assert.throws(() => memberOrigins(loopback, invalid, 'http://127.0.0.1:8125'));
  }
});

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const upstreamJsonHeaders = { 'content-type': [jsonHeaders['content-type']] };
const lookup = { member: 'b', key: 'k0', value: 'b/k0' };

function wireReply(wire: string | Uint8Array, statusCode = 200, headersDistinct: IncomingMessage['headersDistinct'] = upstreamJsonHeaders) {
  return {
    statusCode, headersDistinct,
    destroy() {},
    async *[Symbol.asyncIterator]() { yield typeof wire === 'string' ? Buffer.from(wire) : wire; },
  };
}

function jsonReply(body: unknown, statusCode = 200, headers: IncomingMessage['headersDistinct'] = upstreamJsonHeaders) {
  return wireReply(JSON.stringify(body), statusCode, headers);
}

function openReply(chunks: Uint8Array[], signal: AbortSignal, destroy: () => void) {
  return {
    statusCode: 200, headersDistinct: upstreamJsonHeaders, destroy,
    async *[Symbol.asyncIterator]() {
      yield* chunks;
      if (!signal.aborted) {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      }
    },
  };
}

test('unit: lookup sends one request to the fixed owner URL', async () => {
  let calls = 0;
  const value = await fetchLookup(loopback, 'b', 'k0', async url => {
    calls++;
    assert.equal(url, loopback + '/lookup/k0');
    return jsonReply(lookup, 200, { ...upstreamJsonHeaders, 'content-encoding': ['identity'] });
  });
  assert.equal(value, 'b/k0');
  assert.equal(calls, 1);
});

test('unit: lookup accepts valid JSON at the 8192-byte limit', async () => {
  const wire = JSON.stringify(lookup);
  const exact = wire.padEnd(8192);
  assert.equal(await fetchLookup(loopback, 'b', 'k0', async () => wireReply(exact)), 'b/k0');
});

test('unit: lookup cancels an unfinished body as soon as cumulative bytes reach 8193', async () => {
  const wire = Buffer.from(JSON.stringify(lookup));
  const chunks = [wire, Buffer.alloc(4096, ' '), Buffer.alloc(8193 - 4096 - wire.length, ' ')];
  let cancelled = false;
  const rejected = assert.rejects(
    fetchLookup(loopback, 'b', 'k0', async (_url, signal) => openReply(chunks, signal, () => { cancelled = true; })),
    httpError(502, 'upstream_failure'),
  );
  try {
    assert.equal(await Promise.race([rejected.then(() => 'rejected'), afterIO('pending')]), 'rejected');
    assert.equal(cancelled, true);
  } finally {
    await rejected;
  }
});

test('unit: complete-looking JSON without EOF remains pending until the deadline aborts it', async () => {
  let cancelled = false;
  let signal: AbortSignal | undefined;
  const pending = fetchLookup(loopback, 'b', 'k0', async (_url, requestSignal) => {
    signal = requestSignal;
    return openReply([Buffer.from(JSON.stringify(lookup))], requestSignal, () => { cancelled = true; });
  });
  const rejected = assert.rejects(pending, httpError(502, 'upstream_failure'));
  try {
    assert.equal(await Promise.race([rejected.then(() => 'rejected'), afterIO('pending')]), 'pending');
    assert.equal(signal?.aborted, false);
  } finally {
    await rejected;
  }
  assert.equal(signal?.aborted, true);
  assert.equal(cancelled, true);
});

function stagedLookup(finishAt: number): Promise<string> {
  const start = 10;
  let now = start;
  return fetchLookup(loopback, 'b', 'k0', async () => {
    now = start + 300;
    return {
      statusCode: 200, headersDistinct: upstreamJsonHeaders,
      destroy() {},
      async *[Symbol.asyncIterator]() {
        now = start + finishAt - 1;
        yield Buffer.from(JSON.stringify(lookup));
        now = start + finishAt;
      },
    };
  }, () => now);
}

test('unit: lookup accepts EOF at 499 ms total after headers arrive at 300 ms', async () => {
  assert.equal(await stagedLookup(499), 'b/k0');
});

test('unit: lookup rejects EOF at 500 ms total after headers arrive at 300 ms even before the timer fires', async () => {
  await assert.rejects(stagedLookup(500), httpError(502, 'upstream_failure'));
});

test('unit: lookup rejects a combined Content-Type after a valid JSON parameter', async () => {
  const reply = jsonReply(lookup, 200, { 'content-type': ['application/json; charset=utf-8, text/plain'] });
  await assert.rejects(fetchLookup(loopback, 'b', 'k0', async () => reply), httpError(502, 'upstream_failure'));
});

test('unit: lookup rejects malformed Content-Type parameters', async () => {
  for (const contentType of ['application/json; charset', 'application/json; charset="utf-8']) {
    const reply = jsonReply(lookup, 200, { 'content-type': [contentType] });
    await assert.rejects(fetchLookup(loopback, 'b', 'k0', async () => reply), httpError(502, 'upstream_failure'), contentType);
  }
});

test('unit: lookup accepts a complete JSON Content-Type with a quoted parameter', async () => {
  const reply = jsonReply(lookup, 200, { 'content-type': ['Application/JSON; charset="UTF-8"'] });
  assert.equal(await fetchLookup(loopback, 'b', 'k0', async () => reply), 'b/k0');
});

test('unit: lookup rejects wrong statuses, encoding, types and identities', async () => {
  const replies = [
    jsonReply(lookup, 404),
    jsonReply(lookup, 200, { ...upstreamJsonHeaders, 'content-encoding': ['gzip'] }),
    jsonReply(lookup, 200, { 'content-type': ['text/plain'] }),
    wireReply(Buffer.from([0xc3, 0x28])),
    wireReply('{'),
    jsonReply(null), jsonReply([]), jsonReply('b/k0'),
    jsonReply({ ...lookup, extra: 1 }), jsonReply({ member: 'b', key: 'k0' }),
    jsonReply({ ...lookup, member: 'a' }), jsonReply({ ...lookup, key: 'k1' }),
    jsonReply({ ...lookup, value: 'a/k0' }), jsonReply({ ...lookup, value: { toString: null } }),
  ];
  for (const reply of replies) {
    await assert.rejects(fetchLookup(loopback, 'b', 'k0', async () => reply), httpError(502, 'upstream_failure'));
  }
});

const entry = (name: string) => new URL(`../${name}.mts`, import.meta.url);

test('unit: importing both entrypoints is silent even with invalid runtime settings', async () => {
  const probe = [entry('backend'), entry('router')].map(url => `await import(${JSON.stringify(url.href)})`).join('\n');
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath, ['--v8-pool-size=1', '--input-type=module', '-e', probe],
    {
      timeout: 3000,
      env: {
        PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1', HOST: 'invalid host', PORT: 'invalid',
        MEMBER_ID: 'wrong', MEMBER_A_ORIGIN: 'wrong', MEMBER_B_ORIGIN: 'wrong', MEMBER_C_ORIGIN: 'wrong',
        DB_PATH: '',
      },
    },
  );
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

async function request(
  origin: string, path: string, expectedStatus: number, options: RequestInit = {},
): Promise<unknown> {
  const res = await fetch(origin + path, { ...options, signal: AbortSignal.timeout(3000) });
  const body: unknown = await res.json();
  assert.equal(res.status, expectedStatus, `${options.method ?? 'GET'} ${path}: ${JSON.stringify(body)}`);
  return body;
}

async function rawGet(origin: string, path: string, body = '', leadingFields = 0): Promise<unknown> {
  const headers: string[] = ['host', new URL(origin).host];
  for (let i = 0; i < leadingFields; i++) headers.push('x', 'x');
  headers.push('content-length', String(Buffer.byteLength(body)));
  const res = await new Promise<IncomingMessage>((resolve, reject) => {
    const req = httpRequest(origin, {
      path, method: 'GET', headers,
      signal: AbortSignal.timeout(3000),
    }, resolve);
    req.once('error', reject);
    req.end(body);
  });
  res.setEncoding('utf8');
  let wire = '';
  for await (const chunk of res) {
    assert.equal(typeof chunk, 'string');
    wire += chunk;
    assert.ok(Buffer.byteLength(wire) <= 8192);
  }
  assert.equal(res.statusCode, 400);
  const decoded: unknown = JSON.parse(wire);
  return decoded;
}

function put(body: unknown): RequestInit {
  return { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(body) };
}

function errorBody(code: string) {
  return { error: { code, message: code } };
}

function expectedRoute(revision: number, members: Member[], owner: Member, key: string) {
  return { revision, members, owner, key, value: `${owner}/${key}` };
}

function routerEnv(dbPath: string, origins: Record<Member, string>): Record<string, string> {
  return {
    DB_PATH: dbPath,
    MEMBER_A_ORIGIN: origins.a,
    MEMBER_B_ORIGIN: origins.b,
    MEMBER_C_ORIGIN: origins.c,
  };
}

type AcquireService = (file: URL, env: Record<string, string>) => Promise<RunningService>;

async function withServices(run: (acquire: AcquireService, dbPath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'rendezvous-http-'));
  try {
    const services: RunningService[] = [];
    try {
      await run(async (file, env) => {
        const service = await startService(file, env);
        services.push(service);
        return service;
      }, join(dir, 'membership.sqlite'));
    } finally {
      const stopped = await Promise.allSettled(services.reverse().map(service => service.stop()));
      const errors = stopped.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'Failed to stop test services');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function assertCounts(origins: Record<Member, string>, counts: Record<Member, number>): Promise<void> {
  await Promise.all((['a', 'b', 'c'] satisfies Member[]).map(async member => {
    assert.deepEqual(await request(origins[member], '/stats', 200), { requests: counts[member] }, member);
  }));
}

test('integration: real router contacts only each owner and retains placement after restart', async () => {
  await withServices(async (acquire, dbPath) => {
    const a = await acquire(entry('backend'), { MEMBER_ID: 'a' });
    const b = await acquire(entry('backend'), { MEMBER_ID: 'b' });
    const c = await acquire(entry('backend'), { MEMBER_ID: 'c' });
    const origins = { a: a.url, b: b.url, c: c.url };
    const env = routerEnv(dbPath, origins);
    const router = await acquire(entry('router'), env);

    const members: Member[] = ['a', 'b', 'c'];
    assert.deepEqual(await request(router.url, '/route/k2', 200), expectedRoute(0, members, 'a', 'k2'));
    await assertCounts(origins, { a: 1, b: 0, c: 0 });
    assert.deepEqual(await request(router.url, '/route/k0', 200), expectedRoute(0, members, 'b', 'k0'));
    await assertCounts(origins, { a: 1, b: 1, c: 0 });
    assert.deepEqual(await request(router.url, '/route/k4', 200), expectedRoute(0, members, 'c', 'k4'));
    await assertCounts(origins, { a: 1, b: 1, c: 1 });

    const reduced: Member[] = ['a', 'c'];
    assert.deepEqual(await request(router.url, '/membership', 200, put({ members: ['c', 'a'] })), {
      revision: 1, members: reduced,
    });
    assert.deepEqual(await request(router.url, '/route/k0', 200), expectedRoute(1, reduced, 'a', 'k0'));
    assert.deepEqual(await request(router.url, '/route/k4', 200), expectedRoute(1, reduced, 'c', 'k4'));
    await assertCounts(origins, { a: 2, b: 1, c: 2 });

    await router.stop();
    const restarted = await acquire(entry('router'), env);
    assert.deepEqual(await request(restarted.url, '/route/k0', 200), expectedRoute(1, reduced, 'a', 'k0'));
    assert.deepEqual(await request(restarted.url, '/route/k4', 200), expectedRoute(1, reduced, 'c', 'k4'));
    await assertCounts(origins, { a: 3, b: 1, c: 3 });

    await a.stop();
    assert.deepEqual(await request(restarted.url, '/route/k0', 502), errorBody('upstream_failure'));
    assert.deepEqual(await request(b.url, '/stats', 200), { requests: 1 });
    assert.deepEqual(await request(c.url, '/stats', 200), { requests: 3 });
  });
});

test('integration: HTTP input is strict and revision exhaustion leaves routing intact', async () => {
  await withServices(async (acquire, dbPath) => {
    const a = await acquire(entry('backend'), { MEMBER_ID: 'a' });
    const b = await acquire(entry('backend'), { MEMBER_ID: 'b' });
    const c = await acquire(entry('backend'), { MEMBER_ID: 'c' });
    const origins = { a: a.url, b: b.url, c: c.url };
    const router = await acquire(entry('router'), routerEnv(dbPath, origins));

    for (const [origin, path] of [
      [router.url, '/route/k0?owner=b'],
      [a.url, '/lookup/k0?member=a'], [a.url, '/stats?verbose=1'],
    ] as const) assert.deepEqual(await request(origin, path, 400), errorBody('invalid_request'));
    assert.deepEqual(await rawGet(router.url, '/route/k0?'), errorBody('invalid_request'));
    for (const [origin, path] of [[router.url, '/route/k0'], [a.url, '/lookup/k0'], [a.url, '/stats']] as const) {
      assert.deepEqual(await rawGet(origin, path, '{}'), errorBody('invalid_request'));
    }
    await assertCounts(origins, { a: 0, b: 0, c: 0 });
    for (const [origin, path] of [[router.url, '/route/k0'], [a.url, '/lookup/k0'], [a.url, '/stats']] as const) {
      assert.deepEqual(await rawGet(origin, path, '{}', 1100), errorBody('invalid_request'));
    }
    await assertCounts(origins, { a: 0, b: 0, c: 0 });
    for (const key of ['', 'k00', '%6B0', 'k64', 'k0/other']) {
      assert.deepEqual(await request(router.url, '/route/' + key, 400), errorBody('invalid_key'));
      assert.deepEqual(await request(a.url, '/lookup/' + key, 400), errorBody('invalid_key'));
    }
    assert.deepEqual(await request(router.url, '/missing', 404), errorBody('not_found'));
    assert.deepEqual(await request(router.url, '/route/k0', 405, { method: 'POST' }), errorBody('method_not_allowed'));
    assert.deepEqual(await request(router.url, '/membership', 405), errorBody('method_not_allowed'));
    assert.deepEqual(await request(router.url, '/membership?revision=0', 400, put({ members: ['b'] })), errorBody('invalid_request'));
    for (const body of [null, [], 1, { members: ['a'], extra: 1 }, { members: [{ toString: null }] }]) {
      assert.deepEqual(await request(router.url, '/membership', 400, put(body)), errorBody('invalid_membership'));
    }
    assert.deepEqual(await request(router.url, '/membership', 400, {
      ...put(null), body: '{',
    }), errorBody('invalid_json'));
    assert.deepEqual(await request(router.url, '/membership', 415, {
      method: 'PUT', body: '{"members":["a"]}',
    }), errorBody('unsupported_media_type'));
    assert.deepEqual(await request(router.url, '/membership', 413, {
      ...put(null), body: '{"members":["a"]}'.padEnd(8193),
    }), errorBody('body_too_large'));
    await assertCounts(origins, { a: 0, b: 0, c: 0 });

    for (let i = 1; i <= 16; i++) {
      const members = i % 2 === 0 ? ['a'] : ['b'];
      assert.deepEqual(await request(router.url, '/membership', 200, put({ members })), { revision: i, members });
    }
    assert.deepEqual(await request(router.url, '/membership', 200, put({ members: ['a'] })), {
      revision: 16, members: ['a'],
    });
    assert.deepEqual(await request(router.url, '/membership', 409, put({ members: ['b'] })), errorBody('revision_exhausted'));
    assert.deepEqual(await request(router.url, '/route/k0', 200), expectedRoute(16, ['a'], 'a', 'k0'));
    await assertCounts(origins, { a: 1, b: 0, c: 0 });
  });
});

test('integration: full upstream contract is checked and an in-flight route keeps its captured revision', async () => {
  await withServices(async (acquire, dbPath) => {
    const a = await acquire(entry('backend'), { MEMBER_ID: 'a' });
    const c = await acquire(entry('backend'), { MEMBER_ID: 'c' });
    const b = await acquire(new URL('./upstream-fixture.mts', import.meta.url), { DESTINATION: c.url });
    const origins = { a: a.url, b: b.url, c: c.url };
    const router = await acquire(entry('router'), routerEnv(dbPath, origins));
    const setMode = async (mode: string) => {
      assert.deepEqual(await request(b.url, '/mode', 200, put({ mode })), { mode });
    };
    assert.deepEqual(await request(b.url, '/mode', 400, put({ mode: { toString: null } })), errorBody('invalid_mode'));

    await setMode('421-once');
    assert.deepEqual(await request(router.url, '/route/k0', 502), errorBody('upstream_failure'));
    await assertCounts(origins, { a: 0, b: 1, c: 0 });
    assert.deepEqual(await request(router.url, '/route/k0', 200), expectedRoute(0, ['a', 'b', 'c'], 'b', 'k0'));
    await assertCounts(origins, { a: 0, b: 2, c: 0 });

    await setMode('exact-limit');
    assert.deepEqual(await request(router.url, '/route/k0', 200), expectedRoute(0, ['a', 'b', 'c'], 'b', 'k0'));
    await assertCounts(origins, { a: 0, b: 3, c: 0 });

    await setMode('many-headers');
    assert.deepEqual(await request(router.url, '/route/k0', 200), expectedRoute(0, ['a', 'b', 'c'], 'b', 'k0'));
    await assertCounts(origins, { a: 0, b: 4, c: 0 });

    let count = 4;
    for (const mode of [
      'wrong-member', 'wrong-key', 'wrong-value', 'extra', 'missing', 'primitive', 'array', 'null',
      'malformed', 'invalid-utf8', 'media-type', 'gzip', 'late-encoding', 'oversized-headers',
      'status', 'length', 'chunked', 'redirect', 'stall',
    ]) {
      await setMode(mode);
      const started = performance.now();
      assert.deepEqual(await request(router.url, '/route/k0', 502), errorBody('upstream_failure'), mode);
      const elapsed = performance.now() - started;
      if (mode === 'chunked') {
        assert.ok(elapsed < 400, `Expected the open oversized body to fail before the deadline, got ${elapsed}ms`);
      } else if (mode === 'stall') {
        assert.ok(elapsed >= 400 && elapsed < 1500, `Expected full-body deadline, got ${elapsed}ms`);
      }
      // c is both a reachable redirect destination and a potential fallback.
      await assertCounts(origins, { a: 0, b: ++count, c: 0 });
    }

    await setMode('barrier');
    const inFlight = request(router.url, '/route/k0', 200);
    try {
      // Observe the selected backend receiving the request before changing membership.
      const arrived = await Promise.race([
        request(b.url, '/arrived', 200),
        inFlight.then(() => assert.fail('Barrier response completed before release')),
      ]);
      assert.deepEqual(arrived, { arrived: true });
      assert.deepEqual(await request(router.url, '/membership', 200, put({ members: ['c', 'a'] })), {
        revision: 1, members: ['a', 'c'],
      });
      assert.deepEqual(await request(b.url, '/release', 200, put({})), { released: true });
      assert.deepEqual(await inFlight, expectedRoute(0, ['a', 'b', 'c'], 'b', 'k0'));
    } finally {
      await Promise.allSettled([inFlight]);
    }
    assert.deepEqual(await request(router.url, '/route/k0', 200), expectedRoute(1, ['a', 'c'], 'a', 'k0'));
    await assertCounts(origins, { a: 1, b: count + 1, c: 0 });
  });
});

test('integration: router connects to the selected backend directly with an environment proxy enabled', async () => {
  await withServices(async (acquire, dbPath) => {
    const a = await acquire(entry('backend'), { MEMBER_ID: 'a' });
    const b = await acquire(entry('backend'), { MEMBER_ID: 'b' });
    const c = await acquire(entry('backend'), { MEMBER_ID: 'c' });
    const proxy = await acquire(new URL('./upstream-fixture.mts', import.meta.url), { PROXY_FIXTURE: '1' });
    const origins = { a: a.url, b: b.url, c: c.url };
    const router = await acquire(entry('router'), {
      ...routerEnv(dbPath, origins), NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxy.url, NO_PROXY: '',
    });

    assert.deepEqual(await request(router.url, '/route/k0', 200), expectedRoute(0, ['a', 'b', 'c'], 'b', 'k0'));
    assert.deepEqual(await request(proxy.url, '/stats', 200), { requests: 0 });
    await assertCounts(origins, { a: 0, b: 1, c: 0 });
  });
});
