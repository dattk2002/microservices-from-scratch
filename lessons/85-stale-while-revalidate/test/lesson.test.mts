import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { ReadableStream } from 'node:stream/web';
import test from 'node:test';
import { setImmediate as checkpoint, setTimeout as pause } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { ValueCache } from '../value-cache.mts';
import { parseOriginValue, parsePutValue } from '../contracts.mts';
import type { OriginValue } from '../contracts.mts';
import { prepareAdvance } from '../origin.mts';
import { fetchOrigin, normalizeOrigin } from '../upstream.mts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function rejectCommitForValueSeven(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
    CREATE TRIGGER reject_seven AFTER UPDATE ON snapshot WHEN NEW.value = 7
    BEGIN INSERT INTO child (parent_id) VALUES (1); END;
  `);
}

test('unit: updating a snapshot cannot return a revision that fails to commit', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE snapshot (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, value INTEGER NOT NULL) STRICT;
      INSERT INTO snapshot VALUES (1, 0, 0);
    `);
    rejectCommitForValueSeven(db);
    const advance = prepareAdvance(db);
    assert.throws(() => advance(7), /FOREIGN KEY constraint failed/);
    const read = db.prepare('SELECT version, value FROM snapshot WHERE id = 1');
    assert.deepEqual(parseOriginValue(read.get()), { version: 0, value: 0 });
    assert.deepEqual(advance(8), { version: 1, value: 8 });
    assert.deepEqual(parseOriginValue(read.get()), { version: 1, value: 8 });
  } finally {
    db.close();
  }
});

test('unit: freshness ends at 100 and callers at 500 join the deferred stale refresh', async () => {
  let now = 0;
  let reads = 0;
  const refresh = deferred<OriginValue>();
  const cache = new ValueCache(() => now, async () => {
    reads++;
    return reads === 1 ? { version: 1, value: 15 } : refresh.promise;
  });
  try {
    assert.deepEqual(await cache.get(), { version: 1, value: 15, state: 'fresh' });
    now = 99;
    assert.deepEqual(await cache.get(), { version: 1, value: 15, state: 'fresh' });
    assert.equal(reads, 1);
    now = 100;
    let staleReplies: unknown;
    const hits = Promise.all(Array.from({ length: 10 }, () => cache.get()));
    void hits.then(result => { staleReplies = result; }, () => {});
    await checkpoint();
    assert.deepEqual(staleReplies, Array.from({ length: 10 }, () => ({
      version: 1, value: 15, state: 'stale',
    })));
    assert.equal(reads, 2);
    now = 499;
    assert.deepEqual(await cache.get(), { version: 1, value: 15, state: 'stale' });

    now = 500;
    let received = false;
    const blocking = cache.get();
    void blocking.then(() => { received = true; }, () => {});
    await checkpoint();
    assert.equal(received, false);
    assert.equal(reads, 2);

    now = 560;
    refresh.resolve({ version: 2, value: 20 });
    assert.deepEqual(await blocking, { version: 2, value: 20, state: 'fresh' });
    now = 659;
    assert.deepEqual(await cache.get(), { version: 2, value: 20, state: 'fresh' });
    assert.equal(reads, 2, 'freshness starts at completion of the successful refresh');
  } finally {
    refresh.resolve({ version: 2, value: 20 });
    await cache.close();
  }
});

test('unit: foreground failure uses current age and fallback ends at 1100', async () => {
  let now = 0;
  const failure = new Error('offline');
  const lateFailure = deferred<OriginValue>();
  let reads = 0;
  const cache = new ValueCache(() => now, async () => {
    reads++;
    if (reads === 1) return { version: 3, value: 25 };
    if (reads === 3) return lateFailure.promise;
    throw failure;
  });
  try {
    await cache.get();
    now = 1099;
    assert.deepEqual(await cache.get(), { version: 3, value: 25, state: 'stale-if-error' });
    const blocked = assert.rejects(cache.get(), failure);
    await checkpoint();
    assert.equal(reads, 3);
    now = 1100;
    lateFailure.reject(failure);
    await blocked;
    await assert.rejects(cache.get(), failure);
  } finally {
    lateFailure.resolve({ version: 3, value: 25 });
    await cache.close();
  }
});

