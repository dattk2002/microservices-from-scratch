import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Timers } from '../store.mts';

// These assertions catch early selection, unstable ordering, retraction after an
// attempt, deleted identities, and retries that forget their durable budget.
test('unit: due boundary/order, cancellation, retained replay and uncertain exhaustion', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now = 99;
    const timers = new Timers(db, () => now);
    timers.create({id:'b', dueAt:100, value:2});
    timers.create({id:'a', dueAt:100, value:1});
    timers.create({id:'cancel', dueAt:0, value:3});
    assert.equal(timers.cancel('cancel').state, 'cancelled');
    assert.equal(timers.select(), undefined);
    now = 100;
    assert.equal(timers.select()?.id, 'a');
    assert.equal(timers.get('a')?.attempts, 1);
    assert.equal(timers.get('a')?.state, 'uncertain');
    assert.throws(() => timers.cancel('a'));
    assert.equal(timers.create({id:'a', dueAt:100, value:1}).attempts, 1);
    assert.throws(() => timers.create({id:'a', dueAt:100, value:2}));
    // Reopening the domain over the same database must preserve uncertainty.
    const reopened = new Timers(db, () => now);
    for (let i=0;i<3;i++) { assert.equal(reopened.select()?.id, 'a'); reopened.failed('a'); }
    assert.equal(reopened.get('a')?.state, 'exhausted');
    assert.equal(reopened.get('a')?.attempts, 4);
    assert.equal(reopened.select()?.id, 'b');
    reopened.delivered('b');
    assert.equal(reopened.create({id:'b',dueAt:100,value:2}).state, 'delivered');
    assert.equal(reopened.cancel('cancel').state, 'cancelled');
    assert.equal(reopened.list().length,3);
  } finally { db.close(); }
});

test('unit: exact due boundary selects by timestamp then id', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let now=9; const t=new Timers(db,()=>now);
    t.create({id:'z',dueAt:10,value:1}); t.create({id:'a',dueAt:10,value:1});
    t.create({id:'AAA',dueAt:11,value:1});
    assert.equal(t.select(),undefined); now=10;
    assert.equal(t.select()?.id,'a');t.delivered('a');
    assert.equal(t.select()?.id,'z');t.delivered('z');
    assert.equal(t.select(),undefined);now=11;assert.equal(t.select()?.id,'AAA');
  } finally { db.close(); }
});
test('unit: replay retains attempted identity and rejects changed metadata', () => {
  const db=new DatabaseSync(':memory:');
  try { const t=new Timers(db,()=>1); t.create({id:'x',dueAt:1,value:1}); t.select();
    assert.equal(t.create({id:'x',dueAt:1,value:1}).state,'uncertain');
    assert.throws(()=>t.create({id:'x',dueAt:2,value:1}));
  } finally { db.close(); }
});
test('unit: uncertainty survives reopening and fourth failed attempt exhausts', () => {
  const db=new DatabaseSync(':memory:');
  try { const t=new Timers(db,()=>1); t.create({id:'x',dueAt:1,value:1}); t.select();
    const r=new Timers(db,()=>1); assert.equal(r.get('x')?.state,'uncertain');
    r.failed('x'); for(let i=0;i<3;i++){r.select();r.failed('x');}
    assert.equal(r.get('x')?.state,'exhausted'); assert.equal(r.select(),undefined);
  } finally { db.close(); }
});

import { Receipts, timerInput } from '../store.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

// Removing receipt deduplication would increment total on replay; dropping the
// retained capacity limit would accept the seventeenth distinct identity.
test('unit: receipts atomically deduplicate, reject mutations and retain capacity',()=>{
  const db=new DatabaseSync(':memory:');
  try {const r=new Receipts(db);
    assert.deepEqual(r.accept({id:'a',value:100}),{id:'a',duplicate:false,total:100});
    assert.deepEqual(r.accept({id:'a',value:100}),{id:'a',duplicate:true,total:100});
    assert.throws(()=>r.accept({id:'a',value:99}));
    for(let i=0;i<15;i++)r.accept({id:`b${i}`,value:1});
    assert.throws(()=>r.accept({id:'full',value:1})); assert.equal(r.list().length,16);
    assert.equal(new Receipts(db).total(),115);
    for(const bad of [null,[],true,{id:1,value:1},{id:'ok',value:'1'}])assert.throws(()=>r.accept(bad));
    for(const bad of [null,[],false,{id:'ok',dueAt:'0',value:1},{id:'ok',dueAt:0,value:true}])assert.throws(()=>timerInput(bad));
  }finally{db.close();}
});

