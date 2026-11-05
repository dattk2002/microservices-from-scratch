import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget, hedge } from '../hedge.mts';
import type { Clock, Reply } from '../hedge.mts';
class Manual implements Clock {
  now = 0; jobs = new Map<number, {at: number; fn: () => void}>(); serial = 0;
  after(ms: number, fn: () => void) { const id = ++this.serial; this.jobs.set(id, {at: this.now + ms, fn}); return () => { this.jobs.delete(id); }; }
  tick(ms: number) { this.now += ms; for (const [id, job] of [...this.jobs]) if (job.at <= this.now) { this.jobs.delete(id); job.fn(); } }
}
function deferred() { let resolve!: (v: Reply) => void; const promise = new Promise<Reply>(r => { resolve = r; }); return {promise, resolve}; }
const ok: Reply = {status: 200, value: {id: 'a', text: 'hello'}};
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
test('unit: fast primary suppresses hedge and cleans timers', async () => {
  const clock = new Manual(); const budget = new Budget(1); let calls = 0;
  const result = await hedge(async () => { calls++; return ok; }, clock, budget, new AbortController().signal, 10, 100);
  assert.deepEqual(result, ok); clock.tick(100); assert.equal(calls, 1); assert.equal(clock.jobs.size, 0);
});
test('unit: delayed secondary wins, cancels loser, ignores late result', async () => {
  const clock = new Manual(); const budget = new Budget(1); const primary = deferred(); let loser: AbortSignal | undefined;
  const p = hedge((i, s) => { if (i === 0) { loser = s; return primary.promise; } return Promise.resolve(ok); }, clock, budget, new AbortController().signal, 10, 100);
  clock.tick(10); assert.deepEqual(await p, ok); assert.equal(loser?.aborted, true); assert.equal(budget.active, 0); primary.resolve({status: 403}); await flush(); assert.equal(clock.jobs.size, 0);
});
test('unit: transient failure waits for possible success; fatal stops', async () => {
  const clock = new Manual(); const budget = new Budget(1); let calls = 0;
  const p = hedge(async i => { calls++; return i === 0 ? {status: 503} : ok; }, clock, budget, new AbortController().signal, 10, 100);
  await flush(); clock.tick(10); assert.deepEqual(await p, ok); assert.equal(calls, 2);
  const fatal = await hedge(async () => ({status: 404}), clock, budget, new AbortController().signal, 10, 100); assert.equal(fatal.status, 404); assert.equal(clock.jobs.size, 0);
});
test('unit: all failures, deadline, disconnect and nonqueuing saturation', async () => {
  const clock = new Manual(); const budget = new Budget(0);
  const p = hedge(async () => ({status: 503}), clock, budget, new AbortController().signal, 10, 100); await flush(); clock.tick(10); assert.equal((await p).status, 502);
  for (const disconnect of [false, true]) {
    const c = new AbortController(); const signals: AbortSignal[] = [];
    const pending = hedge((_i, s) => { signals.push(s); return deferred().promise; }, clock, new Budget(1), c.signal, 10, 100);
    clock.tick(10); if (disconnect) c.abort(); else clock.tick(100);
    assert.equal((await pending).status, disconnect ? 499 : 504); assert.equal(signals.length, 2); assert.ok(signals.every(s => s.aborted)); assert.equal(clock.jobs.size, 0);
  }
  const b = new Budget(1); const release = b.acquire(); assert.ok(release); assert.equal(b.acquire(), undefined); release(); release(); assert.equal(b.active, 0);
});

