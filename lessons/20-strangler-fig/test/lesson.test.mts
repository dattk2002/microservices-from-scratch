import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, owner, recovery } from '../policy.mts';

test('unit: ownership follows one durable phase, barrier closes reads and writes', () => {
  assert.equal(owner('legacy-only'), 'legacy');
  assert.equal(owner('copy-cutover'), undefined);
  assert.equal(owner('extracted-owner'), 'extracted');
});

test('unit: only forward adjacent transitions or idempotent repeats are legal', () => {
  assert.equal(transition('legacy-only', 'copy-cutover'), 'copy-cutover');
  assert.equal(transition('copy-cutover', 'extracted-owner'), 'extracted-owner');
  for (const phase of ['legacy-only', 'copy-cutover', 'extracted-owner'] as const) {
    assert.equal(transition(phase, phase), phase);
  }
  assert.throws(() => transition('legacy-only', 'extracted-owner'));
  assert.throws(() => transition('copy-cutover', 'legacy-only'));
  assert.throws(() => transition('extracted-owner', 'legacy-only'));
  assert.throws(() => transition('extracted-owner', 'copy-cutover'));
});

test('unit: interruption never reopens legacy or overwrites an activated target', () => {
  assert.equal(recovery('legacy-only'), 'serve-legacy');
  assert.equal(recovery('copy-cutover'), 'freeze-copy-validate-activate');
  assert.equal(recovery('extracted-owner'), 'serve-extracted');
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { Store, digest, snapshot, note } from '../data.mts';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import type { TestContext } from 'node:test';

function temp(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'strangler-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('unit: durable barrier survives reopen, activated copy retries preserve newer writes', t => {
  const dir = temp(t);
  let facade = new Store(join(dir, 'facade.sqlite'), 'facade');
  facade.advance('copy-cutover'); facade.close();
  facade = new Store(join(dir, 'facade.sqlite'), 'facade');
  assert.equal(owner(facade.phase()), undefined);
  assert.throws(() => facade.advance('legacy-only'));
  facade.close();
  const rows = [{ id: 'seed', text: 'Sổ tay' }];
  let target = new Store(join(dir, 'target.sqlite'), 'extracted');
  assert.throws(() => target.activate(digest(rows)));
  const hash = target.copy(rows);
  assert.deepEqual(target.rows(), rows);
  target.close(); // Interruption after copy, before activation.
  target = new Store(join(dir, 'target.sqlite'), 'extracted');
  assert.equal(target.copy(rows), hash);
  target.activate(hash); target.put({ id: 'seed', text: 'Mới' }); target.close();
  target = new Store(join(dir, 'target.sqlite'), 'extracted');
  try {
    assert.equal(target.state(), 'active');
    assert.equal(target.copy(rows), hash); // Lost activation response: do not overwrite.
    target.activate(hash);
    assert.deepEqual(target.rows(), [{ id: 'seed', text: 'Mới' }]);
    assert.throws(() => target.copy([{ id: 'other', text: 'Wrong snapshot' }]));
  } finally { target.close(); }
  assert.throws(() => new Store(join(dir, 'target.sqlite'), 'legacy'), /owner/);
});

test('unit: snapshot validation rejects duplicates and excessive volume; canonical digest ignores order', () => {
  assert.throws(() => snapshot([{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }]));
  assert.throws(() => snapshot(Array.from({ length: 31 }, (_, i) => ({ id: `n-${i}`, text: 'a' }))));
  assert.throws(() => note({ id: 'x', text: '\u0000' }));
  assert.throws(() => note({ id: 'x', text: '\ud800' }));
  const maximum = snapshot(Array.from({ length: 30 }, (_, i) => ({ id: `${i}`.padStart(24, 'x'), text: '漢'.repeat(64) })));
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) <= 8192);
  assert.throws(() => note({ id: 'x', text: 'ok', extra: true }));
  const a = { id: 'a', text: 'Một' }; const b = { id: 'b', text: 'Hai' };
  assert.equal(digest([a, b]), digest([b, a]));
  assert.notEqual(digest([a]), digest([b]));
});

