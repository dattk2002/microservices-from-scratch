import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store.mts';

test('unit: cut records B→A transfer omitted by naive local sum', () => {
  const a = new Store(':memory:', 'a');
  const b = new Store(':memory:', 'b');
  try {
    const transfer = b.transfer(3);
    a.begin('cut1');
    b.receive(a.head()!);
    a.receive(transfer);
    b.ack(1);
    a.receive(b.head()!);
    const sa = a.snapshot()!; const sb = b.snapshot()!;
    assert.equal(sa.localBalance + sb.localBalance, 17);
    assert.deepEqual(sa.inFlight, [{from:'b',seq:1,kind:'transfer',amount:3}]);
    assert.equal(sa.localBalance + sb.localBalance + sa.inFlight.reduce((n,p) => n+p.amount,0),20);
  } finally { a.close(); b.close(); }
});

test('unit: FIFO replay and marker order preserve a completed cut',()=>{
 const a=new Store(':memory:','a'); const b=new Store(':memory:','b');
 try {
  const first=b.transfer(3); a.begin('one');
  assert.throws(()=>a.receive({...first,seq:2}),/sequence_gap/);
  a.receive(first); a.receive(first);
  assert.throws(()=>a.receive({...first,amount:4}),/replay_conflict/);
  b.receive(a.head()!); b.ack(1);
  const marker=b.head()!; assert.equal(marker.kind,'marker');
  b.transfer(2); a.receive(marker);
  const cut=a.snapshot(); a.receive({from:'b',seq:3,kind:'transfer',amount:2});
  assert.deepEqual(a.snapshot(),cut); assert.equal(a.state().balance,15);
  assert.throws(()=>a.begin('two'),/snapshot_conflict/);
  assert.equal(a.begin('one').created,false);
  a.ack(1); a.ack(1); assert.throws(()=>a.ack(3),/ack_conflict/);
  const before=a.state();
  assert.throws(()=>a.receive({from:'b',seq:4,kind:'marker',snapshotId:'other'}),/snapshot_conflict/);
  assert.deepEqual(a.state(),before); assert.deepEqual(a.snapshot(),cut);
 } finally {a.close();b.close();}
});