import { readResponse, MAX_BODY, parseValue, loopback } from '../protocol.mts';
import { modeFrom } from '../replica.mts';
import { getEventListeners } from 'node:events';
import { spawn } from 'node:child_process';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: maximal escaped representation, oversize, malformed and identity validation', async () => {
  const id = 'a'.repeat(64); const value = {id, text: '\u0000'.repeat(256)};
  const encoded = JSON.stringify(value); assert.equal(Buffer.byteLength(encoded), MAX_BODY);
  const response = (body: string) => new Response(body, {headers: {'content-type': 'application/json'}});
  assert.deepEqual((await readResponse(response(encoded), id)).value, value);
  const oversized=' '.repeat(MAX_BODY+1)+encoded;
  assert.deepEqual(parseValue(JSON.parse(oversized),id),value);
  await assert.rejects(readResponse(response(oversized), id), /Oversized/);
  for (const raw of [{id: 'wrong', text: ''}, {id, text: []}, {id, text: 'x'.repeat(257)}, {id, text: '', extra: 1}]) assert.throws(() => parseValue(raw, id));
  for (const raw of [[], ['hold'], {}, 1, true, null]) assert.throws(() => modeFrom(raw));
  for (const origin of ['https://127.0.0.1', 'http://example.com', 'http://127.0.0.1/path']) assert.throws(() => loopback(origin));
});
test('unit: caller listeners removed, pre-abort does not forward, thrown transport eligible', async () => {
  const clock = new Manual(); const caller = new AbortController(); const b = new Budget(1);
  const p = hedge(i => { if (!i) throw new Error('reset'); return Promise.resolve(ok); }, clock, b, caller.signal, 10, 100);
  await flush(); clock.tick(10); assert.deepEqual(await p, ok); assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  caller.abort(); let calls = 0;
  assert.equal((await hedge(async () => { calls++; return ok; }, clock, b, caller.signal, 10, 100)).status, 499); assert.equal(calls, 0); assert.equal(clock.jobs.size, 0);
});
test('unit: skipped hedge never queues and late primary still wins', async () => {
  const clock = new Manual(); const b = new Budget(1); const release = b.acquire()!; const d = deferred(); let calls = 0;
  const p = hedge(() => { calls++; return d.promise; }, clock, b, new AbortController().signal, 10, 100);
  clock.tick(10); release(); clock.tick(10); assert.equal(calls, 1); d.resolve(ok); assert.deepEqual(await p, ok); assert.equal(b.active, 0);
});
test('unit: nonfatal secondary failure cannot mask unresolved primary', async () => {
  const clock = new Manual(); const d = deferred(); const b = new Budget(1);
  const p = hedge(i => i === 0 ? d.promise : Promise.resolve({status: 503}), clock, b, new AbortController().signal, 10, 100);
  clock.tick(10); await flush(); d.resolve(ok); assert.deepEqual(await p, ok); assert.equal(b.active, 0);
});

test('unit: entrypoint imports ignore invalid runtime configuration silently in child', async () => {
  const imports = ['client.mts', 'replica.mts'].map(file => `await import(${JSON.stringify(new URL('../' + file, import.meta.url).href)});`).join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', imports], {env: {PATH: process.env.PATH ?? '', PORT: 'invalid', HOST: 'invalid', PRIMARY_URL: 'invalid', HEDGE_MS: 'invalid', TEACHING_CONTROLS: 'invalid'}, stdio: ['ignore', 'pipe', 'pipe']});
  let output = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try { const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); assert.equal(code, 0, output); assert.equal(output, ''); } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
});

