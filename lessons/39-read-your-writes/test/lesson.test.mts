import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, minVersion, fallback } from '../store.mts';

test('unit: malformed lag source never authorizes replica fallback',()=>{
 for(const source of [undefined,'primary',false,[],{}]) {
  const body={error:'lag',commitVersion:0,...(source===undefined?{}:{source})};
  assert.equal(fallback(425,body,1),false);
 }
 assert.equal(fallback(425,{error:'lag',commitVersion:0,source:'replica'},1),true);
 assert.equal(fallback(425,{error:'lag',commitVersion:0,source:'primary'},1,'primary'),true);
});

test('unit: commits advance a durable global version and replace one identity', () => {
 const s = new Store(':memory:');
 try {
 assert.deepEqual(s.write('a','first'), {item:{id:'a',value:'first'},commitVersion:1});
 assert.equal(s.write('a','second').commitVersion,2);
 assert.deepEqual(s.snapshot(),{items:[{id:'a',value:'second'}],commitVersion:2});
 } finally {s.close();}
});
test('unit: snapshot replacement validates before writes and canonical replay ignores order', () => {
 const s = new Store(':memory:');
 try {
 const items=[{id:'a',value:'one'},{id:'b',value:'two'}];
 assert.equal(s.apply({items,commitVersion:2}),'applied');
 assert.equal(s.apply({items:items.toReversed(),commitVersion:2}),'duplicate');
 assert.throws(()=>s.apply({items:[{id:'a',value:'changed'}],commitVersion:2}));
 assert.throws(()=>s.apply({items:[{id:'a',value:'ok'},{id:'b',value:3}],commitVersion:3}));
 assert.throws(()=>s.apply({commitVersion:3}));
 for(const commitVersion of [-1,1.5,'3',null,9007199254740992]) assert.throws(()=>s.apply({items:[],commitVersion}));
 assert.equal(s.apply({items:[],commitVersion:1}),'older');
 assert.deepEqual(s.snapshot(),{items,commitVersion:2});
 } finally {s.close();}
});
test('unit: barriers parse strictly and only explicit lag permits fallback',()=>{
 for(const x of ['-1','1.0','01','1e2','','9007199254740992']) assert.throws(()=>minVersion(x));
 assert.equal(minVersion(null),0); assert.equal(minVersion('12'),12);
 assert.equal(fallback(425,{error:'lag',commitVersion:2,source:'replica'},3),true);
 for(const [status,body] of [[503,{error:'unavailable',commitVersion:2,source:'replica'}],[425,{error:'lag',commitVersion:3,source:'replica'}],[425,{error:['lag'],commitVersion:2,source:'replica'}] ] as const) assert.equal(fallback(status,body,3),false);
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: all entrypoint imports are silent despite invalid runtime configuration',async()=>{
 const script="await import('./lessons/39-read-your-writes/primary.mts'); await import('./lessons/39-read-your-writes/replica.mts'); await import('./lessons/39-read-your-writes/gateway.mts');";
 const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PORT:'invalid',DB_PATH:'/unusable/no.sqlite',PRIMARY_ORIGIN:'invalid',REPLICA_ORIGIN:'invalid'},stdio:['ignore','pipe','pipe']});
 let out='',err='';child.stdout.on('data',(b:Buffer)=>{out+=b.toString();});child.stderr.on('data',(b:Buffer)=>{err+=b.toString();});
 const timer=setTimeout(()=>child.kill('SIGKILL'),4000);try {const [code]=await once(child,'exit');assert.equal(code,0);assert.equal(out,'');assert.equal(err,'');}finally{clearTimeout(timer);}
});
test('unit: maximum identities and escaped values fit snapshot schema; seventeenth write is atomic',()=>{
 const s=new Store(':memory:');try{
 for(let i=0;i<16;i++)s.write(`${i}`.padEnd(64,'a'),'\u0000'.repeat(256));
 assert.equal(s.snapshot().commitVersion,16);
 assert.throws(()=>s.write('extra','value'));assert.equal(s.snapshot().commitVersion,16);
 assert.throws(()=>s.write('a','x'.repeat(257)));assert.throws(()=>s.write('é','x'));
 }finally{s.close();}
});
const get=(url:string)=>fetch(url,{signal:AbortSignal.timeout(3000),redirect:'error'});

