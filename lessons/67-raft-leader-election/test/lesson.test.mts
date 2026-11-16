import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Replica } from '../core.mts';

test('unit: a durable vote prevents another candidate in the same term after reopen', () => {
  const db = new DatabaseSync(':memory:');
  try {
    let replica = new Replica(db, 'c', 0, 0);
    assert.equal(replica.vote({term:2,candidateId:'a',lastLogIndex:0,lastLogTerm:0}).granted, true);
    replica = new Replica(db, 'c', 0, 0);
    assert.equal(replica.vote({term:2,candidateId:'b',lastLogIndex:0,lastLogTerm:0}).granted, false);
    assert.equal(replica.vote({term:3,candidateId:'b',lastLogIndex:0,lastLogTerm:0}).granted, true);
  } finally { db.close(); }
});

// Removing durable term advancement, the log comparison or the campaign generation
// guard would respectively break the following independent assertions.
import { configurePeers, exact, parseVote, parseHeartbeat, voteReply } from '../protocol.mts';
import type { Peer, VoteReply } from '../protocol.mts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const peers: readonly [Peer, Peer] = [{id:'b',origin:'http://127.0.0.1:41002'},{id:'c',origin:'http://127.0.0.1:41003'}];
function memory(id:'a'|'b'|'c'='a', index=0, term=0) {
  const db = new DatabaseSync(':memory:');
  try { return {db, replica:new Replica(db,id,index,term)}; }
  catch (error) { db.close(); throw error; }
}
function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise = new Promise<T>(done=>{resolve=done;});
  return {promise,resolve};
}
const yes = (id:'b'|'c',term:number):VoteReply=>({id,term,granted:true});

test('unit: stale logs advance term and freshness compares last term before index', () => {
  const {db,replica:r}=memory('c',4,2);
  try {
    assert.deepEqual(r.vote({term:3,candidateId:'a',lastLogIndex:4,lastLogTerm:1}),{id:'c',term:3,granted:false});
    assert.equal(r.state().votedFor,null);
    assert.equal(r.vote({term:3,candidateId:'b',lastLogIndex:1,lastLogTerm:3}).granted,true);
    assert.equal(r.vote({term:3,candidateId:'b',lastLogIndex:1,lastLogTerm:3}).granted,true);
    assert.equal(r.vote({term:2,candidateId:'a',lastLogIndex:4,lastLogTerm:4}).granted,false);
    assert.equal(r.vote({term:4,candidateId:'a',lastLogIndex:3,lastLogTerm:2}).granted,false);
    assert.equal(r.state().term,4);
  } finally { db.close(); }
});

test('unit: same-term heartbeat demotes candidate, retains vote and invalidates pending promotion', async () => {
  const {db,replica:r}=memory();
  try {
    const gate=deferred<unknown>();
    const election=r.campaign({},peers,()=>gate.promise);
    assert.equal(r.state().role,'candidate');
    assert.deepEqual(r.heartbeat({term:1,leaderId:'b'}),{id:'a',term:1,accepted:true});
    assert.equal(r.state().votedFor,'a');
    gate.resolve(yes('b',1));
    assert.equal((await election).role,'follower');
    r.heartbeat({term:2,leaderId:'c'});
    assert.equal(r.heartbeat({term:1,leaderId:'b'}).accepted,false);
    assert.equal(r.state().votedFor,null);
  } finally { db.close(); }
});

test('unit: unique matching peer votes elect; a higher reply displaces a leader durably', async () => {
  const {db,replica:r}=memory();
  try {
    assert.equal((await r.campaign({},peers,async p=>yes(p.id==='b'?'b':'c',1))).role,'leader');
    assert.equal((await r.campaign({},peers,async p=>p.id==='b'?{id:'b',term:5,granted:false}:yes('c',2))).role,'follower');
    assert.deepEqual(r.state(),{id:'a',term:5,votedFor:null,role:'follower',lastLogIndex:0,lastLogTerm:0});
    const reopened=new Replica(db,'a',0,0);
    assert.equal(reopened.state().term,5);
    assert.equal(reopened.state().role,'follower');
  } finally { db.close(); }
});

