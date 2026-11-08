import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Consumer, route } from '../model.mts';

// Removing the gap gate must mutate neither balances nor checkpoints.
test('unit: gap is rejected without effects and independent partition progresses', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const c = new Consumer(db);
    assert.throws(() => c.apply([{id:'g',key:'c',delta:4,partition:0,offset:2}]), /expected offset 1/);
    assert.deepEqual(c.state(), {checkpoints:[0,0,0],balances:{}});
    c.apply([{id:'b',key:'a',delta:3,partition:1,offset:1}]);
    assert.deepEqual(c.state(), {checkpoints:[0,1,0],balances:{a:3}});
  } finally { db.close(); }
});
test('unit: exact duplicate succeeds but altered identity and reused id conflict', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const c = new Consumer(db);
    const e = {id:'one',key:'c',delta:4,partition:0,offset:1};
    c.apply([e]); c.apply([e]);
    assert.throws(() => c.apply([{...e, delta:5}]), /conflict/);
    assert.throws(() => c.apply([{...e, offset:2}]), /conflict/);
    assert.deepEqual(c.state(), {checkpoints:[1,0,0],balances:{c:4}});
  } finally { db.close(); }
});
test('unit: batch balance overflow rolls back receipts projection and checkpoint', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const c = new Consumer(db);
    assert.throws(() => c.apply(Array.from({length:8}, (_,i) => ({id:`n${i}`,key:'c',delta:1_000_000,partition:0,offset:i+1}))), /balance/);
    assert.deepEqual(c.state(), {checkpoints:[0,0,0],balances:{}});
    c.apply([{id:'n0',key:'c',delta:1,partition:0,offset:1}]);
    assert.equal(c.state().checkpoints[0], 1);
  } finally { db.close(); }
});
test('unit: routing has hand checked fixed partition vectors', () => {
  assert.equal(route('a'),1); assert.equal(route('b'),2); assert.equal(route('c'),0); assert.equal(route('ab'),0);
});

test('unit: wrong routing and primitive types cannot enter durable state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const c = new Consumer(db);
    for (const value of [
      {id:'x',key:'c',delta:1,partition:1,offset:1},
      {id:'x',key:'c',delta:0,partition:0,offset:1},
      {id:'x',key:'c',delta:1,partition:'0',offset:1},
    ]) assert.throws(() => c.apply([value]), /invalid/);
    assert.deepEqual(c.state(), {checkpoints:[0,0,0],balances:{}});
  } finally { db.close(); }
});

// Losing the global id lookup or evicting history breaks these contracts.
test('unit: broker idempotency and hard retention preserve original offsets', async () => {
  const { Broker } = await import('../model.mts');
  const db=new DatabaseSync(':memory:');
  try {
    const b=new Broker(db);
    assert.deepEqual(b.append({id:'first',key:'c',delta:1}),{id:'first',key:'c',delta:1,partition:0,offset:1});
    assert.throws(()=>b.append({id:'first',key:'a',delta:1}),/conflict/);
    for(let i=2;i<=32;i++) b.append({id:`e${i}`,key:'c',delta:1});
    assert.throws(()=>b.append({id:'overflow',key:'c',delta:1}),/retention/);
    assert.equal(b.append({id:'first',key:'c',delta:1}).offset,1);
    assert.deepEqual(b.read(0,31,8),[{id:'e32',key:'c',delta:1,partition:0,offset:32}]);
    b.append({id:'other',key:'a',delta:2});
    assert.equal(b.read(1,0,1).length,1);
  } finally {db.close();}
});
test('unit: seventeenth key rejects atomically for broker and consumer', async () => {
  const {Broker}=await import('../model.mts');
  const bdb=new DatabaseSync(':memory:'), cdb=new DatabaseSync(':memory:');
  try {
    const b=new Broker(bdb),c=new Consumer(cdb);
    for(let i=0;i<16;i++) c.apply([b.append({id:`key${i}`,key:`k${i}`,delta:1})]);
    assert.throws(()=>b.append({id:'extra',key:'seventeenth',delta:1}),/retention/);
    const partition=route('seventeenth');
    assert.throws(()=>c.apply([{id:'extra',key:'seventeenth',delta:1,partition,offset:c.checkpoint(partition)+1}]),/retention/);
    assert.equal(Object.keys(c.state().balances).length,16);
    assert.equal(b.read(partition,c.checkpoint(partition),8).length,0);
  } finally {bdb.close();cdb.close();}
});

import { spawnSync } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