test('unit: failed background refresh preserves the last success and allows another attempt', async () => {
  let now = 0;
  let reads = 0;
  const refresh = deferred<OriginValue>();
  const failure = new Error('offline');
  const cache = new ValueCache(() => now, async () => {
    reads++;
    if (reads === 1) return { version: 2, value: 20 };
    if (reads === 2) return refresh.promise;
    throw failure;
  });
  try {
    await cache.get();
    now = 100;
    assert.deepEqual(await cache.get(), { version: 2, value: 20, state: 'stale' });
    refresh.reject(failure);
    // Node's test runner fails this test on an unhandled rejection.
    await checkpoint();
    now = 500;
    assert.deepEqual(await cache.get(), { version: 2, value: 20, state: 'stale-if-error' });
    assert.equal(reads, 3);
    now = 1100;
    await assert.rejects(cache.get(), failure);
    assert.equal(reads, 4);
  } finally {
    refresh.resolve({ version: 2, value: 20 });
    await cache.close();
  }
});

test('unit: empty misses share one attempt and a failure never creates a cache entry', async () => {
  let reads = 0;
  let recovered = false;
  const first = deferred<OriginValue>();
  const failure = new Error('offline');
  const cache = new ValueCache(() => 0, async () => {
    reads++;
    if (reads === 1) return first.promise;
    if (!recovered) throw failure;
    return { version: 0, value: 0 };
  });
  try {
    const misses = Promise.all(Array.from({ length: 10 }, () => assert.rejects(cache.get(), failure)));
    await checkpoint();
    assert.equal(reads, 1);
    first.reject(failure);
    await misses;
    assert.equal(reads, 1, 'all waiting misses shared the same failed attempt');
    recovered = true;
    assert.deepEqual(await cache.get(), { version: 0, value: 0, state: 'fresh' });
    assert.equal(reads, 2);
  } finally {
    first.resolve({ version: 0, value: 0 });
    await cache.close();
  }
});

test('unit: a regressing or conflicting version cannot replace the last snapshot', async () => {
  let now = 0;
  let answer = { version: 4, value: 29 };
  const cache = new ValueCache(() => now, async () => answer);
  try {
    await cache.get();
    now = 500;
    answer = { version: 3, value: 28 };
    await assert.rejects(cache.get());
    answer = { version: 4, value: 99 };
    await assert.rejects(cache.get());
    now = 1100;
    await assert.rejects(cache.get());
    answer = { version: 4, value: 29 };
    assert.deepEqual(await cache.get(), { version: 4, value: 29, state: 'fresh' });
  } finally {
    await cache.close();
  }
});

test('unit: a new cache has no version floor inherited from a closed cache', async () => {
  let snapshot = { version: 1, value: 12 };
  const fetchValue = async () => snapshot;
  const first = new ValueCache(() => 0, fetchValue);
  try {
    assert.deepEqual(await first.get(), { version: 1, value: 12, state: 'fresh' });
  } finally {
    await first.close();
  }
  // Even an expired restored snapshot would impose its old version floor.
  snapshot = { version: 0, value: 0 };
  const restarted = new ValueCache(() => 2000, fetchValue);
  try {
    assert.deepEqual(await restarted.get(), { version: 0, value: 0, state: 'fresh' });
  } finally {
    await restarted.close();
  }
});

test('unit: shutdown aborts and joins an active fetch and rejects its late success', async () => {
  const result = deferred<OriginValue>();
  const entered = deferred<AbortSignal>();
  const cache = new ValueCache(() => 0, signal => {
    entered.resolve(signal);
    return result.promise;
  });
  try {
    const pending = assert.rejects(cache.get(), { name: 'AbortError' });
    const state = await Promise.race([entered.promise, checkpoint(undefined)]);
    assert.ok(state instanceof AbortSignal, 'the initial miss must enter the fetcher');
    let closed = false;
    const closing = cache.close().then(() => { closed = true; });
    assert.equal(state.aborted, true);
    await checkpoint();
    assert.equal(closed, false);
    result.resolve({ version: 2, value: 8 });
    await Promise.all([pending, closing]);
    await assert.rejects(cache.get(), { name: 'AbortError' });
  } finally {
    result.resolve({ version: 2, value: 8 });
    await cache.close();
  }
});

