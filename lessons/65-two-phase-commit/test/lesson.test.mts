import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Participant } from '../store.mts';

// Removing the durable prepared vote would let a crashed coordinator release capacity.
test('unit: prepared promise reserves capacity across coordinator outage and duplicate commit consumes once', (t) => {
 const db = new DatabaseSync(':memory:');
 try {
  const participant = new Participant(db, 'a');
  assert.deepEqual(participant.prepare('outage', 3), {txId:'outage', amount:3, vote:'yes'});
  t.mock.method(Date,'now',()=>9_000_000_000_000);
  const recovered=new Participant(db,'a');
  assert.deepEqual(recovered.state(),{participant:'a',committed:0,available:1,transactions:[{txId:'outage',amount:3,phase:'prepared'}]});
  assert.equal(recovered.prepare('blocked',1).vote,'no');
  assert.equal(recovered.prepare('outage',3).vote,'yes');
  assert.deepEqual(recovered.decide('outage',3,'commit'),{txId:'outage',amount:3,phase:'committed'});
  recovered.decide('outage',3,'commit');
  assert.equal(new Participant(db,'a').state().committed,3);
  assert.equal(recovered.state().available,1);
 } finally { db.close(); }
});

import { CoordinatorStore } from '../store.mts';
import { Coordinator } from '../engine.mts';
import { HttpError } from '../../../lib/http.mts';
import { parseAmount, parseDecision, parseTxId, origins } from '../protocol.mts';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';

function code(work:()=>unknown, expected:string) {
 assert.throws(work,(e:unknown)=>e instanceof HttpError && e.code===expected);
}
function memory<T>(work:(db:DatabaseSync)=>T):T {
 const db=new DatabaseSync(':memory:');
 try { return work(db); } finally { db.close(); }
}
const fixed={a:'http://127.0.0.1:31001', b:'http://127.0.0.1:31002'};

test('unit: abort tombstone fences delayed prepare and terminal decisions never change',()=>memory(db=>{
 const p=new Participant(db,'a');
 assert.deepEqual(p.decide('late',2,'abort'),{txId:'late',amount:2,phase:'aborted'});
 assert.equal(p.prepare('late',2).vote,'no');
 assert.deepEqual(p.decide('late',2,'abort'),{txId:'late',amount:2,phase:'aborted'});
 code(()=>p.decide('late',2,'commit'),'decision_conflict');
 code(()=>p.prepare('late',3),'tx_conflict');
 code(()=>p.decide('unknown',1,'commit'),'not_prepared');
 assert.equal(p.prepare('held',4).vote,'yes');
 assert.equal(p.prepare('blocked',1).vote,'no');
 code(()=>p.decide('blocked',1,'commit'),'not_prepared');
 p.decide('blocked',1,'abort');p.decide('held',4,'commit');
 code(()=>p.decide('held',4,'abort'),'decision_conflict');
 code(()=>p.decide('held',3,'commit'),'tx_conflict');
 assert.equal(p.prepare('held',4).vote,'yes');
 assert.equal(p.state().committed,4);assert.equal(p.state().available,0);
 assert.equal(p.prepare('insufficient',1).vote,'no');
 assert.deepEqual(p.state().transactions.map(t=>t.txId),['blocked','held','insufficient','late']);
}));

test('unit: eight retained IDs include no votes and tombstones, replay survives exhaustion',()=>memory(db=>{
 const p=new Participant(db,'a');
 for(let i=0;i<8;i++)p.decide(`t${i}`,1,'abort');
 code(()=>p.prepare('ninth',1),'capacity');code(()=>p.decide('ninth',1,'abort'),'capacity');
 assert.equal(p.prepare('t0',1).vote,'no');
 code(()=>p.prepare('t0',2),'tx_conflict');
 assert.equal(p.state().transactions.length,8);
}));

