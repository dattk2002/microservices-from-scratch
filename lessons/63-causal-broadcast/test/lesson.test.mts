import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Replica } from '../core.mts';

test('unit: b1 arriving before a1 waits without advancing b and drains after a1', () => {
  const databases: DatabaseSync[] = [];
  try {
    for(let i=0;i<3;i++) databases.push(new DatabaseSync(':memory:'));
    const [ad, bd, cd] = databases;
    assert.ok(ad && bd && cd);
    const a = new Replica(ad, 'a'), b = new Replica(bd, 'b'), c = new Replica(cd, 'c');
    const a1 = a.publish({value:'a1'});
    b.receive(a1);
    const b1 = b.publish({value:'b1'});
    assert.deepEqual(b1, {sender:'b',seq:1,clock:{a:1,b:1,c:0},value:'b1'});
    assert.deepEqual(c.receive(b1), {status:202,body:{status:'buffered'}});
    assert.deepEqual(c.state().clock, {a:0,b:0,c:0});
    c.receive(a1);
    assert.deepEqual(c.state().delivered, [a1,b1]);
    assert.deepEqual(c.state().clock, {a:1,b:1,c:0});
  } finally { for (const db of databases) db.close(); }
});

function memory(node: 'a'|'b'|'c', run: (replica: Replica) => void) {
  const db = new DatabaseSync(':memory:');
  try { run(new Replica(db,node)); } finally { db.close(); }
}
const event = (sender: 'a'|'b'|'c', seq: number, a: number, b: number, c: number, value = 'x') => ({sender,seq,clock:{a,b,c},value});
function rejectsUnchanged(replica: Replica, operation: () => unknown, status: number) {
  const before = replica.state();
  assert.throws(operation, (e: unknown) => e instanceof Error && 'status' in e && e.status === status);
  assert.deepEqual(replica.state(), before);
}

test('unit: concurrent events permit different delivery orders', () => {
  memory('c', c => memory('b', b => {
    const a1=event('a',1,1,0,0), c1=event('c',1,0,0,1);
    c.receive(a1); c.receive(event('b',1,0,1,0));
    b.receive(c1); b.receive(a1);
    assert.deepEqual(c.state().delivered.map(e=>e.sender), ['a','b']);
    assert.deepEqual(b.state().delivered.map(e=>e.sender), ['c','a']);
  }));
});

test('unit: own publication copies delivered dependencies and ignores pending ones', () => memory('c', c => {
  c.receive(event('b',1,1,1,0));
  const c1=c.publish({value:'local'});
  assert.deepEqual(c1, event('c',1,0,0,1,'local'));
  c.receive(event('a',1,1,0,0));
  assert.deepEqual(c.publish({value:'next'}), event('c',2,1,1,2,'next'));
}));

test('unit: per-sender gaps, exact receipts and changed receipts remain immutable', () => memory('c', c => {
  const a2=event('a',2,2,0,0), a1=event('a',1,1,0,0);
  assert.deepEqual(c.receive(a2),{status:202,body:{status:'buffered'}});
  assert.deepEqual(c.receive(a2),{status:200,body:{status:'buffered'}});
  rejectsUnchanged(c,()=>c.receive({...a2,value:'changed'}),409);
  c.receive(a1);
  assert.deepEqual(c.receive(a2),{status:200,body:{status:'delivered'}});
  rejectsUnchanged(c,()=>c.receive({...a1,clock:{a:1,b:1,c:0}}),409);
  rejectsUnchanged(c,()=>c.receive(event('c',1,0,0,1)),409);
  const own=c.publish({value:'own'});
  assert.deepEqual(c.receive(own),{status:200,body:{status:'delivered'}});
}));

test('unit: full pending buffer admits a dependency and drains deterministically', () => memory('c', c => {
  for(let n=2;n<=5;n++) c.receive(event('a',n,n,0,0));
  assert.deepEqual(c.state().clock,{a:0,b:0,c:0});
  rejectsUnchanged(c,()=>c.receive(event('b',1,8,1,0)),429);
  assert.deepEqual(c.receive(event('a',1,1,0,0)),{status:200,body:{status:'delivered'}});
  assert.deepEqual(c.state().delivered.map(e=>e.seq),[1,2,3,4,5]);
  assert.deepEqual(c.state().pending,[]);
}));