const scheduler=new URL('../scheduler.mts',import.meta.url);
const receiver=new URL('../receiver.mts',import.meta.url);
const fixture=new URL('./upstream.mts',import.meta.url);
async function get(url:string):Promise<Record<string,unknown>> {
  const response=await fetch(url,{signal:AbortSignal.timeout(3000)});assert.equal(response.status,200);
  const body:unknown=await response.json(); assert.ok(body&&typeof body==='object'&&!Array.isArray(body));
  return Object.fromEntries(Object.entries(body));
}
async function post(url:string,body:unknown,status=200):Promise<Record<string,unknown>> {
  const response=await jsonRequest(url,body);assert.equal(response.status,status,`${url}: ${await response.clone().text()}`);
  const value:unknown=await response.json();assert.ok(value&&typeof value==='object'&&!Array.isArray(value));return Object.fromEntries(Object.entries(value));
}
async function waitStarted(url:string,count:number):Promise<void>{
  const deadline=Date.now()+2000;
  while(Date.now()<deadline){if((await get(url+'/state')).started===count)return;await new Promise(r=>setTimeout(r,5));}
  assert.fail('Observable upstream request barrier not reached');
}

test('integration: timestamps, cancel, replay, both database restarts and commit/error recovery',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'timers-')); const services:RunningService[]=[];
  const boot=async(entry:URL,env:Record<string,string>)=>{const s=await startService(entry,env);services.push(s);return s;};
  try {
    const rEnv={DB_PATH:join(dir,'receiver.db'),TEACHING_CONTROLS:'1'};
    let r=await boot(receiver,rEnv);
    const sEnv={DB_PATH:join(dir,'scheduler.db'),RECEIVER_ORIGIN:r.url,TEACHING_CONTROLS:'1',TEACHING_EPOCH_SECONDS:'100'};
    let s=await boot(scheduler,sEnv);
    await post(s.url+'/timers',{id:'z',dueAt:101,value:7});
    await post(s.url+'/timers',{id:'a',dueAt:101,value:3});
    await post(s.url+'/timers',{id:'cancel',dueAt:100,value:100});
    await post(s.url+'/timers/cancel/cancel',{});
    await post(s.url+'/dispatch',{});assert.deepEqual((await get(r.url+'/state')).receipts,[]);
    await s.stop(); s=await boot(scheduler,sEnv);
    assert.deepEqual(await post(s.url+'/dispatch',{}),{dispatched:false});
    await post(s.url+'/teaching/advance',{seconds:1});
    const first=await post(s.url+'/dispatch',{});assert.equal(first.id,'a');
    assert.deepEqual((await get(r.url+'/state')).receipts,[{id:'a',value:3}]);
    await post(s.url+'/timers/a/cancel',{},409);
    assert.equal((await post(s.url+'/timers',{id:'a',dueAt:101,value:3})).state,'delivered');
    await post(s.url+'/timers',{id:'a',dueAt:101,value:4},409);
    await post(r.url+'/teaching/failure',{afterCommit:true});
    assert.equal((await post(s.url+'/dispatch',{})).state,'uncertain');
    assert.equal((await get(r.url+'/state')).total,10);
    assert.equal((await post(r.url+'/fire',{id:'z',value:7})).duplicate,true);
    await s.stop();await r.stop();r=await boot(receiver,rEnv);
    s=await boot(scheduler,{...sEnv,RECEIVER_ORIGIN:r.url,TEACHING_EPOCH_SECONDS:'101'});
    assert.equal((await get(s.url+'/timers/z')).state,'uncertain');
    assert.equal((await get(r.url+'/state')).total,10); // restart itself performs no sends
    assert.equal((await post(s.url+'/dispatch',{})).state,'delivered');
    assert.equal((await get(r.url+'/state')).total,10);
    assert.equal((await get(s.url+'/timers/z')).attempts,2);
    assert.equal((await post(s.url+'/timers/cancel/cancel',{})).state,'cancelled');
    for(let i=0;i<13;i++)await post(s.url+'/timers',{id:`future${i}`,dueAt:2147483647,value:1});
    await post(s.url+'/timers',{id:'over',dueAt:0,value:1},409);
    // Both bounds include identities whose work has already finished.
    for(let i=0;i<14;i++)await post(r.url+'/fire',{id:`receipt${i}`,value:1});
    await post(r.url+'/fire',{id:'over',value:1},409);
    await post(r.url+'/fire',{id:'a',value:4},409);
    assert.equal((await post(r.url+'/fire',{id:'a',value:3})).duplicate,true);
  } finally {await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});

