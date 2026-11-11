import test from 'node:test';
import assert from 'node:assert/strict';
import { Batcher } from '../batcher.mts';

test('unit: distinct keys batch while duplicate positions share a pending result', async () => {
  const jobs: (() => void)[] = [];
  const batches: string[][] = [];
  const b = new Batcher(async ids => { batches.push(ids); return ids.slice().reverse().map(id => ({id, found:true as const, value:10})); }, {schedule: job => jobs.push(job)});
  const p = b.lookup(['a','b','a']);
  const q = b.lookup(['b','c']);
  assert.equal(b.state().waiters, 5);
  jobs.shift()?.();
  assert.deepEqual(await p, [{id:'a',found:true,value:10},{id:'b',found:true,value:10},{id:'a',found:true,value:10}]);
  await q;
  assert.deepEqual(batches, [['a','b','c']]);
  assert.equal(b.state().waiters,0);
  b.close();
});

import { validate,idsFrom } from '../batcher.mts';
import type { Item } from '../batcher.mts';
function harness(){
 const jobs:(()=>void)[]=[];const timers:{job:()=>void;ms:number;live:boolean}[]=[];
 const pending:{ids:string[];signal:AbortSignal;resolve:(items:Item[])=>void;reject:(e:unknown)=>void}[]=[];
 const b=new Batcher((ids,signal)=>new Promise((resolve,reject)=>{pending.push({ids,signal,resolve,reject});signal.addEventListener('abort',()=>reject(Error('abort')),{once:true});}),{schedule:j=>jobs.push(j),timer:(job,ms)=>{const t={job,ms,live:true};timers.push(t);return ()=>{t.live=false;};}});
 return {b,jobs,timers,pending,flush:()=>{jobs.shift()?.();},tick:async()=>{await new Promise<void>(r=>setImmediate(r));}};
}
const absent=(ids:string[]):Item[]=>ids.map(id=>({id,found:false}));
test('unit: eight FIFO keys split into four, then four; settled keys are fetched again',async()=>{
 const h=harness();try{
 const p=h.b.lookup(['a','b','c','d','e','f','g','h']);h.flush();
 assert.deepEqual(h.pending[0]?.ids,['a','b','c','d']);
 h.pending[0]?.resolve(absent(['d','c','b','a']));await h.tick();h.flush();
 assert.deepEqual(h.pending[1]?.ids,['e','f','g','h']);
 h.pending[1]?.resolve(absent(['h','g','f','e']));assert.deepEqual((await p).map(i=>i.id),['a','b','c','d','e','f','g','h']);
 const q=h.b.lookup(['a']);h.flush();assert.equal(h.pending.length,3);h.pending[2]?.resolve(absent(['a']));await q;
 }finally{h.b.close();}
});
test('unit: atomic key and waiter admission reject without partial capacity',async()=>{
 const h=harness();try{
 const p=h.b.lookup(['a','b','c','d','e','f','g','h']);
 await assert.rejects(h.b.lookup(['a','i']),{status:429});assert.equal(h.b.state().waiters,8);
 const q=h.b.lookup(['a','a','a','a','a','a','a','a']);
 await assert.rejects(h.b.lookup(['a']),{status:429});assert.equal(h.b.state().waiters,16);
 const done=Promise.allSettled([p,q]);h.b.close();await done;assert.equal(h.b.state().waiters,0);assert.equal(h.b.state().keys,0);
 }finally{h.b.close();}
});
test('unit: cancelling one waiter preserves shared upstream; all gone aborts and releases',async()=>{
 const h=harness();try{
 const a=new AbortController(),b=new AbortController();
 const p=h.b.lookup(['a'],a.signal),q=h.b.lookup(['a'],b.signal);const rejected=assert.rejects(p,{status:499});h.flush();a.abort();await rejected;
 assert.equal(h.pending[0]?.signal.aborted,false);assert.equal(h.b.state().waiters,1);
 h.pending[0]?.resolve(absent(['a']));await q;await h.tick();
 const c=new AbortController();const r=h.b.lookup(['b'],c.signal);const gone=assert.rejects(r,{status:499});h.flush();c.abort();await gone;await h.tick();
 assert.equal(h.pending[1]?.signal.aborted,true);assert.equal(h.b.state().keys,0);assert.equal(h.b.state().cancelledWaiters,2);
 }finally{h.b.close();}
});
test('unit: queue deadline removes only expired caller and releases queued keys',async()=>{
 const h=harness();try{
 const p=h.b.lookup(['a']);h.flush();const q=h.b.lookup(['b','b']);const expired=assert.rejects(q,{status:504});
 const t=h.timers.filter(t=>t.ms===600)[1];t?.job();await expired;
 assert.equal(h.b.state().keys,1);assert.equal(h.b.state().waiters,1);assert.equal(h.pending[0]?.signal.aborted,false);
 h.pending[0]?.resolve(absent(['a']));await p;await h.tick();assert.equal(h.b.state().keys,0);
 }finally{h.b.close();}
});
test('unit: batch failure rejects whole caller but independent queued caller succeeds',async()=>{
 const h=harness();try{
 const p=h.b.lookup(['a','b','c','d','e']);const failed=assert.rejects(p,{status:502});h.flush();const q=h.b.lookup(['f']);
 h.pending[0]?.resolve(absent(['a','a','c','d']));await failed;await h.tick();h.flush();assert.deepEqual(h.pending[1]?.ids,['f']);
 h.pending[1]?.resolve(absent(['f']));await q;assert.equal(h.b.state().waiters,0);
 }finally{h.b.close();}
});
test('unit: primitive, membership, found and value validation reject malformed replies',()=>{
 for(const v of [null,[],true,{ids:[1]},{ids:['a','a']}])assert.throws(()=>idsFrom(v,4,true));
 assert.deepEqual(idsFrom({ids:['ABCDEFGHIJKLMNOP','abcdefghijklmnop','0123456789_-abcd','z']},4,true),['ABCDEFGHIJKLMNOP','abcdefghijklmnop','0123456789_-abcd','z']);
 for(const items of [[{id:'x',found:false}],[],[{id:'a',found:'true'}],[{id:'a',found:true,value:0}],[{id:'a',found:true,value:101}],[{id:'a',found:false,value:1}],[{id:'a',found:true,value:1.5}]])assert.throws(()=>validate({items},['a']));
});