// Swallowing a local write failure, allowing mutations after it, or processing
// late grants after the failure would respectively break these regressions.
test('unit: failed higher-term persistence rejects campaign and fences mutations until restart', async () => {
  const {db,replica:r}=memory();
  try {
    db.exec(`CREATE TRIGGER reject_term BEFORE UPDATE ON election
      WHEN NEW.current_term=5 BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`);
    await assert.rejects(r.campaign({},peers,async p=>
      p.id==='b'?{id:'b',term:5,granted:false}:yes('c',1)),/injected storage failure/);
    const durable={id:'a',term:1,votedFor:'a',role:'follower',lastLogIndex:0,lastLogTerm:0};
    assert.deepEqual(r.state(),durable);
    // Repairing the storage alone must not revive a replica that forgot term 5.
    db.exec('DROP TRIGGER reject_term');
    let sent=0;
    await assert.rejects(r.campaign({},peers,async p=>{sent++;return yes(p.id==='b'?'b':'c',2);}),/restart required/);
    assert.equal(sent,0);
    for(const term of [1,2,6]) {
      assert.throws(()=>r.vote({term,candidateId:'a',lastLogIndex:0,lastLogTerm:0}),/restart required/);
      assert.throws(()=>r.heartbeat({term,leaderId:'b'}),/restart required/);
      assert.deepEqual(r.state(),durable);
    }
    const restarted=new Replica(db,'a',0,0);
    assert.deepEqual(restarted.state(),durable);
    assert.equal(restarted.vote({term:5,candidateId:'b',lastLogIndex:0,lastLogTerm:0}).granted,true);
  } finally {db.close();}
});

test('unit: late parallel grants cannot promote after another campaign fails to persist a higher term', async () => {
  const {db,replica:r}=memory();
  const b=deferred<unknown>(),c=deferred<unknown>();
  let older:Promise<unknown>|undefined;
  try {
    db.exec(`CREATE TRIGGER reject_term BEFORE UPDATE ON election
      WHEN NEW.current_term=5 BEGIN SELECT RAISE(ABORT,'injected storage failure'); END`);
    // Both old RPCs are held while a newer campaign discovers term 5.
    older=r.campaign({},peers,p=>p.id==='b'?b.promise:c.promise);
    const outcome=older.then(value=>({value}),(error:unknown)=>({error}));
    await assert.rejects(r.campaign({},peers,async p=>
      p.id==='b'?{id:'b',term:5,granted:false}:yes('c',2)),/injected storage failure/);
    assert.equal(r.state().role,'follower');
    b.resolve(yes('b',1));c.resolve(yes('c',1));
    const result=await outcome;
    assert.ok('error' in result,'The older campaign must also fail closed');
    assert.match(String(result.error),/restart required/);
    assert.deepEqual(r.state(),{id:'a',term:2,votedFor:'a',role:'follower',lastLogIndex:0,lastLogTerm:0});
    assert.equal(new Replica(db,'a',0,0).state().term,2);
  } finally {
    b.resolve(yes('b',1));c.resolve(yes('c',1));
    await older?.catch(()=>{});
    db.close();
  }
});

test('unit: older campaigns cannot overwrite a newer campaign or a higher inbound vote', async () => {
  const {db,replica:r}=memory();
  try {
    const old=deferred<unknown>();
    const first=r.campaign({},peers,p=>p.id==='b'?old.promise:Promise.resolve(yes('c',1)));
    assert.equal((await r.campaign({},peers,async p=>yes(p.id==='b'?'b':'c',2))).role,'leader');
    old.resolve(yes('b',1));
    assert.equal((await first).term,2);
    const later=deferred<unknown>();
    const campaign=r.campaign({},peers,()=>later.promise);
    assert.equal(r.vote({term:6,candidateId:'b',lastLogIndex:0,lastLogTerm:0}).granted,true);
    later.resolve(yes('b',3));
    assert.equal((await campaign).role,'follower');
    assert.equal(r.state().term,6);
  } finally { db.close(); }
});

