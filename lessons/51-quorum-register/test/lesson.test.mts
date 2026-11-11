import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { choose, intersects, ReplicaStore, CommandStore, parseRegister } from '../core.mts';

test('unit: quorum intersection requires R+W>N', () => {
  assert.equal(intersects(3, 2, 2), true);
  assert.equal(intersects(3, 1, 2), false);
});
test('unit: reads choose highest valid version and reject ties', () => {
  assert.deepEqual(choose([{version:1,value:10},{version:5,value:80}]), {version:5,value:80});
  assert.throws(() => choose([{version:1,value:10},{version:1,value:20}]));
  assert.throws(() => choose([{version:1,value:10}]));
  for (const bad of [null, [], true, {version:'1',value:3}, {version:0,value:1}, {version:17,value:1}]) assert.equal(parseRegister(bad), null);
});
test('unit: atomic replica rejection preserves current register', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new ReplicaStore(db);
    assert.equal(store.put({version:2,value:40}), 200);
    assert.equal(store.put({version:1,value:10}), 409);
    assert.equal(store.put({version:2,value:41}), 409);
    assert.equal(store.put({version:2,value:40}), 200);
    assert.deepEqual(store.get(), {version:2,value:40});
  } finally { db.close(); }
});
test('unit: receipts allocate once, persist attempts, block unsettled and replay without attempt', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let store = new CommandStore(db);
    assert.deepEqual(store.begin('a',10), {id:'a',value:10,version:1,attempts:1,state:'uncertain'});
    store = new CommandStore(db);
    assert.throws(() => store.begin('b',20));
    assert.throws(() => store.begin('a',11));
    assert.equal(store.begin('a',10).attempts, 2);
    assert.equal(store.begin('a',10).attempts, 3);
    assert.throws(() => store.begin('a',10));
    store.acknowledge('a');
    assert.equal(store.begin('a',10).attempts, 3);
    assert.equal(store.begin('b',20).version, 2);
    store.acknowledge('b');
    for (let n=3;n<=16;n++) { store.begin(`c${n}`,n); store.acknowledge(`c${n}`); }
    assert.throws(() => store.begin('overflow',30));
    assert.equal(store.list().length,16);
  } finally { db.close(); }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