// An import that opens SQLite, reads config or starts a listener fails here.
test('integration: every entrypoint imports silently with invalid runtime configuration',()=>{
  const imports=['broker.mts','consumer.mts','test/upstream.mts'].map(name=>new URL(`../${name}`,import.meta.url).href);
  const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','--eval',`await Promise.all(${JSON.stringify(imports)}.map(u=>import(u)))`],{
    env:{PATH:process.env.PATH??'',PORT:'invalid',HOST:'invalid',DB_PATH:'/nonexistent/invalid/db.sqlite',BROKER_ORIGIN:'invalid',POLL_REQUEST_MS:'invalid',VARIANT:'invalid'},timeout:3000,encoding:'utf8',
  });
  assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

async function state(url:string):Promise<unknown> {
  const response=await fetch(`${url}/state`,{signal:AbortSignal.timeout(2000)});
  assert.equal(response.status,200);return response.json();
}
async function stats(url:string):Promise<{entered:number;aborted:number}> {
  const response=await fetch(`${url}/stats`,{signal:AbortSignal.timeout(2000)});
  const data:unknown=await response.json();
  assert.ok(data && typeof data==='object' && 'entered' in data && 'aborted' in data);
  assert.equal(typeof data.entered,'number');assert.equal(typeof data.aborted,'number');
  return {entered:Number(data.entered),aborted:Number(data.aborted)};
}
async function waitFor(check:()=>Promise<boolean>) {
  const deadline=Date.now()+3000;
  while(Date.now()<deadline) {
    if(await check())return;
    await new Promise<void>(resolve=>setTimeout(resolve,10));
  }
  assert.fail('observable fixture barrier not reached');
}
async function rig(work:(start:(entry:string,env?:Record<string,string>)=>Promise<RunningService>,dir:string)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'partition-order-'));
  const services:RunningService[]=[];
  const starting:Promise<RunningService>[]=[];
  try {
    await work((entry,env={})=>{
      const ready=startService(new URL(`../${entry}`,import.meta.url),env);
      starting.push(ready);
      void ready.then(service=>{services.push(service);},()=>{});
      return ready;
    },dir);
  } finally {
    // A parallel startup may still be pending when its sibling fails.
    await Promise.allSettled(starting);
    try {await Promise.all(services.map(s=>s.stop()));}
    finally {await rm(dir,{recursive:true,force:true});}
  }
}
async function post(url:string,body:unknown,status=200):Promise<unknown> {
  const response=await jsonRequest(url,body);
  assert.equal(response.status,status,await response.clone().text());
  return response.json();
}

test('integration: rejected gap recovers by poll while another partition and independent cursor progress; restart is durable',async()=>{
  await rig(async(start,dir)=>{
    const brokerPath=join(dir,'broker.sqlite'),c1Path=join(dir,'one.sqlite');
    let broker=await start('broker.mts',{DB_PATH:brokerPath});
    let c1=await start('consumer.mts',{DB_PATH:c1Path,BROKER_ORIGIN:broker.url});
    const c2=await start('consumer.mts',{DB_PATH:join(dir,'two.sqlite'),BROKER_ORIGIN:broker.url});
    const one=await post(`${broker.url}/events`,{id:'one',key:'c',delta:2});
    const two=await post(`${broker.url}/events`,{id:'two',key:'c',delta:3});
    const another=await post(`${broker.url}/events`,{id:'other',key:'a',delta:7});
    assert.deepEqual(one,{id:'one',key:'c',delta:2,partition:0,offset:1});
    assert.deepEqual(await post(`${c1.url}/deliver`,two,409),{error:{code:'gap',expected:1,message:'expected offset 1'}});
    await post(`${c1.url}/deliver`,another);
    assert.deepEqual(await state(c1.url),{checkpoints:[0,1,0],balances:{a:7}});
    await post(`${c1.url}/poll`,{partition:0});
    await post(`${c1.url}/deliver`,one);
    await post(`${c1.url}/deliver`,{id:'one',key:'c',delta:9,partition:0,offset:1},409);
    assert.deepEqual(await state(c1.url),{checkpoints:[2,1,0],balances:{a:7,c:5}});
    assert.deepEqual(await state(c2.url),{checkpoints:[0,0,0],balances:{}});
    await post(`${c2.url}/poll`,{partition:0});
    assert.deepEqual(await state(c2.url),{checkpoints:[2,0,0],balances:{c:5}});
    await c1.stop();await broker.stop();
    broker=await start('broker.mts',{DB_PATH:brokerPath});
    c1=await start('consumer.mts',{DB_PATH:c1Path,BROKER_ORIGIN:broker.url});
    assert.deepEqual(await state(c1.url),{checkpoints:[2,1,0],balances:{a:7,c:5}});
    assert.deepEqual(await post(`${broker.url}/events`,{id:'one',key:'c',delta:2}),one);
    await post(`${broker.url}/events`,{id:'one',key:'b',delta:2},409);
    const third=await post(`${broker.url}/events`,{id:'three',key:'c',delta:-1});
    assert.deepEqual(third,{id:'three',key:'c',delta:-1,partition:0,offset:3});
    await post(`${c1.url}/poll`,{partition:0});
    assert.deepEqual(await state(c1.url),{checkpoints:[3,1,0],balances:{a:7,c:4}});
  });
});

