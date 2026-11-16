import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SourceStore, ReplicaStore } from '../store.mts';
import { HttpError } from '../../../lib/http.mts';

function memory(work:(db:DatabaseSync)=>void) {
 const db=new DatabaseSync(':memory:');
 try { work(db); } finally { db.close(); }
}
function errorCode(work:()=>unknown,code:string) {
 assert.throws(work,(e:unknown)=>e instanceof HttpError&&e.code===code);
}

// Advancing directly to through, accepting a bad last record, or replaying an old
// batch without checking its after cursor would break these assertions.
test('unit: snapshot at two hands off to retained changes without gaps or partial invalid batches', () => {
 const sourceDb=new DatabaseSync(':memory:');
 try {
  const replicaDb=new DatabaseSync(':memory:');
  try {
   const source=new SourceStore(sourceDb);
   const replica=new ReplicaStore(replicaDb,'http://127.0.0.1:31001');
   source.put('k0','old'); source.put('k1','erase');
   const boundary=source.snapshot();
   assert.deepEqual(boundary,{through:2,items:[{key:'k0',value:'old'},{key:'k1',value:'erase'}]});
   source.put('k0','new'); source.remove('k1'); source.put('k2','born');
   replica.bootstrap(boundary);
   const first=source.changes(2);
   assert.deepEqual(first,{after:2,through:5,changes:[{seq:3,key:'k0',value:'new'},{seq:4,key:'k1',value:null},{seq:5,key:'k2',value:'born'}]});
   const expected={checkpoint:5,phase:'ready',items:[{key:'k0',value:'new'},{key:'k2',value:'born'}]};
   assert.deepEqual(replica.apply(first),expected);
   assert.throws(()=>replica.apply(first));
   assert.deepEqual(replica.state(),expected);
   assert.deepEqual(replica.apply(source.changes(5)),expected);
   assert.throws(()=>replica.apply({after:5,through:7,changes:[{seq:6,key:'k0',value:'later'},{seq:7,key:'k2',value:42}]}));
   assert.deepEqual(replica.state(),expected);
  } finally { replicaDb.close(); }
 } finally { sourceDb.close(); }
});

