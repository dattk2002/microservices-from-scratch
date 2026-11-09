import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Queue } from '../model.mts';

// A cursor that resets, tenant-only identity, or retries without a limit breaks these contracts.
test('unit: weighted FIFO selections skip empty slots and persist cursor', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let q = new Queue(db);
    for (const tenant of ['red', 'blue'] as const) for (let i=0;i<4;i++) q.admit({tenant,id:`j${i}`,value:10});
    assert.equal(q.snapshot().jobs.length,8);
    const selected=[];
    for(let i=0;i<6;i++){const j=q.select()!; selected.push(`${j.tenant}/${j.id}`); q.finish(j,true); q=new Queue(db);}
    assert.deepEqual(selected,['red/j0','red/j1','blue/j0','red/j2','red/j3','blue/j1']);
    assert.equal(q.select()!.tenant,'blue');
    assert.equal(q.snapshot().cursor,0);
  } finally {db.close();}
});
test('unit: composite immutable identity, retained capacity and three consumed attempts', () => {
 const db=new DatabaseSync(':memory:'); try {
 const q=new Queue(db); q.admit({tenant:'red',id:'a',value:1}); q.admit({tenant:'blue',id:'a',value:2});
 assert.equal(q.admit({tenant:'red',id:'a',value:1}).attempts,0);
 assert.throws(()=>q.admit({tenant:'red',id:'a',value:2}),/conflict/);
 for(let i=0;i<3;i++){const j=q.select()!;q.finish(j,false);}
 // red selected twice, blue once; a failed red job must allow its successor.
 const j=q.select()!; q.finish(j,false); const k=q.select()!;q.finish(k,false);
 assert.equal(q.snapshot().jobs.find(x=>x.tenant==='red')!.state,'failed');
 for(let i=0;i<14;i++)q.admit({tenant:'red',id:`n${i}`,value:100});
 assert.throws(()=>q.admit({tenant:'blue',id:'overflow',value:1}),/capacity/);
 assert.equal(q.admit({tenant:'red',id:'a',value:1}).state,'failed');
 }finally{db.close();}
});
test('unit: crash consumes attempts and terminalizes limit before another execution',()=>{
 const db=new DatabaseSync(':memory:');try{let q=new Queue(db);q.admit({tenant:'red',id:'a',value:1});
 for(let i=0;i<3;i++){assert.equal(q.select()!.attempts,i+1);q=new Queue(db);}
 assert.equal(q.select(),undefined);assert.equal(q.snapshot().jobs[0]!.state,'failed');
 }finally{db.close();}
});

import { input,object } from '../model.mts';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: reject wrong primitives and accept maximum legal identifier/value',()=>{
 for(const v of [null,[],false,{tenant:['red'],id:'a',value:1},{tenant:'red',id:1,value:1},{tenant:'red',id:'a',value:'1'},{tenant:'red',id:'a',value:101}]) assert.throws(()=>input(v));
 for(const v of [null,[],true])assert.throws(()=>object(v));
 assert.deepEqual(input({tenant:'blue',id:'_'.repeat(32),value:100}),{tenant:'blue',id:'_'.repeat(32),value:100});
});
test('unit: imports are silent with invalid configuration and never open SQLite',async()=>{
 const code=`await import(${JSON.stringify(new URL('../queue.mts',import.meta.url).href)});await import(${JSON.stringify(new URL('../executor.mts',import.meta.url).href)});`;
 const r=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{timeout:3000,env:{...process.env,DB_PATH:'/impossible/missing/db',PORT:'bad',EXECUTOR_ORIGIN:'bad'}});
 assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});