test('unit: request and origin snapshots accept only exact integer fields in range', () => {
  assert.equal(parsePutValue({ value: 100 }), 100);
  assert.deepEqual(parseOriginValue({ version: 16, value: 0 }), { version: 16, value: 0 });
  for (const value of [null, [], true, 1, 'x', {}, { value: 0, extra: 1 }, { value: '1' },
    { value: -1 }, { value: 101 }, { value: 1.5 }, { value: { toString: null } }]) {
    assert.throws(() => parsePutValue(value));
  }
  for (const value of [null, [], false, 0, 'x', { value: 0 }, { version: 0 }, { version: 17, value: 0 },
    { version: -1, value: 0 }, { version: 0.5, value: 0 }, { version: '1', value: 0 },
    { version: 0, value: '1' }, { version: 0, value: 101 }, { version: 0, value: 0, state: 'fresh' }]) {
    assert.throws(() => parseOriginValue(value));
  }
});

test('unit: the configured upstream is a normalized loopback HTTP origin', () => {
  assert.equal(normalizeOrigin('http://127.0.0.1:80/'), 'http://127.0.0.1');
  assert.equal(normalizeOrigin('http://127.0.0.1:4500'), 'http://127.0.0.1:4500');
  for (const value of [undefined, 'https://127.0.0.1', 'http://localhost', 'http://example.org',
    'http://user:pass@127.0.0.1', 'http://127.0.0.1/value', 'http://127.0.0.1/?', 'http://127.0.0.1/#',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536']) {
    assert.throws(() => normalizeOrigin(value));
  }
});

test('unit: headers at 300 ms leave a single body deadline at 500 ms even before the timer fires', async () => {
  for (const completion of [499, 500]) {
    let now = 0;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          controller.enqueue(new TextEncoder().encode('{"version":1,"value":6}'));
          sent = true;
          return;
        }
        now = completion;
        controller.close();
      },
    }, { highWaterMark: 0 });
    const read = async () => {
      now = 300;
      return new Response(stream, { headers: { 'content-type': 'application/json' } });
    };
    const response = fetchOrigin('http://127.0.0.1:4500', new AbortController().signal, () => now, read);
    if (completion === 499) assert.deepEqual(await response, { version: 1, value: 6 });
    else await assert.rejects(response, /Origin deadline expired/);
  }
});

function openJsonResponse(parts: string[]) {
  const chunks = parts.map(part => new TextEncoder().encode(part));
  let aborted = false;
  const read: typeof fetch = async (_url, options) => {
    const signal = options?.signal;
    assert.ok(signal);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener('abort', () => {
          aborted = true;
          controller.error(signal.reason);
        }, { once: true });
      },
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });
    return new Response(stream, { headers: { 'content-type': 'application/json' } });
  };
  return { read, wasAborted: () => aborted };
}

test('unit: the accumulated byte limit rejects and aborts a valid 8193-byte prefix before EOF', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const snapshot = '{"version":1,"value":12}';
  const upstream = openJsonResponse([snapshot, ' '.repeat(4096), ' '.repeat(8193 - snapshot.length - 4096)]);
  const shutdown = new AbortController();
  const result = fetchOrigin('http://127.0.0.1:4500', shutdown.signal, () => 0, upstream.read);
  const rejected = assert.rejects(result, /Origin body too large/);
  try {
    assert.equal(await Promise.race([rejected.then(() => 'rejected'), checkpoint('still open')]), 'rejected');
    assert.equal(upstream.wasAborted(), true);
  } finally {
    shutdown.abort();
    await rejected.catch(() => {});
  }
});

test('unit: a valid JSON snapshot held open cannot succeed and is aborted at the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  const upstream = openJsonResponse(['{"version":1,"value":12}']);
  const shutdown = new AbortController();
  const result = fetchOrigin('http://127.0.0.1:4500', shutdown.signal, () => now, upstream.read);
  const settled = result.then(() => 'fulfilled', () => 'rejected');
  try {
    assert.equal(await Promise.race([settled, checkpoint('still open')]), 'still open');
    now = 500;
    t.mock.timers.tick(500);
    await assert.rejects(result, { name: 'AbortError' });
    assert.equal(upstream.wasAborted(), true);
  } finally {
    shutdown.abort();
    await settled;
  }
});

const originEntry = new URL('../origin.mts', import.meta.url);
const cacheEntry = new URL('../cache.mts', import.meta.url);
const fixtureEntry = new URL('./fixture.mts', import.meta.url);