test('unit: malformed, duplicate, stale, unknown and uncertain vote replies cannot make a majority', async () => {
  for (const reply of [null,[],true,1,'x',{id:'b',term:1,granted:'yes'},{id:'b',term:1,granted:true,extra:0},{id:'a',term:1,granted:true},{id:'b',term:0,granted:true},{id:'b',term:17,granted:false}]) {
    const {db,replica:r}=memory();
    try {
      assert.equal((await r.campaign({},peers,async()=>reply)).role,'candidate');
    } finally { db.close(); }
  }
  const {db,replica:r}=memory();
  try {
    assert.equal((await r.campaign({},peers,async()=>{throw new Error('reply lost');})).role,'candidate');
    assert.equal((await r.campaign({},peers,async()=>yes('b',1))).role,'candidate');
  } finally { db.close(); }
});

test('unit: strict request fields, primitive types, tuple bounds and term cap', async () => {
  const {db,replica:r}=memory();
  const valid={term:1,candidateId:'b',lastLogIndex:0,lastLogTerm:0};
  try {
    for (const value of [null,[],1,true,'x',{}, {...valid,extra:0},{...valid,term:'1'},{...valid,term:0},{...valid,term:17},{...valid,term:1.5},{...valid,candidateId:{toString:null}},{...valid,candidateId:'d'},{...valid,lastLogIndex:1},{...valid,lastLogTerm:1},{...valid,lastLogIndex:5,lastLogTerm:1},{...valid,lastLogIndex:1,lastLogTerm:5}]) {
      assert.throws(()=>r.vote(value),/invalid_body/);
    }
    for (const value of [null,[],0,'x',{}, {term:1,leaderId:'b',extra:0},{term:1,leaderId:{toString:null}},{term:0,leaderId:'b'},{term:17,leaderId:'b'}]) assert.throws(()=>r.heartbeat(value),/invalid_body/);
    for(const value of [null,[],false,1,'x',{term:1}]) await assert.rejects(r.campaign(value,peers),/invalid_body/);
    r.heartbeat({term:16,leaderId:'c'});
    await assert.rejects(r.campaign({},peers),/term_exhausted/);
    assert.equal(r.state().term,16);
    assert.equal(r.state().votedFor,null);
    assert.equal(parseVote(valid).term,1);
    assert.equal(parseHeartbeat({term:1,leaderId:'b'}).leaderId,'b');
    assert.equal(voteReply({id:'b',term:0,granted:false},'b'),true);
    assert.equal(voteReply({id:'b',term:0,granted:true},'b'),false);
  } finally { db.close(); }
});

test('unit: bootstrap identity and log are immutable and restart clears volatile role', async () => {
  const {db,replica:r}=memory('a',2,2);
  try {
    assert.equal(r.state().term,2);
    await r.campaign({},peers,async p=>yes(p.id==='b'?'b':'c',3));
    assert.equal(r.state().role,'leader');
    assert.equal(new Replica(db,'a',2,2).state().role,'follower');
    assert.throws(()=>new Replica(db,'b',2,2),/configuration mismatch/);
    assert.throws(()=>new Replica(db,'a',3,2),/configuration mismatch/);
    assert.throws(()=>new Replica(db,'a',2,1),/configuration mismatch/);
    assert.equal(r.state().votedFor,'a');
  } finally { db.close(); }
  for(const [index,term] of [[0,1],[1,0],[5,1],[1,5],[-1,0]] satisfies [number,number][]) {
    const invalid=new DatabaseSync(':memory:');
    try { assert.throws(()=>new Replica(invalid,'a',index,term),/bootstrap/); }
    finally {invalid.close();}
  }
});