test('unit: primitive schemas reject coercion, arrays, extra fields and unsafe numbers',()=>{
 for(const bad of [null,[],{},true,1,'', 'has space', 'x'.repeat(17),'é','\ud800'])code(()=>parseTxId(bad),'invalid_body');
 for(const bad of [null,[],{toString:null},true,'1',0,5,1.5,Number.MAX_SAFE_INTEGER])code(()=>parseAmount(bad),'invalid_body');
 for(const bad of [null,[],{toString:null},true,1,'prepare'])code(()=>parseDecision(bad),'invalid_body');
 assert.equal(parseTxId('a_B-09'), 'a_B-09'); assert.equal(parseAmount(4),4);
 assert.throws(()=>origins('http://127.0.0.1:80','http://127.0.0.1'));
 for(const bad of ['https://127.0.0.1','http://user@127.0.0.1:5','http://127.0.0.1:5/path','file:///tmp/a'])assert.throws(()=>origins(bad,fixed.b));
});

test('unit: same database cannot be reused with another participant or coordinator identity',()=>memory(db=>{
 const a=new Participant(db,'a');a.prepare('identity',2);
 assert.throws(()=>new Participant(db,'b'));
 assert.throws(()=>new CoordinatorStore(db));
 assert.deepEqual(a.state(),{participant:'a',committed:0,available:2,transactions:[{txId:'identity',amount:2,phase:'prepared'}]});
}));

test('unit: commit gate needs both persisted yes votes, crash recovery never reverses commit',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
  let store=new CoordinatorStore(db);store.create('gate',2);
  const calls:string[]=[];
  let c=new Coordinator(store,fixed,async(origin,path,body)=>{calls.push(origin+path);return {...body,vote:'yes'};});
  assert.equal((await c.step('gate')).phase,'preparing');
  assert.deepEqual(store.get('gate').votes,{a:'yes',b:null});
  await assert.rejects(()=>c.deliver('gate'),e=>e instanceof HttpError && e.code==='undecided');
  store=new CoordinatorStore(db);c=new Coordinator(store,fixed,async(origin,path,body)=>{calls.push(origin+path);return {...body,vote:'yes'};});
  const commit=await c.step('gate');assert.equal(commit.phase,'commit');assert.deepEqual(commit.acks,{a:false,b:false});
  assert.deepEqual(calls,[fixed.a+'/prepare',fixed.b+'/prepare']);
  assert.deepEqual(await c.step('gate'),commit);assert.equal(calls.length,2);
  const recovered=new Coordinator(new CoordinatorStore(db),fixed,async()=>{throw new Error('offline');});
  await assert.rejects(()=>recovered.deliver('gate'),e=>e instanceof HttpError && e.code==='upstream_failure');
  assert.deepEqual(store.get('gate'),commit);
 }finally{db.close();}
});

test('unit: no vote and uncertain vote durably choose abort and cannot later send prepare',async()=>{
 for(const reply of [{txId:'stop',amount:1,vote:'no'},null,[],{txId:'stop',amount:1,vote:'yes',extra:true},{txId:'wrong',amount:1,vote:'yes'},{txId:'stop',amount:2,vote:'yes'}]){
  const db=new DatabaseSync(':memory:');
  try{
   const store=new CoordinatorStore(db);store.create('stop',1);let calls=0;
   const c=new Coordinator(store,fixed,async()=>{calls++;return reply;});
   if(reply!==null && !Array.isArray(reply) && 'vote' in reply && reply.vote==='no')assert.equal((await c.step('stop')).phase,'abort');
   else await assert.rejects(()=>c.step('stop'),e=>e instanceof HttpError && e.code==='upstream_failure');
   assert.equal(new CoordinatorStore(db).get('stop').phase,'abort');
   assert.equal((await c.step('stop')).phase,'abort');assert.equal(calls,1);
  }finally{db.close();}
 }
});

test('unit: duplicate decision after lost reply is safe, only validated ack advances delivery',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
 const adb=new DatabaseSync(':memory:');
 try{
  const store=new CoordinatorStore(db),a=new Participant(adb,'a');
  store.create('retry',3);a.prepare('retry',3);
  const c=new Coordinator(store,fixed,async(_origin,path,body)=>({...body,vote:'yes'}));
  await c.step('retry');await c.step('retry');
  let attempts=0;
  const recovery=new Coordinator(store,fixed,async(origin,_path,body)=>{
   if(origin===fixed.b)return {txId:body.txId,amount:body.amount,phase:'committed'};
   const result=a.decide('retry',3,'commit');
   if(++attempts===1)throw new Error('commit-before-reply');
   return result;
  });
  await assert.rejects(()=>recovery.deliver('retry'));
  assert.equal(a.state().committed,3);assert.deepEqual(store.get('retry').acks,{a:false,b:false});
  assert.deepEqual((await recovery.deliver('retry')).acks,{a:true,b:false});
  assert.equal(a.state().committed,3);
  assert.deepEqual((await recovery.deliver('retry')).acks,{a:true,b:true});
  await recovery.deliver('retry');assert.equal(attempts,2);
 }finally{adb.close();}
 }finally{db.close();}
});