test('unit: trigger failure rolls back the business write and its CDC sequence',()=>memory(db=>{
 const source=new SourceStore(db); source.put('k0','old');
 db.exec("CREATE TEMP TRIGGER injected_failure AFTER INSERT ON changes BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.throws(()=>source.put('k0','lost'),/injected/);
 assert.throws(()=>source.remove('k0'),/injected/);
 assert.throws(()=>source.put('k1','lost'),/injected/);
 assert.deepEqual(source.snapshot(),{through:1,items:[{key:'k0',value:'old'}]});
 assert.deepEqual(source.changes(0).changes,[{seq:1,key:'k0',value:'old'}]);
 db.exec('DROP TRIGGER injected_failure'); source.put('k1','next');
 assert.equal(source.snapshot().through,2);
 assert.throws(()=>db.exec("UPDATE changes SET value='fake' WHERE seq=1"),/immutable/);
 assert.throws(()=>db.exec('DELETE FROM changes WHERE seq=1'),/immutable/);
}));

test('unit: replica transaction failure cannot commit items without checkpoint or phase',()=>memory(db=>{
 const replica=new ReplicaStore(db,'http://127.0.0.1:31001');
 db.exec("CREATE TEMP TRIGGER injected_failure BEFORE UPDATE ON progress BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.throws(()=>replica.bootstrap({through:1,items:[{key:'k0',value:'old'}]}),/injected/);
 assert.deepEqual(replica.state(),{checkpoint:0,phase:'empty',items:[]});
 db.exec('DROP TRIGGER injected_failure');
 replica.bootstrap({through:1,items:[{key:'k0',value:'old'}]});
 db.exec("CREATE TEMP TRIGGER injected_failure BEFORE UPDATE ON progress BEGIN SELECT RAISE(ABORT,'injected'); END;");
 assert.throws(()=>replica.apply({after:1,through:3,changes:[{seq:2,key:'k0',value:null},{seq:3,key:'k1',value:'new'}]}),/injected/);
 assert.deepEqual(replica.state(),{checkpoint:1,phase:'ready',items:[{key:'k0',value:'old'}]});
 db.exec('DROP TRIGGER injected_failure');
 assert.equal(replica.apply({after:1,through:3,changes:[{seq:2,key:'k0',value:null},{seq:3,key:'k1',value:'new'}]}).checkpoint,3);
 // Replayed bootstrap must never erase live progress, even if its input is stale.
 assert.equal(replica.bootstrap({through:0,items:[]}).checkpoint,3);
}));

test('unit: through is highwater, only final applied event advances checkpoint',()=>memory(db=>{
 const source=new SourceStore(db);
 for(let i=0;i<7;i++)source.put(`k${i}`,'value');
 assert.equal(source.changes(0).through,7);
 assert.equal(source.changes(0).changes.length,4);
 memory(other=>{
  const replica=new ReplicaStore(other,'http://127.0.0.1:31001');
  errorCode(()=>replica.apply(source.changes(0)),'not_bootstrapped');
  replica.bootstrap({through:0,items:[]});
  assert.equal(replica.apply(source.changes(0)).checkpoint,4);
  assert.equal(replica.apply(source.changes(4)).checkpoint,7);
  assert.equal(replica.state().items.length,7);
 });
 errorCode(()=>source.changes(8),'cursor_ahead');
 for(const bad of [-1,33,1.2,NaN])errorCode(()=>source.changes(bad),'invalid_body');
}));

test('unit: capacity is atomic at 32, no-op updates and missing deletes consume no event',()=>memory(db=>{
 const source=new SourceStore(db);
 for(let i=0;i<32;i++)source.put('k0',i%2===0?'alpha':'beta');
 const before=source.snapshot();
 errorCode(()=>source.put('k0','changed'),'capacity');
 errorCode(()=>source.put('k1','new'),'capacity');
 errorCode(()=>source.remove('k0'),'capacity');
 errorCode(()=>source.remove('k7'),'absent');
 source.put('k0','beta');
 assert.deepEqual(source.snapshot(),before);
 assert.equal(source.changes(28).changes.length,4);
 assert.deepEqual(source.changes(32),{after:32,through:32,changes:[]});
}));

test('unit: entire snapshot and change batch schemas reject primitives, extras and gaps',()=>memory(db=>{
 const replica=new ReplicaStore(db,'http://127.0.0.1:31001');
 const empty={checkpoint:0,phase:'empty',items:[]};
 for(const bad of [null,[],1,true,'snapshot',{}, {through:0,items:[],extra:1},
  {through:'0',items:[]},{through:33,items:[]},{through:0,items:[{key:'k0',value:'a'}]},
  {through:1,items:[{key:'k1',value:'b'},{key:'k0',value:'a'}]},
  {through:2,items:[{key:'k0',value:'a'},{key:'k0',value:'a'}]},
  {through:1,items:[{key:'k0',value:null}]},{through:1,items:[{key:'k0',value:'a',extra:0}]}]) {
  errorCode(()=>replica.bootstrap(bad),'upstream_failure'); assert.deepEqual(replica.state(),empty);
 }
 replica.bootstrap({through:0,items:[]});
 for(const bad of [null,[],true,{}, {after:0,through:0,changes:[],extra:0},
  {after:'0',through:0,changes:[]},{after:1,through:1,changes:[]},
  {after:0,through:1,changes:[]},{after:0,through:0,changes:[{seq:1,key:'k0',value:'a'}]},
  {after:0,through:2,changes:[{seq:2,key:'k0',value:'a'}]},
  {after:0,through:2,changes:[{seq:1,key:'k0',value:'a'},{seq:1,key:'k1',value:'b'}]},
  {after:0,through:1,changes:[{seq:1,key:'k8',value:'a'}]},
  {after:0,through:1,changes:[{seq:1,key:'k0',value:'1'}]},
  {after:0,through:1,changes:[{seq:1,key:'k0',value:'a',extra:0}]},
  {after:0,through:5,changes:Array.from({length:5},(_,i)=>({seq:i+1,key:'k0',value:'a'}))}]) {
  errorCode(()=>replica.apply(bad),'upstream_failure');
  assert.deepEqual(replica.state(),{checkpoint:0,phase:'ready',items:[]});
 }
}));

test('unit: source keys and values reject coercion and enforce bounded ASCII',()=>memory(db=>{
 const source=new SourceStore(db);
 for(const key of ['k8','K0','k00','k-1','',null,[],{toString:null},1]) {
  // Public protocol accepts unknown so validation precedes SQLite parameter binding.
  errorCode(()=>source.put(key,'ok'),'invalid_body');
  errorCode(()=>source.remove(key),'invalid_body');
 }
 for(const value of ['', 'a'.repeat(25),'a1','é','a b',null,[],{},true,1,{toString:null}])errorCode(()=>source.put('k0',value),'invalid_body');
 source.put('k7','a'.repeat(24));
 assert.equal(source.snapshot().items[0]?.value.length,24);
}));

test('unit: stored source identity is normalized, durable and incompatible roles fail closed',()=>memory(db=>{
 const replica=new ReplicaStore(db,'http://127.0.0.1:31001/');
 replica.bootstrap({through:1,items:[{key:'k0',value:'old'}]});
 assert.equal(new ReplicaStore(db,'http://127.0.0.1:31001').state().checkpoint,1);
 assert.throws(()=>new ReplicaStore(db,'http://127.0.0.1:31002'),/identity/);
 assert.throws(()=>new SourceStore(db),/identity/);
}));

import { sourceOrigin, fields, sourceError } from '../protocol.mts';
import { Replica } from '../engine.mts';

test('unit: upstream semantic errors require the exact known code and message',()=>{
 errorCode(()=>sourceError({error:{code:'cursor_ahead',message:'Cursor exceeds source highwater'}},409,'/changes?after=2'),'cursor_ahead');
 for(const body of [null,[],42,true,{}, {error:null},{error:[]},
  {error:{code:'internal_error',message:'Unexpected service error'}},
  {error:{code:'cursor_ahead',message:'wrong'}},
  {error:{code:'cursor_ahead',message:'Cursor exceeds source highwater',extra:0}}]) {
  errorCode(()=>sourceError(body,409,'/changes?after=2'),'upstream_failure');
  errorCode(()=>sourceError(body,404,'/snapshot'),'upstream_failure');
 }
 for(const status of [404,422,429,500])errorCode(()=>sourceError({error:{code:'cursor_ahead',message:'Cursor exceeds source highwater'}},status,'/changes?after=2'),'upstream_failure');
 for(const value of [null,[],1,true,'', {toString:null},{url:'http://127.0.0.1:2'}])errorCode(()=>fields(value,[]),'invalid_body');
 for(const value of [undefined,null,{},'http://127.0.0.1:0','https://127.0.0.1:2','http://localhost:2','http://user@127.0.0.1:2','http://127.0.0.1:2/path','http://127.0.0.1:2/?a=1'])assert.throws(()=>sourceOrigin(value));
 assert.equal(sourceOrigin('http://127.0.0.1:80/'),'http://127.0.0.1');
});

test('unit: single-flight bootstrap, replay without IO and retry after lost response',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const store=new ReplicaStore(db,'http://127.0.0.1:31001');
  let release:(response:Response)=>void=()=>{throw new Error('not started');};let calls=0;
  const replica=new Replica(store,async()=>{calls++;return new Promise<Response>(resolve=>{release=resolve;});});
  const pending=replica.bootstrap();
  await assert.rejects(()=>replica.bootstrap(),(e:unknown)=>e instanceof HttpError&&e.code==='busy');
  await assert.rejects(()=>replica.pump(),(e:unknown)=>e instanceof HttpError&&e.code==='busy');
  release(Response.json({through:1,items:[{key:'k0',value:'old'}]}));
  assert.equal((await pending).checkpoint,1);
  assert.equal((await replica.bootstrap()).checkpoint,1);assert.equal(calls,1);
  let lost=true;const seen:string[]=[];
  const recover=new Replica(store,async(input,init)=>{
   assert.equal(init?.redirect,'error');seen.push(String(input));
   if(lost){lost=false;throw new Error('source committed; reply lost');}
   return Response.json({after:1,through:2,changes:[{seq:2,key:'k0',value:'new'}]});
  });
  await assert.rejects(()=>recover.pump(),(e:unknown)=>e instanceof HttpError&&e.code==='upstream_failure');
  assert.equal(store.state().checkpoint,1);
  assert.equal((await recover.pump()).checkpoint,2);
  assert.deepEqual(seen,['http://127.0.0.1:31001/changes?after=1','http://127.0.0.1:31001/changes?after=1']);
 } finally {db.close();}
});

