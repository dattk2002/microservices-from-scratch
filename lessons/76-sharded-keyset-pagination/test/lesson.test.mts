import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { scheduler } from 'node:timers/promises';
import { promisify } from 'node:util';
import { HttpError } from '../../../lib/http.mts';
import type { RunningService } from '../../../test/support.mts';
import { aggregate } from '../query.mts';
import { exact, isId, isScore, normalizeOrigins, parseQueryPage, parseShardPage, validatePage } from '../protocol.mts';
import type { Item, Vector } from '../protocol.mts';
import { ShardStore } from '../store.mts';
import { startService } from '../../../test/support.mts';

test('unit: one global cursor traverses three tied scores, including a first page entirely from shard a', async () => {
  const origins = { a: 'http://127.0.0.1:1234', b: 'http://127.0.0.1:1235' };
  const fetchShard: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const fromA = url.origin === origins.a;
    assert.ok(fromA || url.origin === origins.b);
    assert.equal(options?.redirect, 'error');
    assert.equal(url.pathname, fromA ? '/snapshots/3/page' : '/snapshots/2/page');
    assert.equal(url.searchParams.get('limit'), '2');
    const afterId = url.searchParams.get('afterId');
    assert.equal(url.searchParams.get('afterScore'), afterId === null ? null : '90');
    const items = afterId === null
      ? (fromA ? [{ id: 'a0', score: 90 }, { id: 'a1', score: 90 }] : [{ id: 'b0', score: 90 }])
      : afterId === 'a1' && !fromA ? [{ id: 'b0', score: 90 }] : [];
    return Response.json({ shard: fromA ? 'a' : 'b', revision: fromA ? 3 : 2, items });
  };

  const pinned = { a: 3, b: 2 };
  const first = await aggregate(origins, { snapshots: pinned, limit: 2, after: null }, fetchShard);
  assert.deepEqual(first, {
    snapshots: pinned, items: [{ id: 'a0', score: 90 }, { id: 'a1', score: 90 }],
    next: { id: 'a1', score: 90 },
  });
  const second = await aggregate(origins, { snapshots: pinned, limit: 2, after: first.next }, fetchShard);
  assert.deepEqual(second, {
    snapshots: pinned, items: [{ id: 'b0', score: 90 }], next: { id: 'b0', score: 90 },
  });
  const last = await aggregate(origins, { snapshots: pinned, limit: 2, after: second.next }, fetchShard);
  assert.deepEqual(last, { snapshots: pinned, items: [], next: null });
});

function errorIs(status: number, code: string) {
  return (error: unknown) => error instanceof HttpError &&
    error.status === status && error.code === code && error.message === code;
}

test('unit: the request parser requires the explicit vector and a complete canonical cursor', () => {
  assert.deepEqual(parseQueryPage('b=16&limit=4&a=0&afterId=b7&afterScore=0'), {
    snapshots: { a: 0, b: 16 }, limit: 4, after: { score: 0, id: 'b7' },
  });
  assert.deepEqual(parseShardPage('limit=1&afterScore=100&afterId=a0'), {
    limit: 1, after: { score: 100, id: 'a0' },
  });
  for (const query of [
    'limit=0&a=0&b=0', 'limit=5&a=0&b=0', 'limit=01&a=0&b=0', 'limit=%31&a=0&b=0',
    'limit=1&a=-0&b=0', 'limit=1&a=0&b=17', 'limit=1&a=0&b=1.0', 'limit=1&a=0',
    'limit=1&a=0&b=0&a=0', 'limit=1&a=0&b=0&url=x', 'limit=1&a=0&b=0&',
    'limit=1&a=0&b=0&afterScore=10', 'limit=1&a=0&b=0&afterId=a0',
    'limit=1&a=0&b=0&afterScore=101&afterId=a0', 'limit=1&a=0&b=0&afterScore=10&afterId=a8',
    'limit=1&a=0&b=0&afterScore=10&afterId=a0%0A',
  ]) {
    assert.throws(() => parseQueryPage(query), errorIs(400, 'invalid_request'), query);
  }
});