test('unit: per-transaction exclusion spans step and deliver, other IDs proceed',async()=>{
 const db=new DatabaseSync(':memory:');
 let release:()=>void=()=>{};let entered:()=>void=()=>{};
 const barrier=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});
 try{
  const store=new CoordinatorStore(db);store.create('slow',1);store.create('other',1);
  const c=new Coordinator(store,fixed,async(_origin,_path,body)=>{if(body.txId==='slow'){entered();await barrier;}return {...body,vote:'yes'};});
  const pending=c.step('slow');
  try{
   await started;
   await assert.rejects(()=>c.step('slow'),e=>e instanceof HttpError && e.code==='busy');
   await assert.rejects(()=>c.deliver('slow'),e=>e instanceof HttpError && e.code==='busy');
   assert.equal((await c.step('other')).votes.a,'yes');
  }finally{release();await pending;}
  assert.equal(store.get('slow').votes.a,'yes');
 }finally{db.close();}
});

test('unit: coordinator capacity retains terminal records and immutable payloads',()=>memory(db=>{
 const s=new CoordinatorStore(db);assert.equal(s.create('first',1).created,true);
 assert.equal(s.create('first',1).created,false);code(()=>s.create('first',2),'tx_conflict');
 code(()=>s.get('absent'),'unknown_transaction');
 for(let i=1;i<8;i++)s.create(`t${i}`,1);
 code(()=>s.create('ninth',1),'capacity');assert.equal(s.create('first',1).created,false);
}));

test('unit: importing entrypoints is silent with invalid configuration and no DB access',()=>{
 const script=`await import(${JSON.stringify(new URL('../participant.mts',import.meta.url).href)});await import(${JSON.stringify(new URL('../coordinator.mts',import.meta.url).href)});`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{PATH:process.env.PATH??'',DB_PATH:'/invalid/db',PARTICIPANT_ID:'invalid',A_ORIGIN:'invalid',B_ORIGIN:'invalid',HOST:'invalid',PORT:'invalid'},encoding:'utf8',timeout:3000});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { object, localRecord, transaction } from '../protocol.mts';