test('unit: importing either entrypoint with invalid settings has no runtime effects', async () => {
  const code = [originEntry, cacheEntry].map(entry => `await import(${JSON.stringify(entry.href)})`).join('\n');
  const result = await promisify(execFile)(process.execPath, ['--v8-pool-size=1', '--input-type=module', '-e', code], {
    env: {
      PATH: process.env.PATH ?? '',
      UV_THREADPOOL_SIZE: '1',
      HOST: 'invalid host',
      PORT: 'invalid',
      ORIGIN_ORIGIN: 'invalid',
      DB_PATH: '/dev/null/invalid.sqlite',
    },
    timeout: 5000,
  });
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

async function withService<T>(
  entry: URL, env: Record<string, string>, use: (service: RunningService) => Promise<T>,
): Promise<T> {
  const service = await startService(entry, env);
  try {
    return await use(service);
  } finally {
    await service.stop();
  }
}

async function withDatabase(use: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'lesson-85-'));
  try {
    await use(join(directory, 'origin.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

type Reply = { status: number; body: unknown };

async function request(base: string, path: string, options: RequestInit = {}): Promise<Reply> {
  const response = await fetch(base + path, { signal: AbortSignal.timeout(2000), ...options });
  const body: unknown = await response.json();
  return { status: response.status, body };
}

function put(base: string, path: string, value: unknown): Promise<Reply> {
  return request(base, path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

function errorReply(status: number, code: string): Reply {
  return { status, body: { error: { code, message: code } } };
}

async function observe<T>(
  message: string, read: (signal: AbortSignal) => Promise<T>, matches: (value: T) => boolean,
): Promise<T> {
  const until = performance.now() + 2500;
  const signal = AbortSignal.timeout(2500);
  let last: T | undefined;
  while (performance.now() < until) {
    last = await read(signal);
    if (matches(last)) return last;
    await pause(10, undefined, { signal });
  }
  assert.fail(`${message}. Last observation: ${JSON.stringify(last)}`);
}

function hasState(reply: Reply, state: string): boolean {
  const body = reply.body;
  return reply.status === 200 && typeof body === 'object' && body !== null &&
    'state' in body && body.state === state;
}

test('integration: origin validates writes and atomically preserves the revision ceiling', async () => {
  await withDatabase(db => withService(originEntry, { DB_PATH: db }, async origin => {
    assert.deepEqual(await request(origin.url, '/stats'), ok({ reads: 0 }));
    assert.deepEqual(await request(origin.url, '/value'), ok({ version: 0, value: 0 }));
    assert.deepEqual(await put(origin.url, '/value', { value: 0 }), ok({ version: 0, value: 0 }));
    assert.deepEqual(await request(origin.url, '/value?unknown=1'), errorReply(400, 'invalid_query'));
    assert.deepEqual(await put(origin.url, '/value?unknown=1', { value: 3 }), errorReply(400, 'invalid_query'));
    assert.deepEqual(await request(origin.url, '/stats?unused=1'), errorReply(400, 'invalid_query'));
    for (const invalid of [null, [], false, 0, '3', {}, { value: 4, revision: 1 },
      { value: '3' }, { value: 1.5 }, { value: -1 }, { value: 101 }, { value: { toString: null } }]) {
      assert.deepEqual(await put(origin.url, '/value', invalid), errorReply(400, 'invalid_body'));
    }
    assert.deepEqual(await request(origin.url, '/value', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{',
    }), errorReply(400, 'invalid_json'));
    assert.deepEqual(await request(origin.url, '/value', { method: 'PUT', body: '{}' }),
      errorReply(415, 'unsupported_media_type'));
    assert.deepEqual(await request(origin.url, '/stats'), ok({ reads: 1 }));

    const sameWrites = await Promise.all(Array.from({ length: 6 }, () => put(origin.url, '/value', { value: 1 })));
    for (const reply of sameWrites) assert.deepEqual(reply, ok({ version: 1, value: 1 }));
    for (let version = 2; version <= 16; version++) {
      assert.deepEqual(await put(origin.url, '/value', { value: version }), ok({ version, value: version }));
    }
    assert.deepEqual(await put(origin.url, '/value', { value: 16 }), ok({ version: 16, value: 16 }));
    assert.deepEqual(await put(origin.url, '/value', { value: 17 }), errorReply(409, 'revision_exhausted'));
    assert.deepEqual(await request(origin.url, '/value'), ok({ version: 16, value: 16 }));
    assert.deepEqual(await request(origin.url, '/stats'), ok({ reads: 2 }));
  }));
});

test('integration: origin reports a commit failure and a successful PUT is visible before shutdown', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  await withDatabase(db => withService(originEntry, { DB_PATH: db }, async origin => {
    const inspector = new DatabaseSync(db);
    try {
      rejectCommitForValueSeven(inspector);
      assert.deepEqual(await put(origin.url, '/value', { value: 7 }), errorReply(500, 'internal_error'));
      assert.deepEqual(await request(origin.url, '/value'), ok({ version: 0, value: 0 }));

      assert.deepEqual(await put(origin.url, '/value', { value: 8 }), ok({ version: 1, value: 8 }));
      const row = inspector.prepare('SELECT version, value FROM snapshot WHERE id = 1').get();
      assert.deepEqual(parseOriginValue(row), { version: 1, value: 8 });
    } finally {
      inspector.close();
    }
  }));
});

test('integration: independent origin and cache refresh, bound outage fallback, and recover after origin restart', async () => {
  await withDatabase(db => withService(originEntry, { DB_PATH: db }, async origin => {
    const config = { ORIGIN_ORIGIN: origin.url + '/' };
    await withService(cacheEntry, config, async cache => {
      assert.deepEqual(await request(cache.url, '/value?unused=1'), errorReply(400, 'invalid_query'));
      assert.deepEqual(await put(cache.url, '/value', { value: 4 }), errorReply(405, 'method_not_allowed'));
      assert.deepEqual(await request(origin.url, '/stats'), ok({ reads: 0 }));
      assert.deepEqual(await request(cache.url, '/value'), ok({ version: 0, value: 0, state: 'fresh' }));
      assert.deepEqual(await put(origin.url, '/value', { value: 45 }), ok({ version: 1, value: 45 }));

      const readCache = (signal: AbortSignal) => request(cache.url, '/value', { signal });
      const stale = await observe('cache exposes old version during refresh', readCache, reply => hasState(reply, 'stale'));
      assert.deepEqual(stale, ok({ version: 0, value: 0, state: 'stale' }));
      const updated = ok({ version: 1, value: 45, state: 'fresh' });
      assert.deepEqual(await observe('refresh installs new version', readCache,
        reply => hasState(reply, 'fresh')), updated);
      assert.deepEqual(await request(origin.url, '/stats'), ok({ reads: 2 }));

      await origin.stop();
      const fallback = await observe('cache falls back after a failed foreground refresh', readCache,
        reply => hasState(reply, 'stale-if-error'));
      assert.deepEqual(fallback, ok({ version: 1, value: 45, state: 'stale-if-error' }));
      assert.deepEqual(await observe('fallback expires during the outage', readCache, reply => reply.status === 502),
        errorReply(502, 'upstream_failure'));

      await withService(originEntry, { DB_PATH: db, PORT: new URL(origin.url).port }, async restartedOrigin => {
        assert.deepEqual(await request(restartedOrigin.url, '/stats'), ok({ reads: 0 }));
        assert.deepEqual(await request(cache.url, '/value'), updated);
        assert.deepEqual(await request(restartedOrigin.url, '/stats'), ok({ reads: 1 }));
      });
    });
  }));
});

test('integration: cache restart discards even an expired snapshot and its version floor', async () => {
  await withService(fixtureEntry, {}, async origin => {
    const config = { ORIGIN_ORIGIN: origin.url };
    const port = await withService(cacheEntry, config, async cache => {
      assert.deepEqual(await request(cache.url, '/value'), ok({ version: 1, value: 12, state: 'fresh' }));
      return new URL(cache.url).port;
    });

    // At any age a restored version 1 would produce either the wrong value or a regression error.
    assert.deepEqual(await put(origin.url, '/mode', { mode: 'regression' }), ok({ mode: 'regression' }));
    await withService(cacheEntry, { ...config, PORT: port }, async cache => {
      assert.deepEqual(await request(cache.url, '/value'), ok({ version: 0, value: 0, state: 'fresh' }));
      assert.deepEqual(await request(origin.url, '/stats'), ok({ reads: 1, open: 0, identity: true }));
    });
  });
});

test('integration: the upstream boundary contains redirects, invalid bodies and stalled fetches', async () => {
  await withService(fixtureEntry, {}, async sink => {
    assert.deepEqual(await request(sink.url, '/stats'), ok({ reads: 0, open: 0, identity: false }));
    await withService(fixtureEntry, { REDIRECT_ORIGIN: sink.url }, async origin => {
      const config = { ORIGIN_ORIGIN: origin.url };
      await withService(cacheEntry, config, async cache => {
        const setMode = async (mode: string) => {
          assert.deepEqual(await put(origin.url, '/mode', { mode }), ok({ mode }));
        };
        const expectFailure = async () => {
          assert.deepEqual(await request(cache.url, '/value'), errorReply(502, 'upstream_failure'));
        };
        const waitForStreamClose = () => observe('origin stream closes after cache aborts',
          signal => request(origin.url, '/stats', { signal }), reply => {
            assert.equal(reply.status, 200);
            const body = reply.body;
            return typeof body === 'object' && body !== null && 'open' in body && body.open === 0;
          });

        assert.deepEqual(await put(origin.url, '/mode', { mode: { toString: null } }), errorReply(400, 'invalid_body'));
        await setMode('redirect');
        await expectFailure();
        assert.deepEqual(await request(sink.url, '/stats'), ok({ reads: 0, open: 0, identity: false }));

        for (const mode of ['unexpected-status', 'semantic-error', 'wrong-media-type', 'encoded',
          'malformed', 'primitive', 'array', 'null', 'extra-field', 'wrong-type', 'out-of-range']) {
          await setMode(mode);
          await expectFailure();
        }
        await setMode('oversize');
        const oversizedStarted = performance.now();
        await expectFailure();
        const oversizedElapsed = performance.now() - oversizedStarted;
        assert.ok(oversizedElapsed < 450, `oversized stream must fail before its deadline: ${oversizedElapsed} ms`);
        assert.deepEqual(await waitForStreamClose(), ok({ reads: 1, open: 0, identity: true }));

        for (const mode of ['stall', 'late-body']) {
          await setMode(mode);
          const started = performance.now();
          await expectFailure();
          const elapsed = performance.now() - started;
          assert.ok(elapsed >= 450 && elapsed < 1200, `${mode}: ${elapsed} ms`);
          await waitForStreamClose();
        }

        await setMode('failed-miss');
        // The first read stays open to its deadline. Later reads fail immediately,
        // so serializing the callers would preserve their 502s but inflate reads.
        const failedMisses = await Promise.allSettled(Array.from({ length: 10 }, () => request(cache.url, '/value')));
        for (const miss of failedMisses) {
          assert.deepEqual(miss, { status: 'fulfilled', value: errorReply(502, 'upstream_failure') });
        }
        assert.deepEqual(await waitForStreamClose(), ok({ reads: 1, open: 0, identity: true }));

        await setMode('hold');
        const pending = Array.from({ length: 10 }, () => request(cache.url, '/value'));
        const settled = Promise.allSettled(pending);
        try {
          await observe('one origin read is held before any client can succeed',
            signal => request(origin.url, '/stats', { signal }), reply => {
              assert.equal(reply.status, 200);
              const body = reply.body;
              return typeof body === 'object' && body !== null && 'open' in body && body.open === 1;
            });
          assert.deepEqual(await request(origin.url, '/stats'), ok({ reads: 1, open: 1, identity: true }));
          assert.deepEqual(await request(origin.url, '/release', { method: 'POST' }), ok({ released: 1 }));
          for (const reply of await Promise.all(pending)) {
            assert.deepEqual(reply, ok({ version: 1, value: 12, state: 'fresh' }));
          }
          assert.deepEqual(await request(origin.url, '/stats'), ok({ reads: 1, open: 0, identity: true }));
        } finally {
          await settled;
        }

        await setMode('conflict');
        assert.deepEqual(await observe('a foreground conflict returns an error even during the fallback window',
          async signal => {
            const reply = await request(cache.url, '/value', { signal });
            assert.equal(hasState(reply, 'stale-if-error'), false);
            return reply;
          }, reply => reply.status === 502), errorReply(502, 'upstream_failure'));
        await setMode('regression');
        await expectFailure();
        await setMode('ok');
        assert.deepEqual(await request(cache.url, '/value'), ok({ version: 1, value: 12, state: 'fresh' }));
      });
    });
  });
});