test('unit: only two distinct other ids and normalized fixed loopback origins are accepted', () => {
  assert.deepEqual(configurePeers('a','b','http://127.0.0.1:41002/','c','http://127.0.0.1:41003'),peers);
  for (const args of [
    ['a','http://127.0.0.1:1','c','http://127.0.0.1:2'],
    ['b','http://127.0.0.1:1','b','http://127.0.0.1:2'],
    ['b','http://127.0.0.1:1','c','http://127.0.0.1:1/'],
    ['b','http://127.0.0.1','c','http://127.0.0.1:80/'],
    ['b','https://127.0.0.1:1','c','http://127.0.0.1:2'],
    ['b','http://example.com:1','c','http://127.0.0.1:2'],
    ['b','http://u:p@127.0.0.1:1','c','http://127.0.0.1:2'],
    ['b','http://127.0.0.1:1/path','c','http://127.0.0.1:2'],
    ['b','http://127.0.0.1:1/?q=1','c','http://127.0.0.1:2'],
    ['b','http://127.0.0.1:1/#f','c','http://127.0.0.1:2'],
    ['b',{toString:null},'c','http://127.0.0.1:2']
  ]) assert.throws(()=>configurePeers('a',args[0],args[1],args[2],args[3]));
});

test('unit: all executable modules import silently with invalid service configuration', async () => {
  const source = ['../node.mts','./fixture.mts'].map(p=>`await import(${JSON.stringify(new URL(p,import.meta.url).href)});`).join('\n');
  const result=await promisify(execFile)(process.execPath,['--input-type=module','--eval',source],{
    env:{PATH:process.env.PATH??'',REPLICA_ID:'invalid',PORT:'broken',DB_PATH:'/cannot/create/db'},timeout:5000
  });
  assert.equal(result.stdout,'');
  assert.equal(result.stderr,'');
});

import { readPeerJson, sendVote } from '../transport.mts';
import { knownVoteError } from '../protocol.mts';

test('unit: upstream JSON byte limits count the wire, with an otherwise-valid oversized reply', async () => {
  const wire='{"id":"b","term":1,"granted":true}';
  const valid:unknown=JSON.parse(wire);
  assert.equal(voteReply(valid,'b'),true);
  assert.deepEqual(await readPeerJson(new Response(wire),new AbortController().signal),valid);
  // Only decoded JSON string tokens are re-encoded; numbers/true remain valid.
  const escaped=wire.replace(/"(?:[^"\\]|\\.)*"/g,token=>{
    const decoded:unknown=JSON.parse(token);
    assert.equal(typeof decoded,'string');
    if(typeof decoded!=='string')throw new Error('Expected string token');
    return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
  const oversized=' '.repeat(8193)+escaped;
  const decodedOversize:unknown=JSON.parse(oversized);
  assert.equal(voteReply(decodedOversize,'b'),true);
  await assert.rejects(readPeerJson(new Response(oversized),new AbortController().signal),/upstream_body_too_large/);
  await assert.rejects(readPeerJson(new Response('null'),AbortSignal.abort()),/abort/i);
});

test('unit: known upstream error envelopes require the exact code, status and fixed message', () => {
  assert.equal(knownVoteError(400,{error:{code:'invalid_body',message:'invalid_body'}}),true);
  for (const value of [null,[],true,{}, {error:null},{error:[]},{error:{code:'invalid_body',message:'other'}},{error:{code:'internal_error',message:'Unexpected service error'}},{error:{code:'unknown',message:'unknown'}},{error:{code:'invalid_body',message:'invalid_body',extra:0}}]) {
    assert.equal(knownVoteError(400,value),false);
  }
  assert.equal(knownVoteError(409,{error:{code:'invalid_body',message:'invalid_body'}}),false);
  assert.equal(typeof sendVote,'function');
});

import { ReadableStream } from 'node:stream/web';
import type { Id } from '../protocol.mts';

