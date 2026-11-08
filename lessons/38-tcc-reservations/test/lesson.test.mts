import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Participant, Transactions } from '../store.mts';
import { identity } from '../protocol.mts';

test('unit: lossless UTF identity rejects surrogate aliases before SQLite binding',()=>{
 for(const bad of ['\ud800','\ud801','\udc00','ok\ud800bad']) assert.throws(()=>identity(bad));
 const db=new DatabaseSync(':memory:');const t=new Transactions(db);
 try {
  for(const id of ['\u0000'.repeat(64),'😀'.repeat(32),'�']) {
   assert.equal(identity(id),id);
   assert.equal(t.bind(identity(id),1,1).id,id);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get()?.n,3);
 }finally{db.close();}
});

test('unit: held resources conserve balance and terminal replay consumes once', () => {
 const db = new DatabaseSync(':memory:'); const p = new Participant(db, 10);
 try {
 p.apply('try', 'a', 4);
 assert.deepEqual(p.state(), {capacity:10,available:6,held:4,consumed:0});
 p.apply('confirm','a',4); p.apply('confirm','a',4);
 assert.deepEqual(p.state(), {capacity:10,available:6,held:0,consumed:4});
 assert.throws(()=>p.apply('cancel','a',4)); assert.throws(()=>p.apply('try','a',5));
 } finally { db.close(); }
});
test('unit: empty rollback persists tombstone and forbids late Try',()=>{
 const db = new DatabaseSync(':memory:'); const p = new Participant(db,10);
 try { assert.equal(p.apply('cancel','late',3),'cancelled'); assert.throws(()=>p.apply('try','late',3));
 assert.equal(p.state().available,10); for(let i=0;i<15;i++) p.apply('cancel',`x${i}`,1);
 assert.throws(()=>p.apply('try','overflow',1)); } finally {db.close();}
});
test('unit: decisions are durable and cannot switch after commit or abort',()=>{
 const db = new DatabaseSync(':memory:'); const t = new Transactions(db);
 try {t.bind('a',2,3); t.decide('a','commit'); assert.throws(()=>t.decide('a','abort'));
 assert.equal(new Transactions(db).get('a')?.decision,'commit');
 t.bind('b',1,1); t.decide('b','abort'); assert.throws(()=>t.decide('b','commit'));
 assert.throws(()=>t.bind('a',2,4)); } finally {db.close();}
});

import { spawnSync } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: importing both entrypoints ignores invalid runtime settings and stays silent',()=>{
 const script=`await import(${JSON.stringify(new URL('../participant.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('../coordinator.mts',import.meta.url).href)});`;
 const r=spawnSync(process.execPath,['--input-type=module','-e',script],{env:{PATH:process.env.PATH??'',PORT:'invalid',CAPACITY:'invalid',DB_PATH:'/invalid/unwritable/db',RESOURCE:'invalid',INVENTORY_ORIGIN:'invalid',WALLET_ORIGIN:'invalid'},timeout:3000,encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});

