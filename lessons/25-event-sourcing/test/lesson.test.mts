import { test } from 'node:test';
import assert from 'node:assert/strict';

test('unit: replay creation and additions deterministically', async () => {
  const { replay } = await import('../model.mts');
  assert.deepEqual(replay([
    { schema: 1, seq: 1, type: 'created' },
    { schema: 1, seq: 2, type: 'added', item: 'tea', quantity: 2 },
  ]), { version: 2, items: { tea: 2 }, checkedOut: false });
});

test('unit: reject invalid schema, gaps, invalid domain commands and stale appends', async () => {
  const { replay, decide } = await import('../model.mts');
  const { Store } = await import('../store.mts');
  for (const history of [
    [{ schema: 2, seq: 1, type: 'created' }],
    [{ schema: 1, seq: 2, type: 'created' }],
    [{ schema: 1, seq: 1, type: 'added', item: 'tea', quantity: 1 }],
  ]) assert.throws(() => replay(history));
  const state = replay([{ schema: 1, seq: 1, type: 'created' }]);
  for (const command of [{ type: 'remove', item: 'tea', quantity: 1 }, { type: 'add', item: 'tea', quantity: 0 }, { type: 'checkout' }]) {
    assert.throws(() => decide(state, command));
  }
  const store = new Store(':memory:');
  try {
    store.append('cart', 0, { type: 'create' });
    assert.throws(() => store.append('cart', 0, { type: 'create' }));
    store.append('cart', 1, { type: 'add', item: 'tea', quantity: 2 });
    assert.equal(store.history('cart', 0, 1).events.length, 1);
    const expected = store.state('cart');
    store.snapshot('cart');
    assert.deepEqual(store.state('cart'), expected);
    store.db.prepare('UPDATE snapshots SET state = ?').run('{"version":2}');
    assert.deepEqual(store.state('cart'), expected);
    store.db.prepare('DELETE FROM snapshots').run();
    assert.deepEqual(store.state('cart'), expected);
    store.append('cart', 2, { type: 'checkout' });
    store.snapshot('cart');
    assert.deepEqual(store.state('cart'), { version: 3, items: { tea: 2 }, checkedOut: true });
    assert.throws(() => store.append('cart', 3, { type: 'add', item: 'tea', quantity: 1 }));
  } finally { store.close(); }
});

test('unit: reducer is pure, validates all event fields and enforces bounds', async () => {
  const { decide, replay, MAX_EVENTS } = await import('../model.mts');
  const created = { schema: 1, seq: 1, type: 'created' };
  const initial = replay([created]);
  const saved = structuredClone(initial);
  const added = decide(initial, { type: 'add', item: 'constructor', quantity: 2 });
  const state = replay([added], initial);
  assert.deepEqual(initial, saved);
  assert.equal(state.items.constructor, 2);
  assert.deepEqual(replay([decide(state, { type: 'remove', item: 'constructor', quantity: 2 })], state).items, {});
  const invalid = [
    { schema: 1, seq: 2, type: 'added', item: 'tea', quantity: 1.5 },
    { schema: 1, seq: 2, type: 'added', item: 'tea', quantity: -1 },
    { schema: 1, seq: 2, type: 'added', item: 'tea', quantity: 100 },
    { schema: 1, seq: 2, type: 'unknown' },
    { schema: 1, seq: 2, type: 'created' },
    { schema: 1, seq: 2, type: 'checkedOut' },
    { schema: 1, seq: 2, type: 'added', item: 'tea', quantity: 1, ignored: true },
  ];
  for (const event of invalid) assert.throws(() => replay([created, event]));
  assert.throws(() => decide(initial, { type: 'add', item: 42, quantity: 1 }));
  assert.throws(() => replay([created, created]));
  let full = initial;
  for (let n = 0; n < 20; n++) full = replay([decide(full, { type: 'add', item: `sku-${n}`, quantity: 1 })], full);
  assert.throws(() => decide(full, { type: 'add', item: 'extra', quantity: 1 }));
  let long = initial;
  for (let seq = 2; seq <= MAX_EVENTS; seq++) long = replay([decide(long, { type: seq % 2 === 0 ? 'add' : 'remove', item: 'tea', quantity: 1 })], long);
  assert.throws(() => decide(long, { type: 'add', item: 'tea', quantity: 1 }));
});

test('unit: SQLite immutability, transactional rollback, snapshot distrust and cart quota', async () => {
  const { Store } = await import('../store.mts');
  const store = new Store(':memory:');
  try {
    store.append('c', 0, { type: 'create' });
    assert.throws(() => store.append('c', 1, { type: 'remove', item: 'tea', quantity: 1 }));
    assert.equal(store.state('c').version, 1);
    assert.throws(() => store.db.prepare('UPDATE events SET body=?').run('{}'));
    assert.throws(() => store.db.exec('DELETE FROM events'));
    for (const limit of [0, 17, 1.5]) assert.throws(() => store.history('c', 0, limit));
    store.snapshot('c');
    for (const body of ['not json', JSON.stringify({ version: 1, items: { tea: 99 }, checkedOut: false }), JSON.stringify({ version: 99, items: {}, checkedOut: false })]) {
      store.db.prepare('UPDATE snapshots SET state=?').run(body);
      assert.deepEqual(store.state('c'), { version: 1, items: {}, checkedOut: false });
    }
    for (let n = 1; n < 100; n++) store.append(`c-${n}`, 0, { type: 'create' });
    assert.throws(() => store.append('overflow', 0, { type: 'create' }));
    assert.equal(store.history('overflow', 0, 1).version, 0);
  } finally { store.close(); }
});

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startService, jsonRequest } from '../../../test/support.mts';