test('unit: abort interrupts an unfinished upstream body and cancels its reader', async () => {
  const controller=new AbortController();
  let cancelled=false;
  const pending=readPeerJson(new Response(new ReadableStream<Uint8Array>({
    start(stream){stream.enqueue(Buffer.from('{'));},
    cancel(){cancelled=true;}
  })),controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending,/abort/i);
  assert.equal(cancelled,true);
});

test('unit: an isolated old leader can coexist with a newer leader until it hears a new term', async () => {
  const databases:DatabaseSync[]=[];
  try {
    const nodes=new Map<Id,Replica>();
    for(const identity of ['a','b','c'] satisfies Id[]) {
      const db=new DatabaseSync(':memory:');databases.push(db);
      nodes.set(identity,new Replica(db,identity,0,0));
    }
    const a=nodes.get('a'), c=nodes.get('c');
    assert.ok(a && c);
    const send=async(peer:Peer,body:Parameters<Replica['vote']>[0])=>{
      const node=nodes.get(peer.id);assert.ok(node);return node.vote(body);
    };
    assert.equal((await a.campaign({},peers,send)).role,'leader');
    const cPeers=configurePeers('c','a','http://127.0.0.1:41001','b','http://127.0.0.1:41002');
    assert.equal((await c.campaign({},cPeers,async(peer,body)=>{
      if(peer.id==='a')throw new Error('partition');
      return send(peer,body);
    })).role,'leader');
    assert.equal(a.state().role,'leader');assert.equal(a.state().term,1);
    assert.equal(c.state().term,2);
    a.heartbeat({term:2,leaderId:'c'});
    assert.equal(a.state().role,'follower');
  } finally {for(const db of databases)db.close();}
});

// HTTP tests below are executed by the outer controller, never by test:unit.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

type Lab={dir:string;start:(entry:string,env?:Record<string,string>)=>Promise<RunningService>};
async function laboratory(work:(lab:Lab)=>Promise<void>) {
  const dir=await mkdtemp(join(tmpdir(),'raft-67-'));
  const cleanups:Array<()=>Promise<void>>=[];
  try {
    await work({dir,start:async(entry,env={})=>{
      const service=await startService(new URL(entry,import.meta.url),env);
      cleanups.push(service.stop);
      return service;
    }});
  } finally {
    const errors:unknown[]=[];
    for(const cleanup of cleanups.reverse())try{await cleanup();}catch(error){errors.push(error);}
    try{await rm(dir,{recursive:true,force:true});}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Fixture cleanup failed');
  }
}
async function ephemeralOrigins():Promise<readonly [string,string,string]> {
  const servers:ReturnType<typeof createServer>[]=[];
  const origins:string[]=[];
  try {
    for(let i=0;i<3;i++) {
      const server=createServer();servers.push(server);
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
      const address=server.address();assert.ok(address && typeof address!=='string');
      origins.push(`http://127.0.0.1:${address.port}`);
    }
    const [a,b,c]=origins;assert.ok(a && b && c);return [a,b,c];
  } finally {
    const errors:unknown[]=[];
    for(const server of servers)try {
      if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    } catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Port reservation cleanup failed');
  }
}
function nodeEnv(identity:Id,dir:string,origins:readonly [string,string,string]):Record<string,string> {
  const byId={a:origins[0],b:origins[1],c:origins[2]};
  const others=(['a','b','c'] satisfies Id[]).filter(value=>value!==identity);
  const [one,two]=others;assert.ok(one && two);
  return {REPLICA_ID:identity,DB_PATH:join(dir,identity+'.sqlite'),PORT:new URL(byId[identity]).port,
    PEER_ONE_ID:one,PEER_ONE_ORIGIN:byId[one],PEER_TWO_ID:two,PEER_TWO_ORIGIN:byId[two]};
}
async function get(url:string):Promise<unknown> {
  const response=await fetch(url,{signal:AbortSignal.timeout(3000)});
  assert.equal(response.status,200);const value:unknown=await response.json();return value;
}
async function state(url:string) {
  const value=await get(url+'/state');
  assert.ok(exact(value,['id','term','votedFor','role','lastLogIndex','lastLogTerm']));
  return value;
}
async function post(url:string,body:unknown) {
  const response=await jsonRequest(url,body);
  const value:unknown=await response.json();return {status:response.status,body:value};
}
async function campaign(url:string) {
  const result=await post(url+'/campaign',{});assert.equal(result.status,200);
  assert.ok(exact(result.body,['id','term','votedFor','role','lastLogIndex','lastLogTerm']));return result.body;
}
async function mode(url:string,value:string) {assert.deepEqual(await post(url+'/mode',{mode:value}),{status:200,body:{ok:true}});}
async function untilHeld(url:string) {
  const deadline=performance.now()+3000;
  while(performance.now()<deadline) {
    const value=await get(url+'/stats');
    if(exact(value,['calls','received','waiting','redirectOrigin']) && value.waiting===1)return;
  }
  assert.fail('Peer never entered the held vote request');
}

