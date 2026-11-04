import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseParent, childContext, encode, beginSpan, bindCompletion, context, type SpanRecord } from '../tracing.mts';
const trace = '1'.repeat(32), parent = '2'.repeat(16), next = '3'.repeat(16);
test('unit: version00 strict profile, flags and fresh parent-child context', () => {
  assert.deepEqual(parseParent(`00-${trace}-${parent}-03`), {traceId:trace,spanId:parent,flags:'03'});
  for (const value of [undefined,'',`01-${trace}-${parent}-01`,`00-${'0'.repeat(32)}-${parent}-01`,`00-${trace}-${'0'.repeat(16)}-01`,`00-${trace}-${parent}-0g`, `00-${trace}-${parent}-01-extra`, `00-${trace}-${parent}-01,00-${trace}-${parent}-01`]) {
    assert.equal(parseParent(value), undefined, value);
  }
  assert.equal(parseParent(`00-${'A'.repeat(32)}-${parent}-01`),undefined);
  const valid = childContext(`00-${trace}-${parent}-03`, bytes => bytes === 16 ? '4'.repeat(32) : next);
  assert.deepEqual(valid,{traceId:trace,spanId:next,parentSpanId:parent,flags:'03'});
  assert.equal(encode(valid),`00-${trace}-${next}-03`);
  const fresh = childContext('bad', bytes => '4'.repeat(bytes*2));
  assert.equal(fresh.parentSpanId,undefined); assert.equal(fresh.traceId,'4'.repeat(32));
  assert.equal(fresh.flags,'01');
});
test('unit: monotonic duration, sampled bit, allowlist and exactly-once finish/close/error', () => {
  for (const order of [['finish','close','error'],['close','finish','error'],['error','close','finish']]) {
    const records: SpanRecord[] = []; let now = 10;
    const ctx = childContext(`00-${trace}-${parent}-03`, () => next);
    const span = beginSpan('orders',ctx, r => records.push(r), () => now);
    const response = new EventEmitter();
    bindCompletion(response,span,() => 200);
    now = 35;
    for (const event of order) response.emit(event);
    assert.equal(records.length,1); assert.equal(records[0]!.durationMs,25);
    assert.equal(records[0]!.outcome,order[0] === 'finish' ? 'ok' : order[0] === 'error' ? 'error' : 'cancelled');
    assert.ok(Buffer.byteLength(JSON.stringify(records[0])) < 512);
  }
  const records: SpanRecord[] = [];
  const unsampled = childContext(`00-${trace}-${parent}-02`, () => next);
  beginSpan('gateway',unsampled,r => records.push(r)).end(200,'ok');
  assert.equal(records.length,0);
});
test('unit: AsyncLocalStorage isolates interleaved continuations', async () => {
  const a = childContext(undefined,b => 'a'.repeat(b*2));
  const b = childContext(undefined,b => 'b'.repeat(b*2));
  let release!: () => void; const gate = new Promise<void>(r => {release=r;});
  const first = context.run(a, async () => { await gate; assert.equal(context.getStore(),a); });
  await context.run(b, async () => { release(); await Promise.resolve(); assert.equal(context.getStore(),b); });
  await first; assert.equal(context.getStore(),undefined);
});

test('unit: all flag bits preserved, only sampled bit controls recording, invalid IDs rejected', () => {
  for (const flags of ['00','01','02','03','fe','ff']) {
    const ctx = childContext(`00-${trace}-${parent}-${flags}`,() => next);
    const records: SpanRecord[] = [];
    const span = beginSpan('catalog',ctx,r => records.push(r),() => 1);
    span.end(502,'error'); span.end(200,'ok');
    assert.equal(encode(ctx).slice(-2),flags);
    assert.equal(records.length,Number.parseInt(flags,16)&1);
    if (records[0]) { assert.equal(records[0].status,502); assert.equal(records[0].outcome,'error'); }
  }
  assert.throws(() => childContext(`00-${trace}-${parent}-01`,() => parent));
  assert.throws(() => childContext(undefined,b => '0'.repeat(b*2)));
  const fresh = childContext(undefined,b => 'a'.repeat(b*2));
  assert.equal(fresh.traceId,'a'.repeat(32)); assert.equal(fresh.parentSpanId,undefined);
});

