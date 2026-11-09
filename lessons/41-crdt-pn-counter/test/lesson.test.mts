import { test } from 'node:test';
import assert from 'node:assert/strict';
// Dynamic loading lets absence be an assertion failure, rather than an import error.
test('unit: PN merge preserves independent positive and negative changes', async () => {
  const model = await import('../model.mts').catch(() => null);
  assert.ok(model, 'PN-counter model must exist');
  assert.equal(model.value(model.merge({p:{a:3,b:0,c:0},n:{a:0,b:0,c:0}}, {p:{a:0,b:0,c:0},n:{a:0,b:5,c:0}})), -2);
});

import { merge, parseState, value, zero } from '../model.mts';
import { Store } from '../store.mts';
import { HttpError } from '../../../lib/http.mts';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const conflict=(e:unknown)=>e instanceof HttpError && e.status===409;
test('unit: merge is commutative associative idempotent and coordinates never regress',()=>{
  const x={p:{a:3,b:0,c:0},n:{a:0,b:0,c:0}};
  const y={p:{a:0,b:0,c:0},n:{a:0,b:5,c:0}};
  const z={p:{a:1,b:0,c:7},n:{a:0,b:2,c:0}};
  assert.deepEqual(merge(x,y),{p:{a:3,b:0,c:0},n:{a:0,b:5,c:0}});
  assert.deepEqual(merge(x,y),merge(y,x));
  assert.deepEqual(merge(merge(x,y),z),merge(x,merge(y,z)));
  assert.deepEqual(merge(x,x),x);
  assert.equal(value(merge(x,y)),-2);
  assert.deepEqual(merge(merge(x,y),zero()),merge(x,y));
});
test('unit: SQLite receipts replay original response and conflicts reject atomically',()=>{
  const s=new Store(':memory:','a');
  try {
    const original=s.apply({id:'one',delta:-7}); s.apply({id:'two',delta:2});
    assert.deepEqual(s.apply({id:'one',delta:-7}),original);
    assert.throws(()=>s.apply({id:'one',delta:7}),conflict);
    assert.equal(s.envelope().value,-5);
    for(let i=0;i<14;i++) s.apply({id:`x${i}`,delta:1});
    const before=s.envelope();
    assert.throws(()=>s.apply({id:'seventeen',delta:1}),conflict);
    assert.deepEqual(s.envelope(),before);
    assert.deepEqual(s.apply({id:'one',delta:-7}),original);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM receipts').get()?.n,16);
  } finally {s.close();}
});
test('unit: overflow and malformed full states have no effects or receipt consumption',()=>{
  const s=new Store(':memory:','a');
  try {
    s.receive({p:{a:999999,b:0,c:0},n:{a:0,b:0,c:0}});
    assert.throws(()=>s.apply({id:'limit',delta:2}),conflict);
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM receipts').get()?.n,0);
    s.apply({id:'limit',delta:1});
    const before=s.envelope();
    for(const invalid of [null,[],true,{p:{a:0,b:0},n:{a:0,b:0,c:0}}, {p:{a:0,b:0,c:0,d:0},n:{a:0,b:0,c:0}}, {p:{a:'1',b:0,c:0},n:{a:0,b:0,c:0}}, {p:{a:1000001,b:0,c:0},n:{a:0,b:0,c:0}}, {p:{a:0.5,b:0,c:0},n:{a:0,b:0,c:0}}]) {
      assert.throws(()=>s.receive(invalid)); assert.deepEqual(s.envelope(),before);
    }
    for(const delta of [0,'1',null,1001,-1001,1.1]) assert.throws(()=>s.apply({id:'bad',delta}));
    assert.deepEqual(s.envelope(),before);
    assert.doesNotThrow(()=>parseState({p:{a:1000000,b:1000000,c:1000000},n:{a:1000000,b:1000000,c:1000000}}));
  } finally {s.close();}
});
test('unit: independent local ids do not suppress another actor contribution',()=>{
  const a=new Store(':memory:','a'),b=new Store(':memory:','b');
  try { a.apply({id:'same',delta:4}); b.apply({id:'same',delta:-9}); a.receive(b.read()); b.receive(a.read()); assert.equal(a.envelope().value,-5); assert.deepEqual(a.read(),b.read()); }
  finally {a.close();b.close();}
});
async function get(url:string) { const r=await fetch(url+'/state',{signal:AbortSignal.timeout(3000)}); assert.equal(r.status,200); return await r.json() as {actor:string;state:unknown;value:number}; }
async function post(url:string,path:string,body:unknown,status=200) {const r=await jsonRequest(url+path,body); assert.equal(r.status,status); return await r.json() as unknown;}
const replica=new URL('../replica.mts',import.meta.url), sync=new URL('../sync.mts',import.meta.url);
test('integration: disconnected processes converge through duplicate and reordered exchanges and durable replay',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pn-')); const services:RunningService[]=[];
  const start=async(actor:string)=>{const s=await startService(replica,{ACTOR_ID:actor,DB_PATH:join(dir,actor+'.db')});services.push(s);return s;};
  try {
    let a=await start('a'); const b=await start('b'),c=await start('c');
    const original=await post(a.url,'/changes',{id:'same',delta:7});
    const old=await get(a.url);
    await post(b.url,'/changes',{id:'same',delta:-10}); await post(c.url,'/changes',{id:'c',delta:2});
    assert.deepEqual([(await get(a.url)).value,(await get(b.url)).value,(await get(c.url)).value],[7,-10,2]);
    const s=await startService(sync,{REPLICA_A_ORIGIN:a.url,REPLICA_B_ORIGIN:b.url,REPLICA_C_ORIGIN:c.url});services.push(s);
    for(const [from,to] of [['a','b'],['b','c'],['c','a'],['a','b'],['a','b']]) await post(s.url,'/sync',{from,to});
    await post(c.url,'/merge',old.state);
    const snapshots=await Promise.all([get(a.url),get(b.url),get(c.url)]);
    assert.deepEqual(snapshots.map(x=>x.value),[-1,-1,-1]); assert.deepEqual(snapshots[0]?.state,snapshots[1]?.state); assert.deepEqual(snapshots[1]?.state,snapshots[2]?.state);
    await a.stop(); a=await start('a'); assert.equal((await get(a.url)).value,-1);
    assert.deepEqual(await post(a.url,'/changes',{id:'same',delta:7}),original);
    await post(a.url,'/changes',{id:'same',delta:8},409);
    await assert.rejects(startService(replica,{ACTOR_ID:'b',DB_PATH:join(dir,'a.db')}),/Actor identity mismatch/);
    for(let i=0;i<15;i++) await post(a.url,'/changes',{id:`r${i}`,delta:1});
    const before=await get(a.url); await post(a.url,'/changes',{id:'full',delta:1},409); assert.deepEqual(await get(a.url),before);
    for(const input of [null,[],false,{id:1,delta:1}]) await post(a.url,'/changes',input,400);
    for(const input of [null,[],false]) { await post(a.url,'/merge',input,400); await post(s.url,'/sync',input,400); }
    await post(a.url,'/changes',{id:'z'.repeat(64),delta:1000},409); // valid maximal command, capacity is the only rejection
    await post(c.url,'/changes',{id:'z'.repeat(64),delta:1000});
  } finally {await Promise.all(services.map(s=>s.stop())); await rm(dir,{recursive:true,force:true});}
});