async function playground() {
 const dir=await mkdtemp(join(tmpdir(),'two-phase-commit-'));
 const services:RunningService[]=[];
 async function close(){
  try{
   const results=await Promise.allSettled(services.toReversed().map(s=>s.stop()));
   const failed=results.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason;
  }finally{await rm(dir,{recursive:true,force:true});}
 }
 try{
  async function start(entry:string,env:Record<string,string>){const s=await startService(new URL(`../${entry}`,import.meta.url),env);services.push(s);return s;}
  return {dir,start,close};
 }catch(error){await close();throw error;}
}
async function cluster(useFixture=false,wire=false) {
 const f=await playground();
 try{
  const sink=useFixture?await f.start('test/fixture.mts',{PARTICIPANT_ID:'b',DB_PATH:join(f.dir,'sink.sqlite'),TEACHING_CONTROLS:'1'}):undefined;
  const aenv={...(wire?{WIRE_ONLY:'1'}:{}),PARTICIPANT_ID:'a',DB_PATH:join(f.dir,'a.sqlite'),...(sink?{REDIRECT_ORIGIN:sink.url,TEACHING_CONTROLS:'1'}:{})};
  const benv={PARTICIPANT_ID:'b',DB_PATH:join(f.dir,'b.sqlite'),...(wire?{WIRE_ONLY:'1',TEACHING_CONTROLS:'1'}:{})};
  const aentry=useFixture?'test/fixture.mts':'participant.mts';
  let a=await f.start(aentry,aenv), b=await f.start(wire?'test/fixture.mts':'participant.mts',benv);
  const cenv={DB_PATH:join(f.dir,'c.sqlite'),A_ORIGIN:a.url,B_ORIGIN:b.url};
  let c=await f.start('coordinator.mts',cenv);
  return {...f,get a(){return a;},get b(){return b;},get c(){return c;},sink,
   async stopCoordinator(){const exited=once(c.child,'exit');c.child.kill('SIGKILL');await exited;},
   async restartCoordinator(){await c.stop();c=await f.start('coordinator.mts',cenv);},
   async restartParticipants(){
    // Origins are fixed, including across crash/restart; rebind the initial ephemeral ports.
    const aport=new URL(a.url).port,bport=new URL(b.url).port;
    await a.stop();await b.stop();
    a=await f.start(aentry,{...aenv,PORT:aport});b=await f.start(wire?'test/fixture.mts':'participant.mts',{...benv,PORT:bport});
   },
  };
 }catch(error){await f.close();throw error;}
}
async function post(service:RunningService,path:string,body:unknown,status=200):Promise<unknown> {
 const response=await jsonRequest(service.url+path,body);const value:unknown=await response.json();
 assert.equal(response.status,status,JSON.stringify(value));return value;
}
async function get(service:RunningService,path:string,status=200):Promise<unknown> {
 const response=await fetch(service.url+path,{signal:AbortSignal.timeout(2000)});const value:unknown=await response.json();
 assert.equal(response.status,status,JSON.stringify(value));return value;
}
function record(value:unknown) {assert.ok(transaction(value),JSON.stringify(value));return value;}
function state(value:unknown) {
 assert.ok(object(value));assert.ok(Array.isArray(value.transactions));
 assert.ok(value.transactions.every(localRecord));
 assert.equal(typeof value.committed,'number');assert.equal(typeof value.available,'number');return value;
}
async function mode(service:RunningService,value:string) {await post(service,'/teaching/mode',{mode:value});}
async function calls(service:RunningService) {const v=await get(service,'/teaching/stats');assert.ok(object(v));assert.ok(typeof v.calls==='number');return v.calls;}
async function begin(service:RunningService,id:string,amount=2){return record(await post(service,'/transactions',{txId:id,amount},201));}
async function commit(service:RunningService,id:string,amount=2){await begin(service,id,amount);await post(service,'/step',{txId:id});return record(await post(service,'/step',{txId:id}));}

test('integration: durable commit before delivery survives all restarts and shows partial visibility',async()=>{
 const f=await cluster();
 try{
  assert.deepEqual(await begin(f.c,'sale',3),{txId:'sale',amount:3,phase:'preparing',votes:{a:null,b:null},acks:{a:false,b:false}});
  assert.equal(record(await post(f.c,'/step',{txId:'sale'})).phase,'preparing');
  const decided=record(await post(f.c,'/step',{txId:'sale'}));assert.equal(decided.phase,'commit');
  assert.equal(state(await get(f.a,'/state')).committed,0);assert.equal(state(await get(f.b,'/state')).available,1);
  await f.stopCoordinator();await f.restartParticipants();await f.restartCoordinator();
  assert.deepEqual(await get(f.c,'/transactions/sale'),decided);
  assert.deepEqual(record(await post(f.c,'/deliver',{txId:'sale'})).acks,{a:true,b:false});
  assert.equal(state(await get(f.a,'/state')).committed,3);
  assert.deepEqual(state(await get(f.b,'/state')).transactions,[{txId:'sale',amount:3,phase:'prepared'}]);
  await f.restartCoordinator();await f.restartParticipants();
  assert.deepEqual(record(await post(f.c,'/deliver',{txId:'sale'})).acks,{a:true,b:true});
  await post(f.c,'/deliver',{txId:'sale'});await post(f.c,'/step',{txId:'sale'});
  for(const p of [f.a,f.b]){
   assert.deepEqual(await get(p,'/state'),{participant:p===f.a?'a':'b',committed:3,available:1,transactions:[{txId:'sale',amount:3,phase:'committed'}]});
   await post(p,'/decide',{txId:'sale',amount:3,decision:'commit'});
   await post(p,'/decide',{txId:'sale',amount:3,decision:'abort'},409);
  }
  await post(f.c,'/transactions',{txId:'sale',amount:3});await post(f.c,'/transactions',{txId:'sale',amount:2},409);
 }finally{await f.close();}
});