test('unit: expired logical deadline makes no source call and a later retry can proceed',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const store=new ReplicaStore(db,'http://127.0.0.1:31001');let calls=0;let clock=1000;
  const replica=new Replica(store,async()=>{calls++;return Response.json({through:0,items:[]});},()=>clock);
  await assert.rejects(()=>replica.bootstrap(999),(e:unknown)=>e instanceof HttpError&&e.code==='upstream_timeout');
  assert.equal(calls,0);assert.equal(store.state().phase,'empty');clock=2000;
  assert.equal((await replica.bootstrap(2500)).phase,'ready');assert.equal(calls,1);
 } finally {db.close();}
});

import { spawnSync } from 'node:child_process';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { readBody } from '../runtime.mts';

import { escapedJson } from './wire.mts';

test('unit: upstream byte bound applies to otherwise valid escaped JSON and error bodies',async()=>{
 const db=new DatabaseSync(':memory:');
 try {
  const store=new ReplicaStore(db,'http://127.0.0.1:31001');
  const boundary={through:1,items:[{key:'k0',value:'a'.repeat(24)}]};
  const valid=escapedJson(boundary);assert.deepEqual(JSON.parse(valid),boundary);
  assert.deepEqual(JSON.parse(escapedJson({after:0,through:1,changes:[{seq:1,key:'k0',value:null}]})),{after:0,through:1,changes:[{seq:1,key:'k0',value:null}]});
  const oversized=valid+' '.repeat(8193);assert.deepEqual(JSON.parse(oversized),boundary);
  const cases:[number,string,string][]=[
   [200,oversized,'application/json'],[409,escapedJson({error:{code:'cursor_ahead',message:'Cursor exceeds source highwater'}})+' '.repeat(8193),'application/json'],
   [200,'null','application/json'],[200,'[]','application/json'],[200,'{','application/json'],[200,valid,'text/plain'],
  ];
  for(const [status,wire,type] of cases) {
   const replica=new Replica(store,async()=>new Response(wire,{status,headers:{'content-type':type}}));
   await assert.rejects(()=>replica.bootstrap(),(e:unknown)=>e instanceof HttpError&&e.code==='upstream_failure');
   assert.deepEqual(store.state(),{checkpoint:0,phase:'empty',items:[]});
  }
  const replica=new Replica(store,async()=>new Response(valid,{headers:{'content-type':'application/json'}}));
  assert.equal((await replica.bootstrap()).checkpoint,1);
 } finally {db.close();}
});

