import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Limiter } from '../controller.mts';

test('unit: four fast samples grow, slow halves, stale tickets and double settle are harmless', () => {
  const l = new Limiter();
  for (let i=0;i<4;i++) l.admit()!('success',100);
  assert.equal(l.state().limit,3);
  const slow=l.admit()!, stale=l.admit()!, survivor=l.admit()!;
  slow('success',101);
  assert.equal(l.state().limit,1);
  assert.equal(l.state().active,2);
  assert.equal(l.admit(),undefined);
  stale('success',0); stale('congestion',0); survivor('congestion',0);
  assert.deepEqual(l.state(),{limit:1,active:0,fastStreak:0,epoch:1,admitted:7,rejected:1});
});

test('unit: neutral releases; limits and counters saturate without resurrecting stale identity', () => {
  const l=new Limiter();
  for(let i=0;i<40;i++) l.admit()!('success',0);
  assert.equal(l.state().limit,4);
  for(let i=0;i<65535;i++) l.admit()!('congestion',0);
  for(let i=0;i<4;i++) l.admit()!('success',0);
  const stale=l.admit()!;
  l.admit()!('congestion',0);
  stale('success',0);
  assert.equal(l.state().epoch,65535);
  assert.equal(l.state().fastStreak,0);
  assert.equal(l.state().limit,1);
  l.admit()!('neutral',0);
  assert.equal(l.state().active,0);
  assert.equal(l.state().admitted,65535);
});