test('unit: origins normalize the default port and reject aliases of the same origin', () => {
  assert.deepEqual(normalizeOrigins('http://127.0.0.1:80/', 'http://127.0.0.1:1235/'), {
    a: 'http://127.0.0.1', b: 'http://127.0.0.1:1235',
  });
  assert.throws(() => normalizeOrigins('http://127.0.0.1:80/', 'http://127.0.0.1'), /distinct/);
  for (const a of [
    'http://localhost:1234', 'https://127.0.0.1:1234', 'http://127.0.0.1:0',
    'http://user@127.0.0.1:1234', 'http://127.0.0.1:1234/path', 'http://127.0.0.1:1234/?',
  ]) {
    assert.throws(() => normalizeOrigins(a, 'http://127.0.0.1:1235'), /loopback/, a);
  }
});

test('unit: upstream candidates must be owned, distinct, ordered and strictly after the global cursor', () => {
  const options = { limit: 2, after: { score: 90, id: 'a1' } };
  const good = { shard: 'a', revision: 3, items: [{ id: 'a2', score: 90 }, { id: 'a0', score: 89 }] };
  assert.deepEqual(validatePage(good, 'a', 3, options), good.items);
  for (const reply of [
    [good], null, true, { ...good, extra: 0 }, { ...good, shard: 'b' },
    { ...good, revision: 2 }, { ...good, revision: '3' }, { ...good, items: {} },
    { ...good, items: [{ id: 'a1', score: 90 }] }, { ...good, items: [{ id: 'a0', score: 90 }] },
    { ...good, items: [{ id: 'a7', score: 91 }] }, { ...good, items: good.items.toReversed() },
    { ...good, items: [{ id: 'a2', score: 90 }, { id: 'a2', score: 89 }] },
    { ...good, items: [{ id: 'b0', score: 90 }] }, { ...good, items: [{ id: 'a7\n', score: 90 }] },
    { ...good, items: [{ id: 'a3', score: { toString: null } }] },
    { ...good, items: [{ id: 'a3', score: -1 }] },
    { ...good, items: [{ id: 'a3', score: 88, extra: 0 }] },
    { ...good, items: [...good.items, { id: 'a6', score: 87 }] },
  ]) {
    assert.throws(() => validatePage(reply, 'a', 3, options), errorIs(502, 'upstream_failure'));
  }
});

test('unit: published snapshots preserve older scores and apply the cursor even if its ID belongs to the other shard', () => {
  using db = new DatabaseSync(':memory:');
  const store = new ShardStore(db, 'a');
  const first = { limit: 4, after: null };
  assert.deepEqual(store.page(0, first), { shard: 'a', revision: 0, items: [] });
  assert.deepEqual(store.publish({}), { revision: 0 });
  store.write('a0', { score: 40 });
  store.write('a1', { score: 40 });
  store.write('a7', { score: 0 });
  assert.deepEqual(store.publish({}), { revision: 3 });

  store.write('a1', { score: 90 });
  assert.throws(() => store.page(4, first), errorIs(404, 'unknown_snapshot'));
  assert.deepEqual(store.publish({}), { revision: 4 });
  assert.deepEqual(store.page(3, first), {
    shard: 'a', revision: 3, items: [{ id: 'a0', score: 40 }, { id: 'a1', score: 40 }, { id: 'a7', score: 0 }],
  });
  assert.deepEqual(store.page(4, { limit: 1, after: { id: 'b0', score: 40 } }), {
    shard: 'a', revision: 4, items: [{ id: 'a7', score: 0 }],
  });
});

test('unit: a repeated publication remains idempotent at the four-snapshot capacity', () => {
  using db = new DatabaseSync(':memory:');
  const store = new ShardStore(db, 'b');
  for (const score of [1, 2, 3]) {
    assert.deepEqual(store.write('b2', { score }), { revision: score });
    assert.deepEqual(store.publish({}), { revision: score });
  }
  assert.deepEqual(store.publish({}), { revision: 3 });
  store.write('b2', { score: 4 });
  assert.throws(() => store.publish({}), errorIs(429, 'snapshot_capacity'));
  assert.throws(() => store.page(4, { limit: 4, after: null }), errorIs(404, 'unknown_snapshot'));
  assert.deepEqual(store.page(1, { limit: 4, after: null }).items, [{ id: 'b2', score: 1 }]);
});