test('integration: malformed lag source returns502 without a primary request',async()=>{
 const services:RunningService[]=[];
 const launch=async(entry:string,env:Record<string,string>)=>{const s=await startService(new URL(entry,import.meta.url),env);services.push(s);return s;};
 try {
  const primary=await launch('./upstream.mts',{VARIANT:'primary'});
  for(const variant of ['lag-primary','lag-missing','lag-boolean']) {
   const replica=await launch('./upstream.mts',{VARIANT:variant});
   const gateway=await launch('../gateway.mts',{PRIMARY_ORIGIN:primary.url,REPLICA_ORIGIN:replica.url});
   const response=await get(gateway.url+'/items/a?minVersion=1');
   assert.deepEqual(await(await get(primary.url+'/count')).json(),{count:0},'malformed lag must not reach primary');
   assert.equal(response.status,502);await response.arrayBuffer();
  }
  const replica=await launch('./upstream.mts',{VARIANT:'lag-valid'});
  const gateway=await launch('../gateway.mts',{PRIMARY_ORIGIN:primary.url,REPLICA_ORIGIN:replica.url});
  const response=await get(gateway.url+'/items/a?minVersion=1');assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{item:{id:'a',value:'fresh'},commitVersion:1,source:'primary'});
  assert.deepEqual(await(await get(primary.url+'/count')).json(),{count:1});
 }finally{await Promise.all(services.map(s=>s.stop()));}
});

test('integration: held replica, fallback, latest state, future barrier and restart durability',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ryw-'));const services:RunningService[]=[];
 const launch=async(name:string,env:Record<string,string>)=>{const s=await startService(new URL(`../${name}.mts`,import.meta.url),env);services.push(s);return s;};
 try{
 let replica=await launch('replica',{DB_PATH:join(dir,'r.sqlite')});
 let primary=await launch('primary',{DB_PATH:join(dir,'p.sqlite'),REPLICA_ORIGIN:replica.url,TEACHING_CONTROLS:'1'});
 let gateway=await launch('gateway',{PRIMARY_ORIGIN:primary.url,REPLICA_ORIGIN:replica.url});
 assert.equal((await jsonRequest(primary.url+'/replication/hold',{})).status,200);
 assert.equal((await jsonRequest(gateway.url+'/items/a',{value:'mine'})).status,200);
 assert.equal((await get(gateway.url+'/items/a')).status,404);
 assert.equal((await get(replica.url+'/items/a?minVersion=1')).status,425);
 assert.deepEqual(await (await get(gateway.url+'/items/a?minVersion=1')).json(),{item:{id:'a',value:'mine'},commitVersion:1,source:'primary'});
 await jsonRequest(primary.url+'/items/a',{value:'newer'});
 assert.equal((await jsonRequest(primary.url+'/replicate',{})).status,200);
 assert.deepEqual(await (await get(gateway.url+'/items/a?minVersion=1')).json(),{item:{id:'a',value:'newer'},commitVersion:2,source:'replica'});
 assert.equal((await get(gateway.url+'/items/a?minVersion=3')).status,425);
 await gateway.stop();await primary.stop();await replica.stop();
 replica=await launch('replica',{DB_PATH:join(dir,'r.sqlite')});primary=await launch('primary',{DB_PATH:join(dir,'p.sqlite'),REPLICA_ORIGIN:replica.url});
 gateway=await launch('gateway',{PRIMARY_ORIGIN:primary.url,REPLICA_ORIGIN:replica.url});
 assert.equal((await get(primary.url+'/items/a?minVersion=2')).status,200);
 assert.equal((await get(replica.url+'/items/a?minVersion=2')).status,200);
 await primary.stop();assert.equal((await get(gateway.url+'/items/a?minVersion=3')).status,502);
 await replica.stop();assert.equal((await get(gateway.url+'/items/a')).status,502);
 }finally{await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});