test('integration: independent three-node election, restart durability, higher-term displacement and stopped majority', async () => {
  await laboratory(async lab=>{
    const origins=await ephemeralOrigins();
    const a=await lab.start('../node.mts',nodeEnv('a',lab.dir,origins));
    const b=await lab.start('../node.mts',nodeEnv('b',lab.dir,origins));
    let c=await lab.start('../node.mts',nodeEnv('c',lab.dir,origins));
    assert.equal((await campaign(a.url)).role,'leader');
    assert.equal((await state(b.url)).votedFor,'a');
    assert.equal((await state(c.url)).votedFor,'a');
    await c.stop();
    c=await lab.start('../node.mts',nodeEnv('c',lab.dir,origins));
    assert.deepEqual(await state(c.url),{id:'c',term:1,votedFor:'a',role:'follower',lastLogIndex:0,lastLogTerm:0});
    assert.deepEqual(await post(c.url+'/vote',{term:1,candidateId:'b',lastLogIndex:0,lastLogTerm:0}),{
      status:200,body:{id:'c',term:1,granted:false}
    });
    const second=await campaign(c.url);
    assert.equal(second.role,'leader');assert.equal(second.term,2);
    assert.equal((await state(a.url)).role,'follower');assert.equal((await state(a.url)).term,2);
    await a.stop();await b.stop();
    const minority=await campaign(c.url);
    assert.equal(minority.role,'candidate');assert.equal(minority.term,3);
    assert.equal(minority.votedFor,'c');
  });
});

