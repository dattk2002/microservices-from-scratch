import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store, windowStart, parseSnapshot, object, integer } from '../store.mts';
import { startService, jsonRequest } from '../../../test/support.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';


test('unit: boundary 9/10 and transactional event-time policies', () => {
  assert.equal(windowStart(9),0);
  assert.equal(windowStart(10),10);
  const db = new DatabaseSync(':memory:');
  try {
    const store = new Store(db);
    const first = store.event({id:'nine',partition:'a',time:9,value:3});
    assert.deepEqual(first,{id:'nine',partition:'a',time:9,value:3,start:0,end:10});
    store.event({id:'ten',partition:'b',time:10,value:4});
    store.event({id:'early',partition:'b',time:1,value:2});
    assert.deepEqual(store.state().windows, [
      {start:0,end:10,count:2,sum:5,finalized:false},
      {start:10,end:20,count:1,sum:4,finalized:false},
    ]);
    store.watermark({partition:'a',time:20});
    assert.equal(store.state().global,0);
    assert.equal(store.state().windows[0]?.finalized,false);
    store.watermark({partition:'b',time:9});
    store.event({id:'below',partition:'a',time:0,value:1});
    store.watermark({partition:'b',time:10});
    assert.equal(store.state().global,10);
    assert.equal(store.state().windows[0]?.finalized,true);
    const before = store.state();
    assert.throws(() => store.event({id:'late',partition:'a',time:9,value:1}));
    assert.deepEqual(store.state(),before);
    assert.deepEqual(store.event({id:'nine',partition:'a',time:9,value:3}),first);
    assert.throws(() => store.event({id:'nine',partition:'a',time:9,value:4}));
    assert.throws(() => store.watermark({partition:'b',time:8}));
    store.watermark({partition:'b',time:10});
    for(let i=4;i<16;i++) store.event({id:`e${i}`,partition:'a',time:19,value:100});
    assert.equal(store.state().receipts,16);
    const full=store.state();
    assert.throws(() => store.event({id:'overflow',partition:'a',time:19,value:1}));
    assert.deepEqual(store.state(),full);
    assert.deepEqual(store.event({id:'nine',partition:'a',time:9,value:3}),first);
  } finally {db.close();}
});

test('unit: ten aligned windows and sixteen receipts are the maximal legal snapshot',()=> {
  const db=new DatabaseSync(':memory:');
  try {
    const store=new Store(db);
    for(let i=0;i<16;i++) store.event({id:`x${i}`,partition:'a',time:(i%10)*10,value:100});
    store.watermark({partition:'a',time:100});store.watermark({partition:'b',time:100});
    const s=store.state();
    assert.equal(s.windows.length,10);assert.equal(s.receipts,16);
    assert.equal(s.windows.reduce((n,w)=>n+w.sum,0),1600);
    assert.ok(s.windows.every(w=>w.finalized));
    for(const bad of [null,[],true,{...s,global:99},{...s,partitions:{a:[],b:100}}, {...s,windows:[...s.windows,s.windows[0]]}]) assert.throws(()=>parseSnapshot(bad));
  } finally {db.close();}
});

test('integration: inert entrypoint imports ignore invalid runtime configuration silently',async()=> {
  const entries=['aggregator.mts','reader.mts','test/upstream.mts'].map(path=>new URL(`../${path}`,import.meta.url).href);
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',entries.map(url=>`await import(${JSON.stringify(url)});`).join('\n')],{
    env:{PATH:process.env.PATH??'',HOST:'invalid host',PORT:'invalid',DB_PATH:'/not/a/real/directory/data.sqlite',AGGREGATOR_ORIGIN:'invalid origin',REDIRECT_ORIGIN:'invalid redirect',TEACHING_CONTROLS:'invalid'},timeout:5000,
  });
  assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

async function get(url:string) {return fetch(url,{signal:AbortSignal.timeout(3000),redirect:'error'});}

