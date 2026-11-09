import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sign } from '../core.mts';
const secret = 'public-demo-key-01234567890123456789';
test('unit: HMAC binds exact bytes and timestamp', () => {
  const raw = Buffer.from('{"id":"a","delta":1}');
  const expected = '5196a7ca36e1f8b69126e19522bbca0c1291d6c5d61372d8728327e90151be6b';
  assert.equal(sign(secret, '1700000000', raw), expected);
  assert.notEqual(sign(secret, '1700000000', Buffer.from('{ "id":"a","delta":1}')), expected);
});
import { verify, ReceiptStore, event, acknowledgment, object } from '../core.mts';
test('unit: strict credentials and inclusive freshness', () => {
 const raw = Buffer.from('{}');
 for (const t of ['940','1060']) assert.equal(verify(secret,t,sign(secret,t,raw),raw,1000),true);
 for (const t of ['939','1061','01000','1e3','-1']) assert.equal(verify(secret,t,sign(secret,t,raw),raw,1000),false);
 for (const s of [undefined, null, [], 123, 'A'.repeat(64), '0'.repeat(63)]) assert.equal(verify(secret,'1000',s,raw,1000),false);
 assert.equal(verify(secret,1000,sign(secret,'1000',raw),raw,1000),false);
 assert.equal(verify(secret,'1000',sign(secret,'1000',raw),Buffer.from('{ }'),1000),false);
});
test('unit: atomic receipts, semantic duplicates, conflict and capacity', () => {
 const store = new ReceiptStore(':memory:');
 try {
  assert.equal(store.apply({id:'a',delta:2}).duplicate,false);
  assert.equal(store.apply({id:'a',delta:2}).duplicate,true);
  assert.throws(()=>store.apply({id:'a',delta:3}));
  assert.deepEqual(store.state(),{total:2,receipts:1});
  for(let i=1;i<16;i++) store.apply({id:`e${i}`,delta:1});
  assert.throws(()=>store.apply({id:'overflow',delta:1}));
  assert.deepEqual(store.state(),{total:17,receipts:16});
 } finally {store.db.close();}
 const rollback = new ReceiptStore(':memory:');
 try {
  rollback.db.exec("CREATE TRIGGER fail_effect BEFORE UPDATE ON counter BEGIN SELECT RAISE(ABORT, 'injected'); END");
  assert.throws(()=>rollback.apply({id:'rollback',delta:1}));
  assert.deepEqual(rollback.state(),{total:0,receipts:0});
 } finally {rollback.db.close();}
});
test('unit: primitives and acknowledgment schema are enforced',()=>{
 for(const v of [null,[],true,{id:1,delta:1},{id:'x',delta:'1'},{id:'x',delta:0}]) assert.throws(()=>event(v));
 assert.deepEqual(event({id:'\\'.repeat(64),delta:-100}),{id:'\\'.repeat(64),delta:-100});
 for(const v of [null,[],{id:'a',duplicate:'false',total:1},{id:'b',duplicate:false,total:1}]) assert.throws(()=>acknowledgment(v,'a'));
});
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
const receiverEntry=new URL('../receiver.mts',import.meta.url);
const publisherEntry=new URL('../publisher.mts',import.meta.url);
async function get(url:string):Promise<unknown> {const r=await fetch(url,{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);return r.json();}
async function signed(url:string,raw:string,t=String(Math.floor(Date.now()/1000)),signature=sign(secret,t,Buffer.from(raw))) {
 return fetch(url+'/webhook',{method:'POST',body:raw,headers:{'x-demo-timestamp':t,'x-demo-signature':signature},signal:AbortSignal.timeout(2000)});
}
test('unit: imports are silent with invalid runtime configuration',()=>{
 const code=`await import(${JSON.stringify(receiverEntry.href)}); await import(${JSON.stringify(publisherEntry.href)});`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH??'',WEBHOOK_SECRET:'bad',DB_PATH:'/nonexistent/never.sqlite',PORT:'invalid',RECEIVER_ORIGIN:'invalid',TEACHING_EPOCH:'invalid'},encoding:'utf8',timeout:3000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});
