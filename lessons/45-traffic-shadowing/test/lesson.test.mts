import { test } from 'node:test';
import assert from 'node:assert/strict';

test('unit: comparator rejects malformed products and detects price differences', async () => {
  const mod = await import('../policy.mts');
  assert.equal(mod.compare({id:'a',price:1,currency:'VND'}, {id:'a',price:2,currency:'VND'}), 'mismatched');
  assert.throws(() => mod.product({id:'a',price:'1',currency:'VND'}, 'a'));
  assert.throws(() => mod.product({id:'b',price:1,currency:'VND'}, 'a'));
  for(const invalid of [null,[],true,{id:'a',price:-1,currency:'VND'},{id:'a',price:1.5,currency:'VND'},{id:'a',price:1,currency:'USD'},{id:'a',price:1,currency:'VND',extra:true}]) assert.throws(()=>mod.product(invalid,'a'));
  assert.deepEqual(mod.product({id:'a',price:0,currency:'VND'},'a'),{id:'a',price:0,currency:'VND'});
  assert.equal(mod.compare({id:'a',price:1,currency:'VND'},{id:'a',price:1,currency:'VND'}),'matched');
  assert.equal(mod.compare({id:'a',price:1,currency:'VND'},{id:'b',price:1,currency:'VND'}),'mismatched');
});

test('unit: two permits drop excess work, release all settlements and saturate counters', async () => {
  const mod = await import('../policy.mts');
  const pool = new mod.Mirrors();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  pool.start(async () => { await barrier; return 'matched'; });
  pool.start(async () => { await barrier; throw new Error('outage'); });
  pool.start(async () => 'mismatched');
  assert.deepEqual(pool.stats(), {active:2,started:2,skipped:1,matched:0,mismatched:0,failed:0});
  release(); await pool.drain();
  assert.deepEqual(pool.stats(), {active:0,started:2,skipped:1,matched:1,mismatched:0,failed:1,last:'matched'});
  assert.equal(mod.increment(999999),1000000);
  assert.equal(mod.increment(1000000),1000000);
});