test('integration: malformed primitives, byte budgets, maximal escaped identities and control gates',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'timer-validation-')); const services:RunningService[]=[];
  const boot=async(entry:URL,env:Record<string,string>)=>{const s=await startService(entry,env);services.push(s);return s;};
  try {
    const r=await boot(receiver,{DB_PATH:join(dir,'r'),TEACHING_CONTROLS:'1'});
    const s=await boot(scheduler,{DB_PATH:join(dir,'s'),RECEIVER_ORIGIN:r.url,TEACHING_CONTROLS:'1',TEACHING_EPOCH_SECONDS:'0'});
    for(const primitive of [null,[],true]){
      for(const route of ['/timers','/dispatch','/timers/missing/cancel','/teaching/advance'])await post(s.url+route,primitive,400);
      for(const route of ['/fire','/teaching/failure'])await post(r.url+route,primitive,400);
    }
    for(const body of [{id:1,dueAt:0,value:1},{id:'a',dueAt:'0',value:1},{id:'a',dueAt:0,value:'1'},{id:'a',dueAt:-1,value:1}])await post(s.url+'/timers',body,400);
    await post(s.url+'/teaching/advance',{seconds:'1'},400);
    await post(s.url+'/teaching/advance',{seconds:61},400);
    await post(r.url+'/teaching/failure',{afterCommit:'true'},400);
    for(let i=0;i<60;i++)await post(s.url+'/teaching/advance',{seconds:60});
    await post(s.url+'/teaching/advance',{seconds:1},400);
    // Every identifier code point escaped: a worst-size legal identity, not a
    // different invalid schema masquerading as an oversized-body regression.
    const raw='{"id":"'+'\\u0041'.repeat(32)+'","dueAt":2147483647,"value":100}';
    const maximal=await fetch(s.url+'/timers',{method:'POST',headers:{'content-type':'application/json'},body:raw,signal:AbortSignal.timeout(3000)});
    assert.equal(maximal.status,200);
    const large=await fetch(s.url+'/timers',{method:'POST',headers:{'content-type':'application/json'},body:raw+' '.repeat(8193),signal:AbortSignal.timeout(3000)});
    assert.equal(large.status,413);
    const fire='{"id":"'+'\\u0042'.repeat(32)+'","value":100}';
    assert.equal((await fetch(r.url+'/fire',{method:'POST',headers:{'content-type':'application/json'},body:fire,signal:AbortSignal.timeout(3000)})).status,200);
    assert.equal((await fetch(r.url+'/fire',{method:'POST',headers:{'content-type':'application/json'},body:fire+' '.repeat(8193),signal:AbortSignal.timeout(3000)})).status,413);
    const normal=await boot(receiver,{DB_PATH:join(dir,'normal')});
    await post(normal.url+'/teaching/failure',{afterCommit:true},404);
    const normalS=await boot(scheduler,{DB_PATH:join(dir,'normalS'),RECEIVER_ORIGIN:normal.url});
    await post(normalS.url+'/teaching/advance',{seconds:1},404);
  } finally {await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});