test('integration: durable delivery, uncertainty recovery, raw authentication and bounded retention',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'signed-webhooks-'));const services:RunningService[]=[];
 try {
  const env={WEBHOOK_SECRET:secret,DB_PATH:join(dir,'receiver.sqlite'),TEACHING_CONTROLS:'1'};
  let r=await startService(receiverEntry,env);services.push(r);
  const p=await startService(publisherEntry,{WEBHOOK_SECRET:secret,DB_PATH:join(dir,'publisher.sqlite'),RECEIVER_ORIGIN:r.url});services.push(p);
  assert.equal((await jsonRequest(p.url+'/events',{id:'a',delta:3})).status,201);
  assert.equal((await jsonRequest(p.url+'/events',{id:'a',delta:4})).status,409);
  const maximalInput='{"id":"'+'\\u007f'.repeat(64)+'","delta":-100}';
  assert.equal((await fetch(p.url+'/events',{method:'POST',body:maximalInput,signal:AbortSignal.timeout(2000)})).status,201);
  assert.equal((await jsonRequest(r.url+'/teaching/failure',{afterCommit:true})).status,200);
  assert.equal((await jsonRequest(p.url+'/deliver',{id:'a'})).status,502);
  assert.deepEqual(await get(r.url+'/state'),{total:3,receipts:1});
  assert.equal((await jsonRequest(p.url+'/deliver',{id:'a'})).status,200);
  assert.deepEqual(await get(r.url+'/state'),{total:3,receipts:1});
  const state=object(await get(p.url+'/events/a'));assert.equal(state.attempts,2);assert.equal(state.delivered,1);
  for(const v of [null,[],true,{afterCommit:'true'}]) assert.equal((await jsonRequest(r.url+'/teaching/failure',v)).status,400);
  for(const v of [null,[],true,{id:2}]) assert.equal((await jsonRequest(p.url+'/deliver',v)).status,400);
  for(const v of [null,[],true,{advance:'1'}]) assert.equal((await jsonRequest(r.url+'/teaching/clock',v)).status,400);
  for(const v of [null,[],true,{id:'invalid',delta:'1'}]) assert.equal((await jsonRequest(p.url+'/events',v)).status,400);
  const clock=object(await (await jsonRequest(r.url+'/teaching/clock',{advance:0})).json());
  assert.equal(typeof clock.now,'number');
  const t=String(clock.now);const raw='{"id":"b","delta":1}';
  for(const offset of [-60,60]) assert.equal((await signed(r.url,'{"id":"a","delta":3}',String(Number(t)+offset))).status,200);
  assert.equal((await fetch(r.url+'/webhook',{method:'POST',body:raw,signal:AbortSignal.timeout(2000)})).status,403);
  assert.equal((await signed(r.url,raw,t,'F'.repeat(64))).status,403);
  assert.equal((await signed(r.url,raw+' ',t,sign(secret,t,Buffer.from(raw)))).status,403);
  assert.equal((await signed(r.url,raw,String(Number(t)-61))).status,403);
  assert.equal((await signed(r.url,raw,String(Number(t)+120))).status,403);
  assert.equal((await signed(r.url,'null')).status,400);
  assert.equal((await signed(r.url,'{')).status,400);
  // Worst-case legal ASCII escaping fits 512 bytes; whitespace alone crosses the byte budget while preserving schema.
  const maximal='{"id":"'+'\\u007f'.repeat(64)+'","delta":-100}';
  assert.equal((await signed(r.url,maximal)).status,503);
  assert.equal((await signed(r.url,raw+' '.repeat(513))).status,413);
  assert.equal((await signed(r.url,'{"id":"a","delta":4}')).status,409);
  await r.stop();r=await startService(receiverEntry,{...env,TEACHING_CONTROLS:'0'});services.push(r);
  assert.deepEqual(await get(r.url+'/state'),{total:-97,receipts:2});
  assert.equal((await jsonRequest(r.url+'/teaching/failure',{afterCommit:true})).status,404);
  assert.equal((await signed(r.url,'{ "delta":3,"id":"a"}')).status,200);
  for(let i=0;i<14;i++) assert.equal((await signed(r.url,JSON.stringify({id:`r${i}`,delta:1}))).status,200);
  assert.equal((await signed(r.url,raw)).status,409);
  assert.deepEqual(await get(r.url+'/state'),{total:-83,receipts:16});
  for(let i=0;i<14;i++) assert.equal((await jsonRequest(p.url+'/events',{id:`p${i}`,delta:1})).status,201);
  assert.equal((await jsonRequest(p.url+'/events',{id:'overflow',delta:1})).status,409);
 } finally {for(const s of services.reverse()) await s.stop();await rm(dir,{recursive:true,force:true});}
});
test('integration: bounded replies, deadline, observable busy state, attempt limit and redirect isolation',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'signed-upstream-'));const services:RunningService[]=[];
 try {
  const target=await startService(new URL('./upstream.mts',import.meta.url));services.push(target);
  const sink=await startService(new URL('./upstream.mts',import.meta.url),{TARGET_ORIGIN:target.url});services.push(sink);
  let p=await startService(publisherEntry,{WEBHOOK_SECRET:secret,DB_PATH:join(dir,'p.sqlite'),RECEIVER_ORIGIN:sink.url,DELIVERY_TIMEOUT_MS:'500'});services.push(p);
  assert.equal((await jsonRequest(p.url+'/events',{id:'a',delta:1})).status,201);
  for(const mode of ['schema','malformed','oversize','redirect']) {
   await jsonRequest(sink.url+'/control',{mode});
   await jsonRequest(target.url+'/control',{mode:'valid'});
   assert.equal((await jsonRequest(p.url+'/deliver',{id:'a'})).status,502);
   assert.equal(object(await get(p.url+'/events/a')).delivered,0);
   assert.deepEqual(await get(sink.url+'/stats'),{calls:1,targets:0,held:false});
   assert.deepEqual(await get(target.url+'/stats'),{calls:0,targets:0,held:false});
  }
  await jsonRequest(sink.url+'/control',{mode:'hold'});
  const pending=jsonRequest(p.url+'/deliver',{id:'a'});
  let observed=false;
  for(let i=0;i<50;i++) {if(object(await get(sink.url+'/stats')).held===true){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(observed,true);
  assert.equal((await jsonRequest(p.url+'/deliver',{id:'a'})).status,409);
  assert.equal((await pending).status,502);
  await jsonRequest(sink.url+'/control',{mode:'release'});
  await jsonRequest(sink.url+'/control',{mode:'valid'});
  for(let i=0;i<3;i++) assert.equal((await jsonRequest(p.url+'/deliver',{id:'a'})).status,200);
  assert.equal((await jsonRequest(p.url+'/deliver',{id:'a'})).status,409);
  assert.equal(object(await get(p.url+'/events/a')).attempts,8);
  await p.stop();
  p=await startService(publisherEntry,{WEBHOOK_SECRET:secret,DB_PATH:join(dir,'p.sqlite'),RECEIVER_ORIGIN:sink.url});services.push(p);
  assert.equal(object(await get(p.url+'/events/a')).attempts,8);
 } finally {for(const s of services.reverse()) await s.stop();await rm(dir,{recursive:true,force:true});}
});