test('unit: inbound body size, media type, invalid JSON and deadline are bounded without sockets listening',async()=>{
 for(const [wire,type,status] of [['{}','text/plain',415],['{','application/json',400],[' '.repeat(8193),'application/json',413]] as const) {
  const socket=new Socket();
  try {
   const req=new IncomingMessage(socket);req.headers['content-type']=type;
   const result=readBody(req);req.push(Buffer.from(wire));req.push(null);
   await assert.rejects(()=>result,(e:unknown)=>e instanceof HttpError&&e.status===status);
  } finally {socket.destroy();}
 }
 const socket=new Socket();
 try {
  const req=new IncomingMessage(socket);req.headers['content-type']='application/json';
  await assert.rejects(()=>readBody(req,performance.now()-1),(e:unknown)=>e instanceof HttpError&&e.status===408);
 } finally {socket.destroy();}
});

test('unit: entrypoints import silently under invalid settings; startup rejects identical normalized origins',()=>{
 const imports=['../source.mts','../replica.mts','./fixture.mts'].map(path=>new URL(path,import.meta.url).href);
 const env={PATH:process.env.PATH??'',HOST:'invalid',PORT:'bad',DB_PATH:':memory:',SOURCE_ORIGIN:'not a URL'};
 const result=spawnSync(process.execPath,['--input-type=module','-e',`for(const path of ${JSON.stringify(imports)}) await import(path);`],{env,encoding:'utf8',timeout:3000});
 assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
 const runtime=new URL('../runtime.mts',import.meta.url).href;
 const config=spawnSync(process.execPath,['--input-type=module','-e',`const {settings}=await import(${JSON.stringify(runtime)}); settings('replica');`],{
  env:{PATH:env.PATH,HOST:'127.0.0.1',PORT:'80',DB_PATH:'unused.sqlite',SOURCE_ORIGIN:'http://127.0.0.1/'},encoding:'utf8',timeout:3000,
 });
 assert.notEqual(config.status,0);assert.match(config.stderr,/origins must be distinct/);assert.equal(config.stdout,'');
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

type Start=(entry:'source'|'replica'|'fixture',env?:Record<string,string>)=>Promise<RunningService>;
async function scenario(work:(directory:string,start:Start)=>Promise<void>) {
 const cleanup:(()=>Promise<void>)[]=[];let failure:unknown;
 try {
  const directory=await mkdtemp(join(tmpdir(),'cdc-handoff-'));
  cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const start:Start=async(entry,env={})=>{
   const service=await startService(new URL(entry==='fixture'?'./fixture.mts':`../${entry}.mts`,import.meta.url),env);
   cleanup.push(service.stop);return service;
  };
  await work(directory,start);
 }catch(error){failure=error;}
 finally {
  for(const close of cleanup.reverse())try{await close();}catch(error){failure??=error;}
 }
 if(failure!==undefined)throw failure;
}
async function call(origin:string,path:string,status=200,method='GET',body?:unknown):Promise<unknown> {
 const response=await fetch(origin+path,{
  method,signal:AbortSignal.timeout(3000),
  ...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),
 });
 const result:unknown=await response.json();assert.equal(response.status,status,JSON.stringify(result));return result;
}
async function rejection(origin:string,path:string,status:number,code:string,method='POST',body?:unknown) {
 const envelope=fields(await call(origin,path,status,method,body===undefined&&method==='POST'?{}:body),['error']);
 assert.equal(fields(envelope.error,['code','message']).code,code);
}
// Receipt of headers proves the server committed; deliberately discard the body.
// Retrying the explicit command must read its durable cursor, not a stale client receipt.
async function loseReply(url:string,method:string,body:unknown):Promise<number> {
 let req:ReturnType<typeof request>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  return await new Promise<number>((resolve,reject)=>{
   req=request(url,{method,headers:{'content-type':'application/json'}},res=>{
    const status=res.statusCode??0;res.destroy();resolve(status);
   });
   req.once('error',reject);timer=setTimeout(()=>{req?.destroy();reject(new Error('Lost-reply test timed out'));},3000);
   req.end(JSON.stringify(body));
  });
 }finally{clearTimeout(timer);req?.destroy();}
}