test('integration: concurrent mixed keys get contiguous per-partition offsets and independent consumers replay',async()=>{
  await rig(async(start,dir)=>{
    const b=await start('broker.mts',{DB_PATH:join(dir,'b')});
    const results:unknown[]=[];
    for(let wave=0;wave<4;wave++) {
      results.push(...await Promise.all(Array.from({length:6},(_,j)=>{
        const i=wave*6+j;
        return post(`${b.url}/events`,{id:`mixed${i}`,key:['a','b','c','d','e','f'][i%6],delta:1});
      })));
    }
    for(const [keys,p] of [[['a','d'],1],[['b','e'],2],[['c','f'],0]] as const) {
      const offsets=results.filter((v):v is {partition:number;offset:number;key:string}=>typeof v==='object'&&v!==null&&'key' in v&&(v.key===keys[0]||v.key===keys[1])&&'partition' in v&&typeof v.partition==='number'&&'offset' in v&&typeof v.offset==='number');
      assert.equal(offsets.length,8);assert.ok(offsets.every(e=>e.partition===p));
      for(const key of keys)assert.equal(offsets.filter(e=>e.key===key).length,4);
      assert.deepEqual(offsets.map(e=>e.offset).sort((a,b)=>a-b),[1,2,3,4,5,6,7,8]);
    }
    const consumers=await Promise.all(['x','y'].map(name=>start('consumer.mts',{DB_PATH:join(dir,name),BROKER_ORIGIN:b.url})));
    await Promise.all(consumers.flatMap(c=>[0,1,2].map(partition=>post(`${c.url}/poll`,{partition}))));
    for(const c of consumers)assert.deepEqual(await state(c.url),{checkpoints:[8,8,8],balances:{a:4,b:4,c:4,d:4,e:4,f:4}});
  });
});

test('integration: full partition and global key retention reject without unsafe eviction',async()=>{
  await rig(async(start,dir)=>{
    const b=await start('broker.mts',{DB_PATH:join(dir,'b')});
    for(let i=1;i<=32;i++)await post(`${b.url}/events`,{id:`r${i}`,key:'c',delta:1});
    await post(`${b.url}/events`,{id:'overflow',key:'c',delta:1},409);
    assert.deepEqual(await post(`${b.url}/events`,{id:'r1',key:'c',delta:1}),{id:'r1',key:'c',delta:1,partition:0,offset:1});
    await post(`${b.url}/events`,{id:'r1',key:'c',delta:-1},409);
    const other=await start('broker.mts',{DB_PATH:join(dir,'keys')});
    for(let i=0;i<16;i++)await post(`${other.url}/events`,{id:`key${i}`,key:`k${i}`,delta:1});
    await post(`${other.url}/events`,{id:'extra',key:'extra',delta:1},409);
    assert.deepEqual(await post(`${other.url}/events`,{id:'key0',key:'k0',delta:1}),{id:'key0',key:'k0',delta:1,partition:2,offset:1});
  });
});

for(const variant of ['malformed','sequence','identity','envelope','oversized']) {
  test(`integration: ${variant} upstream batch has zero partial effects`,async()=>{
    await rig(async(start,dir)=>{
      const upstream=await start('test/upstream.mts',{VARIANT:variant});
      const c=await start('consumer.mts',{DB_PATH:join(dir,'c'),BROKER_ORIGIN:upstream.url});
      await post(`${c.url}/poll`,{partition:0},variant==='identity'?409:502);
      assert.deepEqual(await state(c.url),{checkpoints:[0,0,0],balances:{}});
      assert.equal((await stats(upstream.url)).entered,1);
    });
  });
}

test('integration: maximal escaped legal inputs and eight-event envelope are accepted',async()=>{
  await rig(async(start,dir)=>{
    const b=await start('broker.mts',{DB_PATH:join(dir,'b')});
    const value={id:'x'.repeat(64),key:'c'.repeat(32),delta:-1_000_000};
    const escaped=JSON.stringify(value).replace(/[A-Za-z]/g,c=>`\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
    const response=await fetch(`${b.url}/events`,{method:'POST',headers:{'content-type':'application/json'},body:escaped,signal:AbortSignal.timeout(2000)});
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{...value,partition:0,offset:1});
    const oversized=await fetch(`${b.url}/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'over',key:'c',delta:1})+' '.repeat(8193),signal:AbortSignal.timeout(2000)});
    assert.equal(oversized.status,413);await oversized.arrayBuffer();
    const u=await start('test/upstream.mts',{VARIANT:'valid'});
    const c=await start('consumer.mts',{DB_PATH:join(dir,'c'),BROKER_ORIGIN:u.url});
    await post(`${c.url}/poll`,{partition:0});
    assert.deepEqual(await state(c.url),{checkpoints:[8,0,0],balances:{['c'.repeat(32)]:8}});
    const oversizedDelivery=await fetch(`${c.url}/deliver`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'over',key:'c'.repeat(32),delta:1,partition:0,offset:9})+' '.repeat(8193),signal:AbortSignal.timeout(2000)});
    assert.equal(oversizedDelivery.status,413);await oversizedDelivery.arrayBuffer();
    assert.deepEqual(await state(c.url),{checkpoints:[8,0,0],balances:{['c'.repeat(32)]:8}});
  });
});