test('integration: HTTP request schemas, native readiness and bootstrap mismatch before listening', async () => {
  await laboratory(async lab=>{
    const origins=await ephemeralOrigins();
    const env={...nodeEnv('a',lab.dir,origins),PORT:'0',BOOTSTRAP_LOG_INDEX:'2',BOOTSTRAP_LOG_TERM:'2'};
    const service=await lab.start('../node.mts',env);
    assert.equal((await state(service.url)).term,2);
    for(const route of ['vote','heartbeat','campaign']) {
      for(const value of [null,[],true,1,'bad',{extra:1}])assert.equal((await post(service.url+'/'+route,value)).status,400);
    }
    for(const value of [
      {term:'3',candidateId:'b',lastLogIndex:2,lastLogTerm:2},
      {term:3,candidateId:{toString:null},lastLogIndex:2,lastLogTerm:2},
      {term:3,candidateId:'b',lastLogIndex:2,lastLogTerm:2,origin:'http://127.0.0.1:9'}
    ])assert.equal((await post(service.url+'/vote',value)).status,400);
    assert.equal((await post(service.url+'/heartbeat',{term:3,leaderId:{toString:null}})).status,400);
    const badJson=await fetch(service.url+'/vote',{method:'POST',headers:{'content-type':'application/json'},body:'{',signal:AbortSignal.timeout(3000)});
    assert.equal(badJson.status,400);await badJson.arrayBuffer();
    const media=await fetch(service.url+'/vote',{method:'POST',body:'{}',signal:AbortSignal.timeout(3000)});
    assert.equal(media.status,415);await media.arrayBuffer();
    const tooBig=await fetch(service.url+'/campaign',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(8193)+'{}',signal:AbortSignal.timeout(3000)});
    assert.equal(tooBig.status,413);await tooBig.arrayBuffer();
    const method=await fetch(service.url+'/vote',{signal:AbortSignal.timeout(3000)});
    assert.equal(method.status,405);assert.equal(method.headers.get('allow'),'POST');await method.arrayBuffer();
    const missing=await fetch(service.url+'/missing',{signal:AbortSignal.timeout(3000)});
    assert.equal(missing.status,404);await missing.arrayBuffer();
    // A stale candidate still advances the durable term before denial.
    assert.deepEqual(await post(service.url+'/vote',{term:3,candidateId:'b',lastLogIndex:4,lastLogTerm:1}),{
      status:200,body:{id:'a',term:3,granted:false}
    });
    assert.equal((await state(service.url)).votedFor,null);
    await post(service.url+'/heartbeat',{term:16,leaderId:'b'});
    assert.deepEqual(await post(service.url+'/campaign',{}),{status:409,body:{error:{code:'term_exhausted',message:'term_exhausted'}}});
    await service.stop();
    await assert.rejects(lab.start('../node.mts',{...env,REPLICA_ID:'b',PEER_ONE_ID:'a',PEER_TWO_ID:'c'}),/configuration mismatch/);
    await assert.rejects(lab.start('../node.mts',{...env,BOOTSTRAP_LOG_INDEX:'3'}),/configuration mismatch/);
    const restarted=await lab.start('../node.mts',env);
    assert.deepEqual(await state(restarted.url),{id:'a',term:16,votedFor:null,role:'follower',lastLogIndex:2,lastLogTerm:2});
  });
});

test('integration: bounded upstream schemas, semantic errors, uncertain votes, total body deadline and redirect containment', async () => {
  await laboratory(async lab=>{
    const upstream=await lab.start('./fixture.mts');
    const peer:Peer={id:'b',origin:upstream.url};
    let request={term:1,candidateId:'a',lastLogIndex:0,lastLogTerm:0} satisfies Parameters<typeof sendVote>[1];
    assert.deepEqual(await sendVote(peer,request,AbortSignal.timeout(1000)),{id:'b',term:1,granted:true});
    await mode(upstream.url,'escaped');
    assert.deepEqual(await sendVote(peer,request,AbortSignal.timeout(1000)),{id:'b',term:1,granted:true});
    assert.equal((await post(upstream.url+'/mode',{mode:{toString:null}})).status,400);
    for(const current of ['wrong_id','wrong_term','wrong_boolean','extra','null','array','primitive','malformed','oversize','bad_media',
      'known_error','unexpected_error','error_null','error_array','error_primitive','error_wrong_message','error_extra']) {
      await mode(upstream.url,current);
      await assert.rejects(sendVote(peer,request,AbortSignal.timeout(1000)),error=>error instanceof Error,current);
    }
    request={...request,term:2};
    await mode(upstream.url,'drop');
    await assert.rejects(sendVote(peer,request,AbortSignal.timeout(1000)));
    const uncertain=await state(upstream.url);
    assert.equal(uncertain.term,2);assert.equal(uncertain.votedFor,'a');
    const stats=await get(upstream.url+'/stats');assert.ok(exact(stats,['calls','received','waiting','redirectOrigin']));
    assert.equal(stats.received,0);
    assert.equal(typeof stats.redirectOrigin,'string');
    if(typeof stats.redirectOrigin!=='string')assert.fail('Missing sink origin');
    assert.notEqual(stats.redirectOrigin,upstream.url);
    const target=new URL(stats.redirectOrigin);assert.equal(target.hostname,'127.0.0.1');
    const socket=createConnection({host:'127.0.0.1',port:Number(target.port)});
    try{
      socket.setTimeout(1000,()=>socket.destroy(new Error('Sink connection deadline')));
      await once(socket,'connect');
    }finally{socket.destroy();}
    await mode(upstream.url,'redirect');
    await assert.rejects(sendVote(peer,request,AbortSignal.timeout(1000)));
    // Check immediately, before any mode change could erase accidental forwarding.
    const after=await get(upstream.url+'/stats');assert.ok(exact(after,['calls','received','waiting','redirectOrigin']));
    assert.equal(after.received,0);
    await mode(upstream.url,'slow_body');
    const started=performance.now();
    await assert.rejects(sendVote(peer,request,AbortSignal.timeout(500)));
    assert.ok(performance.now()-started<1000,'A 500 ms total budget must not restart after headers');
    await mode(upstream.url,'deny');
    assert.deepEqual(await sendVote(peer,request,AbortSignal.timeout(1000)),{id:'b',term:2,granted:false});
  });
});