test('integration: independent aggregator and reader preserve logical progress, receipts and restart',async()=> {
  const dir=await mkdtemp(join(tmpdir(),'event-watermarks-'));
  const env={DB_PATH:join(dir,'events.sqlite')};
  let aggregator:Awaited<ReturnType<typeof startService>>|undefined;
  let reader:Awaited<ReturnType<typeof startService>>|undefined;
  try {
    aggregator=await startService(new URL('../aggregator.mts',import.meta.url),env);
    reader=await startService(new URL('../reader.mts',import.meta.url),{AGGREGATOR_ORIGIN:aggregator.url});
    const post=async(route:string,body:unknown,status=200):Promise<unknown>=> {const r=await jsonRequest(`${aggregator!.url}${route}`,body);assert.equal(r.status,status);return r.json();};
    const state=async()=>parseSnapshot(await (await get(`${aggregator!.url}/state`)).json());
    const receipt=await post('/events',{id:'nine',partition:'a',time:9,value:3});
    await post('/events',{id:'ten',partition:'b',time:10,value:4});
    await post('/watermarks',{partition:'a',time:100});
    assert.equal((await state()).global,0);
    assert.ok((await state()).windows.every(w=>!w.finalized));
    await post('/watermarks',{partition:'b',time:9});
    await post('/events',{id:'out-of-order',partition:'b',time:0,value:2});
    assert.deepEqual((await state()).windows[0],{start:0,end:10,count:2,sum:5,finalized:false});
    await post('/watermarks',{partition:'b',time:10});
    const before=await state();
    await post('/events',{id:'late',partition:'a',time:9,value:1},409);
    assert.deepEqual(await state(),before);
    assert.deepEqual(await post('/events',{id:'nine',partition:'a',time:9,value:3}),receipt);
    await post('/events',{id:'nine',partition:'a',time:9,value:4},409);
    await post('/watermarks',{partition:'b',time:9},409);
    await post('/watermarks',{partition:'b',time:10});
    assert.deepEqual(await (await get(`${reader.url}/windows`)).json(),{global:10,windows:before.windows});
    for(const body of [null,[],true,{id:'valid',partition:['a'],time:1,value:1},{id:123,partition:'a',time:1,value:1},{id:'valid',partition:'a',time:'1',value:1},{id:'valid',partition:'a',time:1,value:true}]) await post('/events',body,400);
    for(const body of [null,[],false,{partition:['a'],time:10},{partition:'a',time:'10'},{partition:'a',time:101}]) await post('/watermarks',body,400);
    const oversized=await fetch(`${aggregator.url}/events`,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(8193)+JSON.stringify({id:'nine',partition:'a',time:9,value:3}),signal:AbortSignal.timeout(3000)});
    assert.equal(oversized.status,413);
    assert.deepEqual(await state(),before);
    await reader.stop();reader=undefined;
    await aggregator.stop();aggregator=await startService(new URL('../aggregator.mts',import.meta.url),env);
    assert.deepEqual(await state(),before);
    assert.deepEqual(await post('/events',{id:'nine',partition:'a',time:9,value:3}),receipt);
    // Fill all remaining windows, then all sixteen immutable receipts.
    for(let i=2;i<10;i++) await post('/events',{id:`w${i}`,partition:'a',time:i*10,value:100});
    for(let i=11;i<15;i++) await post('/events',{id:`extra${i}`,partition:'b',time:99,value:100});
    // Worst identifier escaping: 32 URL-safe characters encoded as six-byte escapes.
    const escaped=JSON.stringify({id:'_'.repeat(32),partition:'b',time:99,value:100}).replaceAll('_','\\u005f');
    const maximum=await fetch(`${aggregator.url}/events`,{method:'POST',headers:{'content-type':'application/json'},body:escaped,signal:AbortSignal.timeout(3000)});
    assert.equal(maximum.status,200);
    assert.equal((await state()).receipts,16);
    const full=await state();
    await post('/events',{id:'full',partition:'a',time:99,value:1},409);
    assert.deepEqual(await state(),full);
    await post('/watermarks',{partition:'b',time:100});
    reader=await startService(new URL('../reader.mts',import.meta.url),{AGGREGATOR_ORIGIN:aggregator.url});
    const maximal=await (await get(`${reader.url}/windows`)).json();
    const final=await state();
    assert.equal(final.windows.length,10);assert.ok(final.windows.every(w=>w.finalized));
    assert.deepEqual(maximal,{global:100,windows:final.windows});
    assert.deepEqual(await post('/events',{id:'nine',partition:'a',time:9,value:3}),receipt);
  } finally {await Promise.allSettled([reader?.stop(),aggregator?.stop()]);await rm(dir,{recursive:true,force:true});}
});