test('integration: redirects cannot leave fixed broker origin',async()=>{
  await rig(async(start,dir)=>{
    const sink=await start('test/upstream.mts');
    const redirect=await start('test/upstream.mts',{VARIANT:'redirect',TARGET_ORIGIN:sink.url});
    const c=await start('consumer.mts',{DB_PATH:join(dir,'c'),BROKER_ORIGIN:redirect.url});
    await post(`${c.url}/poll`,{partition:0},502);
    assert.equal((await stats(redirect.url)).entered,1);
    assert.equal((await stats(sink.url)).entered,0);
    assert.deepEqual(await state(c.url),{checkpoints:[0,0,0],balances:{}});
  });
});

for(const settings of [
  {POLL_REQUEST_MS:'80',POLL_TOTAL_MS:'2000'},
  {POLL_REQUEST_MS:'2000',POLL_TOTAL_MS:'80'},
]) test(`integration: streaming upstream obeys request=${settings.POLL_REQUEST_MS} total=${settings.POLL_TOTAL_MS} deadline`,async()=>{
  await rig(async(start,dir)=>{
    const u=await start('test/upstream.mts',{VARIANT:'stream'});
    const c=await start('consumer.mts',{DB_PATH:join(dir,'c'),BROKER_ORIGIN:u.url,...settings});
    await post(`${c.url}/poll`,{partition:0},502);
    await waitFor(async()=> (await stats(u.url)).aborted===1);
    assert.deepEqual(await state(c.url),{checkpoints:[0,0,0],balances:{}});
  });
});

test('integration: bounded poll admission and a held partition never prevent another partition delivery',async()=>{
  await rig(async(start,dir)=>{
    const u=await start('test/upstream.mts',{VARIANT:'hold'});
    const c=await start('consumer.mts',{DB_PATH:join(dir,'c'),BROKER_ORIGIN:u.url,POLL_REQUEST_MS:'2000',POLL_TOTAL_MS:'4000'});
    const pending=post(`${c.url}/poll`,{partition:0}).then(()=>({ok:true as const}),(error:unknown)=>({ok:false as const,error}));
    try {
      // Observe entry, not elapsed time, before exercising concurrency.
      await waitFor(async()=> (await stats(u.url)).entered===1);
      await post(`${c.url}/poll`,{partition:0},503);
      await post(`${c.url}/deliver`,{id:'gap',key:'c',delta:1,partition:0,offset:2},409);
      await post(`${c.url}/deliver`,{id:'other',key:'a',delta:7,partition:1,offset:1});
      assert.deepEqual(await state(c.url),{checkpoints:[0,1,0],balances:{a:7}});
    } finally {
      try {await post(`${u.url}/release`,{});}
      finally {const result=await pending;if(!result.ok)throw result.error;}
    }
    assert.deepEqual(await state(c.url),{checkpoints:[8,1,0],balances:{a:7,['c'.repeat(32)]:8}});
  });
});

test('unit: all 96 receipts remain available for exact duplicate recognition',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const c=new Consumer(db);
    for(const [partition,key] of [[0,'c'],[1,'a'],[2,'b']] as const) {
      for(let after=0;after<32;after+=8) c.apply(Array.from({length:8},(_,i)=>({id:`p${partition}n${after+i+1}`,key,delta:1,partition,offset:after+i+1})));
    }
    c.apply([{id:'p0n1',key:'c',delta:1,partition:0,offset:1}]);
    c.apply([{id:'p2n32',key:'b',delta:1,partition:2,offset:32}]);
    assert.deepEqual(c.state(),{checkpoints:[32,32,32],balances:{a:32,b:32,c:32}});
    assert.throws(()=>c.apply([{id:'p0n1',key:'c',delta:2,partition:0,offset:1}]),/conflict/);
    assert.throws(()=>c.apply([{id:'overflow',key:'c',delta:1,partition:0,offset:33}]),/invalid/);
  }finally{db.close();}
});