test('unit: revision 16 still accepts a no-op and rejects both updates and inserts', () => {
  using db = new DatabaseSync(':memory:');
  const store = new ShardStore(db, 'a');
  for (let score = 1; score <= 16; score++) {
    assert.deepEqual(store.write('a0', { score }), { revision: score });
  }
  assert.deepEqual(store.write('a0', { score: 16 }), { revision: 16 });
  assert.throws(() => store.write('a0', { score: 17 }), errorIs(409, 'revision_exhausted'));
  assert.throws(() => store.write('a1', { score: 16 }), errorIs(409, 'revision_exhausted'));
  assert.deepEqual(store.publish({}), { revision: 16 });
  assert.deepEqual(store.page(16, { limit: 4, after: null }).items, [{ id: 'a0', score: 16 }]);
});

test('unit: write and publish reject wrong object shapes before changing state', () => {
  using db = new DatabaseSync(':memory:');
  const store = new ShardStore(db, 'a');
  for (const body of [
    null, [], true, 0, 'x', {}, { score: null }, { score: [] }, { score: '1' },
    { score: 1.5 }, { score: 101 }, { score: -1 }, { score: { toString: null } }, { score: 1, extra: 0 },
  ]) {
    assert.throws(() => store.write('a0', body), errorIs(400, 'invalid_request'));
  }
  for (const id of ['b0', 'a8', 'a00', 'a1\n', {}, null]) {
    assert.throws(() => store.write(id, { score: 0 }), errorIs(400, 'invalid_request'));
  }
  for (const body of [null, [], 1, false, 'x', { extra: true }]) {
    assert.throws(() => store.publish(body), errorIs(400, 'invalid_request'));
  }
  assert.deepEqual(store.publish({}), { revision: 0 });
  assert.deepEqual(store.write('a7', { score: 0 }), { revision: 1 });
});

test('unit: either shard failing makes the entire page upstream_failure', async () => {
  const origins = { a: 'http://127.0.0.1:1234', b: 'http://127.0.0.1:1235' };
  const query = { snapshots: { a: 1, b: 2 }, limit: 1, after: null };
  for (const broken of ['a', 'b']) {
    for (const reply of [
      () => Response.json({ error: { code: 'unknown_snapshot', message: 'unknown_snapshot' } }, { status: 404 }),
      () => Response.json({ error: { code: 'internal_error', message: 'internal_error' } }, { status: 404 }),
      () => Response.json({ error: { code: 'unknown_snapshot', message: 'wrong' } }, { status: 404 }),
      () => Response.json({ error: [] }, { status: 404 }),
      () => Response.json(null, { status: 404 }),
      () => Response.json({ shard: 'a', revision: 1, items: [] }, { status: 503 }),
      () => new Response('{', { headers: { 'content-type': 'application/json' } }),
      () => { throw new Error('connection reset'); },
    ]) {
      const fetchShard: typeof fetch = async input => {
        const shard = new URL(String(input)).origin === origins.a ? 'a' : 'b';
        return shard === broken ? reply() : Response.json({
          shard, revision: query.snapshots[shard], items: [{ id: shard + '0', score: 10 }],
        });
      };
      await assert.rejects(aggregate(origins, query, fetchShard), errorIs(502, 'upstream_failure'));
    }
  }
});