test('unit: importing every entrypoint with invalid configuration exits silently without resources', async () => {
  const entries = ['legacy.mts', 'extracted.mts', 'facade.mts'].map(entry => new URL(`../${entry}`, import.meta.url).href);
  const child = spawn(process.execPath, ['--input-type=module', '--eval',
    `for (const entry of ${JSON.stringify(entries)}) await import(entry);`], {
    env: { PATH: process.env.PATH ?? '', PORT: 'invalid', DB_PATH: '/invalid/no/database',
      LEGACY_URL: 'invalid', EXTRACTED_URL: 'invalid', DRAIN_MS: 'invalid', TEST_CONTROL: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try {
    const [code, signal] = await once(child, 'close');
    assert.equal(signal, null); assert.equal(code, 0);
    assert.equal(stdout, ''); assert.equal(stderr, '');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

async function get(url: string) {
  return fetch(url, { signal: AbortSignal.timeout(5000) });
}
async function state(url: string): Promise<unknown> { return (await get(url)).json(); }
async function until(url: string, predicate: (value: unknown) => boolean) {
  const end = Date.now() + 2500;
  while (Date.now() < end) {
    if (predicate(await state(url))) return;
    await delay(10);
  }
  assert.fail(`Condition not observed at ${url}`);
}
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined;
}
async function fixture(t: TestContext, drainMs = '1200') {
  const dir = mkdtempSync(join(tmpdir(), 'strangler-'));
  const running: RunningService[] = [];
  async function start(entry: string, env: Record<string, string>) {
    const service = await startService(new URL(`../${entry}.mts`, import.meta.url), env);
    running.push(service); return service;
  }
  t.after(async () => {
    try { for (const service of [...running].reverse()) await service.stop(); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });
  const legacyEnv = { DB_PATH: join(dir, 'legacy.sqlite'), TEST_CONTROL: '1', DRAIN_MS: drainMs };
  const extractedEnv = { DB_PATH: join(dir, 'extracted.sqlite'), TEST_CONTROL: '1' };
  const legacy = await start('legacy', legacyEnv);
  const extracted = await start('extracted', extractedEnv);
  const facadeEnv = { DB_PATH: join(dir, 'facade.sqlite'), LEGACY_URL: legacy.url, EXTRACTED_URL: extracted.url };
  const facade = await start('facade', facadeEnv);
  return { start, legacy, extracted, facade, legacyEnv, extractedEnv, facadeEnv };
}

test('integration: stable API, synchronized drain, explicit barrier, durable ownership and no fallback', async t => {
  const f = await fixture(t);
  assert.equal(new Set([f.legacy.child.pid, f.extracted.child.pid, f.facade.child.pid]).size, 3);
  const first = { id: 'packing', text: 'Đóng gói trước 17 giờ' };
  const before = await jsonRequest(f.facade.url + '/notes', first);
  assert.equal(before.status, 200); assert.deepEqual(await before.json(), first);
  assert.deepEqual(await state(f.facade.url + '/notes'), [first]);
  assert.equal((await jsonRequest(f.extracted.url + '/notes', first)).status, 503);
  await jsonRequest(f.legacy.url + '/control/hold', {});
  const inflightNote = { id: 'shipping', text: 'Write đã được legacy nhận' };
  const inflight = jsonRequest(f.facade.url + '/notes', inflightNote);
  // Attach a rejection handler immediately so cleanup on a failed assertion is safe.
  const written = inflight.then(response => response, () => undefined);
  await until(f.legacy.url + '/status', value => field(value, 'active') === 1);
  const migrating = jsonRequest(f.facade.url + '/migrate', {}).then(response => response, () => undefined);
  await until(f.legacy.url + '/status', value => field(value, 'state') === 'frozen' && field(value, 'active') === 1);
  const blocked = await jsonRequest(f.facade.url + '/notes', { id: 'blocked', text: 'Valid payload during barrier' });
  assert.equal(blocked.status, 503);
  assert.equal(field(field(await blocked.json(), 'error'), 'code'), 'cutover_barrier');
  assert.equal((await get(f.facade.url + '/notes')).status, 503);
  assert.equal((await jsonRequest(f.legacy.url + '/notes', { id: 'direct', text: 'Valid fenced request' })).status, 503);
  await jsonRequest(f.legacy.url + '/control/release', {});
  assert.equal((await written)?.status, 200);
  assert.equal((await migrating)?.status, 200);
  assert.deepEqual(await state(f.facade.url + '/notes'), [first, inflightNote]);
  const after = { id: 'packing', text: 'Nội dung thuộc extracted' };
  const updated = await jsonRequest(f.facade.url + '/notes', after);
  assert.equal(updated.status, before.status); assert.deepEqual(await updated.json(), after);
  // Restart all processes with the same durable files, reusing the originally ephemeral ports.
  await f.facade.stop(); await f.extracted.stop(); await f.legacy.stop();
  await f.start('legacy', { ...f.legacyEnv, PORT: new URL(f.legacy.url).port });
  const restartedTarget = await f.start('extracted', { ...f.extractedEnv, PORT: new URL(f.extracted.url).port });
  const restartedFacade = await f.start('facade', f.facadeEnv);
  assert.equal(field(await state(restartedFacade.url + '/migration'), 'phase'), 'extracted-owner');
  assert.deepEqual(await state(restartedFacade.url + '/notes'), [after, inflightNote]);
  await jsonRequest(restartedTarget.url + '/control/hold-reply', {});
  const uncertainRow = { id: 'uncertain', text: 'Đã commit nhưng chưa trả lời' };
  const uncertain = jsonRequest(restartedFacade.url + '/notes', uncertainRow).then(r => r, () => undefined);
  await until(restartedTarget.url + '/status', value => field(value, 'committed') === 1 && field(value, 'active') === 1);
  const targetExited = new Promise<void>(resolve => restartedTarget.child.once('exit', () => resolve()));
  restartedTarget.child.kill('SIGKILL'); await targetExited;
  const lostReply = await uncertain;
  assert.equal(lostReply?.status, 503);
  if (lostReply) assert.equal(field(field(await lostReply.json(), 'error'), 'code'), 'owner_unavailable');
  const recoveredTarget = await f.start('extracted', { ...f.extractedEnv, PORT: new URL(f.extracted.url).port });
  assert.deepEqual(await state(restartedFacade.url + '/notes'), [after, inflightNote, uncertainRow]);
  await recoveredTarget.stop();
  const unavailable = await jsonRequest(restartedFacade.url + '/notes', { id: 'no-leak', text: 'Valid owner failure payload' });
  assert.equal(unavailable.status, 503);
  assert.equal((await get(restartedFacade.url + '/notes')).status, 503);
  const frozen = await jsonRequest(f.legacy.url + '/freeze', {});
  assert.equal(frozen.status, 200); assert.deepEqual(await frozen.json(), [first, inflightNote]);
});

test('integration: interrupted facade stays behind durable barrier, then resumes from a drained snapshot', async t => {
  const f = await fixture(t);
  await jsonRequest(f.legacy.url + '/control/hold', {});
  const row = { id: 'admitted', text: 'Không bỏ sót write đã nhận' };
  const admitted = jsonRequest(f.legacy.url + '/notes', row).then(r => r, () => undefined);
  await until(f.legacy.url + '/status', value => field(value, 'active') === 1);
  const interrupted = jsonRequest(f.facade.url + '/migrate', {}).then(r => r, () => undefined);
  await until(f.legacy.url + '/status', value => field(value, 'state') === 'frozen');
  // A hard kill, not a graceful drain, models loss of the migration coordinator.
  const exited = new Promise<void>(resolve => f.facade.child.once('exit', () => resolve()));
  f.facade.child.kill('SIGKILL'); await exited; await interrupted;
  await jsonRequest(f.legacy.url + '/control/release', {});
  assert.equal((await admitted)?.status, 200);
  await f.legacy.stop();
  await f.start('legacy', { ...f.legacyEnv, PORT: new URL(f.legacy.url).port });
  const resumed = await f.start('facade', f.facadeEnv);
  assert.equal(field(await state(resumed.url + '/migration'), 'phase'), 'copy-cutover');
  assert.equal((await jsonRequest(resumed.url + '/notes', { id: 'new', text: 'Valid pending recovery' })).status, 503);
  assert.equal((await jsonRequest(resumed.url + '/migrate', {})).status, 200);
  assert.deepEqual(await state(resumed.url + '/notes'), [row]);
});

test('integration: bounded drain timeout leaves a closed barrier; retry after release preserves data', async t => {
  const f = await fixture(t, '200');
  await jsonRequest(f.legacy.url + '/control/hold', {});
  const row = { id: 'slow', text: 'Write hoàn tất sau deadline của drain' };
  const admitted = jsonRequest(f.legacy.url + '/notes', row).then(r => r, () => undefined);
  await until(f.legacy.url + '/status', value => field(value, 'active') === 1);
  const failed = await jsonRequest(f.facade.url + '/migrate', {});
  assert.equal(failed.status, 503);
  assert.equal(field(await state(f.facade.url + '/migration'), 'phase'), 'copy-cutover');
  assert.equal(field(await state(f.extracted.url + '/status'), 'state'), 'passive');
  assert.equal((await jsonRequest(f.facade.url + '/notes', { id: 'blocked', text: 'Valid timeout test' })).status, 503);
  await jsonRequest(f.legacy.url + '/control/release', {});
  assert.equal((await admitted)?.status, 200);
  assert.equal((await jsonRequest(f.facade.url + '/migrate', {})).status, 200);
  assert.deepEqual(await state(f.facade.url + '/notes'), [row]);
});