test('integration: an in-flight campaign cannot undo a same-term heartbeat; malformed and lost replies give no majority', async () => {
  await laboratory(async lab=>{
    const upstream=await lab.start('./fixture.mts');
    const service=await lab.start('../node.mts',{
      REPLICA_ID:'a',DB_PATH:join(lab.dir,'a.sqlite'),PEER_ONE_ID:'b',PEER_ONE_ORIGIN:upstream.url,
      PEER_TWO_ID:'c',PEER_TWO_ORIGIN:'http://127.0.0.1:1'
    });
    await mode(upstream.url,'hold');
    const pending=campaign(service.url);
    // Attach a rejection handler immediately while synchronization is in progress.
    const settled=pending.then(value=>({value}),error=>({error}));
    await untilHeld(upstream.url);
    assert.deepEqual(await post(service.url+'/heartbeat',{term:1,leaderId:'c'}),{status:200,body:{id:'a',term:1,accepted:true}});
    assert.deepEqual(await post(upstream.url+'/release',{}),{status:200,body:{ok:true}});
    const result=await settled;
    assert.ok('value' in result);assert.equal(result.value.role,'follower');assert.equal(result.value.votedFor,'a');
    for(const current of ['wrong_id','drop','oversize','unexpected_error','slow_body']) {
      await mode(upstream.url,current);
      assert.equal((await campaign(service.url)).role,'candidate');
    }
    await mode(upstream.url,'normal');
    assert.equal((await campaign(service.url)).role,'leader');
    await mode(upstream.url,'higher');
    const displaced=await campaign(service.url);
    assert.equal(displaced.role,'follower');assert.equal(displaced.term,16);assert.equal(displaced.votedFor,null);
  });
});

test('unit: a delayed higher-term reply from an old campaign demotes a newer leader', async () => {
  const {db,replica:r}=memory();
  try {
    const gate=deferred<unknown>();
    const older=r.campaign({},peers,p=>p.id==='b'?gate.promise:Promise.resolve(yes('c',1)));
    assert.equal((await r.campaign({},peers,async p=>yes(p.id==='b'?'b':'c',2))).role,'leader');
    gate.resolve({id:'b',term:7,granted:false});
    assert.equal((await older).role,'follower');
    assert.deepEqual(new Replica(db,'a',0,0).state(),{
      id:'a',term:7,votedFor:null,role:'follower',lastLogIndex:0,lastLogTerm:0
    });
  } finally {db.close();}
});

import { persistentPath } from '../protocol.mts';
test('unit: service configuration requires a persistent SQLite file, while core units may use memory', () => {
  assert.equal(persistentPath('/private/a.sqlite'),'/private/a.sqlite');
  assert.equal(persistentPath('./a.sqlite'),'./a.sqlite');
  for(const value of ['',':memory:','file:mem?mode=memory',undefined,null,{toString:null}]) {
    assert.throws(()=>persistentPath(value),/DB_PATH must name a persistent file/);
  }
});