test('unit: eligible pending ties drain in sender/sequence order', () => memory('c', c => {
  c.receive(event('b',1,1,1,0)); c.receive(event('a',2,2,0,0));
  c.receive(event('a',1,1,0,0));
  assert.deepEqual(c.state().delivered.map(e=>`${e.sender}${e.seq}`),['a1','a2','b1']);
}));

test('unit: strict schemas and sequence cap reject without mutation', () => memory('a', a => {
  for(const body of [null,[],1,true,'x',{}, {value:1}, {value:''}, {value:'bad space'}, {value:'x',extra:1}, {value:{toString:null}}])
    rejectsUnchanged(a,()=>a.publish(body),400);
  const valid=event('b',1,0,1,0);
  for(const body of [null,[],1,{}, {...valid,extra:0}, {...valid,sender:'z'}, {...valid,seq:0}, {...valid,seq:1.5}, {...valid,clock:{a:0,b:2,c:0}}, {...valid,clock:{a:-1,b:1,c:0}}, {...valid,clock:{a:0,b:1,c:9}}, {...valid,clock:{a:0,b:1,c:0,d:0}}, {...valid,value:17}, {...valid,value:'abcdefghijklmnopq'}])
    rejectsUnchanged(a,()=>a.receive(body),400);
  for(let n=1;n<=8;n++) assert.equal(a.publish({value:'x'}).seq,n);
  rejectsUnchanged(a,()=>a.publish({value:'ninth'}),429);
}));

test('unit: persistent snapshot binds identity and retains pending and receipts', () => {
  const db=new DatabaseSync(':memory:');
  try {
    const a=new Replica(db,'a'); a.receive(event('b',2,0,2,0)); a.publish({value:'saved'});
    assert.deepEqual(new Replica(db,'a').state(),a.state());
    const beforeRefusal=a.state();
    assert.throws(()=>new Replica(db,'b'),/identity/);
    assert.deepEqual(a.state(),beforeRefusal);
    const reopened=new Replica(db,'a');
    assert.deepEqual(reopened.state(),a.state());
    reopened.receive(event('b',1,0,1,0));
    rejectsUnchanged(reopened,()=>reopened.receive(event('b',2,0,2,0,'changed')),409);
    assert.deepEqual(reopened.get('b',2),event('b',2,0,2,0));
    assert.throws(()=>reopened.get('c',1), (e: unknown)=>e instanceof Error && 'status' in e && e.status===404);
  } finally {db.close();}
});

import { origins, relayInput, sourceReply, destinationReply, WIRE_LIMIT } from '../relay.mts';
import { messages } from '../core.mts';

test('unit: relay normalizes fixed origins and validates primitive hop fields', () => {
  assert.deepEqual(origins('http://127.0.0.1:1001/','http://127.0.0.1:1002','http://127.0.0.1:1003'),{a:'http://127.0.0.1:1001',b:'http://127.0.0.1:1002',c:'http://127.0.0.1:1003'});
  assert.throws(()=>origins('http://127.0.0.1:1001','http://127.0.0.1:1001/','http://127.0.0.1:1003'));
  for(const bad of ['https://user:pass@example.com','http://127.0.0.1/path','http://127.0.0.1/?q=x','file:///tmp/x'])
    assert.throws(()=>origins(bad,'http://127.0.0.1:1002','http://127.0.0.1:1003'));
  const input={from:'a',to:'c',sender:'b',seq:1};
  assert.deepEqual(relayInput(input),input);
  for(const body of [null,[],1,{...input,from:'c'}, {...input,seq:'1'}, {...input,to:{toString:null}}, {...input,url:'http://elsewhere'}, {...input,sender:'d'}])
    assert.throws(()=>relayInput(body));
});

