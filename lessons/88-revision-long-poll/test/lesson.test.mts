import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { isJsonMedia, parseAfter, parseOrigin, parsePeerBody, parseValue } from '../contracts.mts';
import { prepareDocument, putDocument } from '../document.mts';
import { createObserver } from '../permits.mts';
import { createWaiters } from '../waiters.mts';
import type { Snapshot } from '../waiters.mts';

function fakeTime() {
  let now = 0;
  const timers = new Set<() => void>();
  return {
    timers,
    now: () => now,
    set: (ms: number) => { now = ms; },
    schedule: (callback: () => void) => { timers.add(callback); return callback; },
    cancel: (callback: () => void) => { timers.delete(callback); },
  };
}

test('unit: registration re-read sees a commit even without a notification', async () => {
  const time = fakeTime();
  const signal = new AbortController().signal;
  let reads = 0;
  let waitingOnReread: number | undefined;
  const waiters = createWaiters({
    ...time,
    read(): Snapshot {
      if (++reads === 1) return { revision: 0, value: 0 };
      waitingOnReread = waiters.waiting;
      return { revision: 1, value: 20 };
    },
  });
  assert.deepEqual(await waiters.poll(0, signal), { revision: 1, value: 20 });
  assert.equal(waitingOnReread, 1, 'the waiter must already be registered during the reread');
  assert.equal(waiters.waiting, 0);
  assert.equal(time.timers.size, 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

function waitingFixture(read: () => Snapshot) {
  const time = fakeTime();
  const controller = new AbortController();
  const waiters = createWaiters({ ...time, read });
  function assertReleased() {
    assert.equal(waiters.waiting, 0);
    assert.equal(time.timers.size, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
  return { time, controller, waiters, assertReleased };
}

for (const elapsed of [249, 250]) {
  test(`unit: a successful notification read at ${elapsed}ms respects the park deadline`, async () => {
    let latest = { revision: 7, value: 10 };
    const { time, controller, waiters, assertReleased } = waitingFixture(() => latest);
    const result = waiters.poll(7, controller.signal);
    const [callback] = time.timers;
    assert.ok(callback);
    time.set(elapsed);
    latest = { revision: 8, value: 20 };
    waiters.notify();
    assertReleased();
    assert.deepEqual(await result, elapsed === 249 ? { revision: 8, value: 20 } : null);
    callback();
    callback();
    assertReleased();
  });
}

test('unit: an abort inside schedule releases even the timer handle returned after settlement', async () => {
  const time = fakeTime();
  const caller = new AbortController();
  const reason = new Error('caller disconnected during timer acquisition');
  const waiters = createWaiters({
    ...time,
    read: () => ({ revision: 0, value: 0 }),
    schedule(callback, ms) {
      const handle = time.schedule(callback);
      assert.equal(ms, 250);
      caller.abort(reason);
      return handle;
    },
  });
  await assert.rejects(waiters.poll(0, caller.signal), reason);
  assert.equal(waiters.waiting, 0);
  assert.equal(time.timers.size, 0);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
});

test('unit: an already-aborted caller rejects before a synchronous deadline can run', async () => {
  const time = fakeTime();
  const caller = new AbortController();
  const reason = new Error('caller disconnected before polling');
  caller.abort(reason);
  let reads = 0;
  let scheduled = 0;
  const waiters = createWaiters({
    ...time,
    read() {
      reads++;
      return { revision: 0, value: 0 };
    },
    schedule(callback) {
      scheduled++;
      const handle = time.schedule(callback);
      time.set(250);
      callback();
      return handle;
    },
  });

  const result = waiters.poll(0, caller.signal);
  const waiting = waiters.waiting;
  const timers = time.timers.size;
  const listeners = getEventListeners(caller.signal, 'abort').length;
  await assert.rejects(result, error => error === reason);
  assert.equal(reads, 0);
  assert.equal(scheduled, 0);
  assert.equal(waiting, 0);
  assert.equal(timers, 0);
  assert.equal(listeners, 0);
});

for (const elapsed of [249, 250]) {
  test(`unit: a synchronous timer callback at ${elapsed}ms preserves ownership of the current timer`, async () => {
    const time = fakeTime();
    const signal = new AbortController().signal;
    let first = true;
    const waiters = createWaiters({
      ...time,
      read: () => ({ revision: 0, value: 0 }),
      schedule(callback) {
        const handle = time.schedule(() => callback());
        if (first) {
          first = false;
          time.set(elapsed);
          callback();
        }
        return handle;
      },
    });
    const result = waiters.poll(0, signal);
    assert.equal(time.timers.size, elapsed === 249 ? 1 : 0);
    if (elapsed === 249) {
      assert.equal(waiters.waiting, 1);
      const [callback] = time.timers;
      assert.ok(callback);
      time.set(250);
      callback();
    }
    assert.equal(await result, null);
    assert.equal(waiters.waiting, 0);
    assert.equal(time.timers.size, 0);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  });
}

test('unit: a deadline callback can expire without reading, but an early callback rearms', async () => {
  let reads = 0;
  const { time, controller, waiters, assertReleased } = waitingFixture(() => {
    reads++;
    return { revision: 0, value: 0 };
  });
  const result = waiters.poll(0, controller.signal);
  const [first] = time.timers;
  assert.ok(first);
  time.set(249);
  first();
  assert.equal(waiters.waiting, 1);
  assert.equal(time.timers.size, 1);
  time.set(250);
  const [second] = time.timers;
  assert.ok(second);
  second();
  assert.equal(await result, null);
  assert.equal(reads, 2);
  assertReleased();
});

test('unit: a failed re-read rejects and immediately cleans up the slot, timer and listener', async () => {
  let reads = 0;
  const failure = new Error('read failed');
  const { controller, waiters, assertReleased } = waitingFixture(() => {
    if (++reads === 2) throw failure;
    return { revision: 0, value: 0 };
  });
  const result = waiters.poll(0, controller.signal);
  assertReleased();
  await assert.rejects(result, { status: 500, code: 'internal_error' });
  const next = waiters.poll(0, controller.signal);
  assert.equal(waiters.waiting, 1);
  waiters.shutdown();
  await assert.rejects(next, /shut down/);
  assertReleased();
});

test('unit: a notification read failure at the deadline is still a failure', async () => {
  let reads = 0;
  const failure = new Error('durable snapshot unreadable');
  const { time, controller, waiters, assertReleased } = waitingFixture(() => {
    if (++reads > 2) throw failure;
    return { revision: 0, value: 0 };
  });
  const result = waiters.poll(0, controller.signal);
  time.set(250);
  waiters.notify();
  await assert.rejects(result, { status: 500, code: 'internal_error' });
  assertReleased();
});

test('unit: abort during the first read is detected after registration', async () => {
  const controller = new AbortController();
  const time = fakeTime();
  const reason = new Error('caller already gone');
  const waiters = createWaiters({
    ...time,
    read: () => {
      controller.abort(reason);
      return { revision: 0, value: 0 };
    },
    schedule(callback) {
      const handle = time.schedule(callback);
      time.set(250);
      callback();
      return handle;
    },
  });
  await assert.rejects(waiters.poll(0, controller.signal), reason);
  assert.equal(waiters.waiting, 0);
  assert.equal(time.timers.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('unit: disconnect releases an occupied slot while shutdown rejects remaining polls', async () => {
  const time = fakeTime();
  const waiters = createWaiters({ ...time, read: () => ({ revision: 4, value: 5 }) });
  const callers = Array.from({ length: 8 }, () => new AbortController());
  const results = callers.map(caller => waiters.poll(4, caller.signal));
  const settled = Promise.allSettled(results);
  assert.equal(waiters.waiting, 8);
  const signal = new AbortController().signal;
  await assert.rejects(waiters.poll(4, signal), { status: 503, code: 'busy' });
  await assert.rejects(waiters.poll(5, signal), { status: 409, code: 'future_revision' });
  assert.deepEqual(await waiters.poll(3, signal), { revision: 4, value: 5 });

  const [first] = callers;
  assert.ok(first);
  first.abort(new Error('disconnected'));
  assert.equal(waiters.waiting, 7);
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  const next = waiters.poll(4, signal);
  assert.equal(waiters.waiting, 8);
  waiters.shutdown();
  await assert.rejects(next, /shut down/);
  const outcomes = await settled;
  assert.equal(outcomes[0]?.status, 'rejected');
  for (const outcome of outcomes.slice(1)) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.match(String(outcome.reason), /shut down/);
  }
  assert.equal(waiters.waiting, 0);
  assert.equal(time.timers.size, 0);
  for (const caller of callers) assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('unit: the revision parameter requires one canonical decimal on the wire', () => {
  assert.equal(parseAfter('after=0'), 0);
  assert.equal(parseAfter('after=16'), 16);
  for (const query of [undefined, '', 'after=00', 'after=01', 'after=+1', 'after=%31', '%61fter=1',
    'after=1&', 'after=1&after=1', 'after=1&extra=1', 'after=17', 'after=1.0', 'after=1\n']) {
    assert.throws(() => parseAfter(query), { status: 400, code: 'invalid_query' });
  }
});

test('unit: PUT schema checks shape and numeric range before using the value', () => {
  assert.equal(parseValue({ value: 100 }), 100);
  for (const body of [null, 0, [], {}, { value: -1 }, { value: 101 }, { value: 1.1 },
    { value: '1' }, { value: { toString: null } }, { value: 2, extra: true }]) {
    assert.throws(() => parseValue(body), { status: 400, code: 'invalid_body' });
  }
});

test('unit: JSON media permits only the sole optional UTF-8 charset parameter', () => {
  for (const media of ['application/json', 'APPLICATION/JSON\t; CHARSET="UTF-8" ']) {
    assert.equal(isJsonMedia(media), true);
  }
  for (const media of [undefined, 'application/json;', 'application/json, application/json',
    'application/json; charset=utf-8; charset=utf-8', 'application/json; charset=utf-16',
    'application/json; note="utf-8"', 'application/json; charset="utf-8"extra']) {
    assert.equal(isJsonMedia(media), false);
  }
});

test('unit: observer origin normalizes only the fixed HTTP loopback origin', () => {
  assert.equal(parseOrigin('http://127.0.0.1:80/').origin, 'http://127.0.0.1');
  assert.equal(parseOrigin('http://127.0.0.1:1').origin, 'http://127.0.0.1:1');
  assert.equal(parseOrigin('http://127.0.0.1:65535').origin, 'http://127.0.0.1:65535');
  for (const origin of ['', 'http://localhost', 'http://127.1', 'http://user@127.0.0.1',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'https://127.0.0.1',
    'http://127.0.0.1/foo', 'http://127.0.0.1/?', 'http://127.0.0.1/#']) {
    assert.throws(() => parseOrigin(origin));
  }
});

test('unit: peer snapshots must advance the caller and match the complete schema', () => {
  assert.deepEqual(parsePeerBody(200, { revision: 16, value: 100 }, 2),
    { status: 200, snapshot: { revision: 16, value: 100 } });
  for (const body of [null, [], 9, { revision: 2, value: 100 }, { revision: 17, value: 100 },
    { revision: '16', value: 100 }, { revision: 3, value: 101 }, { revision: 3, value: 50, extra: true }]) {
    assert.throws(() => parsePeerBody(200, body, 2));
  }
});

for (const { status, code, after } of [
  { status: 409, code: 'future_revision', after: 1 },
  { status: 503, code: 'busy', after: 0 },
]) {
  test(`unit: semantic status ${status} requires its exact error envelope`, () => {
    assert.deepEqual(parsePeerBody(status, { error: { code, message: code } }, after), { status, code });
    for (const body of [null, [], 'busy', { error: [] }, { error: { code, message: 'wrong message' } },
      { error: { code: 'internal_error', message: 'internal_error' } },
      { extra: 1, error: { code, message: code } }, { error: { code, message: code, extra: 1 } }]) {
      assert.throws(() => parsePeerBody(status, body, after));
    }
  });
}

test('unit: a peer cannot reject revision zero as a future revision', () => {
  assert.throws(() => parsePeerBody(409, {
    error: { code: 'future_revision', message: 'future_revision' },
  }, 0));
});

test('unit: a no-op keeps the park and a committed change is visible to a separate reader at notification', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  using directory = mkdtempDisposableSync(join(tmpdir(), 'revision-commit-'));
  const dbPath = join(directory.path, 'document.sqlite');
  using writer = new DatabaseSync(dbPath);
  const store = prepareDocument(writer);
  using reader = new DatabaseSync(dbPath, { readOnly: true });
  const select = reader.prepare('SELECT revision, value FROM document WHERE id = 1');
  const { waiters, controller, assertReleased } = waitingFixture(store.read);
  const pending = waiters.poll(0, controller.signal);
  const notifications: unknown[] = [];
  function notify() {
    const row = select.get();
    assert.ok(row);
    notifications.push({ ...row });
    waiters.notify();
  }
  assert.deepEqual(putDocument(store, 0, notify), { revision: 0, value: 0 });
  assert.deepEqual(notifications, []);
  assert.equal(waiters.waiting, 1);
  assert.deepEqual(putDocument(store, 27, notify), { revision: 1, value: 27 });
  assert.deepEqual(notifications, [{ revision: 1, value: 27 }]);
  assert.deepEqual(await pending, { revision: 1, value: 27 });
  assertReleased();
});

test('unit: all eight outbound permits can be held, and failure or completion frees one', async () => {
  const releases = new Array<() => void>();
  let dials = 0;
  let active = 0;
  const observer = createObserver(async (_after, signal) => {
    dials++;
    active++;
    try {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        releases.push(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
      });
      return { status: 204 };
    } finally {
      active--;
    }
  });
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const calls = controllers.map(controller => observer(0, controller.signal));
  void Promise.allSettled(calls);
  const ninth = new AbortController();
  const denied = observer(0, ninth.signal);
  ninth.abort();
  await assert.rejects(denied, { status: 503, code: 'busy' });
  assert.equal(dials, 8);
  assert.equal(active, 8);
  controllers[0]?.abort();
  await assert.rejects(calls[0] ?? Promise.resolve(), { status: 502, code: 'upstream_failure' });
  const signal = new AbortController().signal;
  const next = observer(0, signal);
  assert.equal(dials, 9);
  assert.equal(active, 8);
  for (const release of releases) release();
  assert.deepEqual(await next, { status: 204 });
  await Promise.all(calls.slice(1));
  const fresh = observer(0, signal);
  releases.at(-1)?.();
  assert.deepEqual(await fresh, { status: 204 });
  assert.equal(active, 0);
});

test('unit: importing both entrypoints is silent even with invalid runtime settings', async () => {
  const imports = ['origin.mts', 'observer.mts'].map(name => {
    const url = new URL(`../${name}`, import.meta.url);
    return `await import(${JSON.stringify(url.href)});`;
  });
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    '--v8-pool-size=1', '--input-type=module', '--eval', imports.join('\n'),
  ], {
    env: { ...process.env, PORT: 'invalid', ORIGIN_ORIGIN: 'invalid', DB_PATH: '/nonexistent/document.sqlite' },
    timeout: 3000,
  });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});
