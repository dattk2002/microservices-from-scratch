import test from 'node:test';
import assert from 'node:assert/strict';
import { add, estimate, merge, position, smallRange, validRegisters, validSnapshot, validValue, wordPosition } from '../protocol.mts';
import { configuredOrigins, normalizeOrigin, validateHost } from '../protocol.mts';
import { Sketch } from '../store.mts';
import { aggregate } from '../aggregate.mts';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { exact } from '../protocol.mts';

const algorithm = 'hll-sha256-32-p4-v1';
const zeros = (): number[] => Array<number>(16).fill(0);
function replay(values: string[]): number[] {
  const r = zeros();
  for (const value of values) add(r, value);
  return r;
}

// Catches low-bit indexing, signed shifts, off-by-one ranks and a changed hash encoding.
test('unit: golden SHA256 high-four-bit index and low-28-bit rank, including unsigned bit31', () => {
  assert.deepEqual(position('v0'), {index: 0, rank: 3}); // SHA256 starts 0270da4d
  assert.deepEqual(position('v1'), {index: 3, rank: 1}); // 3bfc2695
  assert.deepEqual(position('v42'), {index: 10, rank: 1}); // aafa8c00
  assert.deepEqual(position('v255'), {index: 1, rank: 1}); // 1d56e5fc
  assert.deepEqual(wordPosition(0), {index: 0, rank: 29});
  assert.deepEqual(wordPosition(0x80000000), {index: 8, rank: 29});
  assert.deepEqual(wordPosition(0xffffffff), {index: 15, rank: 1});
  assert.deepEqual(wordPosition(0x00000001), {index: 0, rank: 28});
});

// Catches summing, replacement by a lower rank, mutation of inputs, and lost updates.
test('unit: max update is duplicate-idempotent and max merge is an associative commutative idempotent union', () => {
  const a = replay(['v0', 'v1']), b = replay(['v1', 'v42']), c = replay(['v255', 'v0']);
  assert.deepEqual(a, [3,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0]);
  const before = [...a];
  assert.equal(add(a, 'v0'), false);
  assert.deepEqual(a, before);
  const dominant = [29,...zeros().slice(1)];
  assert.equal(add(dominant, 'v0'), false);
  assert.equal(dominant[0], 29);
  assert.deepEqual(merge(a, b), merge(b, a));
  assert.deepEqual(merge(a, a), a);
  assert.deepEqual(merge(merge(a, b), c), merge(a, merge(b, c)));
  assert.deepEqual(merge(merge(a, b), c), [3,1,0,1,0,0,0,0,0,0,1,0,0,0,0,0]);
  assert.deepEqual(merge(merge(a, b), c), replay(['v0', 'v1', 'v1', 'v42', 'v255', 'v0']));
  const merged = merge(a, b); merged[0] = 29;
  assert.deepEqual(a, before);
  const all = Array.from({length: 256}, (_, i) => `v${i}`);
  assert.deepEqual(merge(replay(all.slice(0,180)), replay(all.slice(90))), replay(all));
});

// These are estimator fixtures, not claims that particular datasets have exact estimates.
test('unit: estimator empty, one register, no-zero raw formula and inclusive small-range boundary40', () => {
  assert.equal(estimate(zeros()), 0);
  const one = zeros(); one[0] = 1;
  assert.equal(estimate(one), 16 * Math.log(16 / 15));
  assert.equal(estimate(Array<number>(16).fill(1)), 21.536);
  assert.equal(estimate(Array<number>(16).fill(2)), 43.072);
  assert.equal(smallRange(40, 1), 16 * Math.log(16));
  assert.equal(smallRange(40.00000000000001, 1), 40.00000000000001);
  assert.equal(smallRange(40, 0), 40);
  assert.equal(Number.isFinite(estimate(Array<number>(16).fill(29))), true);
});

test('unit: canonical value and exact snapshot schemas reject coercion, wrong identity and malformed ranks', () => {
  for (const value of ['v0','v1','v255']) assert.equal(validValue(value), true);
  for (const value of [null,[],{}, {toString:null},1,true,'v00','v01','v256','v-1','v1.0','v1\n']) assert.equal(validValue(value), false);
  const snapshot = {id:'a', algorithm, registers:zeros()};
  assert.equal(validSnapshot(snapshot, 'a'), true);
  for (const value of [null,[],true,1,'x',{}, {...snapshot,id:'b'}, {...snapshot,algorithm:'hll++'}, {...snapshot,extra:1}, {...snapshot,registers:null}]) assert.equal(validSnapshot(value, 'a'), false);
  for (const bad of [[],zeros().slice(1),[...zeros(),0],Array(16).fill('0'),[29.1,...zeros().slice(1)],[-1,...zeros().slice(1)],[30,...zeros().slice(1)],[NaN,...zeros().slice(1)],[null,...zeros().slice(1)]]) {
    assert.equal(validRegisters(bad), false);
    assert.equal(validSnapshot({...snapshot,registers:bad}, 'a'), false);
  }
  assert.equal(validRegisters(Array(16).fill(29)), true);
});