test('integration: fixed upstream validates complete snapshots and never follows redirects',async()=> {
  const destination=await startService(new URL('./upstream.mts',import.meta.url),{TEACHING_CONTROLS:'1'});
  let upstream:Awaited<ReturnType<typeof startService>>|undefined;
  let reader:Awaited<ReturnType<typeof startService>>|undefined;
  try {
    upstream=await startService(new URL('./upstream.mts',import.meta.url),{TEACHING_CONTROLS:'1',REDIRECT_ORIGIN:destination.url});
    reader=await startService(new URL('../reader.mts',import.meta.url),{AGGREGATOR_ORIGIN:upstream.url});
    for(const invalid of [null,[],true,{mode:['valid']},{mode:1}]) assert.equal((await jsonRequest(`${upstream.url}/control`,invalid)).status,400);
    for(const mode of ['valid','primitive','partition','minimum','order','alignment','count','sum','flag','receipts','malformed','oversized','slow','redirect']) {
      assert.equal((await jsonRequest(`${upstream.url}/control`,{mode})).status,200);
      assert.equal((await jsonRequest(`${destination.url}/control`,{mode:'valid'})).status,200);
      const response=await get(`${reader.url}/windows`);
      assert.equal(response.status,mode==='valid'?200:502,mode);
      const body:unknown=await response.json();
      if(mode==='valid') {
        const expected=Array.from({length:10},(_,i)=>({start:i*10,end:i*10+10,count:i===9?7:1,sum:i===9?700:100,finalized:true}));
        assert.deepEqual(body,{global:100,windows:expected});
      } else {assert.ok(typeof body==='object' && body!==null && !('windows' in body));}
      const stats=object(await (await get(`${upstream.url}/stats`)).json());
      assert.equal(integer(stats.reads,0,10),1,mode);assert.equal(integer(stats.targets,0,10),0,mode);
      const targetStats=object(await (await get(`${destination.url}/stats`)).json());
      assert.equal(integer(targetStats.targets,0,10),0,mode);
    }
    assert.equal((await get(`${reader.url}/windows?url=${encodeURIComponent(upstream.url+'/target')}`)).status,404);
  } finally {await Promise.allSettled([reader?.stop(),upstream?.stop(),destination.stop()]);}
});

test('unit: receipt insert failure rolls back window mutation and failed watermark finalization rolls back progress',()=> {
  const db=new DatabaseSync(':memory:');
  try {
    const store=new Store(db);
    store.event({id:'kept',partition:'a',time:1,value:2});
    const before=store.state();
    db.exec("CREATE TRIGGER refuse_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'test disk failure'); END;");
    assert.throws(()=>store.event({id:'rejected',partition:'b',time:1,value:8}));
    assert.deepEqual(store.state(),before);
    db.exec('DROP TRIGGER refuse_receipt');
    store.watermark({partition:'a',time:10});
    const stalled=store.state();
    db.exec("CREATE TRIGGER refuse_finalize BEFORE UPDATE ON windows BEGIN SELECT RAISE(ABORT, 'test finalize failure'); END;");
    assert.throws(()=>store.watermark({partition:'b',time:10}));
    assert.deepEqual(store.state(),stalled);
  } finally {db.close();}
});

test('unit: missing windows still close and snapshot semantic corruptions are rejected',()=> {
  const db=new DatabaseSync(':memory:');
  try {
    const store=new Store(db);
    store.watermark({partition:'a',time:10});store.watermark({partition:'b',time:10});
    assert.throws(()=>store.event({id:'absent',partition:'b',time:0,value:1}));
    assert.equal(store.state().receipts,0);assert.deepEqual(store.state().windows,[]);
    const legal={partitions:{a:19,b:19},global:19,receipts:1,windows:[{start:10,end:20,count:1,sum:100,finalized:false}]};
    assert.deepEqual(parseSnapshot(legal),legal);
    for(const fields of [{start:11,end:21},{end:30},{count:17},{sum:101},{sum:0},{finalized:[]},{finalized:true},{count:'1'}]) {
      assert.throws(()=>parseSnapshot({...legal,windows:[{...legal.windows[0],...fields}]}));
    }
  } finally {db.close();}
});