test('unit: importing both entrypoints is silent and inert with invalid environment', async () => {
  const modules = ['shard.mts', 'query.mts'].map(file => new URL('../' + file, import.meta.url).href);
  const child = await promisify(execFile)(process.execPath, [
    '--v8-pool-size=1', '--input-type=module', '-e',
    modules.map(module => `await import(${JSON.stringify(module)});`).join('\n'),
  ], {
    env: {
      PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1', HOST: 'invalid', PORT: 'invalid',
      SHARD_A_ORIGIN: 'invalid', SHARD_B_ORIGIN: 'invalid', SHARD_ID: 'invalid', DB_PATH: '',
    },
    encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL',
  });
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

test('unit: the upstream byte cap counts JSON whitespace and allows exactly 8192 bytes', async () => {
  const origins = { a: 'http://127.0.0.1:1234', b: 'http://127.0.0.1:1235' };
  const query = { snapshots: { a: 1, b: 0 }, limit: 1, after: null };
  const valid = { shard: 'a', revision: 1, items: [{ id: 'a0', score: 100 }] };
  const document = JSON.stringify(valid);
  const boundary = document.padEnd(8192, ' ');
  const oversized = boundary + ' ';
  assert.deepEqual(JSON.parse(oversized), valid);
  const fetchShard = (wire: string): typeof fetch => async input => {
    if (new URL(String(input)).origin === origins.b) return Response.json({ shard: 'b', revision: 0, items: [] });
    return new Response(wire, { headers: { 'content-type': 'application/json' } });
  };
  assert.deepEqual(await aggregate(origins, query, fetchShard(boundary)), {
    snapshots: { a: 1, b: 0 }, items: [{ id: 'a0', score: 100 }], next: { id: 'a0', score: 100 },
  });
  await assert.rejects(aggregate(origins, query, fetchShard(oversized)), errorIs(502, 'upstream_failure'));
});

test('unit: a stalled body is cancelled by the aggregate deadline', async () => {
  const origins = { a: 'http://127.0.0.1:1234', b: 'http://127.0.0.1:1235' };
  let cancelled = false;
  const fetchShard: typeof fetch = async input => {
    if (new URL(String(input)).origin === origins.a) return Response.json({ shard: 'a', revision: 0, items: [] });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from('{')); },
      cancel() { cancelled = true; },
    });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  };
  await assert.rejects(aggregate(origins, { snapshots: { a: 0, b: 0 }, limit: 4, after: null }, fetchShard),
    errorIs(502, 'upstream_failure'));
  assert.equal(cancelled, true);
});

test('unit: the same 500 ms deadline covers both shards from headers through body reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const origins = { a: 'http://127.0.0.1:1234', b: 'http://127.0.0.1:1235' };
  const signals = new Map<string, AbortSignal>();
  const reading: string[] = [];
  const cancelled: string[] = [];
  const fetchShard: typeof fetch = async (input, options) => {
    const origin = new URL(String(input)).origin;
    const shard = origin === origins.a ? 'a' : 'b';
    assert.ok(options?.signal);
    signals.set(origin, options.signal);
    await new Promise<void>(resolve => setTimeout(resolve, shard === 'a' ? 200 : 450));
    const stream = new ReadableStream<Uint8Array>({
      pull() { reading.push(shard); },
      cancel() { cancelled.push(shard); },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  };

  const page = aggregate(origins, { snapshots: { a: 0, b: 0 }, limit: 4, after: null }, fetchShard);
  const signal = signals.get(origins.a);
  assert.ok(signal);
  assert.equal(signals.get(origins.b), signal);

  t.mock.timers.tick(200);
  await scheduler.yield();
  assert.deepEqual(reading, ['a']);
  t.mock.timers.tick(250);
  await scheduler.yield();
  assert.deepEqual(reading, ['a', 'b']);
  t.mock.timers.tick(49);
  assert.equal(signal.aborted, false, 'the deadline is still open at 499 ms');
  assert.deepEqual(cancelled, []);

  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true, 'the shared signal aborts at 500 ms');
  await assert.rejects(page, errorIs(502, 'upstream_failure'));
  assert.deepEqual(cancelled.sort(), ['a', 'b']);
});

test('unit: encoded upstream JSON cannot bypass the wire body byte limit', async () => {
  const origins = { a: 'http://127.0.0.1:1234', b: 'http://127.0.0.1:1235' };
  for (const encoding of ['gzip', 'br', 'GZip', 'identity, gzip']) {
    const fetchShard: typeof fetch = async input => {
      const shard = new URL(String(input)).origin === origins.a ? 'a' : 'b';
      return Response.json({ shard, revision: 0, items: [] }, { headers: { 'content-encoding': encoding } });
    };
    await assert.rejects(aggregate(origins, { snapshots: { a: 0, b: 0 }, limit: 2, after: null }, fetchShard), errorIs(502, 'upstream_failure'));
  }
});

test('unit: absolute monotonic deadline rejects late success even before abort timer dispatch', async () => {
  const origins = { a: 'http://127.0.0.1:1234', b: 'http://127.0.0.1:1235' };
  for (const finishAt of [499, 500, 575]) {
    let now = 0;
    const fetchShard: typeof fetch = async input => {
      const shard = new URL(String(input)).origin === origins.a ? 'a' : 'b';
      now = finishAt;
      return Response.json({ shard, revision: 0, items: [] });
    };
    const result = aggregate(origins, { snapshots: { a: 0, b: 0 }, limit: 2, after: null }, fetchShard, () => now);
    if (finishAt < 500) assert.deepEqual(await result, { snapshots: { a: 0, b: 0 }, items: [], next: null });
    else await assert.rejects(result, errorIs(502, 'upstream_failure'));
  }
});