test('integration: imports are silent despite deliberately invalid runtime configuration',async()=>{
  const code=`await import(${JSON.stringify(replica.href)}); await import(${JSON.stringify(sync.href)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH??'',ACTOR_ID:'wrong',DB_PATH:'/invalid/blocked.db',PORT:'invalid',REPLICA_A_ORIGIN:'invalid'},stdio:['ignore','pipe','pipe']});
  let out='',err=''; child.stdout.on('data',(x:Buffer)=>{out+=x;});child.stderr.on('data',(x:Buffer)=>{err+=x;});
  const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
  try {const [exit]=await once(child,'exit');assert.equal(exit,0);assert.equal(out,'');assert.equal(err,'');} finally {clearTimeout(timer);if(child.exitCode===null) child.kill('SIGKILL');}
});

test('integration: bounded upstream parsing identity value redirects and deadlines protect destination',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pn-upstream-'));const services:RunningService[]=[];
  try {
    const dest=await startService(replica,{ACTOR_ID:'b',DB_PATH:join(dir,'b.db')});services.push(dest);
    const before=await get(dest.url);
    for(const mode of ['malformed','identity','value','oversized','redirect','timeout','body-timeout','escaped']) {
      const sink=await startService(new URL('./upstream.mts',import.meta.url),{VARIANT:'valid'}); services.push(sink);
      const source=await startService(new URL('./upstream.mts',import.meta.url),{VARIANT:mode,TARGET_ORIGIN:sink.url}); services.push(source);
      const exchange=await startService(sync,{REPLICA_A_ORIGIN:source.url,REPLICA_B_ORIGIN:dest.url,REPLICA_C_ORIGIN:dest.url,SYNC_TIMEOUT_MS:'300'}); services.push(exchange);
      await post(exchange.url,'/sync',{from:'a',to:'b'},mode==='escaped'?200:502);
      const stats=await fetch(source.url+'/stats',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
      assert.deepEqual(stats,{reads:1,escaped:0});
      assert.deepEqual(await fetch(sink.url+'/stats',{signal:AbortSignal.timeout(2000)}).then(r=>r.json()),{reads:0,escaped:0});
      if(mode!=='escaped') assert.deepEqual(await get(dest.url),before);
      else assert.equal((await get(dest.url)).value,3000000);
      await exchange.stop();await source.stop();await sink.stop();
    }
  } finally {await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});