async function state(s:RunningService):Promise<{jobs:import('../model.mts').Job[];cursor:number;active:boolean}>{
 const r=await fetch(s.url+'/state',{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);return r.json();
}
async function post(s:RunningService,path:string,body:unknown,status=200){const r=await jsonRequest(s.url+path,body);assert.equal(r.status,status);return r;}
async function held(s:RunningService){
 for(let i=0;i<100;i++){
 const r=await fetch(s.url+'/teaching/state',{signal:AbortSignal.timeout(1000)});const v:unknown=await r.json();if(object(v).held===true)return;
 await new Promise(resolve=>setTimeout(resolve,5));
 }assert.fail('Executor never reached held barrier');
}
test('integration: bounded blue wait, FIFO results, retained jobs/cursor survive restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fair-'));let executor:RunningService|undefined;let queue:RunningService|undefined;
 try{
 executor=await startService(new URL('../executor.mts',import.meta.url));
 const env={DB_PATH:join(dir,'queue.sqlite'),EXECUTOR_ORIGIN:executor.url};
 queue=await startService(new URL('../queue.mts',import.meta.url),env);
 for(let i=0;i<6;i++)await post(queue,'/jobs',{tenant:'red',id:`r${i}`,value:i+1});
 const maximal='{"tenant":"'+String.raw`\u0062\u006c\u0075\u0065`+'","id":"'+String.raw`\u005f`.repeat(32)+'","value":100}';
 const maximum=await fetch(queue.url+'/jobs',{method:'POST',headers:{'content-type':'application/json'},body:maximal,signal:AbortSignal.timeout(2000)});assert.equal(maximum.status,200);
 for(let i=0;i<3;i++)await post(queue,'/dispatch',{});
 let s=await state(queue);assert.equal(s.jobs[6]!.state,'done');assert.equal(s.jobs[6]!.result,200);
 assert.deepEqual(s.jobs.filter(x=>x.state==='done').map(x=>x.id),['r0','r1','_'.repeat(32)]);assert.equal(s.cursor,0);
 await post(queue,'/dispatch',{});s=await state(queue);assert.equal(s.cursor,1);
 await queue.stop();queue=await startService(new URL('../queue.mts',import.meta.url),env);
 const restarted=await state(queue);assert.deepEqual(restarted.jobs,s.jobs);assert.equal(restarted.cursor,1);
 await post(queue,'/dispatch',{});assert.equal((await state(queue)).jobs[3]!.result,8);
 for(const bad of [null,[],true,{tenant:['red'],id:'a',value:1}])await post(queue,'/jobs',bad,400);
 for(const bad of [null,[],true,{unexpected:1}])await post(queue,'/dispatch',bad,400);
 await post(executor,'/teaching/hold',{enabled:true},404);
 }finally{await queue?.stop();await executor?.stop();await rm(dir,{recursive:true,force:true});}
});
test('integration: held executor proves busy barrier, crash consumes attempt and releases permit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fair-hold-'));let e:RunningService|undefined;let q:RunningService|undefined;
 try{
 e=await startService(new URL('../executor.mts',import.meta.url),{TEACHING_CONTROLS:'1'});
 const env={DB_PATH:join(dir,'q.sqlite'),EXECUTOR_ORIGIN:e.url};q=await startService(new URL('../queue.mts',import.meta.url),env);
 for(const path of ['/teaching/hold','/teaching/behavior'])for(const bad of [null,[],true,{enabled:'true',mode:['same']}])await post(e,path,bad,400);
 await post(q,'/jobs',{tenant:'red',id:'a',value:1});await post(e,'/teaching/hold',{enabled:true});
 const pending=post(q,'/dispatch',{},502);await held(e);assert.equal((await state(q)).active,true);await post(q,'/dispatch',{},409);
 await pending;assert.equal((await state(q)).active,false);assert.equal((await state(q)).jobs[0]!.attempts,1);
 await post(e,'/teaching/hold',{enabled:false});await post(e,'/teaching/hold',{enabled:true});
 // SIGKILL models lost acknowledgement; settle fetch before restarting.
 const lost=jsonRequest(q.url+'/dispatch',{}).then(()=>{},()=>{});await held(e);q.child.kill('SIGKILL');await lost;await q.stop();
 await post(e,'/teaching/hold',{enabled:false});q=await startService(new URL('../queue.mts',import.meta.url),env);
 assert.equal((await state(q)).jobs[0]!.attempts,2);await post(q,'/dispatch',{});assert.equal((await state(q)).jobs[0]!.attempts,3);assert.equal((await state(q)).jobs[0]!.state,'done');
 }finally{await q?.stop();await e?.stop();await rm(dir,{recursive:true,force:true});}
});
test('integration: reusable upstream rejects bad replies, oversized valid JSON, slow body and redirects',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'fair-errors-'));let source:RunningService|undefined;let sink:RunningService|undefined;let q:RunningService|undefined;
 try{
 sink=await startService(new URL('./upstream.mts',import.meta.url));
 source=await startService(new URL('./upstream.mts',import.meta.url),{REDIRECT_ORIGIN:sink.url});q=await startService(new URL('../queue.mts',import.meta.url),{DB_PATH:join(dir,'q.sqlite'),EXECUTOR_ORIGIN:source.url});
 for(const mode of ['identity','invalid','oversized','slow','redirect','unavailable']){
 await post(source,'/control',{mode});await post(q,'/jobs',{tenant:'red',id:mode,value:1});
 for(let attempt=1;attempt<=3;attempt++){
 await post(q,'/dispatch',{},502);const s=await state(q);const j=s.jobs.find(x=>x.id===mode)!;assert.equal(j.attempts,attempt);assert.equal(j.state,attempt===3?'failed':'pending');assert.equal(j.result,undefined);assert.equal(s.active,false);
 }
 const counters=object(await (await fetch(source.url+'/state',{signal:AbortSignal.timeout(1000)})).json());assert.equal(counters.calls,3);assert.equal(counters.forwarded,0);
 const sinkCounters=object(await (await fetch(sink.url+'/state',{signal:AbortSignal.timeout(1000)})).json());assert.equal(sinkCounters.calls,0);
 }
 await post(source,'/control',{mode:'same'});await post(q,'/jobs',{tenant:'red',id:'successor',value:100});await post(q,'/dispatch',{});
 assert.equal((await state(q)).jobs.at(-1)!.result,200);
 for(let i=0;i<9;i++)await post(q,'/jobs',{tenant:'blue',id:`n${i}`,value:1});
 await post(q,'/jobs',{tenant:'red',id:'overflow',value:1},429);
 await post(q,'/jobs',{tenant:'red',id:'successor',value:100});await post(q,'/jobs',{tenant:'red',id:'successor',value:99},409);
 }finally{await q?.stop();await source?.stop();await sink?.stop();await rm(dir,{recursive:true,force:true});}
});

test('unit: execution permit rejects concurrency and is released after rejection',async()=>{
 const { Permit }=await import('../permit.mts');const permit=new Permit();let release:()=>void=()=>{};
 const barrier=new Promise<void>(resolve=>{release=resolve;});const first=permit.run(()=>barrier);
 assert.equal(permit.active,true);await assert.rejects(permit.run(async()=>1),/busy/);release();await first;
 await assert.rejects(permit.run(async()=>{throw new Error('executor');}),/executor/);
 assert.equal(permit.active,false);assert.equal(await permit.run(async()=>42),42);
});