test('unit: private SQLite max update is atomic, duplicate-idempotent and snapshots do not alias durable state', async () => {
  const sketch = await Sketch.open(':memory:', 'a');
  try {
    assert.deepEqual(sketch.snapshot(), {id:'a',algorithm,registers:zeros()});
    assert.deepEqual(sketch.write({value:'v0'}), {changed:true});
    const before = sketch.snapshot();
    assert.deepEqual(before.registers, [3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
    assert.deepEqual(sketch.write({value:'v0'}), {changed:false});
    assert.deepEqual(sketch.snapshot(), before);
    before.registers[0] = 29;
    assert.equal(sketch.snapshot().registers[0], 3);
    for (const body of [null,[],1,true,'v1',{}, {value:1}, {value:null}, {value:{toString:null}}, {value:'v01'}, {value:'v256'}, {value:'v1',extra:1}]) {
      assert.throws(() => sketch.write(body), {status:400,code:'invalid_request'});
    }
    assert.deepEqual(sketch.snapshot().registers, [3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]);
  } finally { sketch.close(); }
  await assert.rejects(Sketch.open(':memory:', 'c'), /SKETCH_ID/);
});

const firstOrigin = 'http://127.0.0.1:18073', secondOrigin = 'http://127.0.0.1:18074';
const snapshotA = {id:'a',algorithm,registers:[3,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]};
const snapshotB = {id:'b',algorithm,registers:[1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0]};

test('unit: aggregate merges registers by max before estimating, including overlapping source registers', async () => {
  const fetcher: typeof fetch = async input => {
    if (input === firstOrigin + '/snapshot') return Response.json(snapshotA);
    if (input === secondOrigin + '/snapshot') return Response.json(snapshotB);
    throw new Error('Unexpected URL');
  };
  assert.deepEqual(await aggregate(firstOrigin, secondOrigin, fetcher), {
    registers:[3,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0], estimate:16 * Math.log(16 / 14),
  });
});

test('unit: both upstream branches reject malformed exact schemas, unexpected statuses and business-looking errors', async () => {
  for (const branch of ['a','b']) {
    const good = branch === 'a' ? snapshotA : snapshotB;
    const badBodies: unknown[] = [null,[],1,true,'x',{}, {...good,id:branch==='a'?'b':'a'}, {...good,algorithm:'other'}, {...good,extra:1}, {...good,registers:zeros().slice(1)}, {...good,registers:[30,...zeros().slice(1)]}, {...good,registers:['1',...zeros().slice(1)]}, {error:{code:'internal_error',message:'internal_error'}}];
    for (const bad of badBodies) {
      const fetcher: typeof fetch = async input => Response.json(input === (branch==='a'?firstOrigin:secondOrigin)+'/snapshot' ? bad : (branch==='a'?snapshotB:snapshotA));
      await assert.rejects(aggregate(firstOrigin, secondOrigin, fetcher), {status:502,code:'upstream_failure',message:'upstream_failure'});
    }
    for (const status of [201,404,409,422,429,500,503]) for (const payload of [good,{error:{code:'absent',message:'absent'}}]) {
      const fetcher: typeof fetch = async input => input === (branch==='a'?firstOrigin:secondOrigin)+'/snapshot'
        ? Response.json(payload, {status}) : Response.json(branch==='a'?snapshotB:snapshotA);
      await assert.rejects(aggregate(firstOrigin, secondOrigin, fetcher), {status:502});
    }
  }
});

test('unit: upstream wire limits cover full bodies while escaped-string valid JSON remains accepted', async () => {
  for (const branch of ['a','b']) for (const mode of ['limit','over-limit','oversize','utf8','malformed','media','escaped','transport']) {
    const fetcher: typeof fetch = async input => {
      const isA = input === firstOrigin+'/snapshot', body = isA ? snapshotA : snapshotB;
      if ((branch==='a') !== isA) return Response.json(body);
      if (mode === 'transport') throw new Error('connection reset');
      const wire = mode === 'escaped' ? escapedJson(body) : JSON.stringify(body);
      if (mode === 'limit' || mode === 'over-limit') return new Response(wire.padEnd(mode === 'limit' ? 8192 : 8193, ' '), {headers:{'content-type':'application/json'}});
      return new Response(mode === 'utf8' ? Buffer.from([0xff]) : mode === 'malformed' ? '{' : wire + (mode === 'oversize' ? ' '.repeat(8192) : ''), {headers:{'content-type':mode==='media'?'text/plain':'application/json'}});
    };
    if (mode === 'escaped' || mode === 'limit') assert.equal((await aggregate(firstOrigin,secondOrigin,fetcher)).estimate, 16*Math.log(16/14));
    else await assert.rejects(aggregate(firstOrigin,secondOrigin,fetcher), {status:502});
  }
});

function escapedJson(body: unknown): string {
  return JSON.stringify(body).replace(/"(?:[^"\\]|\\.)*"/g, token => {
    const decoded: unknown = JSON.parse(token);
    if (typeof decoded !== 'string') throw new Error('Expected JSON string token');
    return '"' + Array.from(decoded, c => '\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('') + '"';
  });
}