// Break caught: moving config reads, SQLite opens or main() to module scope.
test('unit: imports are silent with deliberately invalid runtime configuration', () => {
  const imports=['core','replica','quorum'].map(n=>`await import(${JSON.stringify(new URL(`../${n}.mts`,import.meta.url).href)});`).join('\n');
  const result=spawnSync(process.execPath,['--input-type=module','-e',imports],{
    env:{PATH:process.env.PATH??'',PORT:'invalid',DB_PATH:'/nonexistent/forbidden/database',REPLICA_A_ORIGIN:'invalid',OPERATION_MS:'invalid'},timeout:3000,encoding:'utf8',maxBuffer:8192,
  });
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.stdout,''); assert.equal(result.stderr,'');
});
async function request(base:string,path:string,method='GET',body?:unknown) {
  return fetch(base+path,{method,signal:AbortSignal.timeout(3000),redirect:'error',
    ...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
}
async function expectJson(base:string,path:string,status:number,method='GET',body?:unknown):Promise<unknown> {
  const response=await request(base,path,method,body);
  assert.equal(response.status,status,await response.clone().text());
  return response.json();
}
async function availability(s:RunningService,available:boolean) { await expectJson(s.url,'/teaching/availability',200,'POST',{available}); }
function coordinatorEnv(dir:string,replicas:RunningService[]) {
  const [a,b,c]=replicas;
  assert.ok(a&&b&&c);
  return {DB_PATH:join(dir,'quorum.db'),REPLICA_A_ORIGIN:a.url,REPLICA_B_ORIGIN:b.url,REPLICA_C_ORIGIN:c.url,OPERATION_MS:'300'};
}
const replicaEntry=new URL('../replica.mts',import.meta.url);
const quorumEntry=new URL('../quorum.mts',import.meta.url);

test('integration: W2/R2, partial uncertainty, retry, repair and durable independent restarts', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'quorum-'));
  const services:RunningService[]=[];
  try {
    const replicas:RunningService[]=[];
    for (let i=0;i<3;i++) {
      const s=await startService(replicaEntry,{DB_PATH:join(dir,`r${i}.db`),TEACHING_CONTROLS:'1'});
      services.push(s); replicas.push(s);
    }
    const [a,b,c]=replicas; assert.ok(a&&b&&c);
    let env=coordinatorEnv(dir,replicas);
    let q=await startService(quorumEntry,env); services.push(q);
    assert.deepEqual(await expectJson(q.url,'/repair',200,'POST',{}),{register:{version:0,value:null},acknowledgements:0});
    await availability(c,false);
    assert.deepEqual(await expectJson(q.url,'/writes',200,'POST',{id:'first',value:10}),{id:'first',value:10,version:1,attempts:1,state:'acknowledged'});
    assert.deepEqual(await expectJson(q.url,'/register',200),{version:1,value:10});
    await availability(b,false);
    assert.deepEqual(await expectJson(q.url,'/writes',503,'POST',{id:'partial',value:20}),{id:'partial',value:20,version:2,attempts:1,state:'uncertain'});
    assert.deepEqual(await expectJson(a.url,'/register',200),{version:2,value:20});
    await expectJson(q.url,'/register',503);
    await expectJson(q.url,'/writes',409,'POST',{id:'new',value:30});
    await expectJson(q.url,'/writes',409,'POST',{id:'partial',value:21});
    await q.stop(); q=await startService(quorumEntry,env); services.push(q);
    assert.deepEqual(await expectJson(q.url,'/writes/partial',200),{receipt:{id:'partial',value:20,version:2,attempts:1,state:'uncertain'},active:false});
    await availability(b,true);
    // A read can expose a write that received 503, without settling its receipt.
    assert.deepEqual(await expectJson(q.url,'/register',200),{version:2,value:20});
    assert.deepEqual(await expectJson(b.url,'/register',200),{version:1,value:10});
    assert.deepEqual(await expectJson(q.url,'/writes/partial',200),{receipt:{id:'partial',value:20,version:2,attempts:1,state:'uncertain'},active:false});
    assert.deepEqual(await expectJson(q.url,'/writes',200,'POST',{id:'partial',value:20}),{id:'partial',value:20,version:2,attempts:2,state:'acknowledged'});
    await availability(c,true);
    assert.deepEqual(await expectJson(c.url,'/register',200),{version:0,value:null});
    assert.deepEqual(await expectJson(q.url,'/repair',200,'POST',{}),{register:{version:2,value:20},acknowledgements:3});
    await c.stop();
    const restarted=await startService(replicaEntry,{DB_PATH:join(dir,'r2.db'),TEACHING_CONTROLS:'1'}); services.push(restarted); replicas[2]=restarted;
    assert.deepEqual(await expectJson(restarted.url,'/register',200),{version:2,value:20});
    // Restart availability is true; it was never stored in SQLite.
    await availability(restarted,false); await restarted.stop();
    const again=await startService(replicaEntry,{DB_PATH:join(dir,'r2.db')}); services.push(again); replicas[2]=again;
    assert.deepEqual(await expectJson(again.url,'/register',200),{version:2,value:20});
    await expectJson(again.url,'/teaching/availability',404,'POST',{available:false});
    await q.stop(); env=coordinatorEnv(dir,replicas); q=await startService(quorumEntry,env); services.push(q);
    await availability(a,false); await availability(b,false);
    // Replay bypasses all replica I/O even with no quorum.
    assert.deepEqual(await expectJson(q.url,'/writes',200,'POST',{id:'first',value:10}),{id:'first',value:10,version:1,attempts:1,state:'acknowledged'});
    for (let attempt=1;attempt<=3;attempt++) {
      assert.deepEqual(await expectJson(q.url,'/writes',503,'POST',{id:'stuck',value:30}),{id:'stuck',value:30,version:3,attempts:attempt,state:'uncertain'});
    }
    await expectJson(q.url,'/writes',409,'POST',{id:'stuck',value:30});
    await availability(a,true); await availability(b,true);
    // Repair may propagate uncertainty but must not acknowledge a command receipt.
    assert.deepEqual(await expectJson(q.url,'/repair',200,'POST',{}),{register:{version:3,value:30},acknowledgements:3});
    await expectJson(q.url,'/writes',409,'POST',{id:'later',value:40});
    const state=await expectJson(q.url,'/state',200);
    assert.deepEqual(state,{receipts:[{id:'first',value:10,version:1,attempts:1,state:'acknowledged'},{id:'partial',value:20,version:2,attempts:2,state:'acknowledged'},{id:'stuck',value:30,version:3,attempts:3,state:'uncertain'}],active:false});
    for (const bad of [null,[],true,{id:1,value:10},{id:'x',value:'10'}]) await expectJson(q.url,'/writes',400,'POST',bad);
    for (const bad of [null,[],true,{available:1}]) await expectJson(a.url,'/teaching/availability',400,'POST',bad);
    for (const bad of [null,[],false,{version:'4',value:2},{version:4,value:true}]) await expectJson(a.url,'/register',400,'PUT',bad);
    for (const bad of [null,[],false,{extra:1}]) await expectJson(q.url,'/repair',400,'POST',bad);
    assert.deepEqual(await expectJson(a.url,'/register',409,'PUT',{version:2,value:20}),{version:3,value:30});
    assert.deepEqual(await expectJson(a.url,'/register',409,'PUT',{version:3,value:31}),{version:3,value:30});
  } finally { await Promise.all(services.map(s=>s.stop())); await rm(dir,{recursive:true,force:true}); }
});

// Poll an observable count, with one absolute deadline; no elapsed-time assertion.
async function until(base:string,predicate:(value:unknown)=>boolean) {
  const end=Date.now()+2000;
  while(Date.now()<end) {
    const value=await expectJson(base,'/state',200);
    if (predicate(value)) return;
    await new Promise<void>(resolve=>setTimeout(resolve,5));
  }
  assert.fail('Observable barrier was not reached');
}