test('unit: relay preserves semantic errors only for exact recognized contracts', () => {
  const unknown={error:{code:'unknown_event',message:messages.unknown_event}};
  assert.deepEqual(sourceReply(404,unknown,'a',1),{status:404,body:unknown});
  const a1=event('a',1,1,0,0);
  assert.deepEqual(sourceReply(200,a1,'a',1),a1);
  assert.throws(()=>sourceReply(200,a1,'b',1));
  for(const bad of [null,[],true,{error:'unknown_event'},{error:{code:'internal_error',message:messages.unknown_event}}, {error:{code:'unknown_event',message:'different'}}, {...unknown,extra:0}])
    assert.throws(()=>sourceReply(404,bad,'a',1));
  for(const [status,code] of [[409,'event_conflict'],[429,'buffer_full']] as const) {
    const good={error:{code,message:messages[code]}};
    assert.deepEqual(destinationReply(status,good),{status,body:good});
    for(const bad of [null,[],1,{error:{code:'internal_error',message:messages[code]}},{error:{code,message:'different'}},{...good,extra:true}])
      assert.throws(()=>destinationReply(status,bad));
  }
  assert.deepEqual(destinationReply(200,{status:'buffered'}),{status:200,body:{status:'buffered'}});
  assert.deepEqual(destinationReply(202,{status:'buffered'}),{status:202,body:{status:'buffered'}});
  assert.deepEqual(destinationReply(200,{status:'delivered'}),{status:200,body:{status:'delivered'}});
  for(const [status,body] of [[202,{status:'delivered'}],[200,{status:'delivered',extra:1}],[500,{status:'buffered'}],[200,{status:1}]] as const)
    assert.throws(()=>destinationReply(status,body));
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
const nodeEntry=new URL('../node.mts',import.meta.url);
const relayEntry=new URL('../relay.mts',import.meta.url);
const fixtureEntry=new URL('./upstream.mts',import.meta.url);
async function payload(response:Response):Promise<unknown> {const body:unknown=await response.json();return body;}
async function get(url:string) {return payload(await fetch(url,{signal:AbortSignal.timeout(3000)}));}
async function post(url:string,body:unknown,status:number) {
  const res=await jsonRequest(url,body);assert.equal(res.status,status,JSON.stringify(await (res.status===status?Promise.resolve(null):payload(res))));
  return payload(res);
}
async function stopAll(services:RunningService[]) {
  const stopped=await Promise.allSettled(services.toReversed().map(s=>s.stop()));
  const failures=stopped.filter(result=>result.status==='rejected');
  if(failures.length) throw new AggregateError(failures.map(result=>result.reason),'Cleanup failed');
}
async function start(services:RunningService[],entry:URL,env:Record<string,string>={}) {
  const service=await startService(entry,env);services.push(service);return service;
}

test('unit: entrypoints import silently despite invalid runtime configuration', async()=>{
  const {stdout,stderr}=await promisify(execFile)(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(nodeEntry.href)}); await import(${JSON.stringify(relayEntry.href)}); await import(${JSON.stringify(fixtureEntry.href)});`],{
    env:{PATH:process.env.PATH,REPLICA_ID:'invalid',DB_PATH:'/invalid/no.sqlite',A_ORIGIN:'invalid',PORT:'invalid'},timeout:3000,
  });
  assert.equal(stdout,'');assert.equal(stderr,'');
});

test('integration: three processes deliver causal chain, persist pending and immutable receipts across restart', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'causal-63-'));
  const services:RunningService[]=[];
  try {
    const a=await start(services,nodeEntry,{REPLICA_ID:'a',DB_PATH:join(dir,'a.sqlite')});
    const b=await start(services,nodeEntry,{REPLICA_ID:'b',DB_PATH:join(dir,'b.sqlite')});
    let c=await start(services,nodeEntry,{REPLICA_ID:'c',DB_PATH:join(dir,'c.sqlite')});
    let relay=await start(services,relayEntry,{A_ORIGIN:a.url,B_ORIGIN:b.url,C_ORIGIN:c.url});
    const hop=(from:string,to:string,sender:string,seq:number)=>({from,to,sender,seq});
    const a1=await post(a.url+'/publish',{value:'created'},201);
    assert.deepEqual(a1,event('a',1,1,0,0,'created'));
    await post(relay.url+'/relay',hop('a','b','a',1),200);
    const b1=await post(b.url+'/publish',{value:'observed'},201);
    assert.deepEqual(b1,event('b',1,1,1,0,'observed'));
    assert.deepEqual(await post(relay.url+'/relay',hop('b','c','b',1),202),{status:'buffered'});
    assert.deepEqual(await get(c.url+'/state'),{node:'c',clock:{a:0,b:0,c:0},delivered:[],pending:[b1]});
    assert.equal((await fetch(c.url+'/events/b/1')).status,404);
    await c.stop();await relay.stop();
    c=await start(services,nodeEntry,{REPLICA_ID:'c',DB_PATH:join(dir,'c.sqlite')});
    relay=await start(services,relayEntry,{A_ORIGIN:a.url,B_ORIGIN:b.url,C_ORIGIN:c.url});
    assert.deepEqual(await post(relay.url+'/relay',hop('b','c','b',1),200),{status:'buffered'});
    // b is a transport hop carrying original sender a: no extra identity request.
    assert.deepEqual(await post(relay.url+'/relay',hop('b','c','a',1),200),{status:'delivered'});
    assert.deepEqual(await get(c.url+'/state'),{node:'c',clock:{a:1,b:1,c:0},delivered:[a1,b1],pending:[]});
    assert.deepEqual(await post(relay.url+'/relay',hop('b','c','b',1),200),{status:'delivered'});
    assert.deepEqual(await post(relay.url+'/relay',hop('a','c','c',1),404),{error:{code:'unknown_event',message:messages.unknown_event}});
    await c.stop();await relay.stop();
    await assert.rejects(start(services,nodeEntry,{REPLICA_ID:'a',DB_PATH:join(dir,'c.sqlite')}),/identity/);
    c=await start(services,nodeEntry,{REPLICA_ID:'c',DB_PATH:join(dir,'c.sqlite')});
    const before=await get(c.url+'/state');
    assert.deepEqual(before,{node:'c',clock:{a:1,b:1,c:0},delivered:[a1,b1],pending:[]});
    await post(c.url+'/receive',event('b',1,1,1,0,'tampered'),409);
    assert.deepEqual(await get(c.url+'/state'),before);
    for(const route of ['/control','/stats','/relay','/events/a/0','/events/a/1?url=http://example.com'])
      assert.equal((await fetch(c.url+route)).status,404);
    await post(c.url+'/publish',{value:{toString:null}},400);
    assert.equal((await jsonRequest(c.url+'/control',{mode:'good'})).status,404);
    assert.deepEqual(await post(c.url+'/receive',b1,200),{status:'delivered'});
    const publish=await post(c.url+'/publish',{value:'after'},201);
    assert.deepEqual(publish,event('c',1,1,1,1,'after'));
  } finally {
    try {await stopAll(services);} finally {await rm(dir,{recursive:true,force:true});}
  }
});

test('integration: relay checks every upstream body, escaped budget, redirects and total deadline', async()=>{
  const services:RunningService[]=[];
  try {
    const sink=await start(services,fixtureEntry,{TEACHING_CONTROLS:'1'});
    const source=await start(services,fixtureEntry,{TEACHING_CONTROLS:'1',REDIRECT_ORIGIN:sink.url});
    const target=await start(services,fixtureEntry,{TEACHING_CONTROLS:'1',REDIRECT_ORIGIN:sink.url});
    const relay=await start(services,relayEntry,{A_ORIGIN:source.url,B_ORIGIN:target.url,C_ORIGIN:sink.url});
    const mode=async(s:RunningService,mode:string)=>{await post(s.url+'/control',{mode},200);};
    const input={from:'a',to:'b',sender:'a',seq:1};
    const run=(status:number)=>post(relay.url+'/relay',input,status);
    assert.deepEqual(await run(200),{status:'delivered'});
    await mode(source,'escaped');await mode(target,'escaped');
    assert.deepEqual(await run(200),{status:'delivered'});
    await mode(source,'good');
    for(const [m,status,want] of [['buffered',202,{status:'buffered'}],['replay_buffered',200,{status:'buffered'}],['conflict',409,{error:{code:'event_conflict',message:messages.event_conflict}}],['full',429,{error:{code:'buffer_full',message:messages.buffer_full}}]] as const) {
      await mode(target,m);assert.deepEqual(await run(status),want);
    }
    await mode(target,'good');await mode(source,'unknown');
    assert.deepEqual(await run(404),{error:{code:'unknown_event',message:messages.unknown_event}});
    const invalid=['unexpected_code','unexpected_full_code','wrong_message','error_primitive','error_array','error_extra','primitive','array','extra','invalid','oversize','unexpected_status','wrong_type','transport'];
    for(const s of [source,target]) {
      await mode(source,'good');await mode(target,'good');
      for(const bad of [...invalid,...(s===source?['wrong_tuple','wrong_clock']:[])]) {
        await mode(s,bad);
        const targetBefore=await get(target.url+'/stats');
        if(bad==='oversize') {
          const response=s===source?await fetch(s.url+'/events/a/1'):await jsonRequest(s.url+'/receive',event('a',1,1,0,0,'abcdefghijklmnop'));
          const wire=await response.text();
          assert.ok(Buffer.byteLength(wire)>WIRE_LIMIT);
          const decoded:unknown=JSON.parse(wire);
          assert.deepEqual(decoded,s===source?event('a',1,1,0,0,'abcdefghijklmnop'):{status:'delivered'});
        }
        assert.deepEqual(await run(502),{error:{code:'upstream_failure',message:messages.upstream_failure}},`${s===source?'source':'target'} ${bad}`);
        if(s===source) assert.deepEqual(await get(target.url+'/stats'),targetBefore,'invalid source must not contact target');
      }
      await mode(s,'good');
    }
    // A distinct reachable destination must see neither GET nor POST redirects.
    const baseline=await get(sink.url+'/stats');
    for(const s of [source,target]) {
      await mode(s,'redirect');await run(502);
      assert.deepEqual(await get(sink.url+'/stats'),baseline);
      // Check counter before changing any fixture mode.
      await mode(s,'good');
    }
    for(const s of [source,target]) for(const bad of ['slow_headers','slow_body']) {
      await mode(s,bad);const begin=performance.now();await run(502);
      assert.ok(performance.now()-begin<1200,'deadline must include complete response body');
      await mode(s,'good');
    }
    await mode(source,'slow_pair');await mode(target,'slow_pair');
    const begin=performance.now();await run(502);
    assert.ok(performance.now()-begin<850,'one deadline, not 500ms per hop');
    await mode(source,'good');await mode(target,'good');
    for(const bad of [null,[],true,{...input,from:'b'}, {...input,seq:'1'}, {...input,to:{toString:null}}, {...input,url:sink.url}])
      await post(relay.url+'/relay',bad,400);
    for(const bad of [null,[],{mode:1},{mode:{toString:null}},{mode:'good',extra:1}])
      await post(source.url+'/control',bad,400);
    assert.equal((await fetch(relay.url+'/state')).status,404);
    await assert.rejects(start(services,relayEntry,{A_ORIGIN:source.url+'/',B_ORIGIN:source.url,C_ORIGIN:target.url}),/distinct/);
  } finally {await stopAll(services);}
});


test('integration: fixture teaching controls are absent by default', async()=>{
  const services:RunningService[]=[];
  try {
    const fixture=await start(services,fixtureEntry);
    assert.equal((await jsonRequest(fixture.url+'/control',{mode:'good'})).status,404);
    assert.equal((await fetch(fixture.url+'/stats')).status,404);
  } finally {await stopAll(services);}
});

test('unit: publication can release pending events waiting on this node', ()=>memory('a',a=>{
  a.receive(event('b',1,1,1,0));
  const own=a.publish({value:'release'});
  assert.deepEqual(a.state(),{node:'a',clock:{a:1,b:1,c:0},delivered:[own,event('b',1,1,1,0)],pending:[]});
}));

test('unit: all 24 tuple receipts stay immutable at vector limits',()=>memory('c',c=>{
  for(let n=1;n<=8;n++) {
    c.receive(event('a',n,n,0,0));
    c.receive(event('b',n,0,n,0));
    c.publish({value:'local'});
  }
  assert.deepEqual(c.state().clock,{a:8,b:8,c:8});
  assert.equal(c.state().delivered.length,24);
  assert.deepEqual(c.receive(event('a',1,1,0,0)),{status:200,body:{status:'delivered'}});
  rejectsUnchanged(c,()=>c.receive(event('b',1,0,1,0,'changed')),409);
}));

test('unit: object mutation cannot rewrite retained event or vector',()=>memory('c',c=>{
  const input=event('a',1,1,0,0);
  c.receive(input);input.value='tampered';input.clock.b=8;
  const output=c.state();output.clock.a=8;output.delivered[0]!.value='tampered';
  const local=c.publish({value:'local'});local.clock.a=7;
  assert.deepEqual(c.get('a',1),event('a',1,1,0,0));
  assert.deepEqual(c.get('c',1),event('c',1,1,0,1,'local'));
}));