test('unit: one total 500ms deadline includes stalled bodies and never waits for a hanging cancellation', async () => {
  for (const branch of ['a','b']) {
    const fetcher: typeof fetch = async input => {
      const isA = input === firstOrigin+'/snapshot';
      if ((branch==='a') !== isA) return Response.json(isA?snapshotA:snapshotB);
      return new Response(new ReadableStream<Uint8Array>({start(c) { c.enqueue(Buffer.from('{')); }, cancel() { return new Promise<void>(() => {}); }}), {headers:{'content-type':'application/json'}});
    };
    const start = performance.now();
    await assert.rejects(aggregate(firstOrigin,secondOrigin,fetcher), {status:502});
    const elapsed = performance.now()-start;
    assert.ok(elapsed >= 450 && elapsed < 1200, `${elapsed}ms`);
  }
});

test('unit: header latency and body latency consume the same total budget', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    await delay(280, undefined, {signal:init?.signal ?? undefined});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        timer = setTimeout(() => {
          controller.enqueue(Buffer.from(JSON.stringify(input === firstOrigin+'/snapshot' ? snapshotA : snapshotB)));
          controller.close();
        },350);
      },
      cancel() { clearTimeout(timer); },
    });
    return new Response(stream, {headers:{'content-type':'application/json'}});
  };
  const start = performance.now();
  await assert.rejects(aggregate(firstOrigin,secondOrigin,fetcher), {status:502});
  const elapsed = performance.now()-start;
  assert.ok(elapsed >= 450 && elapsed < 1200, `${elapsed}ms`);
});

test('unit: startup accepts normalized distinct loopback origins and rejects caller URLs or host escapes', () => {
  assert.equal(normalizeOrigin(firstOrigin+'/'), firstOrigin);
  assert.deepEqual(configuredOrigins(firstOrigin+'/', secondOrigin, undefined, 0), [firstOrigin,secondOrigin]);
  assert.throws(() => configuredOrigins(firstOrigin, firstOrigin+'/', undefined, 0), /distinct/);
  assert.throws(() => configuredOrigins(firstOrigin,secondOrigin,undefined,18073), /distinct/);
  assert.throws(() => configuredOrigins('http://127.0.0.1:80','http://127.0.0.1/',undefined,0), /distinct/);
  for (const value of ['http://localhost:80','https://127.0.0.1:12','http://127.0.0.1:0','http://127.0.0.1:12/path','http://user@127.0.0.1:12','http://127.0.0.1:12?x=1','http://127.0.0.1:12/#x']) assert.throws(() => normalizeOrigin(value));
  for (const host of ['0.0.0.0','localhost','::1',null,{},1]) assert.throws(() => validateHost(host));
});

test('unit: both entrypoints import silently with invalid configuration without loading runtime SQLite', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(new URL('../hll.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('../aggregate.mts',import.meta.url).href)});`,
  ], {encoding:'utf8',timeout:3000,env:{PATH:process.env.PATH??'',PORT:'invalid',HOST:'invalid',DB_PATH:'',SKETCH_ID:'invalid',SOURCE_A_ORIGIN:'invalid',SOURCE_B_ORIGIN:'invalid'}});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, '');
  assert.equal(child.stderr, '');
});