test('integration: one yes blocks after restart until a no vote and explicit abort delivery',async()=>{
 const f=await cluster();
 try{
  await post(f.b,'/prepare',{txId:'separate',amount:1});
  await begin(f.c,'blocked',2);await post(f.c,'/step',{txId:'blocked'});
  await f.stopCoordinator();await f.restartParticipants();
  assert.deepEqual(await post(f.a,'/prepare',{txId:'other',amount:1}),{txId:'other',amount:1,vote:'no'});
  assert.equal(state(await get(f.a,'/state')).available,2);
  await f.restartCoordinator();
  assert.equal(record(await get(f.c,'/transactions/blocked')).phase,'preparing');
  await post(f.c,'/deliver',{txId:'blocked'},409);
  const abort=record(await post(f.c,'/step',{txId:'blocked'}));assert.equal(abort.phase,'abort');assert.deepEqual(abort.votes,{a:'yes',b:'no'});
  assert.equal(state(await get(f.a,'/state')).available,2);
  await post(f.c,'/deliver',{txId:'blocked'});assert.equal(state(await get(f.a,'/state')).available,4);
  await post(f.c,'/deliver',{txId:'blocked'});
  assert.equal(state(await get(f.b,'/state')).available,3);
  assert.deepEqual(await post(f.a,'/prepare',{txId:'blocked',amount:2}),{txId:'blocked',amount:2,vote:'no'});
  assert.deepEqual(await post(f.a,'/prepare',{txId:'fresh',amount:4}),{txId:'fresh',amount:4,vote:'yes'});
  await post(f.b,'/decide',{txId:'separate',amount:1,decision:'abort'});
 }finally{await f.close();}
});

test('integration: lost commit reply leaves false ack and retry consumes once after restart',async()=>{
 const f=await cluster(true);
 try{
  await commit(f.c,'lost',3);await mode(f.a,'drop_once');
  await post(f.c,'/deliver',{txId:'lost'},502);
  assert.equal(state(await get(f.a,'/state')).committed,3);
  const t=record(await get(f.c,'/transactions/lost'));assert.equal(t.phase,'commit');assert.deepEqual(t.acks,{a:false,b:false});
  await f.restartCoordinator();
  assert.deepEqual(record(await post(f.c,'/deliver',{txId:'lost'})).acks,{a:true,b:false});
  assert.equal(state(await get(f.a,'/state')).committed,3);
  await post(f.c,'/deliver',{txId:'lost'});const before=await calls(f.a);
  await post(f.c,'/deliver',{txId:'lost'});assert.equal(await calls(f.a),before);
 }finally{await f.close();}
});

test('integration: uncertain prepare aborts durably and tombstone fences a late vote',async()=>{
 const f=await cluster(true);
 try{
  await begin(f.c,'uncertain',2);await mode(f.a,'drop_once');await post(f.c,'/step',{txId:'uncertain'},502);
  const abort=record(await get(f.c,'/transactions/uncertain'));assert.equal(abort.phase,'abort');assert.deepEqual(abort.votes,{a:null,b:null});
  assert.equal(state(await get(f.a,'/state')).available,2);
  await f.restartCoordinator();await post(f.c,'/deliver',{txId:'uncertain'});await post(f.c,'/deliver',{txId:'uncertain'});
  assert.deepEqual(await post(f.b,'/prepare',{txId:'uncertain',amount:2}),{txId:'uncertain',amount:2,vote:'no'});
  assert.equal(state(await get(f.a,'/state')).available,4);
 }finally{await f.close();}
});

test('integration: prepare wire faults all choose abort, redirects carry no payload, absolute body deadline',async()=>{
 // Each DB retains at most eight IDs. Reuse the same fixture processes for eight
 // variants, then acquire a fresh isolated group; never recycle rows/tombstones.
 const variants=['null','array','primitive','extra','wrong_id','wrong_amount','wrong_vote','malformed','oversize','redirect','delayed_body','error404','error409','error422','error429','unexpected_code'];
 for(let offset=0;offset<variants.length;offset+=8){
  const f=await cluster(true,true);
  try{
   for(const [i,variant] of variants.slice(offset,offset+8).entries()){
    const id=`fault${i}`;await begin(f.c,id,2);await mode(f.a,variant);
    assert.ok(f.sink);const sinkCalls=await calls(f.sink),before=await calls(f.a);
    const start=performance.now();await post(f.c,'/step',{txId:id},502);
    // Read the reachable redirect destination BEFORE changing any fixture mode.
    assert.equal(await calls(f.sink),sinkCalls,`redirect leak in ${variant}`);
    if(variant==='delayed_body')assert.ok(performance.now()-start<1200,'full body must have an absolute 500ms deadline');
    const t=record(await get(f.c,`/transactions/${id}`));assert.equal(t.phase,'abort');assert.deepEqual(t.votes,{a:null,b:null});assert.deepEqual(t.acks,{a:false,b:false});
    await post(f.c,'/step',{txId:id});assert.equal(await calls(f.a),before+1);
   }
  }finally{await f.close();}
 }
});