import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const entry=(name:string)=>new URL(`../${name}.mts`,import.meta.url);
async function get(url:string) { return fetch(url,{signal:AbortSignal.timeout(3500)}); }
async function data(url:string):Promise<Record<string,unknown>> {
  const response=await get(url); assert.equal(response.status,200); return await response.json() as Record<string,unknown>;
}
async function post(url:string,body:unknown) {const res=await jsonRequest(url,body);assert.equal(res.status,200);return res.json();}
async function until(url:string,key:string,want:unknown) {
  for(let i=0;i<100;i++) {const state=await data(url);if(state[key]===want)return state;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.fail(`Barrier ${key}=${String(want)} was not observed`);
}
async function services(run:(start:(name:string,env?:Record<string,string>)=>Promise<RunningService>)=>Promise<void>) {
  const running:RunningService[]=[];
  try {await run(async(name,env={})=>{const service=await startService(entry(name),env);running.push(service);return service;});}
  finally {for(const service of running.reverse())await service.stop();}
}

test('integration: held mirrors prove caller completion, drop excess, compare and recover from outage', async()=>{
  await services(async start=>{
    const primary=await start('backend',{VARIANT:'primary',TEACHING_CONTROLS:'1'});
    const shadow=await start('backend',{VARIANT:'shadow',TEACHING_CONTROLS:'1'});
    const gateway=await start('gateway',{PRIMARY_ORIGIN:primary.url,SHADOW_ORIGIN:shadow.url,TEACHING_CONTROLS:'1'});
    const drain=()=>post(`${gateway.url}/teaching/drain`,{});
    try {
      await post(`${shadow.url}/teaching/hold`,{enabled:true});
      // Awaiting these caller bodies before releasing the shadow is the observable nonblocking proof.
      for(let i=0;i<2;i++) assert.deepEqual(await data(`${gateway.url}/products/a`),{id:'a',price:10000,currency:'VND'});
      await until(`${shadow.url}/teaching/state`,'held',2);
      assert.equal((await data(`${gateway.url}/stats`)).active,2);
      await data(`${gateway.url}/products/a`);
      assert.equal((await data(`${gateway.url}/stats`)).skipped,1);
      assert.equal((await data(`${shadow.url}/teaching/state`)).calls,2);
      await post(`${shadow.url}/teaching/hold`,{enabled:false}); await drain();
      assert.equal((await data(`${gateway.url}/stats`)).matched,2);
      await post(`${shadow.url}/teaching/behavior`,{mode:'different'});
      assert.deepEqual(await data(`${gateway.url}/products/a`),{id:'a',price:10000,currency:'VND'});await drain();
      const mismatch=await data(`${gateway.url}/stats`);assert.equal(mismatch.last,'mismatched');assert.equal(mismatch.mismatched,1);
      await post(`${shadow.url}/teaching/behavior`,{mode:'unavailable'});
      await data(`${gateway.url}/products/a`);await drain();assert.equal((await data(`${gateway.url}/stats`)).failed,1);
      const before=(await data(`${shadow.url}/teaching/state`)).calls;
      assert.equal((await jsonRequest(`${gateway.url}/products/a`,{})).status,405);
      assert.equal((await get(`${gateway.url}/products/a?secret=x`)).status,400);
      assert.equal((await get(`${gateway.url}/products/${'a'.repeat(33)}`)).status,400);
      await drain();assert.equal((await data(`${shadow.url}/teaching/state`)).calls,before);
      for(const body of [null,[],false,{mode:1},{mode:['same']}]) assert.equal((await jsonRequest(`${shadow.url}/teaching/behavior`,body)).status,400);
      for(const body of [null,[],true,{enabled:'false'}]) assert.equal((await jsonRequest(`${shadow.url}/teaching/hold`,body)).status,400);
      for(const body of [null,[],true,{extra:1}]) assert.equal((await jsonRequest(`${gateway.url}/teaching/drain`,body)).status,400);
      // Own deadline settles a held task even without a release request.
      await post(`${shadow.url}/teaching/hold`,{enabled:true});await data(`${gateway.url}/products/a`);
      await until(`${shadow.url}/teaching/state`,'held',1);await drain();
      assert.equal((await data(`${gateway.url}/stats`)).active,0);
      await until(`${shadow.url}/teaching/state`,'held',0);
      assert.ok(Buffer.byteLength(JSON.stringify(await data(`${gateway.url}/stats`)))<256);
      await data(`${gateway.url}/products/a`);await until(`${shadow.url}/teaching/state`,'held',1);
      await gateway.stop();await until(`${shadow.url}/teaching/state`,'held',0);
    } finally {await post(`${shadow.url}/teaching/hold`,{enabled:false});}
  });
});

test('integration: fixed origins reject redirects, strip caller context, enforce primary byte/schema/deadline',async()=>{
  await services(async start=>{
    const sink=await start('test/upstream');
    const primary=await start('test/upstream',{TARGET_ORIGIN:sink.url});
    const shadow=await start('test/upstream',{TARGET_ORIGIN:sink.url});
    const gateway=await start('gateway',{PRIMARY_ORIGIN:primary.url,SHADOW_ORIGIN:shadow.url,TEACHING_CONTROLS:'1'});
    const drain=()=>post(`${gateway.url}/teaching/drain`,{});
    const configure=(service:RunningService,mode:string)=>post(`${service.url}/configure`,{mode});
    await configure(shadow,'same');
    const response=await fetch(`${gateway.url}/products/a`,{headers:{authorization:'Bearer educational',cookie:'private=example','x-signed-context':'example'},signal:AbortSignal.timeout(3500)});
    assert.equal(response.status,200);await response.json();await drain();
    assert.deepEqual((await data(`${shadow.url}/state`)).last,{path:'/products/a',method:'GET',authorization:null,cookie:null,context:null,accept:'application/json',body:null});
    await configure(shadow,'redirect');await data(`${gateway.url}/products/a`);await drain();
    assert.equal((await data(`${sink.url}/state`)).calls,0);
    assert.equal((await data(`${gateway.url}/stats`)).failed,1);
    for(const [mode,status] of [['wrong',502],['oversized',502],['slow',504],['redirect',502],['unavailable',502]] as const) {
      await configure(primary,mode);await configure(shadow,'same');
      const result=await get(`${gateway.url}/products/a`);assert.equal(result.status,status,mode);await result.json();await drain();
      assert.equal((await data(`${shadow.url}/state`)).calls,0,mode);
    }
    assert.equal((await data(`${sink.url}/state`)).calls,0);
    await configure(primary,'maximum');await configure(shadow,'maximum');
    const id='z'.repeat(32);
    assert.deepEqual(await data(`${gateway.url}/products/${id}`),{id,price:Number.MAX_SAFE_INTEGER,currency:'VND'});await drain();
    assert.equal((await data(`${gateway.url}/stats`)).last,'matched');
    // GET payload is rejected before reaching either upstream.
    const { request }=await import('node:http');
    const rejected=await new Promise<number>((resolve,reject)=>{
      const req=request(`${gateway.url}/products/a`,{method:'GET',headers:{'content-length':'2'},timeout:2000},res=>{res.resume();resolve(res.statusCode!);});
      req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('deadline')));req.end('{}');
    });assert.equal(rejected,400);
  });
});

test('integration: disabled teaching routes are absent and imports ignore invalid runtime configuration silently',async()=>{
  await services(async start=>{
    const backend=await start('backend');
    const gateway=await start('gateway',{PRIMARY_ORIGIN:backend.url,SHADOW_ORIGIN:backend.url});
    for(const service of [backend,gateway]) assert.equal((await jsonRequest(`${service.url}/teaching/drain`,{})).status,404);
  });
  const child=spawn(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(entry('gateway').href)});await import(${JSON.stringify(entry('backend').href)});`],{
    env:{PATH:process.env.PATH ?? '',PORT:'invalid',PRIMARY_ORIGIN:'invalid',SHADOW_ORIGIN:'invalid',VARIANT:'invalid'},stdio:['ignore','pipe','pipe']
  });
  let output='';child.stdout.on('data',(chunk:Buffer)=>{output+=chunk.toString();});child.stderr.on('data',(chunk:Buffer)=>{output+=chunk.toString();});
  const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
  try {const [code]=await once(child,'exit');assert.equal(code,0,output);assert.equal(output,'');}finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
});

test('unit: synchronous throw and mismatch both release permits without rejecting drain',async()=>{
  const { Mirrors }=await import('../policy.mts');
  const pool=new Mirrors();
  pool.start(()=>{throw new Error('synchronous failure');});
  pool.start(async()=>'mismatched');
  await pool.drain();
  assert.deepEqual(pool.stats(),{active:0,started:2,skipped:0,matched:0,mismatched:1,failed:1,last:'mismatched'});
  pool.start(async()=>'matched');await pool.drain();
  assert.equal(pool.stats().active,0);assert.equal(pool.stats().matched,1);
});