async function stopAll(services: RunningService[]): Promise<void> {
  const results = await Promise.allSettled(services.map(service => service.stop()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
async function request(base: string, path: string, status = 200, method = 'GET', data?: unknown): Promise<unknown> {
  const response = await fetch(base+path, {method,signal:AbortSignal.timeout(3000),
    ...(data === undefined ? {} : {headers:{'content-type':'application/json'},body:JSON.stringify(data)}),
  });
  const body: unknown = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(body)}`);
  return body;
}

test('integration: three processes merge overlapping values, persist max registers and preserve duplicates across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hll-73-'));
  const services: RunningService[] = [];
  try {
    const file = join(dir,'a.db');
    let a = await startService(new URL('../hll.mts',import.meta.url), {DB_PATH:file,SKETCH_ID:'a'}); services.push(a);
    const b = await startService(new URL('../hll.mts',import.meta.url), {DB_PATH:join(dir,'b.db'),SKETCH_ID:'b'}); services.push(b);
    let gateway = await startService(new URL('../aggregate.mts',import.meta.url), {SOURCE_A_ORIGIN:a.url+'/',SOURCE_B_ORIGIN:b.url}); services.push(gateway);
    assert.deepEqual(await request(gateway.url,'/estimate'), {registers:zeros(),estimate:0});
    for (const value of ['v0','v1','v42']) assert.deepEqual(await request(a.url,'/values',200,'POST',{value}), {changed:true});
    for (const value of ['v1','v255']) assert.deepEqual(await request(b.url,'/values',200,'POST',{value}), {changed:true});
    assert.deepEqual(await request(b.url,'/values',200,'POST',{value:'v1'}), {changed:false});
    const want = {registers:[3,1,0,1,0,0,0,0,0,0,1,0,0,0,0,0],estimate:16*Math.log(16/12)};
    assert.deepEqual(await request(gateway.url,'/estimate'), want);
    const before = await request(a.url,'/snapshot');
    assert.deepEqual(before, {id:'a',algorithm,registers:[3,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0]});
    await gateway.stop(); await a.stop();
    await assert.rejects(startService(new URL('../hll.mts',import.meta.url), {DB_PATH:file,SKETCH_ID:'b'}), /identity mismatch/);
    // Tamper only while the owner is stopped to prove startup validates stored algorithm.
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      assert.ok(exact(before,['id','algorithm','registers']));
      db.prepare('UPDATE sketch SET data=? WHERE singleton=1').run(JSON.stringify({...before,algorithm:'incompatible-v2'}));
    } finally { db.close(); }
    await assert.rejects(startService(new URL('../hll.mts',import.meta.url), {DB_PATH:file,SKETCH_ID:'a'}), /algorithm mismatch/);
    const restore = new DatabaseSync(file);
    try { restore.prepare('UPDATE sketch SET data=? WHERE singleton=1').run(JSON.stringify(before)); }
    finally { restore.close(); }
    a = await startService(new URL('../hll.mts',import.meta.url), {DB_PATH:file,SKETCH_ID:'a'}); services.push(a);
    assert.deepEqual(await request(a.url,'/snapshot'), before);
    assert.deepEqual(await request(a.url,'/values',200,'POST',{value:'v0'}), {changed:false});
    assert.deepEqual(await request(a.url,'/snapshot'), before);
    gateway = await startService(new URL('../aggregate.mts',import.meta.url), {SOURCE_A_ORIGIN:a.url,SOURCE_B_ORIGIN:b.url}); services.push(gateway);
    assert.deepEqual(await request(gateway.url,'/estimate'), want);
  } finally {
    try { await stopAll(services); } finally { await rm(dir,{recursive:true,force:true}); }
  }
});

test('integration: exact request schemas, canonical paths, methods and distinct origins are enforced', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hll-schema-73-'));
  const services: RunningService[] = [];
  try {
    const a = await startService(new URL('../hll.mts',import.meta.url), {DB_PATH:join(dir,'a.db'),SKETCH_ID:'a'}); services.push(a);
    const b = await startService(new URL('../hll.mts',import.meta.url), {DB_PATH:join(dir,'b.db'),SKETCH_ID:'b'}); services.push(b);
    const gateway = await startService(new URL('../aggregate.mts',import.meta.url), {SOURCE_A_ORIGIN:a.url,SOURCE_B_ORIGIN:b.url}); services.push(gateway);
    await assert.rejects(startService(new URL('../aggregate.mts',import.meta.url), {SOURCE_A_ORIGIN:a.url,SOURCE_B_ORIGIN:a.url+'/'}), /distinct/);
    for (const body of [null,[],1,true,'v1',{}, {value:null},{value:1},{value:[]},{value:{toString:null}},{value:'v01'},{value:'v256'},{value:'v1\n'},{value:'v1',extra:1}]) {
      assert.deepEqual(await request(a.url,'/values',400,'POST',body), {error:{code:'invalid_request',message:'invalid_request'}});
    }
    assert.deepEqual(await request(a.url,'/snapshot'), {id:'a',algorithm,registers:zeros()});
    for (const [body,status,code,type] of [['{',400,'invalid_json','application/json'],['{}'+' '.repeat(8192),413,'body_too_large','application/json'],['{}',415,'unsupported_media_type','text/plain']]) {
      assert.ok(typeof body === 'string' && typeof type === 'string');
      const response = await fetch(a.url+'/values', {method:'POST',headers:{'content-type':type},body,signal:AbortSignal.timeout(3000)});
      const parsed: unknown = await response.json();
      assert.equal(response.status,status); assert.deepEqual(parsed,{error:{code,message:code}});
    }
    for (const [base,path] of [[a.url,'/snapshot'],[a.url,'/values'],[gateway.url,'/estimate']]) {
      assert.ok(base && path);
      const response = await fetch(base+path,{method:'DELETE',signal:AbortSignal.timeout(3000)});
      const body: unknown = await response.json();
      assert.equal(response.status,405); assert.ok(response.headers.get('allow'));
      assert.deepEqual(body,{error:{code:'method_not_allowed',message:'method_not_allowed'}});
    }
    for (const path of ['/snapshot?x=1','/values?url=http://127.0.0.1:1']) await request(a.url,path,400);
    await request(gateway.url,'/estimate?url='+encodeURIComponent(a.url),400);
    await request(a.url,'/snapshot/',404); await request(gateway.url,'/estimate/',404);
    await request(a.url,'/delete',404);
    assert.deepEqual(await request(a.url,'/values',200,'POST',{value:'v255'}),{changed:true});
  } finally {
    try { await stopAll(services); } finally { await rm(dir,{recursive:true,force:true}); }
  }
});

test('integration: both snapshots validate full wire contracts, redirects never reach a distinct sink and total deadline covers bodies', async () => {
  const services: RunningService[] = [];
  try {
    const sink = await startService(new URL('./fixture.mts',import.meta.url), {FIXTURE_ID:'sink'}); services.push(sink);
    const a = await startService(new URL('./fixture.mts',import.meta.url), {FIXTURE_ID:'a',REDIRECT_ORIGIN:sink.url}); services.push(a);
    const b = await startService(new URL('./fixture.mts',import.meta.url), {FIXTURE_ID:'b',REDIRECT_ORIGIN:sink.url}); services.push(b);
    const gateway = await startService(new URL('../aggregate.mts',import.meta.url), {SOURCE_A_ORIGIN:a.url,SOURCE_B_ORIGIN:b.url}); services.push(gateway);
    const mode = async (source: RunningService, name: string) => request(source.url,'/mode',200,'POST',{mode:name});
    for (const body of [null,[],1,true,'ok',{}, {mode:1},{mode:{toString:null}},{mode:'ok',extra:1}]) await request(a.url,'/mode',400,'POST',body);
    for (const source of [a,b]) {
      for (const name of ['null','array','primitive','extra','wrong-id','wrong-algorithm','short','long','negative','high','fraction','string-rank','object-registers','error','error-primitive','error-array','error-extra','wrong-code','status201','status404','status409','status422','status429','status503','media','utf8','malformed','oversize','chunked-oversize','close']) {
        await mode(source,name);
        assert.deepEqual(await request(gateway.url,'/estimate',502), {error:{code:'upstream_failure',message:'upstream_failure'}});
      }
      await mode(source,'escaped');
      assert.deepEqual(await request(gateway.url,'/estimate'), {registers:zeros(),estimate:0});
      await mode(source,'redirect');
      await request(gateway.url,'/estimate',502);
      // Inspect before any fixture control could reset the evidence. Sink stays reachable.
      assert.deepEqual(await request(sink.url,'/stats'), {received:0});
      for (const name of ['slow-headers','slow-body','slow-parts']) {
        await mode(source,name);
        const start = performance.now();
        await request(gateway.url,'/estimate',502);
        const elapsed = performance.now()-start;
        assert.ok(elapsed >= 450 && elapsed < 1200, `${name}: ${elapsed}ms`);
      }
      await mode(source,'ok');
    }
    assert.deepEqual(await request(gateway.url,'/estimate'), {registers:zeros(),estimate:0});
    await b.stop();
    await request(gateway.url,'/estimate',502);
  } finally { await stopAll(services); }
});