test('unit: all entrypoints import silently with invalid runtime configuration', async () => {
  const entries = ['owner.mts', 'reader.mts', 'model.mts', 'store.mts', 'test/history-fixture.mts'];
  const script = entries.map(path => `await import(${JSON.stringify(new URL(`../${path}`, import.meta.url).href)});`).join('\n');
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { PATH: process.env.PATH ?? '', PORT: 'invalid', HOST: 'invalid', CART_DB: '/unavailable/db', OWNER_URL: 'invalid', FIXTURE_MODE: 'invalid' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

const ownerEntry = new URL('../owner.mts', import.meta.url);
const readerEntry = new URL('../reader.mts', import.meta.url);
const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(3000) });
async function command(url: string, expectedVersion: number, value: unknown) {
  return jsonRequest(`${url}/carts/cart/commands`, { expectedVersion, command: value });
}

test('integration: independent owner and reader, conflicts, paging, snapshots and restart', { timeout: 14000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-cart-'));
  const path = join(directory, 'owner.sqlite');
  let owner: Awaited<ReturnType<typeof startService>> | undefined;
  let reader: Awaited<ReturnType<typeof startService>> | undefined;
  try {
    owner = await startService(ownerEntry, { CART_DB: path });
    reader = await startService(readerEntry, { OWNER_URL: owner.url });
    assert.equal((await get(`${reader.url}/carts/cart`)).status, 404);
    assert.equal((await command(owner.url, 0, { type: 'create' })).status, 201);
    const results = await Promise.all([
      command(owner.url, 1, { type: 'add', item: 'tea', quantity: 2 }),
      command(owner.url, 1, { type: 'add', item: 'tea', quantity: 2 }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    for (let version = 2; version < 7; version++) assert.equal((await command(owner.url, version, { type: 'add', item: 'tea', quantity: 1 })).status, 201);
    assert.equal((await command(owner.url, 7, { type: 'remove', item: 'tea', quantity: 1 })).status, 201);
    assert.equal((await command(owner.url, 8, { type: 'checkout' })).status, 201);
    const expected = { version: 9, items: { tea: 6 }, checkedOut: true };
    assert.deepEqual(await (await get(`${reader.url}/carts/cart`)).json(), expected);
    assert.deepEqual(await (await get(`${owner.url}/carts/cart/state`)).json(), expected);
    const page = await (await get(`${owner.url}/carts/cart/events?after=4&limit=2`)).json();
    assert.deepEqual(page, { version: 9, events: [
      { schema: 1, seq: 5, type: 'added', item: 'tea', quantity: 1 },
      { schema: 1, seq: 6, type: 'added', item: 'tea', quantity: 1 },
    ] });
    assert.equal((await get(`${owner.url}/carts/cart/events?limit=17`)).status, 400);
    assert.equal((await command(owner.url, 9, { type: 'add', item: 'tea', quantity: 1 })).status, 422);
    assert.equal((await jsonRequest(`${owner.url}/carts/cart/snapshot`, {})).status, 200);
    await reader.stop(); reader = undefined;
    await owner.stop(); owner = undefined;
    // Only the test administrator touches the owner DB, while owner is stopped.
    // The reader never receives this path.
    const db = new DatabaseSync(path);
    try { db.exec('DELETE FROM snapshots'); } finally { db.close(); }
    owner = await startService(ownerEntry, { CART_DB: path });
    reader = await startService(readerEntry, { OWNER_URL: owner.url });
    assert.deepEqual(await (await get(`${owner.url}/carts/cart/state`)).json(), expected);
    assert.deepEqual(await (await get(`${reader.url}/carts/cart`)).json(), expected);
    // A duplicate command is a version conflict, never an automatic retry.
    assert.equal((await command(owner.url, 8, { type: 'checkout' })).status, 409);
  } finally {
    try { await reader?.stop(); } finally {
      try { await owner?.stop(); } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
});

test('integration: reader rejects malformed and out-of-order history from independent HTTP owner', { timeout: 14000 }, async () => {
  for (const mode of ['schema', 'sequence', 'missing', 'oversized', 'slow']) {
    const fixture = await startService(new URL('./history-fixture.mts', import.meta.url), { FIXTURE_MODE: mode });
    let reader: Awaited<ReturnType<typeof startService>> | undefined;
    try {
      reader = await startService(readerEntry, { OWNER_URL: fixture.url });
      const response = await get(`${reader.url}/carts/cart`);
      assert.equal(response.status, 502, mode);
      assert.deepEqual(await response.json(), { error: { code: 'invalid_history', message: 'Owner unavailable or invalid history' } });
    } finally { try { await reader?.stop(); } finally { await fixture.stop(); } }
  }
});