import { startService,jsonRequest } from '../../../test/support.mts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
async function state(url:string):Promise<Record<string,unknown>>{
 const response=await fetch(url,{signal:AbortSignal.timeout(2000)});assert.equal(response.status,200);const body:unknown=await response.json();assert.ok(typeof body==='object'&&body!==null&&!Array.isArray(body));return body as Record<string,unknown>;
}
async function until(url:string,predicate:(s:Record<string,unknown>)=>boolean){
 const deadline=Date.now()+2000;
 while(Date.now()<deadline){const s=await state(url);if(predicate(s))return s;await new Promise<void>(r=>setTimeout(r,5));}
 assert.fail(`Barrier not reached: ${url}`);
}
async function control(url:string,body:unknown){const r=await jsonRequest(url,body);assert.equal(r.status,200);await r.arrayBuffer();}

test('integration: inert imports silently succeed despite invalid runtime configuration',async()=>{
 const urls=['gateway.mts','catalog.mts','batcher.mts'].map(p=>new URL('../'+p,import.meta.url).href);
 const child=spawn(process.execPath,['--input-type=module','-e',urls.map(u=>`await import(${JSON.stringify(u)});`).join('')],{env:{PATH:process.env.PATH??'',PORT:'invalid',CATALOG_ORIGIN:'invalid',HOST:'invalid'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',(c:Buffer)=>{output+=c.toString();});child.stderr.on('data',(c:Buffer)=>{output+=c.toString();});
 const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
 try{const [code]=await once(child,'exit');assert.equal(code,0,output);assert.equal(output,'');}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
});

test('integration: held batch proves cross-request queue batching and independent cancellation',async()=>{
 const catalog=await startService(new URL('../catalog.mts',import.meta.url),{TEACHING_CONTROLS:'1'});
 try{
  const gateway=await startService(new URL('../gateway.mts',import.meta.url),{CATALOG_ORIGIN:catalog.url});
  try{
   await control(catalog.url+'/teaching/hold',{enabled:true});
   const first=jsonRequest(gateway.url+'/lookup',{ids:['a']});
   await until(catalog.url+'/teaching/state',s=>s.active===1);
   const b=jsonRequest(gateway.url+'/lookup',{ids:['b','c','b']});
   await until(gateway.url+'/state',s=>s.waiters===4&&s.keys===3);
   const c=jsonRequest(gateway.url+'/lookup',{ids:['d']});
   await until(gateway.url+'/state',s=>s.waiters===5&&s.keys===4);
   await control(catalog.url+'/teaching/hold',{enabled:false});
   for(const p of [first,b,c]){const r=await p;assert.equal(r.status,200);await r.arrayBuffer();}
   const cs=await state(catalog.url+'/teaching/state');assert.equal(cs.calls,2);assert.equal(cs.maxConcurrent,1);assert.deepEqual(cs.lastIds,['b','c','d']);
   await control(catalog.url+'/teaching/hold',{enabled:true});
   const abort=new AbortController();const gone=fetch(gateway.url+'/lookup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:['e']}),signal:abort.signal});const rejection=assert.rejects(gone);
   await until(catalog.url+'/teaching/state',s=>s.active===1);
   const survivor=jsonRequest(gateway.url+'/lookup',{ids:['e','e']});await until(gateway.url+'/state',s=>s.waiters===3);
   abort.abort();await rejection;await until(gateway.url+'/state',s=>s.waiters===2);
   assert.equal((await state(catalog.url+'/teaching/state')).active,1);
   await control(catalog.url+'/teaching/hold',{enabled:false});const survived=await survivor;assert.equal(survived.status,200);assert.deepEqual(await survived.json(),{items:[{id:'e',found:true,value:50},{id:'e',found:true,value:50}]});
   await control(catalog.url+'/teaching/hold',{enabled:true});
   const all=new AbortController();const abandoned=fetch(gateway.url+'/lookup',{method:'POST',headers:{'content-type':'application/json'},body:'{"ids":["f"]}',signal:all.signal});const rejected=assert.rejects(abandoned);
   await until(catalog.url+'/teaching/state',s=>s.active===1);all.abort();await rejected;
   await until(gateway.url+'/state',s=>s.waiters===0&&s.keys===0&&s.activeBatchSize===0);
   await until(catalog.url+'/teaching/state',s=>s.active===0);
   await control(catalog.url+'/teaching/hold',{enabled:false});const next=await jsonRequest(gateway.url+'/lookup',{ids:['a','b','c','d','e','f','g','h']});assert.equal(next.status,200);await next.arrayBuffer();
   for(const body of [null,[],true,{ids:[1]},{ids:[]}]){const r=await jsonRequest(gateway.url+'/lookup',body);assert.equal(r.status,400);await r.arrayBuffer();}
   for(const path of ['hold','behavior'])for(const body of [null,[],true,{enabled:'true',mode:1}]){const r=await jsonRequest(catalog.url+'/teaching/'+path,body);assert.equal(r.status,400);await r.arrayBuffer();}
   await control(catalog.url+'/teaching/behavior',{mode:'unavailable'});assert.equal((await jsonRequest(gateway.url+'/lookup',{ids:['a']})).status,502);
   await control(catalog.url+'/teaching/behavior',{mode:'normal'});
  }finally{await gateway.stop();}
  const restarted=await startService(new URL('../gateway.mts',import.meta.url),{CATALOG_ORIGIN:catalog.url});
  try{const r=await jsonRequest(restarted.url+'/lookup',{ids:['h','unknown','h']});assert.equal(r.status,200);assert.deepEqual(await r.json(),{items:[{id:'h',found:true,value:80},{id:'unknown',found:false},{id:'h',found:true,value:80}]});}finally{await restarted.stop();}
 }finally{await catalog.stop();}
});

test('integration: reused upstream validates membership, bytes, absolute body deadline and redirect containment',async()=>{
 const sink=await startService(new URL('./fixture.mts',import.meta.url));
 try{
  const source=await startService(new URL('./fixture.mts',import.meta.url));
  try{
   const gateway=await startService(new URL('../gateway.mts',import.meta.url),{CATALOG_ORIGIN:source.url});
   try{
    const ids=['ABCDEFGHIJKLMNOP','abcdefghijklmnop','0123456789_-abcd','zzzzzzzzzzzzzzzz'];
    for(const mode of ['missing','extra','duplicate','falseValue','badBoolean','range','fraction','oversize','slow','redirect','escaped','normal']){
     await control(source.url+'/configure',{mode,target:sink.url+'/sink'});
     const r=await jsonRequest(gateway.url+'/lookup',{ids});
     assert.equal(r.status,mode==='escaped'||mode==='normal'?200:502,mode);
     const body:unknown=await r.json();
     if(mode==='escaped'||mode==='normal')assert.deepEqual(body,{items:ids.map(id=>({id,found:true,value:10}))});
     else assert.ok(typeof body==='object'&&body!==null&&!('items' in body),mode);
     // Check destination evidence BEFORE any reset/configure operation.
     assert.equal((await state(sink.url+'/state')).hits,0,mode);
     await until(gateway.url+'/state',s=>s.waiters===0&&s.keys===0&&s.activeBatchSize===0);
     assert.equal((await state(source.url+'/state')).calls,1,mode);
    }
    // Maximal legal request escaping: encode string tokens only, including field names.
    const wire='{"\\u0069\\u0064\\u0073":['+Array.from({length:8},()=> '"'+Array.from({length:16},()=> '\\u0061').join('')+'"').join(',')+']}';
    const r=await fetch(gateway.url+'/lookup',{method:'POST',headers:{'content-type':'application/json'},body:wire,signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);const result=await r.json() as {items:unknown[]};assert.equal(result.items.length,8);
    const large=await fetch(gateway.url+'/lookup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids:['a']})+' '.repeat(8192),signal:AbortSignal.timeout(2000)});assert.equal(large.status,413);await large.arrayBuffer();
   }finally{await gateway.stop();}
  }finally{await source.stop();}
 }finally{await sink.stop();}
 const normal=await startService(new URL('../catalog.mts',import.meta.url));
 try{const r=await jsonRequest(normal.url+'/teaching/hold',{enabled:true});assert.equal(r.status,404);await r.arrayBuffer();}finally{await normal.stop();}
});

test('unit: upstream absolute deadline releases active capacity and queued batch proceeds',async()=>{
 const h=harness();try{
 const p=h.b.lookup(['a']);const failed=assert.rejects(p,{status:502});h.flush();const q=h.b.lookup(['b']);
 h.timers.find(t=>t.ms===300&&t.live)?.job();await failed;await h.tick();h.flush();
 assert.equal(h.pending[0]?.signal.aborted,true);assert.deepEqual(h.pending[1]?.ids,['b']);h.pending[1]?.resolve(absent(['b']));await q;
 assert.equal(h.b.state().waiters,0);assert.equal(h.b.state().keys,0);
 }finally{h.b.close();}
});

test('unit: second batch failure never resolves a caller with the first four results',async()=>{
 const h=harness();try{
 const p=h.b.lookup(['a','b','c','d','e']);const failed=assert.rejects(p,{status:502});h.flush();
 h.pending[0]?.resolve(absent(['a','b','c','d']));await h.tick();
 assert.equal(h.b.state().waiters,1);h.flush();assert.deepEqual(h.pending[1]?.ids,['e']);
 h.pending[1]?.resolve([]);await failed;assert.equal(h.b.state().waiters,0);
 }finally{h.b.close();}
});

test('unit: a new same-key caller survives delayed settlement of an aborted batch',async()=>{
 for(const cause of ['cancel','deadline'])for(const settlement of ['reject','resolve']){
  const jobs:(()=>void)[]=[];const timers:{job:()=>void;ms:number}[]=[];
  const pending:{ids:string[];signal:AbortSignal;resolve:(items:Item[])=>void;reject:(e:unknown)=>void}[]=[];
  const b=new Batcher((ids,signal)=>new Promise((resolve,reject)=>pending.push({ids,signal,resolve,reject})),{schedule:job=>jobs.push(job),timer:(job,ms)=>{timers.push({job,ms});return ()=>{};}});
  try{
   const cancelled=new AbortController();
   const first=b.lookup(['a'],cancelled.signal);const gone=assert.rejects(first,{status:cause==='cancel'?499:502});jobs.shift()?.();
   if(cause==='cancel')cancelled.abort();else timers.find(t=>t.ms===300)?.job();
   assert.equal(pending[0]?.signal.aborted,true);
   await assert.rejects(b.lookup(['b','c','d','e','f','g','h','i']),{status:429});
   assert.equal(b.state().keys,1,'retiring transport keys still count toward the distinct-key bound');
   const next=b.lookup(['a']);const outcome=next.then(items=>({items}),error=>({error}));
   assert.equal(b.state().waiters,cause==='cancel'?1:2);assert.equal(pending.length,1,'only one upstream batch may be active');
   if(settlement==='reject')pending[0]?.reject(Error('delayed abort'));
   else pending[0]?.resolve([{id:'a',found:true,value:99}]);
   await gone;await new Promise<void>(resolve=>setImmediate(resolve));jobs.shift()?.();
   assert.equal(pending.length,2,'new caller needs a fresh upstream batch');
   assert.deepEqual(pending[1]?.ids,['a']);assert.equal(pending[1]?.signal.aborted,false);
   pending[1]?.resolve([{id:'a',found:true,value:10}]);
   assert.deepEqual(await outcome,{items:[{id:'a',found:true,value:10}]});
   assert.deepEqual(b.state(),{waiters:0,keys:0,activeBatchSize:0,upstreamCalls:2,cancelledWaiters:cause==='cancel'?1:0});
  }finally{b.close();}
 }
});