test('integration: decision wire faults keep durable commit and ack false; escaped receipts succeed',async()=>{
 const f=await cluster(true,true);
 try{
  const id='A_-0123456789xyz'; // maximal 16-character identity, escaped on the wire
  await mode(f.a,'escaped');await mode(f.b,'escaped');
  assert.equal((await commit(f.c,id,2)).phase,'commit');
  const variants=['null','array','primitive','extra','wrong_id','wrong_amount','wrong_terminal','malformed','oversize','redirect','delayed_body','error404','error409','error422','error429','unexpected_code'];
  for(const variant of variants){
   await mode(f.a,variant);assert.ok(f.sink);const sinkCalls=await calls(f.sink);
   await post(f.c,'/deliver',{txId:id},502);
   assert.equal(await calls(f.sink),sinkCalls,`redirect leak in ${variant}`);
   const t=record(await get(f.c,`/transactions/${id}`));assert.equal(t.phase,'commit');assert.deepEqual(t.acks,{a:false,b:false});
  }
  await mode(f.a,'escaped');assert.deepEqual(record(await post(f.c,'/deliver',{txId:id})).acks,{a:true,b:false});
  assert.deepEqual(record(await post(f.c,'/deliver',{txId:id})).acks,{a:true,b:true});
  const aCalls=await calls(f.a),bCalls=await calls(f.b);
  await post(f.c,'/deliver',{txId:id});await post(f.c,'/step',{txId:id});
  assert.equal(await calls(f.a),aCalls);assert.equal(await calls(f.b),bCalls);
 }finally{await f.close();}
});

async function untilWaiting(s:RunningService) {
 const deadline=performance.now()+2000;
 while(performance.now()<deadline){
  const v=await get(s,'/teaching/stats');assert.ok(object(v));if(v.waiting===1)return;
  // Polling yields to the independent server; the state is the barrier, not elapsed time.
  await new Promise<void>(r=>setTimeout(r,5));
 }
 assert.fail('Upstream did not reach deterministic hold barrier');
}

test('integration: HTTP exclusion spans pending prepare and decision, lock releases on failure',async()=>{
 const f=await cluster(true,true);
 try{
  await begin(f.c,'busy',1);await mode(f.a,'hold');
  const pending=post(f.c,'/step',{txId:'busy'},502);
  try{
   await untilWaiting(f.a);
   await post(f.c,'/step',{txId:'busy'},409);await post(f.c,'/deliver',{txId:'busy'},409);
   // Leave the fixture held: the total deadline must choose abort.
   await pending;
  }finally{await post(f.a,'/teaching/release',{});await pending;}
  await mode(f.a,'normal');assert.equal(record(await post(f.c,'/step',{txId:'busy'})).phase,'abort');
  await mode(f.a,'hold');const delivery=post(f.c,'/deliver',{txId:'busy'},502);
  try{
   await untilWaiting(f.a);await post(f.c,'/step',{txId:'busy'},409);await post(f.c,'/deliver',{txId:'busy'},409);
   await delivery;
  }finally{await post(f.a,'/teaching/release',{});await delivery;}
  await mode(f.a,'normal');assert.deepEqual(record(await post(f.c,'/deliver',{txId:'busy'})).acks,{a:true,b:false});
 }finally{await f.close();}
});