// All listeners are children started inside a test. Files live outside the read-only source tree.
async function fixture(walletCapacity=10,controls=true){
 const dir=await mkdtemp(join(tmpdir(),'tcc-'));const services:RunningService[]=[];
 async function start(entry:string,env:Record<string,string>){const s=await startService(new URL(`../${entry}`,import.meta.url),env);services.push(s);return s;}
 const participant=(resource:string,capacity:number)=>start('participant.mts',{RESOURCE:resource,CAPACITY:String(capacity),DB_PATH:join(dir,`${resource}.sqlite`),TEACHING_CONTROLS:controls?'1':'0'});
 try{
 let inventory=await participant('inventory',10),wallet=await participant('wallet',walletCapacity);
 let coordinator=await start('coordinator.mts',{DB_PATH:join(dir,'coordinator.sqlite'),INVENTORY_ORIGIN:inventory.url,WALLET_ORIGIN:wallet.url});
 return {
 get inventory(){return inventory;},get wallet(){return wallet;},get coordinator(){return coordinator;},
 async seedUndecided(){const db=new DatabaseSync(join(dir,'coordinator.sqlite'));try{new Transactions(db).bind('undecided',2,3);}finally{db.close();}},
 async restartCoordinator(){await coordinator.stop();coordinator=await start('coordinator.mts',{DB_PATH:join(dir,'coordinator.sqlite'),INVENTORY_ORIGIN:inventory.url,WALLET_ORIGIN:wallet.url});},
 async restartInventory(){await inventory.stop();inventory=await participant('inventory',10);},
 async close(){for(const s of services.toReversed())await s.stop();await rm(dir,{recursive:true,force:true});}
 };
 }catch(e){for(const s of services.toReversed())await s.stop();await rm(dir,{recursive:true,force:true});throw e;}
}
async function state(s:RunningService){const r=await fetch(`${s.url}/state`,{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);return await r.json() as Record<string,unknown>;}
async function post(s:RunningService,path:string,body:unknown,status=200){const r=await jsonRequest(s.url+path,body);assert.equal(r.status,status);return await r.json() as Record<string,unknown>;}
async function failure(s:RunningService,phase:string,enabled:boolean){await post(s,'/teaching/failure',{phase,enabled});}

test('integration: lossless UTF identity rejects malformed transaction and reservation IDs without effects',async()=>{
 const f=await fixture();try{
  for(const id of ['\ud800','\ud801','\udc00']) {
   await post(f.coordinator,'/transactions',{id,quantity:1,amount:1},400);
   await post(f.inventory,'/try',{id,units:1},400);
  }
  assert.deepEqual(await state(f.inventory),{resource:'inventory',capacity:10,available:10,held:0,consumed:0});
  assert.deepEqual(await state(f.wallet),{resource:'wallet',capacity:10,available:10,held:0,consumed:0});
  const id='😀';
  const result=await post(f.coordinator,'/transactions',{id,quantity:1,amount:1});assert.equal(result.id,id);assert.equal(result.status,'committed');
  const response=await fetch(f.coordinator.url+'/transactions/'+encodeURIComponent(id),{signal:AbortSignal.timeout(2000)});
  assert.equal(response.status,200);assert.equal((await response.json() as Record<string,unknown>).id,id);
  await post(f.coordinator,'/transactions',{id,quantity:1,amount:1});
  assert.equal((await state(f.inventory)).consumed,1);assert.equal((await state(f.wallet)).consumed,1);
 }finally{await f.close();}
});

test('integration: malformed escaped transaction ID returns400 instead of internal error',async()=>{
 const f=await fixture();try{
  for(const escaped of ['%','%E0%A4%A','%ED%A0%80']) {
   const response=await fetch(f.coordinator.url+'/transactions/'+escaped,{signal:AbortSignal.timeout(2000)});
   assert.equal(response.status,400);await response.arrayBuffer();
  }
  assert.equal((await state(f.inventory)).available,10);assert.equal((await state(f.wallet)).available,10);
 }finally{await f.close();}
});

test('integration: success, maximal escaped identity, replay and participant restart never consume twice',async()=>{
 const f=await fixture();try{
 const body={id:'\u0000'.repeat(64),quantity:3,amount:4};
 assert.equal((await post(f.coordinator,'/transactions',body)).status,'committed');
 assert.equal((await post(f.coordinator,'/transactions',body)).status,'committed');
 await post(f.coordinator,'/transactions',{...body,amount:5},409);
 await f.restartInventory();
 await post(f.inventory,'/confirm',{id:body.id,units:3});
 assert.deepEqual(await state(f.inventory),{resource:'inventory',capacity:10,available:7,held:0,consumed:3});
 assert.equal((await state(f.wallet)).consumed,4);
 }finally{await f.close();}
});
test('integration: insufficient second Try releases first hold and retains cancellation of both',async()=>{
 const f=await fixture(1);try{
 assert.equal((await post(f.coordinator,'/transactions',{id:'poor',quantity:3,amount:2})).status,'aborted');
 assert.equal((await state(f.inventory)).available,10);
 await post(f.wallet,'/try',{id:'poor',units:2},409);
 await post(f.inventory,'/try',{id:'poor',units:3},409);
 }finally{await f.close();}
});
test('integration: cancellation before Try, conflicting payload, primitive parsing and disabled controls',async()=>{
 const f=await fixture(10,false);try{
 await post(f.inventory,'/cancel',{id:'late',units:2});
 await post(f.inventory,'/cancel',{id:'late',units:2});
 await post(f.inventory,'/try',{id:'late',units:2},409);
 await post(f.inventory,'/cancel',{id:'late',units:3},409);
 await post(f.inventory,'/try',{id:'bad',units:'2'},400);
 await post(f.inventory,'/teaching/failure',{phase:'try',enabled:true},404);
 await post(f.inventory,'/try',{id:'normal',units:1});
 assert.equal((await state(f.inventory)).held,1);
 }finally{await f.close();}
});
test('integration: partial Confirm survives coordinator restart and only rolls forward',async()=>{
 const f=await fixture();try{
 await failure(f.wallet,'confirm',true);
 const t=await post(f.coordinator,'/transactions',{id:'commit',quantity:3,amount:4},202);
 assert.equal(t.decision,'commit');assert.equal(t.inventory,true);assert.equal(t.wallet,false);
 assert.equal((await state(f.inventory)).consumed,3);assert.equal((await state(f.wallet)).held,4);
 await f.restartCoordinator();
 assert.equal((await post(f.coordinator,'/recover',{id:'commit'},202)).decision,'commit');
 await failure(f.wallet,'confirm',false);
 assert.equal((await post(f.coordinator,'/recover',{id:'commit'})).status,'committed');
 await post(f.coordinator,'/recover',{id:'commit'});
 assert.equal((await state(f.wallet)).consumed,4);assert.equal((await state(f.inventory)).consumed,3);
 }finally{await f.close();}
});
test('integration: uncertain Try cancels both and failed Cancel remains pending across restart',async()=>{
 const f=await fixture();try{
 await failure(f.wallet,'try',true);await failure(f.wallet,'cancel',true);
 assert.equal((await post(f.coordinator,'/transactions',{id:'abort',quantity:2,amount:2},202)).decision,'abort');
 assert.equal((await state(f.inventory)).available,10);
 await f.restartCoordinator();await failure(f.wallet,'cancel',false);await failure(f.wallet,'try',false);
 assert.equal((await post(f.coordinator,'/recover',{id:'abort'})).status,'aborted');
 await post(f.wallet,'/try',{id:'abort',units:2},409);
 }finally{await f.close();}
});
test('integration: retained identities are bounded without evicting tombstones',async()=>{
 const f=await fixture();try{
 for(let i=0;i<16;i++)await post(f.inventory,'/cancel',{id:`r${i}`,units:1});
 await post(f.inventory,'/try',{id:'overflow',units:1},409);
 await post(f.inventory,'/try',{id:'r0',units:1},409);
 assert.equal((await state(f.inventory)).available,10);
 }finally{await f.close();}
});

for(const mode of ['malformed','oversized','redirect','barrier'] as const){
 test(`integration: ${mode} upstream cannot produce an unsafe commit`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tcc-boundary-'));const children:RunningService[]=[];
 try{
 const inventory=await startService(new URL('../participant.mts',import.meta.url),{RESOURCE:'inventory',CAPACITY:'10',DB_PATH:join(dir,'i.sqlite')});children.push(inventory);
 const wallet=await startService(new URL('./upstream.mts',import.meta.url),{MODE:mode,TARGET:inventory.url});children.push(wallet);
 const c=await startService(new URL('../coordinator.mts',import.meta.url),{DB_PATH:join(dir,'c.sqlite'),INVENTORY_ORIGIN:inventory.url,WALLET_ORIGIN:wallet.url});children.push(c);
 const pending=jsonRequest(c.url+'/transactions',{id:'boundary',quantity:2,amount:1});
 if(mode==='barrier'){
 // Arrival at the blocked upstream proves admission is occupied, without elapsed-time inference.
 const r=await fetch(wallet.url+'/arrived',{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);
 await post(c,'/recover',{id:'boundary'},503);
 await post(wallet,'/release',{});
 }
 const response=await pending;assert.equal(response.status,202);const t=await response.json() as Record<string,unknown>;assert.equal(t.decision,'abort');
 const s=await state(inventory);assert.equal(s.available,10);assert.equal(s.consumed,0);
 // A followed redirect would submit wallet units=1 to inventory for id already bound to 2.
 // The target participant must not receive that redirected request; fixture reports attempts via a dedicated sink.
 if(mode==='redirect'){
 const r=await fetch(wallet.url+'/count',{signal:AbortSignal.timeout(2000)});assert.deepEqual(await r.json(),{forwarded:0});
 }
 }finally{for(const c of children.toReversed())await c.stop();await rm(dir,{recursive:true,force:true});}
 });
}

test('integration: coordinator restarts with undecided record and conservatively cancels both',async()=>{
 const f=await fixture();try{
 await f.seedUndecided();
 await post(f.inventory,'/try',{id:'undecided',units:2});
 await f.restartCoordinator();
 assert.equal((await post(f.coordinator,'/recover',{id:'undecided'})).status,'aborted');
 await post(f.wallet,'/try',{id:'undecided',units:3},409);
 assert.equal((await state(f.inventory)).available,10);
 }finally{await f.close();}
});
test('integration: maximal numeric and escaped request fields fit the body budget',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tcc-max-'));let p:RunningService|undefined;
 try{p=await startService(new URL('../participant.mts',import.meta.url),{RESOURCE:'inventory',CAPACITY:'1000000',DB_PATH:join(dir,'p.sqlite')});
 await post(p,'/try',{id:'\u0000'.repeat(64),units:1000000});
 assert.equal((await state(p)).held,1000000);
 }finally{await p?.stop();await rm(dir,{recursive:true,force:true});}
});