test('integration: two private processes hand off at a snapshot boundary, survive lost replies and resume after both restart',async()=>scenario(async(directory,start)=>{
 const sourcePath=join(directory,'source.sqlite'),replicaPath=join(directory,'replica.sqlite');
 let source=await start('source',{DB_PATH:sourcePath});const sourceOrigin=source.url;
 let replica=await start('replica',{DB_PATH:replicaPath,SOURCE_ORIGIN:sourceOrigin});
 assert.deepEqual(await call(replica.url,'/state'),{checkpoint:0,phase:'empty',items:[]});
 await rejection(replica.url,'/pump',409,'not_bootstrapped');
 for(const body of [null,[],1,true,'', {extra:0},{mode:{toString:null}}])await rejection(replica.url,'/bootstrap',400,'invalid_body','POST',body);
 for(const body of [null,[],true,{value:1},{value:null},{value:{toString:null}},{value:'a1'},{value:'good',extra:0}])await rejection(source.url,'/items/k0',400,'invalid_body','PUT',body);
 await rejection(source.url,'/items/k8',400,'invalid_body','PUT',{value:'valid'});
 const oversized=await fetch(source.url+'/items/k0',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({value:'valid'})+' '.repeat(8193),signal:AbortSignal.timeout(3000)});
 assert.equal(oversized.status,413);await oversized.arrayBuffer();
 assert.deepEqual(await call(source.url,'/snapshot'),{through:0,items:[]});
 assert.equal(await loseReply(source.url+'/items/k0','PUT',{value:'old'}),200);
 await call(source.url,'/items/k0',200,'PUT',{value:'old'});
 await call(source.url,'/items/k1',200,'PUT',{value:'erase'});
 assert.deepEqual(await call(replica.url,'/bootstrap',200,'POST',{}),{checkpoint:2,phase:'ready',items:[{key:'k0',value:'old'},{key:'k1',value:'erase'}]});
 // All seven writes occur after the snapshot and before the first pump.
 assert.equal(await loseReply(source.url+'/items/k0','PUT',{value:'new'}),200);
 await call(source.url,'/items/k0',200,'PUT',{value:'new'});
 await call(source.url,'/items/k1',200,'DELETE');
 await call(source.url,'/items/k2',200,'PUT',{value:'born'});
 await call(source.url,'/items/k3',200,'PUT',{value:'third'});
 await call(source.url,'/items/k0',200,'PUT',{value:'latest'});
 await call(source.url,'/items/k4',200,'PUT',{value:'fourth'});
 await call(source.url,'/items/k5',200,'PUT',{value:'fifth'});
 const batch=fields(await call(source.url,'/changes?after=2'),['after','through','changes']);
 assert.equal(batch.through,9);assert.ok(Array.isArray(batch.changes));assert.equal(batch.changes.length,4);
 assert.equal(await loseReply(replica.url+'/pump','POST',{}),200);
 assert.deepEqual(await call(replica.url,'/state'),{checkpoint:6,phase:'ready',items:[{key:'k0',value:'new'},{key:'k2',value:'born'},{key:'k3',value:'third'}]});
 const settled={checkpoint:9,phase:'ready',items:[{key:'k0',value:'latest'},{key:'k2',value:'born'},{key:'k3',value:'third'},{key:'k4',value:'fourth'},{key:'k5',value:'fifth'}]};
 assert.deepEqual(await call(replica.url,'/pump',200,'POST',{}),settled);
 assert.deepEqual(await call(replica.url,'/pump',200,'POST',{}),settled);
 await source.stop();
 assert.deepEqual(await call(replica.url,'/bootstrap',200,'POST',{}),settled);
 await rejection(replica.url,'/pump',502,'upstream_failure');
 assert.deepEqual(await call(replica.url,'/state'),settled);
 await replica.stop();
 await assert.rejects(()=>start('replica',{DB_PATH:replicaPath,SOURCE_ORIGIN:'http://127.0.0.1:1'}),/identity/);
 replica=await start('replica',{DB_PATH:replicaPath,SOURCE_ORIGIN:sourceOrigin+'/'});
 assert.deepEqual(await call(replica.url,'/bootstrap',200,'POST',{}),settled);
 source=await start('source',{DB_PATH:sourcePath,PORT:new URL(sourceOrigin).port});
 assert.deepEqual(await call(source.url,'/snapshot'),{through:9,items:settled.items});
 await call(source.url,'/items/k0',200,'DELETE');
 const deleted={checkpoint:10,phase:'ready',items:settled.items.slice(1)};
 assert.deepEqual(await call(replica.url,'/pump',200,'POST',{}),deleted);
 await rejection(source.url,'/items/k0',404,'absent','DELETE',undefined);
 assert.deepEqual(await call(source.url,'/changes?after=10'),{after:10,through:10,changes:[]});
 const retained=fields(await call(source.url,'/changes?after=0'),['after','through','changes']);
 assert.equal(retained.through,10);assert.ok(Array.isArray(retained.changes));assert.deepEqual(retained.changes[0],{seq:1,key:'k0',value:'old'});
}));