test('integration: strict public schemas, immutable IDs, retained bounds, controls disabled',async()=>{
 const f=await cluster();
 try{
  for(const bad of [null,[],1,true,'text',{txId:'x',amount:1,extra:true},{txId:[],amount:1},{txId:'x',amount:{toString:null}},{txId:'x',amount:'1'},{txId:'x',amount:0},{txId:'x',amount:5}]){
   await post(f.a,'/prepare',bad,400);await post(f.c,'/transactions',bad,400);
  }
  for(const bad of [null,[],1,{txId:'x',extra:1},{txId:{toString:null}},{txId:'x',amount:1}]){
   await post(f.c,'/step',bad,400);await post(f.c,'/deliver',bad,400);
  }
  for(const bad of [null,[],true,{txId:'x',amount:1,decision:{toString:null}},{txId:'x',amount:1,decision:'commit',extra:true}])await post(f.a,'/decide',bad,400);
  for(const route of ['/transactions/%','/transactions/%E0%A4%A','/transactions/has%20space'])await get(f.c,route,400);
  await get(f.c,'/transactions/missing',404);await post(f.c,'/step',{txId:'missing'},404);await post(f.c,'/deliver',{txId:'missing'},404);
  await post(f.a,'/teaching/mode',{mode:'normal'},404);await post(f.c,'/teaching/mode',{mode:'normal'},404);
  for(let i=0;i<8;i++){
   await post(f.a,'/decide',{txId:`r${i}`,amount:1,decision:'abort'});await begin(f.c,`r${i}`,1);
  }
  await post(f.a,'/prepare',{txId:'ninth',amount:1},429);await post(f.a,'/decide',{txId:'ninth',amount:1,decision:'abort'},429);await post(f.c,'/transactions',{txId:'ninth',amount:1},429);
  await post(f.a,'/prepare',{txId:'r0',amount:2},409);await post(f.c,'/transactions',{txId:'r0',amount:2},409);
  assert.deepEqual(await post(f.a,'/prepare',{txId:'r0',amount:1}),{txId:'r0',amount:1,vote:'no'});
  await post(f.c,'/transactions',{txId:'r0',amount:1});
 }finally{await f.close();}
});

test('integration: control rejects non-coercible primitives and identity/config conflicts fail before readiness',async()=>{
 const f=await playground();
 try{
  const path=join(f.dir,'identity.sqlite');
  let a=await f.start('participant.mts',{PARTICIPANT_ID:'a',DB_PATH:path});
  await post(a,'/prepare',{txId:'keep',amount:2});await a.stop();
  await assert.rejects(()=>f.start('participant.mts',{PARTICIPANT_ID:'b',DB_PATH:path}),/Database identity conflict/);
  a=await f.start('participant.mts',{PARTICIPANT_ID:'a',DB_PATH:path});
  assert.deepEqual(await get(a,'/state'),{participant:'a',committed:0,available:2,transactions:[{txId:'keep',amount:2,phase:'prepared'}]});
  await assert.rejects(()=>f.start('coordinator.mts',{DB_PATH:join(f.dir,'bad.sqlite'),A_ORIGIN:'http://127.0.0.1:80',B_ORIGIN:'http://127.0.0.1'}),/distinct/);
  const fixture=await f.start('test/fixture.mts',{PARTICIPANT_ID:'b',DB_PATH:join(f.dir,'fixture.sqlite'),TEACHING_CONTROLS:'1'});
  for(const bad of [{mode:{toString:null}},{mode:[]},{mode:null},{mode:1},{mode:'normal',extra:true},[]])await post(fixture,'/teaching/mode',bad,400);
 }finally{await f.close();}
});

test('unit: invalid terminal receipts never acknowledge or reverse a persisted decision',async()=>{
 const db=new DatabaseSync(':memory:');
 try{
  const s=new CoordinatorStore(db);s.create('receipt',2);s.vote('receipt','a','yes');s.vote('receipt','b','yes');
  for(const reply of [null,[],true,'committed',{txId:'other',amount:2,phase:'committed'},{txId:'receipt',amount:3,phase:'committed'},{txId:'receipt',amount:2,phase:'aborted'},{txId:'receipt',amount:2,phase:'committed',extra:true},{error:{code:'internal_error',message:'internal_error'}}]){
   const c=new Coordinator(s,fixed,async()=>reply);
   await assert.rejects(()=>c.deliver('receipt'),e=>e instanceof HttpError && e.status===502);
   assert.equal(s.get('receipt').phase,'commit');assert.deepEqual(s.get('receipt').acks,{a:false,b:false});
  }
  // An explicit abort also requires an aborted receipt, never merely any terminal phase.
  s.create('cancel',1);s.abort('cancel');
  const bad=new Coordinator(s,fixed,async()=>({txId:'cancel',amount:1,phase:'committed'}));
  await assert.rejects(()=>bad.deliver('cancel'));assert.deepEqual(s.get('cancel').acks,{a:false,b:false});
 }finally{db.close();}
});