test('unit: first marker closes empty channel; exhausted marker allocation rolls back receipt',()=>{
 const a=new Store(':memory:','a'); const b=new Store(':memory:','b');
 try {
  a.receive({from:'b',seq:1,kind:'marker',snapshotId:'empty'});
  assert.deepEqual(a.snapshot(),{snapshotId:'empty',localBalance:10,channelOpen:false,inFlight:[]});
  for(let seq=1;seq<=16;seq++) { b.receive({from:'a',seq,kind:'transfer',amount:1}); b.transfer(1); }
  const before=b.state();
  assert.throws(()=>b.begin('full'),/exhausted/); assert.equal(b.snapshot(),null);
  assert.throws(()=>b.transfer(1),/exhausted/); assert.deepEqual(b.state(),before);
  // Reuse an unconsumed incoming slot on a separate saturated sender.
  const c=new Store(':memory:','a');
  try {
   for(let seq=1;seq<=16;seq++) { if(seq>10) c.receive({from:'b',seq:seq-10,kind:'transfer',amount:1}); c.transfer(1); }
   const state=c.state();
   assert.throws(()=>c.receive({from:'b',seq:7,kind:'marker',snapshotId:'full'}),/exhausted/);
   assert.deepEqual(c.state(),state); assert.equal(c.snapshot(),null);
   assert.throws(()=>c.transfer(1),/insufficient/);
  } finally {c.close();}
  assert.deepEqual(b.state(),before);
 } finally {a.close();b.close();}
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { packet, snapshot } from '../protocol.mts';
import { origin } from '../channel.mts';

async function post(url:string,body:unknown,status=200):Promise<unknown> {
 const response=await jsonRequest(url,body); assert.equal(response.status,status,await response.clone().text()); return response.json();
}
async function get(url:string,status=200):Promise<unknown> { const r=await fetch(url,{signal:AbortSignal.timeout(2000)}); assert.equal(r.status,status); return r.json(); }
async function launch(services:RunningService[],entry:string,env:Record<string,string>={}) { const s=await startService(new URL(entry,import.meta.url),env); services.push(s); return s; }
async function cleanup(services:RunningService[]) {
 const results=await Promise.allSettled(services.reverse().map(s=>s.stop()));
 const failures=results.filter(r=>r.status==='rejected');
 if(failures.length) throw new AggregateError(failures,'Service cleanup failed');
}

test('unit: exact primitive schemas reject malformed packets and channel reports',()=>{
 for(const bad of [null,[],1,'a',true,{}, {from:'a',seq:1,kind:'transfer',amount:1,extra:0},{from:'a',seq:'1',kind:'transfer',amount:1},{from:'a',seq:17,kind:'transfer',amount:1},{from:'a',seq:1,kind:'marker',snapshotId:'../x'}]) assert.equal(packet(bad),false);
 for(const bad of [null,[],{snapshotId:'x',localBalance:10,channelOpen:false,inFlight:[{from:'a',seq:1,kind:'transfer',amount:3}]},{snapshotId:'x',localBalance:10,channelOpen:0,inFlight:[]}]) assert.equal(snapshot(bad,'a'),false);
 assert.equal(origin('http://127.0.0.1:1234/'),'http://127.0.0.1:1234');
 for(const bad of ['https://127.0.0.1:1','http://localhost:1','http://127.0.0.1:1/x']) assert.throws(()=>origin(bad));
});

test('unit: durable identity, receipts, outbox and open recording survive reopening',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'snapshot-unit-'));
 try {
  const path=join(dir,'a.db'); let a=new Store(path,'a');
  try {a.begin('durable'); a.receive({from:'b',seq:1,kind:'transfer',amount:3});} finally {a.close();}
  assert.throws(()=>new Store(path,'b'),/identity conflict/);
  a=new Store(path,'a');
  try {
   assert.equal(a.head()?.kind,'marker'); a.receive({from:'b',seq:1,kind:'transfer',amount:3});
   assert.equal(a.state().balance,13); assert.equal(a.snapshot()?.inFlight.length,1);
   a.receive({from:'b',seq:2,kind:'marker',snapshotId:'durable'}); a.ack(1);
  } finally {a.close();}
  a=new Store(path,'a');
  try {assert.equal(a.head(),null); assert.equal(a.snapshot()?.channelOpen,false); assert.equal(a.state().receivedThrough,2);} finally {a.close();}
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('unit: entrypoint imports ignore deliberately invalid runtime environment',async()=>{
 const child=spawn(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../node.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('../channel.mts',import.meta.url).href)});`],{env:{PATH:process.env.PATH??'',REPLICA_ID:'bad',DB_PATH:'/invalid/path',PORT:'bad',A_ORIGIN:'bad',B_ORIGIN:'bad'},stdio:['ignore','pipe','pipe']});
 let timer:ReturnType<typeof setTimeout>|undefined;
 try {
  let stdout='',stderr=''; child.stdout.on('data',(b:Buffer)=>stdout+=b.toString()); child.stderr.on('data',(b:Buffer)=>stderr+=b.toString());
  timer=setTimeout(()=>child.kill('SIGKILL'),2000);
  const [code]=await once(child,'exit'); assert.equal(code,0,stderr); assert.equal(stdout,''); assert.equal(stderr,'');
 } finally {
  clearTimeout(timer);
  if(child.pid && child.exitCode===null && child.signalCode===null) { const exited=once(child,'exit'); child.kill('SIGKILL'); await exited; }
 }
});

test('integration: durable FIFO cut totals 20; replay, restart and later work preserve report',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'snapshot-http-')); const services:RunningService[]=[];
 try {
  let a=await launch(services,'../node.mts',{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')});
  let b=await launch(services,'../node.mts',{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')});
  let c=await launch(services,'../channel.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
  await post(b.url+'/transfer',{amount:3},201); await post(a.url+'/snapshot',{snapshotId:'cut1'},201);
  assert.deepEqual(await get(c.url+'/snapshot'),{complete:false});
  await post(c.url+'/pump',{from:'a'});
  // Receiver commits, sender deliberately retains head: retry must deduplicate both effects.
  await post(a.url+'/messages',{from:'b',seq:1,kind:'transfer',amount:3});
  await c.stop(); await a.stop(); await b.stop();
  await assert.rejects(()=>launch(services,'../node.mts',{REPLICA_ID:'b',DB_PATH:join(dir,'a.db')}),/identity conflict/);
  a=await launch(services,'../node.mts',{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')});
  b=await launch(services,'../node.mts',{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')});
  c=await launch(services,'../channel.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
  await post(c.url+'/pump',{from:'b'}); await post(c.url+'/pump',{from:'b'});
  const report={complete:true,snapshotId:'cut1',balances:{a:10,b:7},inFlight:[{from:'b',seq:1,kind:'transfer',amount:3}],total:20};
  assert.deepEqual(await get(c.url+'/snapshot'),report);
  await post(b.url+'/transfer',{amount:2},201); await post(c.url+'/pump',{from:'b'});
  assert.deepEqual(await get(c.url+'/snapshot'),report);
  await c.stop(); await a.stop(); await b.stop();
  a=await launch(services,'../node.mts',{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')});
  b=await launch(services,'../node.mts',{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')});
  c=await launch(services,'../channel.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
  assert.deepEqual(await get(c.url+'/snapshot'),report);
  assert.deepEqual(await post(c.url+'/pump',{from:'b'}),{delivered:false});
  for(const route of ['/transfer','/ack','/snapshot','/messages']) for(const bad of [null,[],3,true,'x',{}]) await post(a.url+route,bad,400);
  const unchanged=await get(a.url+'/state');
  for(const amount of [0,6,1.5,'1',null,{toString:null}]) await post(a.url+'/transfer',{amount},400);
  for(const seq of [0,17,1.5,'1',null,{toString:null}]) await post(a.url+'/ack',{seq},400);
  for(const snapshotId of ['', 'abcdefghijklmnopq','../x',1,null,{toString:null}]) await post(a.url+'/snapshot',{snapshotId},400);
  assert.deepEqual(await get(a.url+'/state'),unchanged);
  await post(c.url+'/pump',{from:{toString:null}},400);
  await post(a.url+'/snapshot',{snapshotId:'different'},409);
  await post(a.url+'/messages',{from:'b',seq:1,kind:'transfer',amount:4},409);
  await post(a.url+'/messages',{from:'a',seq:1,kind:'transfer',amount:1},400);
 } finally {try {await cleanup(services);} finally {await rm(dir,{recursive:true,force:true});}}
});

import { object } from '../protocol.mts';
async function configure(s:RunningService,route:string,body:unknown,mode='json',status=200,delay=0) { await post(s.url+'/control',{route,mode,body,status,delay}); }
async function count(s:RunningService,route:string):Promise<number> { const v=await get(s.url+'/counts'); assert.ok(object(v)); const n=v[route]??0; assert.equal(typeof n,'number'); if(typeof n!=='number') throw new Error('Invalid counter'); return n; }

test('integration: all pump hops reject invalid upstreams, bound full bodies and contain redirects',async()=>{
 const services:RunningService[]=[];
 try {
  const sink=await launch(services,'./fixture.mts');
  const a=await launch(services,'./fixture.mts',{TEACHING_CONTROLS:'1',SINK_ORIGIN:sink.url});
  const b=await launch(services,'./fixture.mts',{TEACHING_CONTROLS:'1',SINK_ORIGIN:sink.url});
  const c=await launch(services,'../channel.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
  const head={message:{from:'a',seq:1,kind:'transfer',amount:3}};
  const receipt={seq:1};
  await configure(a,'/head',head); await configure(b,'/messages',receipt); await configure(a,'/ack',receipt);
  assert.deepEqual(await post(c.url+'/pump',{from:'a'}),{delivered:true,from:'a',seq:1});
  for(const [service,route,valid] of [[a,'/head',head],[b,'/messages',receipt],[a,'/ack',receipt]] satisfies [RunningService,string,unknown][]) {
   for(const bad of [null,[],false,4,'x',{},{seq:'1'},{seq:2},{error:{code:'internal_error',message:'internal_error'}}]) {
    await configure(service,route,bad); await post(c.url+'/pump',{from:'a'},502);
   }
   for(const mode of ['oversize','slow','drop','redirect']) {
    await configure(service,route,valid,mode);
    const before=await count(sink,'/sink');
    await post(c.url+'/pump',{from:'a'},502);
    // Assert before reconfiguration: no fixture reset can erase redirect evidence.
    assert.equal(await count(sink,'/sink'),before);
   }
   for(const status of [404,409,422,429,500]) { await configure(service,route,{error:{code:'internal_error',message:'internal_error'}},'json',status); await post(c.url+'/pump',{from:'a'},502); }
   await configure(service,route,valid,'escaped'); await post(c.url+'/pump',{from:'a'});
   await configure(service,route,valid);
  }
  await configure(a,'/head',{message:{from:'b',seq:1,kind:'transfer',amount:3}}); await post(c.url+'/pump',{from:'a'},502);
  await configure(a,'/head',{message:{from:'a',seq:16,kind:'marker',snapshotId:'abcdefghijklmnop'}},'escaped');
  await configure(b,'/messages',{seq:16},'escaped'); await configure(a,'/ack',{seq:16},'escaped');
  assert.deepEqual(await post(c.url+'/pump',{from:'a'}),{delivered:true,from:'a',seq:16});
  await configure(b,'/messages',receipt); await configure(a,'/ack',receipt);
  await configure(a,'/head',{message:null},'escaped'); assert.deepEqual(await post(c.url+'/pump',{from:'a'}),{delivered:false});
  await configure(a,'/head',head,'json',200,300); await configure(b,'/messages',receipt,'json',200,300);
  const before=await count(a,'/ack');
  await post(c.url+'/pump',{from:'a'},502); assert.equal(await count(a,'/ack'),before);
  // Busy is observed behind a real head-read barrier, not a scheduling guess.
  await configure(b,'/messages',receipt); const heads=await count(a,'/head');
  const pending=post(c.url+'/pump',{from:'a'});
  try {
   const deadline=Date.now()+1000;
   while(await count(a,'/head')===heads) { if(Date.now()>deadline) throw new Error('Head barrier timeout'); await new Promise<void>(r=>setTimeout(r,5)); }
   await post(c.url+'/pump',{from:'a'},409);
  } finally {await pending;}
  await post(a.url+'/control',{route:'/head',mode:{toString:null},body:head,status:200,delay:0},400);
  await post(sink.url+'/control',{route:'/head',mode:'json',body:head,status:200,delay:0},404);
 } finally {await cleanup(services);}
});

test('integration: report validates both whole snapshots, escaped strings, IDs and full-body deadlines',async()=>{
 const services:RunningService[]=[];
 try {
  const sink=await launch(services,'./fixture.mts');
  const a=await launch(services,'./fixture.mts',{TEACHING_CONTROLS:'1',SINK_ORIGIN:sink.url});
  const b=await launch(services,'./fixture.mts',{TEACHING_CONTROLS:'1',SINK_ORIGIN:sink.url});
  const c=await launch(services,'../channel.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
  const sa={snapshot:{snapshotId:'abcdefghijklmnop',localBalance:10,channelOpen:false,inFlight:[{from:'b',seq:1,kind:'transfer',amount:3}]}};
  const sb={snapshot:{snapshotId:'abcdefghijklmnop',localBalance:7,channelOpen:false,inFlight:[]}};
  await configure(a,'/snapshot',sa,'escaped'); await configure(b,'/snapshot',sb,'escaped');
  assert.deepEqual(await get(c.url+'/snapshot'),{complete:true,snapshotId:'abcdefghijklmnop',balances:{a:10,b:7},inFlight:[{from:'b',seq:1,kind:'transfer',amount:3}],total:20});
  for(const [service,valid] of [[a,sa],[b,sb]] satisfies [RunningService,unknown][]) {
   for(const bad of [null,[],false,1,'x',{}, {snapshot:[]},{snapshot:{snapshotId:'x',localBalance:10,channelOpen:false,inFlight:[{from:service===a?'a':'b',seq:1,kind:'transfer',amount:3}]}},{snapshot:{snapshotId:'x',localBalance:10,channelOpen:false,inFlight:[],extra:0}}]) {
    await configure(service,'/snapshot',bad); await get(c.url+'/snapshot',502);
   }
   for(const mode of ['oversize','slow','redirect']) {
    await configure(service,'/snapshot',valid,mode); const before=await count(sink,'/sink');
    await get(c.url+'/snapshot',502); assert.equal(await count(sink,'/sink'),before);
   }
   await configure(service,'/snapshot',valid,'json',500); await get(c.url+'/snapshot',502);
   await configure(service,'/snapshot',valid);
  }
  const full={snapshot:{snapshotId:'abcdefghijklmnop',localBalance:0,channelOpen:false,inFlight:Array.from({length:15},(_,i)=>({from:'b',seq:i+1,kind:'transfer',amount:1}))}};
  await configure(a,'/snapshot',full,'escaped');
  await configure(b,'/snapshot',{snapshot:{...sb.snapshot,localBalance:5}},'escaped');
  const maximal=await get(c.url+'/snapshot'); assert.ok(object(maximal)); assert.equal(maximal.total,20); assert.ok(Array.isArray(maximal.inFlight)); assert.equal(maximal.inFlight.length,15);
  await configure(a,'/snapshot',{snapshot:null});
  await configure(b,'/snapshot',{snapshot:false}); await get(c.url+'/snapshot',502);
  await configure(b,'/snapshot',sb); assert.deepEqual(await get(c.url+'/snapshot'),{complete:false});
  await configure(a,'/snapshot',sa); await configure(b,'/snapshot',{snapshot:{...sb.snapshot,snapshotId:'other'}}); await get(c.url+'/snapshot',409);
  await configure(b,'/snapshot',{snapshot:{...sb.snapshot,channelOpen:true}}); assert.deepEqual(await get(c.url+'/snapshot'),{complete:false});
  await configure(a,'/snapshot',sa,'json',200,300); await configure(b,'/snapshot',sb,'json',200,300); await get(c.url+'/snapshot',502);
 } finally {await cleanup(services);}
});