import { spawn } from 'node:child_process';
import { startService, type RunningService } from '../../../test/support.mts';
import { request as httpRequest } from 'node:http';
test('unit: all modules import silently with deliberately invalid runtime configuration', async () => {
  const script = ['gateway','orders','catalog','service','tracing'].map(name => `await import(${JSON.stringify(new URL(`../${name}.mts`,import.meta.url).href)});`).join('\n');
  const child = spawn(process.execPath,['--input-type=module','-e',script],{
    env:{PATH:process.env.PATH ?? '',PORT:'bad',HOST:'invalid',DOWNSTREAM_URL:'not a URL',DEADLINE_MS:'invalid',TEACHING_CONTROLS:'1'},stdio:['ignore','pipe','pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data',(b:Buffer) => {stdout=(stdout+b.toString()).slice(-4096);});
  child.stderr.on('data',(b:Buffer) => {stderr=(stderr+b.toString()).slice(-4096);});
  const timer = setTimeout(() => child.kill('SIGKILL'),3000);
  try {
    const code = await new Promise<number|null>((resolve,reject) => {child.once('error',reject);child.once('close',resolve);});
    assert.equal(code,0,stderr); assert.equal(stdout,''); assert.equal(stderr,'');
  } finally {clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');}
});

type Observation = {records:SpanRecord[];active:number;arrivals:number};
async function call(url:string,path = '/order',headers:Record<string,string> = {},method = 'GET') {
  return fetch(url+path,{headers,method,signal:AbortSignal.timeout(3000)});
}
async function observe(service:RunningService):Promise<Observation> {
  const response = await call(service.url,'/observe'); assert.equal(response.status,200);
  return await response.json() as Observation;
}
async function until<T>(read:()=>Promise<T>,ready:(value:T)=>boolean):Promise<T> {
  const deadline = performance.now()+3500;
  while (performance.now()<deadline) {
    const value = await read(); if (ready(value)) return value;
    await new Promise<void>(resolve => setTimeout(resolve,10));
  }
  throw new Error('Observation deadline exceeded');
}
async function cluster(deadline = '2000') {
  const running:RunningService[] = [];
  try {
    const launch = async (name:string,env:Record<string,string> = {}) => {
      const service = await startService(new URL(`../${name}.mts`,import.meta.url),{TEACHING_CONTROLS:'1',DEADLINE_MS:deadline,...env});
      running.push(service); return service;
    };
    const catalog = await launch('catalog');
    const orders = await launch('orders',{DOWNSTREAM_URL:catalog.url});
    const gateway = await launch('gateway',{DOWNSTREAM_URL:orders.url});
    return {gateway,orders,catalog,stop:async () => {for (const service of running.reverse()) await service.stop();}};
  } catch(error) {for (const service of running.reverse()) await service.stop();throw error;}
}
async function tree(c:Awaited<ReturnType<typeof cluster>>,id:string) {
  const observations = await Promise.all([c.gateway,c.orders,c.catalog].map(s => until(() => observe(s),v => v.records.some(r => r.traceId === id))));
  const records = observations.map(o => o.records.filter(r => r.traceId === id));
  assert.deepEqual(records.map(r => r.length),[1,1,1]);
  const [g,o,k] = records.map(r => r[0]!);
  assert.ok(g && o && k);
  assert.equal(o.parentSpanId,g.spanId); assert.equal(k.parentSpanId,o.spanId);
  assert.equal(new Set([g.spanId,o.spanId,k.spanId]).size,3);
  assert.deepEqual([g.operation,o.operation,k.operation],['gateway','orders','catalog']);
  return [g,o,k];
}

test('integration: independent processes continue inbound tree, isolate interleaving, replace invalid context', {timeout:14000}, async () => {
  const c = await cluster();
  try {
    const held = call(c.gateway.url,'/order',{'traceparent':`00-${trace}-${parent}-03`,'x-teaching-hold':'1','authorization':'secret-not-recorded'});
    await until(() => observe(c.catalog),v => v.active === 1);
    const fast = await call(c.gateway.url,'/order?private=never-record',{'traceparent':'invalid'});
    assert.equal(fast.status,200); await fast.arrayBuffer();
    const fresh = parseParent(fast.headers.get('traceparent') ?? undefined)!;
    assert.ok(fresh); assert.notEqual(fresh.traceId,trace);
    const second = await tree(c,fresh.traceId); assert.equal(second[0]!.parentSpanId,undefined);
    const waiting = await observe(c.catalog); assert.equal(waiting.active,1);
    const release = await call(c.catalog.url,'/release',{},'POST'); await release.arrayBuffer();
    const first = await held; assert.equal(first.status,200); await first.arrayBuffer();
    const records = await tree(c,trace);
    assert.equal(records[0]!.parentSpanId,parent);
    for (const r of records) {assert.equal(r.flags,'03');assert.equal(r.outcome,'ok');assert.ok(r.durationMs > 0);}
    const capture = JSON.stringify(await Promise.all([c.gateway,c.orders,c.catalog].map(observe)));
    assert.ok(!capture.includes('secret-not-recorded')); assert.ok(!capture.includes('private='));
    assert.ok(Buffer.byteLength(capture)<128*512*3);
    // No-header request is also a fresh root; all three spans still connect.
    const absent = await call(c.gateway.url); await absent.arrayBuffer();
    const absentCtx = parseParent(absent.headers.get('traceparent') ?? undefined)!;
    assert.ok(absentCtx); assert.notEqual(absentCtx.traceId,fresh.traceId);
    assert.equal((await tree(c,absentCtx.traceId))[0]!.parentSpanId,undefined);
  } finally {await c.stop();}
});

test('integration: synchronized slow dependency error yields one error span at every hop', {timeout:12000}, async () => {
  const c = await cluster();
  try {
    const pending = call(c.gateway.url,'/order',{'traceparent':`00-${trace}-${parent}-01`,'x-teaching-hold':'1'});
    const entered = await until(() => observe(c.catalog),v => v.active === 1);
    assert.equal(entered.arrivals,1); assert.equal(entered.records.length,0);
    const failed = await call(c.catalog.url,'/fail',{},'POST'); await failed.arrayBuffer();
    const response = await pending; assert.equal(response.status,502); await response.arrayBuffer();
    const spans = await tree(c,trace);
    for (const span of spans) {assert.equal(span.status,502);assert.equal(span.outcome,'error');assert.ok(span.durationMs>0);}
    assert.equal((await observe(c.catalog)).active,0);
  } finally {await c.stop();}
});

test('integration: deadline aborts dependency and releases barrier exactly once', {timeout:12000}, async () => {
  const c = await cluster('500');
  try {
    const pending = call(c.gateway.url,'/order',{'traceparent':`00-${trace}-${parent}-01`,'x-teaching-hold':'1'});
    await until(() => observe(c.catalog),v => v.active === 1);
    const response = await pending; assert.equal(response.status,504); await response.arrayBuffer();
    await until(() => observe(c.catalog),v => v.active === 0 && v.records.length === 1);
    const spans = await tree(c,trace);
    assert.equal(spans[0]!.outcome,'error'); assert.equal(spans[0]!.status,504);
    for (const span of spans) assert.ok(span.durationMs < 2500);
    const release = await call(c.catalog.url,'/release',{},'POST'); await release.arrayBuffer();
    await tree(c,trace);
  } finally {await c.stop();}
});

test('integration: caller disconnect propagates abort and completes each span only once', {timeout:12000}, async () => {
  const c = await cluster();
  let request:ReturnType<typeof httpRequest> | undefined;
  try {
    request = httpRequest(c.gateway.url+'/order',{headers:{traceparent:`00-${trace}-${parent}-01`,'x-teaching-hold':'1'}});
    request.on('error',() => {}); request.setTimeout(3000,() => request?.destroy()); request.end();
    await until(() => observe(c.catalog),v => v.active === 1);
    request.destroy();
    await until(() => observe(c.catalog),v => v.active === 0 && v.records.length === 1);
    const spans = await tree(c,trace);
    for (const span of spans) {assert.equal(span.outcome,'cancelled');assert.equal(span.status,0);}
    const release = await call(c.catalog.url,'/release',{},'POST'); await release.arrayBuffer();
    await tree(c,trace);
  } finally {request?.destroy();await c.stop();}
});