test('integration: closing private SQLite files preserves prepared promise, decision and ack receipts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'two-phase-unit-'));
 try{
  const path=join(dir,'participant.sqlite');
  const first=new DatabaseSync(path);
  try{new Participant(first,'a').prepare('disk',3);}finally{first.close();}
  const second=new DatabaseSync(path);
  try{
   const p=new Participant(second,'a');assert.equal(p.state().available,1);
   assert.equal(p.prepare('blocked',1).vote,'no');p.decide('disk',3,'commit');
  }finally{second.close();}
  const third=new DatabaseSync(path);
  try{const p=new Participant(third,'a');p.decide('disk',3,'commit');assert.equal(p.state().committed,3);}finally{third.close();}
  const cpath=join(dir,'coordinator.sqlite');const log=new DatabaseSync(cpath);
  try{
   const s=new CoordinatorStore(log,fixed);s.create('disk',3);s.vote('disk','a','yes');s.vote('disk','b','yes');s.ack('disk','a');
  }finally{log.close();}
  const recovered=new DatabaseSync(cpath);
  try{
   const s=new CoordinatorStore(recovered,fixed);assert.deepEqual(s.get('disk'),{txId:'disk',amount:3,phase:'commit',votes:{a:'yes',b:'yes'},acks:{a:true,b:false}});
   assert.throws(()=>new CoordinatorStore(recovered,{a:fixed.b,b:fixed.a}));
   s.abort('disk');assert.equal(s.get('disk').phase,'commit');
  }finally{recovered.close();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('unit: a retained no vote does not become yes when another reservation releases',()=>memory(db=>{
 const p=new Participant(db,'b');p.prepare('first',2);
 assert.deepEqual(p.prepare('rejected',1),{txId:'rejected',amount:1,vote:'no'});
 p.decide('first',2,'abort');assert.equal(p.state().available,4);
 assert.deepEqual(new Participant(db,'b').prepare('rejected',1),{txId:'rejected',amount:1,vote:'no'});
}));

import { exchange } from '../engine.mts';
import { escaped } from './fixture.mts';

test('unit: outbound byte bound accepts maximum escaping and 1024 bytes, rejects valid 1025-byte JSON',async(t)=>{
 const tuple={txId:'A_-0123456789xyz',amount:4};
 const receipt={...tuple,vote:'yes'};
 const encoded=escaped(receipt);
 assert.deepEqual(JSON.parse(encoded),receipt); // escaping must preserve the number token
 let wire=encoded;
 t.mock.method(globalThis,'fetch',async(_input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  assert.equal(init?.redirect,'error');
  return new Response(wire,{status:200,headers:{'content-type':'application/json'}});
 });
 assert.deepEqual(await exchange(fixed.a,'/prepare',tuple),receipt);
 wire=' '.repeat(1024-Buffer.byteLength(encoded))+encoded;
 assert.deepEqual(await exchange(fixed.a,'/prepare',tuple),receipt);
 wire+=' ';
 assert.deepEqual(JSON.parse(wire),receipt); // unrelated schema/identity is still valid
 await assert.rejects(()=>exchange(fixed.a,'/prepare',tuple),/body too large/);
});

test('unit: the outbound absolute deadline remains armed after headers until complete body',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 t.mock.method(globalThis,'fetch',async(_input:Parameters<typeof fetch>[0],init?:Parameters<typeof fetch>[1])=>{
  const signal=init?.signal;assert.ok(signal);
  const body=new ReadableStream<Uint8Array>({
   start(controller){signal.addEventListener('abort',()=>controller.error(new Error('deadline')),{once:true});},
  });
  return new Response(body,{status:200,headers:{'content-type':'application/json'}});
 });
 const pending=exchange(fixed.a,'/prepare',{txId:'deadline',amount:1});
 const rejected=assert.rejects(pending,/deadline/);
 // A real event-loop turn ensures headers arrived and reading the body is pending.
 await new Promise<void>(r=>setImmediate(r));
 t.mock.timers.tick(500);
 await rejected;
});