test('integration: stopped-owner fault injection rolls back CDC, capacity and no-op contracts survive restart',async()=>scenario(async(directory,start)=>{
 const path=join(directory,'source.sqlite');let source=await start('source',{DB_PATH:path});
 await call(source.url,'/items/k0',200,'PUT',{value:'old'});
 await rejection(source.url,'/changes?after=2',409,'cursor_ahead','GET',undefined);
 for(const query of ['', '?after=-1','?after=33','?after=01','?after=1.5','?after=true','?after=0&after=1','?after=0&extra=0'])await rejection(source.url,'/changes'+query,400,'invalid_body','GET',undefined);
 await source.stop();
 // Test-only database access happens with the owning process stopped.
 let db=new DatabaseSync(path);
 try{db.exec("CREATE TRIGGER injected_failure AFTER INSERT ON changes BEGIN SELECT RAISE(ABORT,'injected'); END;");}finally{db.close();}
 source=await start('source',{DB_PATH:path});
 await rejection(source.url,'/items/k0',500,'internal_error','PUT',{value:'failed'});
 await rejection(source.url,'/items/k1',500,'internal_error','PUT',{value:'failed'});
 await rejection(source.url,'/items/k0',500,'internal_error','DELETE',undefined);
 assert.deepEqual(await call(source.url,'/snapshot'),{through:1,items:[{key:'k0',value:'old'}]});
 assert.deepEqual(await call(source.url,'/changes?after=0'),{after:0,through:1,changes:[{seq:1,key:'k0',value:'old'}]});
 await source.stop();db=new DatabaseSync(path);
 try{db.exec('DROP TRIGGER injected_failure');}finally{db.close();}
 source=await start('source',{DB_PATH:path});
 for(let i=0;i<31;i++)await call(source.url,'/items/k0',200,'PUT',{value:i%2===0?'alpha':'beta'});
 const full={through:32,items:[{key:'k0',value:'alpha'}]};
 assert.deepEqual(await call(source.url,'/snapshot'),full);
 await call(source.url,'/items/k0',200,'PUT',{value:'alpha'});
 await rejection(source.url,'/items/k0',429,'capacity','PUT',{value:'beta'});
 await rejection(source.url,'/items/k1',429,'capacity','PUT',{value:'new'});
 await rejection(source.url,'/items/k0',429,'capacity','DELETE',undefined);
 await rejection(source.url,'/items/k7',404,'absent','DELETE',undefined);
 assert.deepEqual(await call(source.url,'/snapshot'),full);
 assert.deepEqual(await call(source.url,'/changes?after=32'),{after:32,through:32,changes:[]});
}));