test('integration: maximal JSON accepted; oversized valid snapshots and partial snapshots do zero writes',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ryw-size-'));let replica:RunningService|undefined;
 try{
 replica=await startService(new URL('../replica.mts',import.meta.url),{DB_PATH:join(dir,'r.sqlite')});
 const items=Array.from({length:16},(_,i)=>({id:`${i}`.padEnd(64,'a'),value:'\u0000'.repeat(256)}));
 const payload={items,commitVersion:16};assert.equal((await jsonRequest(replica.url+'/snapshot',payload)).status,200);
 const invalid={items:[{id:'a',value:'valid'},{id:'b',value:7}],commitVersion:17};assert.equal((await jsonRequest(replica.url+'/snapshot',invalid)).status,400);
 const oversized=JSON.stringify({items,commitVersion:17})+' '.repeat(27000);
 const r=await fetch(replica.url+'/snapshot',{method:'POST',headers:{'content-type':'application/json'},body:oversized,signal:AbortSignal.timeout(3000)});assert.equal(r.status,413);
 assert.equal((await get(replica.url+'/items/0'+'a'.repeat(63)+'?minVersion=17')).status,425);
 assert.equal((await jsonRequest(replica.url+'/snapshot',{items:[],commitVersion:15})).status,200);
 assert.equal((await get(replica.url+'/items/0'+'a'.repeat(63)+'?minVersion=16')).status,200);
 }finally{await replica?.stop();await rm(dir,{recursive:true,force:true});}
});

test('integration: fixed origins reject read/write/push redirects, malformed success and hung upstream',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ryw-boundary-'));const services:RunningService[]=[];
 const launch=async(entry:string,env:Record<string,string>)=>{const s=await startService(new URL(entry,import.meta.url),env);services.push(s);return s;};
 try{
 const sink=await launch('./upstream.mts',{VARIANT:'sink'});
 const redirect=await launch('./upstream.mts',{VARIANT:'redirect',TARGET:sink.url+'/stolen'});
 const gateway=await launch('../gateway.mts',{PRIMARY_ORIGIN:redirect.url,REPLICA_ORIGIN:redirect.url});
 assert.equal((await get(gateway.url+'/items/a')).status,502);
 assert.equal((await jsonRequest(gateway.url+'/items/a',{value:'private'})).status,502);
 const primary=await launch('../primary.mts',{DB_PATH:join(dir,'p.sqlite'),REPLICA_ORIGIN:redirect.url,TEACHING_CONTROLS:'1'});
 await jsonRequest(primary.url+'/replication/hold',{});
 assert.equal((await jsonRequest(primary.url+'/items/a',{value:'\u0000'.repeat(256)})).status,200);
 assert.equal((await jsonRequest(primary.url+'/replicate',{})).status,503);
 assert.deepEqual(await(await get(sink.url+'/count')).json(),{count:0});
 const malformed=await launch('./upstream.mts',{VARIANT:'malformed'});
 const badGateway=await launch('../gateway.mts',{PRIMARY_ORIGIN:sink.url,REPLICA_ORIGIN:malformed.url});
 assert.equal((await get(badGateway.url+'/items/a?minVersion=1')).status,502);
 assert.deepEqual(await(await get(sink.url+'/count')).json(),{count:0});
 const hung=await launch('./upstream.mts',{VARIANT:'hang'});
 const deadline=await launch('../gateway.mts',{PRIMARY_ORIGIN:sink.url,REPLICA_ORIGIN:hung.url,DEADLINE_MS:'50'});
 assert.equal((await get(deadline.url+'/items/a')).status,504);
 assert.deepEqual(await(await get(hung.url+'/count')).json(),{count:1});
 assert.deepEqual(await(await get(sink.url+'/count')).json(),{count:0});
 }finally{await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});