test('integration: bounded validated votes, redirect containment and observable global busy guard', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'quorum-faults-'));
  const services:RunningService[]=[];
  try {
    const a=await startService(replicaEntry,{DB_PATH:join(dir,'a.db'),TEACHING_CONTROLS:'1'}); services.push(a);
    const b=await startService(replicaEntry,{DB_PATH:join(dir,'b.db'),TEACHING_CONTROLS:'1'}); services.push(b);
    const fixture=await startService(new URL('./upstream.mts',import.meta.url),{TEACHING_CONTROLS:'1',REDIRECT_ORIGIN:b.url}); services.push(fixture);
    const q=await startService(quorumEntry,coordinatorEnv(dir,[a,b,fixture])); services.push(q);
    const mode=async(mode:string)=>{await expectJson(fixture.url,'/control',200,'POST',{mode});};
    await availability(b,false);
    for (const variant of ['malformed','oversized','status']) {
      await mode(variant);
      await expectJson(q.url,'/register',503);
      await expectJson(q.url,'/repair',503,'POST',{});
    }
    await mode('escaped');
    assert.deepEqual(await expectJson(q.url,'/register',200),{version:1,value:100});
    // Redirected PUT must not deliver a caller value to B (B is available now).
    await mode('redirect'); await availability(b,true); await availability(a,false);
    await expectJson(q.url,'/writes',503,'POST',{id:'redirect',value:100});
    assert.deepEqual(await expectJson(b.url,'/register',200),{version:1,value:100});
    // Following the redirect would count B twice and incorrectly return 200.
    await availability(a,true);
    await mode('valid');
    await expectJson(q.url,'/writes',200,'POST',{id:'redirect',value:100});
    await mode('conflict');
    await expectJson(a.url,'/register',200,'PUT',{version:2,value:100});
    await expectJson(q.url,'/register',502); // B v1=100 versus fixture v1=99.
    await mode('hold');
    const inFlight=expectJson(q.url,'/repair',200,'POST',{});
    await until(fixture.url,v=> typeof v==='object' && v!==null && 'pending' in v && v.pending===1);
    assert.deepEqual(await expectJson(q.url,'/state',200),{receipts:[{id:'redirect',value:100,version:1,attempts:2,state:'acknowledged'}],active:true});
    await expectJson(q.url,'/writes',409,'POST',{id:'busy',value:2});
    await expectJson(q.url,'/repair',409,'POST',{});
    await mode('valid'); await inFlight;
    // A held body must exhaust the same overall deadline and release admission.
    await availability(b,false); await mode('hold');
    await expectJson(q.url,'/register',503);
    await mode('valid');
    const maxId='a'.repeat(32);
    const escaped='{"id":"'+'\\u0061'.repeat(32)+'","value":100}';
    const max=await fetch(q.url+'/writes',{method:'POST',headers:{'content-type':'application/json'},body:escaped,signal:AbortSignal.timeout(3000)});
    assert.equal(max.status,200); assert.deepEqual(await max.json(),{id:maxId,value:100,version:2,attempts:1,state:'acknowledged'});
    // Same valid schema/id/value; ONLY byte budget is violated by whitespace.
    const oversized=await fetch(q.url+'/writes',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(8193)+JSON.stringify({id:'oversized',value:3}),signal:AbortSignal.timeout(3000)});
    assert.equal(oversized.status,413); await oversized.body?.cancel();
    await mode('wrongEcho');
    await expectJson(q.url,'/writes',503,'POST',{id:'wrongEcho',value:60});
    await mode('valid');
    await expectJson(q.url,'/writes',200,'POST',{id:'wrongEcho',value:60});
    await mode('valid'); // reset fixture counters before acknowledged replay
    await expectJson(q.url,'/writes',200,'POST',{id:'wrongEcho',value:60});
    assert.deepEqual(await expectJson(fixture.url,'/state',200),{calls:0,pending:0});
    // Admission must occur before awaiting the complete request body.
    let finish:()=>void=()=>{};
    const bodyResponse=new Promise<number>((resolve,reject)=>{
      const partial=httpRequest(q.url+'/writes',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(3000)},res=>{
        res.resume(); res.once('end',()=>resolve(res.statusCode??0)); res.once('error',reject);
      });
      partial.once('error',reject);
      partial.write('{"id":"body",');
      finish=()=>partial.end('"value":70}');
    });
    // Attach rejection handling immediately, including if a barrier assertion fails.
    const settled=bodyResponse.then(status=>({status}),error=>({error}));
    try {
      await until(q.url,v=>typeof v==='object' && v!==null && 'active' in v && v.active===true);
      await expectJson(q.url,'/repair',409,'POST',{});
      await expectJson(q.url,'/writes',409,'POST',{id:'other',value:80});
    } finally { finish(); }
    assert.deepEqual(await settled,{status:200});
  } finally { await Promise.all(services.map(s=>s.stop())); await rm(dir,{recursive:true,force:true}); }
});