test('integration: one adversarial source proves whole-body deadlines, strict schemas, busy exclusion and redirect containment',async()=>scenario(async(directory,start)=>{
 const fixture=await start('fixture');
 const replica=await start('replica',{DB_PATH:join(directory,'replica.sqlite'),SOURCE_ORIGIN:fixture.url});
 const stats=async()=>fields(await call(fixture.url,'/stats'),['requests','forwarded','sinkOrigin','paths']);
 const mode=async(value:string)=>{await call(fixture.url,'/control',200,'POST',{mode:value});};
 const unchanged={checkpoint:0,phase:'empty',items:[]};
 await rejection(fixture.url,'/control',400,'invalid_body','POST',{mode:{toString:null}});
 await rejection(replica.url,'/pump',409,'not_bootstrapped');assert.equal((await stats()).requests,0);
 const sink=(await stats()).sinkOrigin;assert.equal(typeof sink,'string');
 if(typeof sink!=='string')throw new Error('Invalid sink origin');
 assert.notEqual(sink,fixture.url);assert.notEqual(sink,replica.url);
 assert.deepEqual(await call(sink,'/health'),{ready:true});assert.equal((await stats()).forwarded,0);
 for(const value of ['primitive','array','extra','bad-snapshot','unsorted','duplicate','error-known','error-unexpected','error-primitive','error-array','error-fields','error-message','error-404','error-422','error-429','oversize','oversize-error','malformed','wrong-type','drop']) {
  await mode(value);await rejection(replica.url,'/bootstrap',502,'upstream_failure');
  assert.deepEqual(await call(replica.url,'/state'),unchanged);
 }
 await mode('redirect');await rejection(replica.url,'/bootstrap',502,'upstream_failure');
 // Read the destination counter BEFORE changing fixture mode. No reset exists.
 assert.equal((await stats()).forwarded,0);
 for(const value of ['slow-headers','slow-body','slow-total']) {
  await mode(value);const before=(await stats()).requests;assert.equal(typeof before,'number');
  const began=performance.now();const pending=rejection(replica.url,'/bootstrap',504,'upstream_timeout');
  // Observe early rejection immediately, then await it even when a later assertion fails.
  void pending.catch(()=>{});
  try {
   const deadline=performance.now()+1000;let observed=false;
   while(performance.now()<deadline) {
    const count=(await stats()).requests;
    if(typeof count==='number'&&typeof before==='number'&&count>before){observed=true;break;}
   }
   assert.equal(observed,true,'Synchronize on downstream request, not elapsed sleep');
   await rejection(replica.url,'/bootstrap',503,'busy');await rejection(replica.url,'/pump',503,'busy');
   assert.deepEqual(await call(replica.url,'/state'),unchanged);
  } finally {await pending;}
  assert.ok(performance.now()-began<1000,'One 500ms budget includes response body');
  assert.deepEqual(await call(replica.url,'/state'),unchanged);
 }
 await mode('normal');
 const boot={checkpoint:2,phase:'ready',items:[{key:'k0',value:'old'},{key:'k1',value:'erase'}]};
 assert.deepEqual(await call(replica.url,'/bootstrap',200,'POST',{}),boot);
 const beforeReplay=(await stats()).requests;await mode('error-unexpected');
 assert.deepEqual(await call(replica.url,'/bootstrap',200,'POST',{}),boot);assert.equal((await stats()).requests,beforeReplay);
 for(const value of ['primitive','array','extra','bad-last','gap','wrong-after','empty-lag','too-many','low-through','error-unexpected','error-primitive','error-array','error-fields','error-message','error-404','error-422','error-429','oversize','oversize-error','malformed','wrong-type','drop']) {
  await mode(value);await rejection(replica.url,'/pump',502,'upstream_failure');assert.deepEqual(await call(replica.url,'/state'),boot);
 }
 await mode('error-known');await rejection(replica.url,'/pump',409,'cursor_ahead');assert.deepEqual(await call(replica.url,'/state'),boot);
 await mode('slow-total');await rejection(replica.url,'/pump',504,'upstream_timeout');assert.deepEqual(await call(replica.url,'/state'),boot);
 await mode('redirect');await rejection(replica.url,'/pump',502,'upstream_failure');assert.equal((await stats()).forwarded,0);
 await mode('normal');
 assert.deepEqual(await call(replica.url,'/pump',200,'POST',{}),{checkpoint:6,phase:'ready',items:[{key:'k0',value:'new'},{key:'k2',value:'born'},{key:'k3',value:'third'}]});
 const final={checkpoint:7,phase:'ready',items:[{key:'k0',value:'latest'},{key:'k2',value:'born'},{key:'k3',value:'third'}]};
 assert.deepEqual(await call(replica.url,'/pump',200,'POST',{}),final);assert.deepEqual(await call(replica.url,'/pump',200,'POST',{}),final);
}));