const shardEntry = new URL('../shard.mts', import.meta.url);
const queryEntry = new URL('../query.mts', import.meta.url);
const fixtureEntry = new URL('./fixture.mts', import.meta.url);
const envelope = (code: string) => ({ error: { code, message: code } });

async function request(origin: string, path: string, status = 200, method = 'GET', data?: unknown): Promise<unknown> {
  const response = await fetch(origin + path, {
    method, signal: AbortSignal.timeout(3000),
    ...(data === undefined ? {} : {
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(data),
    }),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(body)}`);
  return body;
}

class Services {
  private readonly running: RunningService[] = [];

  async start(entry: URL, env: Record<string, string>): Promise<RunningService> {
    const service = await startService(entry, env);
    this.running.push(service);
    return service;
  }

  async stop(): Promise<void> {
    const results = await Promise.allSettled(this.running.map(service => service.stop()));
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }
}

async function withShardDirectory(run: (services: Services, dir: string) => Promise<void>): Promise<void> {
  const services = new Services();
  const dir = await mkdtemp(join(tmpdir(), 'keyset-76-'));
  try {
    await run(services, dir);
  } finally {
    try {
      await services.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

test('integration: failed second service startup stops the first shard and removes its database directory', async () => {
  let dir: string | undefined;
  let first: RunningService | undefined;
  await assert.rejects(withShardDirectory(async (services, directory) => {
    dir = directory;
    first = await services.start(shardEntry, { SHARD_ID: 'a', DB_PATH: join(dir, 'a.db') });
    assert.ok(first.child.pid);
    assert.equal(first.child.exitCode, null);
    await services.start(shardEntry, { SHARD_ID: 'invalid', DB_PATH: join(dir, 'b.db') });
  }), /Service exited 1: SHARD_ID must be a or b/);
  assert.ok(first);
  assert.ok(first.child.exitCode !== null || first.child.signalCode !== null, 'the first shard exited');
  await assert.rejects(fetch(first.url, { signal: AbortSignal.timeout(1000) }));
  assert.ok(dir);
  await assert.rejects(stat(dir), { code: 'ENOENT' });
});

function pagePath(vector: Vector, limit: number, cursor: Item | null = null): string {
  const base = `/page?limit=${limit}&a=${vector.a}&b=${vector.b}`;
  return cursor ? `${base}&afterScore=${cursor.score}&afterId=${cursor.id}` : base;
}

async function exhaust(origin: string, vector: Vector, limit: number, expected: readonly Item[]): Promise<void> {
  let after: Item | null = null;
  for (let offset = 0; offset < expected.length + limit; offset += limit) {
    const items = expected.slice(offset, offset + limit);
    const body = await request(origin, pagePath(vector, limit, after));
    assert.deepEqual(body, { snapshots: vector, items, next: items.at(-1) ?? null });
    assert.ok(exact(body, ['snapshots', 'items', 'next']));
    if (body.next === null) return;
    assert.ok(exact(body.next, ['id', 'score']) && isId(body.next.id) && isScore(body.next.score));
    after = { id: body.next.id, score: body.next.score };
  }
  assert.fail('Expected a final empty page');
}

const allItems = [
  { id: 'a0', score: 100 }, { id: 'a1', score: 95 }, { id: 'a2', score: 95 }, { id: 'a3', score: 95 },
  { id: 'b0', score: 95 }, { id: 'b1', score: 90 }, { id: 'a4', score: 80 }, { id: 'b2', score: 80 },
  { id: 'b3', score: 75 }, { id: 'a5', score: 50 }, { id: 'a6', score: 50 }, { id: 'b4', score: 50 },
  { id: 'b5', score: 20 }, { id: 'a7', score: 0 }, { id: 'b6', score: 0 }, { id: 'b7', score: 0 },
];

test('integration: three independent services page a pinned vector across ties, live mutation and restart', async () => {
  await withShardDirectory(async (services, dir) => {
    const aEnv = { SHARD_ID: 'a', DB_PATH: join(dir, 'a.db') };
    const bEnv = { SHARD_ID: 'b', DB_PATH: join(dir, 'b.db') };
    let a = await services.start(shardEntry, aEnv);
    const b = await services.start(shardEntry, bEnv);
    const startQuery = () => services.start(queryEntry, { SHARD_A_ORIGIN: a.url + '/', SHARD_B_ORIGIN: b.url });
    let query = await startQuery();

    await exhaust(query.url, { a: 0, b: 0 }, 1, []);
    for (const item of allItems) {
      await request(item.id.startsWith('a') ? a.url : b.url, '/items/' + item.id, 200, 'PUT', { score: item.score });
    }
    assert.deepEqual(await request(a.url, '/publish', 200, 'POST', {}), { revision: 8 });
    assert.deepEqual(await request(b.url, '/publish', 200, 'POST', {}), { revision: 8 });
    const pinned = { a: 8, b: 8 };
    await exhaust(query.url, pinned, 4, allItems);
    assert.deepEqual(await request(query.url, pagePath(pinned, 1)), {
      snapshots: pinned, items: [{ id: 'a0', score: 100 }], next: { id: 'a0', score: 100 },
    });
    assert.deepEqual(await request(a.url, '/snapshots/8/page?limit=1&afterScore=95&afterId=b0'), {
      shard: 'a', revision: 8, items: [{ id: 'a4', score: 80 }],
    });
    assert.deepEqual(await request(b.url, '/snapshots/8/page?limit=1&afterScore=95&afterId=a3'), {
      shard: 'b', revision: 8, items: [{ id: 'b0', score: 95 }],
    });

    assert.deepEqual(await request(a.url, '/items/a0', 200, 'PUT', { score: 0 }), { revision: 9 });
    await exhaust(query.url, pinned, 4, allItems);
    assert.deepEqual(await request(a.url, '/snapshots/9/page?limit=4', 404), envelope('unknown_snapshot'));
    assert.deepEqual(await request(query.url, pagePath({ a: 9, b: 8 }, 4), 502), envelope('upstream_failure'));
    assert.deepEqual(await request(query.url, pagePath({ a: 8, b: 7 }, 4), 502), envelope('upstream_failure'));
    assert.deepEqual(await request(a.url, '/publish', 200, 'POST', {}), { revision: 9 });

    await a.stop();
    await query.stop();
    await assert.rejects(services.start(shardEntry, { ...aEnv, SHARD_ID: 'b' }), /identity mismatch/);
    a = await services.start(shardEntry, aEnv);
    query = await startQuery();

    await exhaust(query.url, pinned, 4, allItems);
    const changed = { a: 9, b: 8 };
    assert.deepEqual(await request(query.url, pagePath(changed, 4)), {
      snapshots: changed,
      items: [{ id: 'a1', score: 95 }, { id: 'a2', score: 95 }, { id: 'a3', score: 95 }, { id: 'b0', score: 95 }],
      next: { id: 'b0', score: 95 },
    });
    assert.deepEqual(await request(a.url, '/items/a0', 200, 'PUT', { score: 0 }), { revision: 9 });
    assert.deepEqual(await request(a.url, '/publish', 200, 'POST', {}), { revision: 9 });
    for (let revision = 10; revision <= 16; revision++) {
      assert.deepEqual(await request(a.url, '/items/a0', 200, 'PUT', { score: revision }), { revision });
      if (revision === 10) {
        assert.deepEqual(await request(a.url, '/publish', 200, 'POST', {}), { revision: 10 });
        assert.deepEqual(await request(a.url, '/publish', 200, 'POST', {}), { revision: 10 });
      }
    }
    assert.deepEqual(await request(a.url, '/items/a0', 200, 'PUT', { score: 16 }), { revision: 16 });
    assert.deepEqual(await request(a.url, '/items/a0', 409, 'PUT', { score: 17 }), envelope('revision_exhausted'));
    assert.deepEqual(await request(a.url, '/publish', 429, 'POST', {}), envelope('snapshot_capacity'));

    for (const body of [null, [], 1, false, 'x', {}, { score: { toString: null } }, { score: '1' }, { score: 0, extra: 1 }]) {
      assert.deepEqual(await request(a.url, '/items/a0', 400, 'PUT', body), envelope('invalid_request'));
    }
    for (const body of [null, [], 1, false, 'x', { extra: 1 }]) {
      assert.deepEqual(await request(a.url, '/publish', 400, 'POST', body), envelope('invalid_request'));
    }
    assert.deepEqual(await request(a.url, '/items/b0', 400, 'PUT', { score: 0 }), envelope('invalid_request'));
    for (const path of [
      '/snapshots/00/page?limit=1', '/snapshots/17/page?limit=1', '/snapshots/0/page',
      '/snapshots/0/page?limit=0', '/snapshots/0/page?limit=5', '/snapshots/0/page?limit=1&limit=1',
      '/snapshots/0/page?limit=1&afterId=b0', '/snapshots/0/page?limit=1&afterScore=00&afterId=b0',
      '/snapshots/0/page?limit=1&afterScore=88&afterId=a8',
    ]) {
      assert.deepEqual(await request(a.url, path, 400), envelope('invalid_request'));
    }
    for (const path of [
      '/page?limit=1&a=0', '/page?limit=1&a=00&b=0', '/page?limit=1&a=0&b=0&b=0',
      '/page?limit=1&a=0&b=0&url=x', '/page?limit=1&a=0&b=0&afterScore=10',
      '/page?limit=1&a=0&b=0&afterScore=1.0&afterId=b0', '/page?limit=%31&a=0&b=0',
    ]) {
      assert.deepEqual(await request(query.url, path, 400), envelope('invalid_request'));
    }
    await assert.rejects(services.start(queryEntry, {
      SHARD_A_ORIGIN: a.url, SHARD_B_ORIGIN: a.url + '/',
    }), /distinct/);
    await b.stop();
    assert.deepEqual(await request(query.url, pagePath(pinned, 4), 502), envelope('upstream_failure'));
  });
});

test('integration: the aggregator fails closed on bad upstream pages, late bodies and redirects', async () => {
  const services = new Services();
  try {
    // B doubles as a reachable redirect destination on an origin distinct from A.
    const b = await services.start(fixtureEntry, { SHARD_ID: 'b' });
    const a = await services.start(fixtureEntry, { SHARD_ID: 'a', REDIRECT_ORIGIN: b.url });
    const query = await services.start(queryEntry, { SHARD_A_ORIGIN: a.url, SHARD_B_ORIGIN: b.url });
    const vector = { a: 2, b: 3 };
    const path = pagePath(vector, 2, { id: 'a0', score: 90 });
    const expected = {
      snapshots: vector, items: [{ id: 'a1', score: 90 }, { id: 'b0', score: 90 }], next: { id: 'b0', score: 90 },
    };
    const mode = (peer: RunningService, value: string) => request(peer.url, '/mode', 200, 'POST', { mode: value });
    assert.deepEqual(await request(query.url, path), expected);
    for (const body of [null, [], 1, { mode: { toString: null } }, { mode: 'ok', extra: 1 }]) {
      assert.deepEqual(await request(a.url, '/mode', 400, 'POST', body), envelope('invalid_request'));
    }

    for (const peer of [a, b]) {
      for (const invalid of ['identity', 'rewound', 'unexpected-code', 'unknown', 'oversize']) {
        await mode(peer, invalid);
        assert.deepEqual(await request(query.url, path, 502), envelope('upstream_failure'), invalid);
      }
      await mode(peer, 'ok');
    }
    for (const invalid of ['wrong-revision', 'cursor-equal', 'unordered', 'malformed', 'error-array', 'wrong-message', 'unavailable']) {
      await mode(a, invalid);
      assert.deepEqual(await request(query.url, path, 502), envelope('upstream_failure'), invalid);
    }

    await mode(a, 'late-body');
    const start = performance.now();
    assert.deepEqual(await request(query.url, path, 502), envelope('upstream_failure'));
    assert.ok(performance.now() - start >= 400, 'Expected the shared deadline to expire');

    await mode(a, 'redirect');
    assert.deepEqual(await request(query.url, path, 502), envelope('upstream_failure'));
    assert.deepEqual(await request(b.url, '/stats'), { received: 0 });
    await mode(a, 'ok');
    assert.deepEqual(await request(query.url, path), expected);
  } finally {
    await services.stop();
  }
});