function request(url: string, init: RequestInit = {}) {
  const pending = fetch(url, {...init, signal: init.signal ?? AbortSignal.timeout(3000)});
  // Keep failures observed while a test is waiting on another barrier; awaiting still rejects.
  void pending.catch(() => {});
  return pending;
}
async function control(service: RunningService, mode: unknown) {
  return request(service.url + '/control', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({mode})});
}
async function stat(service: RunningService, name: string): Promise<number> {
  const r = await request(service.url + '/stats'); const raw: unknown = await r.json();
  assert.ok(typeof raw === 'object' && raw !== null && name in raw);
  const value: unknown = Reflect.get(raw, name); assert.ok(typeof value === 'number'); return value;
}
async function barrier(service: RunningService, name: string, value: number) {
  // Poll observable state; the time bound is a failure guard, never the success condition.
  const until = Date.now() + 4000;
  while (Date.now() < until) { if (await stat(service, name) === value) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(`barrier ${name}=${value}`);
}
async function fixture(run: (a: RunningService, b: RunningService, client: (env?: Record<string, string>) => Promise<RunningService>) => Promise<void>) {
  const services: RunningService[] = [];
  const start = async (file: string, env: Record<string, string>) => { const s = await startService(new URL('../' + file, import.meta.url), env); services.push(s); return s; };
  try {
    const a = await start('replica.mts', {TEACHING_CONTROLS: '1'}); const b = await start('replica.mts', {TEACHING_CONTROLS: '1'});
    await run(a, b, env => start('client.mts', {PRIMARY_URL: a.url, SECONDARY_URL: b.url, HEDGE_MS: '20', DEADLINE_MS: '2000', ...env}));
  } finally { for (const service of services.reverse()) await service.stop(); }
}
test('integration: fast primary one request and unsafe requests never forwarded', async () => {
  await fixture(async (a, b, start) => {
    const c = await start({HEDGE_MS: '5000', DEADLINE_MS: '9000'});
    assert.equal((await request(c.url + '/items/a')).status, 200);
    assert.equal(await stat(a, 'received'), 1); assert.equal(await stat(b, 'received'), 0);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await request(c.url + '/items/a', {method})).status, 405);
    assert.equal(await stat(a, 'received'), 1); assert.equal(await stat(b, 'received'), 0);
    for (const mode of [[], ['hold'], {}, 1, null]) assert.equal((await control(a, mode)).status, 400);
  });
});
test('integration: held primary secondary wins and losing replica observes cancellation', async () => {
  await fixture(async (a, b, start) => {
    assert.equal((await control(a, 'hold')).status, 200); await control(b, 'hold'); const c = await start();
    const p = request(c.url + '/items/a'); await barrier(a, 'held', 1); await barrier(b, 'held', 1); await control(b, 'normal');
    const r = await p; assert.equal(r.status, 200); assert.deepEqual(await r.json(), {id: 'a', text: 'hello'});
    await barrier(a, 'cancelled', 1); await barrier(a, 'active', 0); await barrier(b, 'active', 0); await barrier(c, 'extra', 0);
  });
});
test('integration: caller disconnect and overall deadline cancel both branches', async () => {
  for (const disconnect of [true, false]) await fixture(async (a, b, start) => {
    await control(a, 'hold'); await control(b, 'hold'); const c = await start({DEADLINE_MS: '1500'});
    const abort = new AbortController(); const pending = request(c.url + '/items/a', {signal: abort.signal});
    // Attach rejection handling immediately, before aborting the request.
    const outcome = pending.then(r => r.status, () => 499);
    await barrier(a, 'held', 1); await barrier(b, 'held', 1);
    if (disconnect) abort.abort(); assert.equal(await outcome, disconnect ? 499 : 504);
    for (const s of [a, b]) { await barrier(s, 'cancelled', 1); await barrier(s, 'active', 0); }
    await barrier(c, 'extra', 0);
  });
});
test('integration: malformed identity and oversized successes rejected, maximal accepted', async () => {
  await fixture(async (a, b, start) => {
    const c = await start();
    for (const mode of ['malformed', 'wrong-id', 'oversized']) {
      await control(a, mode); await control(b, 'hold');
      const p = request(c.url + '/items/a'); await barrier(b, 'held', 1);
      await control(b, 'normal'); const r = await p; assert.equal(r.status, 200); assert.deepEqual(await r.json(), {id: 'a', text: 'hello'});
    }
    await control(a, 'maximal'); await control(b, 'maximal');
    const id = 'a'.repeat(64); const r = await request(c.url + '/items/' + id); assert.equal(r.status, 200); assert.deepEqual(await r.json(), {id, text: '\u0000'.repeat(256)});
    await control(a, 'malformed'); await control(b, 'malformed'); assert.equal((await request(c.url + '/items/a')).status, 502);
    await control(a, 'fatal'); assert.equal((await request(c.url + '/items/a')).status, 404);
  });
});
test('integration: saturated hedge permit skips without an unbounded queue', async () => {
  await fixture(async (a, b, start) => {
    await control(a, 'hold'); await control(b, 'hold'); const c = await start({HEDGE_CAPACITY: '1'});
    const first = request(c.url + '/items/a'); await barrier(b, 'held', 1);
    const rest = Array.from({length: 6}, () => request(c.url + '/items/a'));
    await barrier(a, 'received', 7); await barrier(c, 'skipped', 6); assert.equal(await stat(c, 'extra'), 1); assert.equal(await stat(b, 'received'), 1);
    await control(a, 'normal'); const replies = await Promise.all([first, ...rest]); assert.ok(replies.every(r => r.status === 200));
    await barrier(b, 'active', 0); await barrier(c, 'extra', 0); assert.equal(await stat(b, 'received'), 1);
    // Releasing capacity does not schedule deferred extra requests. Future operations may hedge.
  });
});

test('integration: oversized fixture is schema-valid and rejected specifically by byte limit', async () => {
  const replica=await startService(new URL('../replica.mts',import.meta.url),{TEACHING_CONTROLS:'1'});
  try {
    assert.equal((await control(replica,'oversized')).status,200);
    const response=await request(replica.url+'/items/a');
    const body=await response.text();
    assert.ok(Buffer.byteLength(body)>MAX_BODY);
    const raw: unknown=JSON.parse(body);
    assert.doesNotThrow(()=>parseValue(raw,'a'),'oversized fixture must pass unrelated schema validation');
    await assert.rejects(readResponse(await request(replica.url+'/items/a'),'a'),/Oversized/);
  } finally {await replica.stop();}
});
test('unit: both attempts fail; secondary fatal cancels pending primary', async () => {
  for (const fatal of [false, true]) {
    const clock = new Manual(); const b = new Budget(1); let primary: AbortSignal | undefined;
    const p = hedge((i, signal) => {
      if (i === 0) { primary = signal; return fatal ? deferred().promise : Promise.reject(new Error('reset')); }
      return Promise.resolve({status: fatal ? 403 : 429});
    }, clock, b, new AbortController().signal, 10, 100);
    await flush(); clock.tick(10); assert.equal((await p).status, fatal ? 403 : 502);
    assert.equal(primary?.aborted, true); assert.equal(clock.jobs.size, 0); assert.equal(b.active, 0);
  }
});