test('integration: invalid, oversized, slow and redirected replies stay uncertain; busy and cancellation barrier',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'timer-acks-'));const services:RunningService[]=[];
  const boot=async(entry:URL,env:Record<string,string>)=>{const s=await startService(entry,env);services.push(s);return s;};
  try {
    const target=await boot(fixture,{}),up=await boot(fixture,{});
    const env={DB_PATH:join(dir,'s'),RECEIVER_ORIGIN:up.url,TEACHING_CONTROLS:'1',TEACHING_EPOCH_SECONDS:'10',DELIVERY_TIMEOUT_MS:'200'};
    let s=await boot(scheduler,env);
    for(const mode of ['invalid','wrong-id','wrong-total','null','oversized','slow','redirect']){
      await post(up.url+'/control',{mode,target:target.url});
      await post(s.url+'/timers',{id:mode,dueAt:1,value:1});
      for(let i=0;i<4;i++){
        const answer=await post(s.url+'/dispatch',{});
        assert.equal(answer.id,mode); assert.equal(answer.state,i===3?'exhausted':'uncertain');
      }
      assert.equal((await get(s.url+'/timers/'+mode)).attempts,4);
      assert.deepEqual(await post(s.url+'/dispatch',{}),{dispatched:false});
      await post(up.url+'/release',{});
    }
    assert.equal((await get(target.url+'/state')).started,0,'redirect must never forward payload to another origin');
    await s.stop(); s=await boot(scheduler,{...env,DELIVERY_TIMEOUT_MS:'2000'});
    await post(up.url+'/control',{mode:'hold',target:target.url});
    await post(s.url+'/timers',{id:'barrier',dueAt:2,value:1});
    const sending=post(s.url+'/dispatch',{});
    void sending.catch(()=>{});
    await waitStarted(up.url,1);
    assert.equal((await get(s.url+'/state')).busy,true);
    await post(s.url+'/dispatch',{},409);await post(s.url+'/timers/barrier/cancel',{},409);
    await post(up.url+'/release',{});assert.equal((await sending).state,'delivered');
    assert.equal((await get(up.url+'/state')).started,1);
    // A process killed while awaiting a reply must restart without auto-send.
    await post(up.url+'/control',{mode:'hold',target:target.url});
    await post(s.url+'/timers',{id:'crash',dueAt:3,value:1});
    const interrupted=jsonRequest(s.url+'/dispatch',{}).catch(()=>undefined);
    await waitStarted(up.url,1);s.child.kill('SIGKILL');await s.stop();await interrupted;
    await post(up.url+'/release',{});s=await boot(scheduler,env);
    assert.equal((await get(s.url+'/timers/crash')).state,'uncertain');
    assert.equal((await get(up.url+'/state')).started,1);
    await post(up.url+'/control',{mode:'ok',target:target.url});
    assert.equal((await post(s.url+'/dispatch',{})).state,'delivered');
    assert.equal((await get(s.url+'/timers/crash')).attempts,2);
    await post(up.url+'/control',{mode:'escaped',target:target.url});
    await post(s.url+'/timers',{id:'A'.repeat(32),dueAt:4,value:100});
    assert.equal((await post(s.url+'/dispatch',{})).state,'delivered');
  } finally {await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});

test('integration: all entrypoints import silently despite deliberately invalid runtime configuration',async()=>{
  const code=`await import(${JSON.stringify(scheduler.href)});await import(${JSON.stringify(receiver.href)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH??'',PORT:'invalid',DB_PATH:'/nonexistent/invalid/db',RECEIVER_ORIGIN:'not a URL',TEACHING_CONTROLS:'bad',TEACHING_EPOCH_SECONDS:'bad'},stdio:['ignore','pipe','pipe']});
  let out='',err=''; child.stdout.on('data',(b:Buffer)=>{out+=b.toString();});child.stderr.on('data',(b:Buffer)=>{err+=b.toString();});
  const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
  try {const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(exit,0);assert.equal(out,'');assert.equal(err,'');}
  finally {clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