import { startService,jsonRequest } from '../../../test/support.mts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { idBody,validReply,origin } from '../contracts.mts';
const entry=(name:string)=>new URL('../'+name+'.mts',import.meta.url);
async function state(url:string):Promise<Record<string,unknown>> {
  const value:unknown=await (await fetch(url+'/state')).json();
  assert.ok(typeof value==='object'&&value!==null&&!Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}
async function barrier(check:()=>Promise<boolean>){
  const deadline=performance.now()+2000;
  while(!await check()){assert.ok(performance.now()<deadline,'barrier deadline');await delay(5);}
}
async function workerActive(url:string,n:number){
  await barrier(async()=>{const value:unknown=await(await fetch(url+'/teaching/state')).json();return typeof value==='object'&&value!==null&&'active' in value&&value.active===n;});
}

test('unit: exact input schemas and upstream semantic envelopes reject impostors',()=>{
  for(const body of [null,[],1,true,'a',{}, {id:'a',extra:1},{id:1},{id:''},{id:'a'.repeat(17)}]) assert.throws(()=>idBody(body));
  assert.equal(idBody({id:'A_09-'}),'A_09-');
  for(const status of [404,503])for(const body of [null,[],{error:{code:'internal_error',message:'Unexpected service error'}},{error:{code:'not_found',message:'wrong'}}])assert.equal(validReply(body,'a',status),false);
  assert.equal(validReply({id:'a',value:10},'a',200),true);
  assert.equal(validReply({id:'z',value:10},'z',200),false);
  assert.throws(()=>origin('https://example.com'));
});

test('unit: entrypoint imports are silent despite invalid runtime configuration',async()=>{
  const child=spawn(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(entry('gateway').href)});await import(${JSON.stringify(entry('worker').href)});`],{env:{...process.env,PORT:'invalid',WORKER_ORIGIN:'invalid'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',(v:Buffer)=>{output+=v.toString();});child.stderr.on('data',(v:Buffer)=>{output+=v.toString();});
  const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
  try{const [code]=await once(child,'exit');assert.equal(code,0);assert.equal(output,'');}finally{clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
});

test('integration: held barriers prove no queue, logical slow shrink, survivors and fresh recovery',async()=>{
  const worker=await startService(entry('worker'),{TEACHING_CONTROLS:'1'});
  try{
    const gateway=await startService(entry('gateway'),{WORKER_ORIGIN:worker.url,TEACHING_CONTROLS:'1'});
    try{
      for(let i=0;i<4;i++)assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,200);
      assert.equal((await state(gateway.url)).limit,3);
      for(const body of [null,[],{enabled:'true'},{enabled:true,extra:0}])assert.equal((await jsonRequest(worker.url+'/teaching/hold',body)).status,400);
      for(const body of [null,[],{mode:1},{mode:'bad'},{mode:'normal',extra:0}])assert.equal((await jsonRequest(worker.url+'/teaching/behavior',body)).status,400);
      await jsonRequest(worker.url+'/teaching/hold',{enabled:true});
      const a=jsonRequest(gateway.url+'/work',{id:'a'});await workerActive(worker.url,1);
      const b=jsonRequest(gateway.url+'/work',{id:'b'});await workerActive(worker.url,2);
      const c=jsonRequest(gateway.url+'/work',{id:'c'});await workerActive(worker.url,3);
      const rejected=await jsonRequest(gateway.url+'/work',{id:'d'});assert.equal(rejected.status,429);assert.equal(rejected.headers.get('retry-after'),'1');
      const stats:unknown=await(await fetch(worker.url+'/teaching/state')).json();assert.deepEqual(stats,{calls:7,active:3,maxConcurrent:3});
      assert.equal((await jsonRequest(gateway.url+'/teaching/advance',{milliseconds:101})).status,200);
      await jsonRequest(worker.url+'/teaching/hold',{enabled:false});
      assert.deepEqual((await Promise.all([a,b,c])).map(r=>r.status),[200,200,200]);
      assert.deepEqual(await state(gateway.url),{limit:1,active:0,fastStreak:0,epoch:1,admitted:7,rejected:1});
      for(let i=0;i<4;i++)assert.equal((await jsonRequest(gateway.url+'/work',{id:'h'})).status,200);
      assert.equal((await state(gateway.url)).limit,2);
      assert.equal((await jsonRequest(gateway.url+'/work',{id:'unknown'})).status,404);
      for(const body of [null,[],false,{id:'a',x:1}])assert.equal((await jsonRequest(gateway.url+'/work',body)).status,400);
      for(const body of [null,[],{milliseconds:'1'},{milliseconds:0},{milliseconds:1,extra:1}])assert.equal((await jsonRequest(gateway.url+'/teaching/advance',body)).status,400);
      await jsonRequest(worker.url+'/teaching/hold',{enabled:true});
      const abort=new AbortController();
      const pending=fetch(gateway.url+'/work',{method:'POST',headers:{'content-type':'application/json'},body:'{"id":"a"}',signal:abort.signal}).catch(()=>undefined);
      await workerActive(worker.url,1);abort.abort();await pending;
      await barrier(async()=>(await state(gateway.url)).active===0);await workerActive(worker.url,0);
      assert.equal((await state(gateway.url)).epoch,1);
      await jsonRequest(worker.url+'/teaching/hold',{enabled:false});
    }finally{await gateway.stop();}
  }finally{await worker.stop();}
});

test('integration: bounded upstream contracts, full-body deadline and reachable redirect containment',async()=>{
  const destination=await startService(new URL('./upstream.mts',import.meta.url));
  try{
    const fixture=await startService(new URL('./upstream.mts',import.meta.url));
    try{
      const gateway=await startService(entry('gateway'),{WORKER_ORIGIN:fixture.url,TEACHING_CONTROLS:'1'});
      try{
        const mode=async(value:string)=>{assert.equal((await jsonRequest(fixture.url+'/mode',{mode:value,destination:destination.url})).status,200);};
        for(const value of ['primitive','extra','wrong-value','oversize','404-array','404-primitive','404-null','404-unexpected','404-wrong','503-array','503-primitive','503-null','503-unexpected','503-wrong']){
          await mode(value);assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,502,value);assert.equal((await state(gateway.url)).epoch,0);
        }
        await mode('escaped');const escaped=await jsonRequest(gateway.url+'/work',{id:'a'});assert.equal(escaped.status,200);assert.deepEqual(await escaped.json(),{id:'a',value:10});
        await mode('redirect');assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,502);
        // Inspect destination BEFORE any mode/reset call can hide forwarded payloads.
        assert.deepEqual(await(await fetch(destination.url+'/state')).json(),{calls:0});
        await mode('404-valid');assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,404);
        await mode('503-valid');const unavailable=await jsonRequest(gateway.url+'/work',{id:'a'});assert.equal(unavailable.status,502);assert.deepEqual(await unavailable.json(),{error:{code:'unavailable',message:'Worker unavailable'}});const congested=await state(gateway.url);assert.equal(congested.epoch,1);assert.equal(congested.active,0);assert.equal(congested.limit,1);
        await mode('slow');assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,504);assert.equal((await state(gateway.url)).epoch,2);assert.equal((await state(gateway.url)).active,0);
      }finally{await gateway.stop();}
    }finally{await fixture.stop();}
  }finally{await destination.stop();}
});

test('integration: teaching controls disabled and worker lookup exact schema',async()=>{
  const worker=await startService(entry('worker'));
  try{
    const gateway=await startService(entry('gateway'),{WORKER_ORIGIN:worker.url});
    try{
      for(const route of ['/teaching/hold','/teaching/behavior'])assert.equal((await jsonRequest(worker.url+route,{enabled:true})).status,404);
      assert.equal((await fetch(worker.url+'/teaching/state')).status,404);
      assert.equal((await jsonRequest(gateway.url+'/teaching/advance',{milliseconds:1})).status,404);
      for(const body of [null,[],1,{id:false},{id:'a',other:1}])assert.equal((await jsonRequest(worker.url+'/lookup',body)).status,400);
      for(const [id,value] of [['a',10],['h',80]]){const r=await jsonRequest(gateway.url+'/work',{id});assert.equal(r.status,200);assert.deepEqual(await r.json(),{id,value});}
      assert.equal((await jsonRequest(gateway.url+'/work',{id:'i'})).status,404);
    }finally{await gateway.stop();}
  }finally{await worker.stop();}
});

test('integration: one slow completion shrinks while admitted survivors retain capacity',async()=>{
  const fixture=await startService(new URL('./upstream.mts',import.meta.url));
  try{
    const gateway=await startService(entry('gateway'),{WORKER_ORIGIN:fixture.url,TEACHING_CONTROLS:'1'});
    try{
      for(let i=0;i<4;i++)assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,200);
      await jsonRequest(fixture.url+'/mode',{mode:'hold',destination:''});
      const held=async(n:number)=>barrier(async()=>{const v:unknown=await(await fetch(fixture.url+'/held')).json();return typeof v==='object'&&v!==null&&'active'in v&&v.active===n;});
      const first=jsonRequest(gateway.url+'/work',{id:'a'});await held(1);
      const second=jsonRequest(gateway.url+'/work',{id:'a'});await held(2);
      const third=jsonRequest(gateway.url+'/work',{id:'a'});await held(3);
      await jsonRequest(gateway.url+'/teaching/advance',{milliseconds:101});
      await jsonRequest(fixture.url+'/release',{});assert.equal((await first).status,200);
      assert.equal((await state(gateway.url)).active,2);assert.equal((await state(gateway.url)).limit,1);
      assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,429);
      await jsonRequest(fixture.url+'/release',{});assert.equal((await second).status,200);
      assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,429);
      await jsonRequest(fixture.url+'/release',{});assert.equal((await third).status,200);
      assert.deepEqual(await state(gateway.url),{limit:1,active:0,fastStreak:0,epoch:1,admitted:7,rejected:2});
      await jsonRequest(fixture.url+'/mode',{mode:'normal',destination:''});
      for(let i=0;i<4;i++)assert.equal((await jsonRequest(gateway.url+'/work',{id:'a'})).status,200);
      assert.equal((await state(gateway.url)).limit,2);
    }finally{await gateway.stop();}
  }finally{await fixture.stop();}
});
