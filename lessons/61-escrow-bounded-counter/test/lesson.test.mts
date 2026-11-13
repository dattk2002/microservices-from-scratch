import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store.mts';

// Break caught: spending global stock instead of the actor's locally owned rights.
test('unit: initial A cannot spend4; observed B transfer2 permits spend5 leaving1', () => {
  const a = new Store(':memory:', 'a');
  try {
    const b = new Store(':memory:', 'b');
    try {
      assert.throws(() => a.spend({amount:4}), {status:409});
      assert.deepEqual(a.envelope(), {replica:'a',snapshot:{spent:{a:0,b:0},transferred:{ab:0,ba:0}},rights:{a:3,b:3},remaining:6});
      b.transfer({amount:2});
      a.receive(b.envelope().snapshot);
      a.spend({amount:5});
      assert.deepEqual(a.envelope(), {replica:'a',snapshot:{spent:{a:5,b:0},transferred:{ab:0,ba:2}},rights:{a:0,b:1},remaining:1});
    } finally { b.close(); }
  } finally { a.close(); }
});

// Break caught: disconnected actors oversell or a sender spends rights already given away.
test('unit: disconnected spends3+3 exhaust stock; transfer rights require observation', () => {
  const a = new Store(':memory:', 'a');
  try {
    const b = new Store(':memory:', 'b');
    try {
      a.spend({amount:3}); b.spend({amount:3});
      a.receive(b.envelope().snapshot); b.receive(a.envelope().snapshot);
      assert.deepEqual(a.envelope(),{replica:'a',snapshot:{spent:{a:3,b:3},transferred:{ab:0,ba:0}},rights:{a:0,b:0},remaining:0});
      assert.throws(()=>a.spend({amount:1}),{status:409});
      assert.throws(()=>b.transfer({amount:1}),{status:409});
    } finally { b.close(); }
  } finally { a.close(); }
  const c = new Store(':memory:', 'a');
  try {
    const d = new Store(':memory:', 'b');
    try {
      c.transfer({amount:3});
      assert.throws(()=>c.spend({amount:1}),{status:409});
      assert.throws(()=>d.spend({amount:4}),{status:409});
      d.receive(c.envelope().snapshot); d.spend({amount:6});
      assert.deepEqual(d.envelope(),{replica:'b',snapshot:{spent:{a:0,b:6},transferred:{ab:3,ba:0}},rights:{a:0,b:0},remaining:0});
    } finally { d.close(); }
  } finally { c.close(); }
});

// Break caught: replay/stale snapshots overwrite monotonic coordinates and recreate stock.
test('unit: stale duplicate and reordered merges never recreate rights; commands are new', () => {
  const a = new Store(':memory:', 'a');
  try {
    const b = new Store(':memory:', 'b');
    try {
      const initial = a.envelope().snapshot;
      b.transfer({amount:1}); const first = b.envelope().snapshot;
      b.transfer({amount:1}); const second = b.envelope().snapshot;
      a.receive(second); a.spend({amount:2}); a.spend({amount:2});
      const before=a.envelope();
      for(const s of [first,second,initial,second]) a.receive(s);
      assert.deepEqual(a.envelope(),before);
      assert.deepEqual(before,{replica:'a',snapshot:{spent:{a:4,b:0},transferred:{ab:0,ba:2}},rights:{a:1,b:1},remaining:2});
    } finally { b.close(); }
  } finally { a.close(); }
});

// Break caught: missing post-join validation commits an impossible merge.
test('unit: invalid incoming and individually valid incompatible join roll back atomically', () => {
  const a=new Store(':memory:','a');
  try {
    a.spend({amount:3}); const before=a.envelope();
    for(const s of [
      {spent:{a:4,b:0},transferred:{ab:0,ba:0}},
      {spent:{a:0,b:0},transferred:{ab:3,ba:0}},
      {spent:{a:6,b:1},transferred:{ab:0,ba:3}},
    ]) { assert.throws(()=>a.receive(s),{status:409}); assert.deepEqual(a.envelope(),before); }
  } finally { a.close(); }
});

// Break caught: saturated transfer counters reset, overflow, or consume rights on rejection.
test('unit: reachable transfers hit16 with no reset; over-limit and insufficient roll back', () => {
  const a=new Store(':memory:','a');
  try {
    const b=new Store(':memory:','b');
    try {
      for(let n=0;n<16;n++) {
        a.transfer({amount:1}); b.receive(a.envelope().snapshot);
        b.transfer({amount:1}); a.receive(b.envelope().snapshot);
      }
      assert.deepEqual(a.envelope(),{replica:'a',snapshot:{spent:{a:0,b:0},transferred:{ab:16,ba:16}},rights:{a:3,b:3},remaining:6});
      const before=a.envelope();
      assert.throws(()=>a.transfer({amount:1}),{status:429});
      assert.throws(()=>a.transfer({amount:4}),{status:409});
      assert.deepEqual(a.envelope(),before);
      a.spend({amount:3}); assert.equal(a.envelope().remaining,3);
    } finally { b.close(); }
  } finally { a.close(); }
});

import { parseSnapshot, parseEnvelope, joinSnapshots, origin } from '../model.mts';
import type { Snapshot } from '../model.mts';

// Hand-derived reachable history: A→B1, B spends2; A spends1 without seeing that spend.
test('unit: reachable max join is associative commutative idempotent with literal result', () => {
  const x:Snapshot={spent:{a:0,b:0},transferred:{ab:1,ba:0}};
  const y:Snapshot={spent:{a:0,b:2},transferred:{ab:1,ba:0}};
  const z:Snapshot={spent:{a:1,b:0},transferred:{ab:1,ba:0}};
  const want:Snapshot={spent:{a:1,b:2},transferred:{ab:1,ba:0}};
  assert.deepEqual(joinSnapshots(joinSnapshots(x,y),z),want);
  assert.deepEqual(joinSnapshots(x,joinSnapshots(y,z)),want);
  assert.deepEqual(joinSnapshots(y,z),want);
  assert.deepEqual(joinSnapshots(z,y),want);
  assert.deepEqual(joinSnapshots(want,want),want);
});

// Break caught: coercion, extra fields or unchecked derived values cross a trust boundary.
test('unit: exact snapshot/full-state schemas and fixed origins validate primitive types', () => {
  const zero={spent:{a:0,b:0},transferred:{ab:0,ba:0}};
  for(const v of [null,[],false,1,'a',{}, {...zero,extra:0}, {spent:{a:0,b:0,c:0},transferred:{ab:0,ba:0}}, {spent:{a:'0',b:0},transferred:{ab:0,ba:0}}, {spent:{a:-1,b:0},transferred:{ab:0,ba:0}}, {spent:{a:0,b:0},transferred:{ab:17,ba:0}}, {spent:{a:0.5,b:0},transferred:{ab:0,ba:0}}]) assert.throws(()=>parseSnapshot(v),{status:400});
  const full={replica:'a',snapshot:zero,rights:{a:3,b:3},remaining:6};
  assert.deepEqual(parseEnvelope(full,'a'),full);
  for(const v of [null,[],false,3,'a',{}, {...full,extra:0},{...full,replica:'b'},{...full,rights:{a:4,b:3}},{...full,rights:{a:3,b:3,extra:0}},{...full,remaining:5},{...full,remaining:'6'},{...full,snapshot:{spent:{a:4,b:0},transferred:{ab:0,ba:0}}}]) assert.throws(()=>parseEnvelope(v,'a'));
  assert.equal(origin('http://127.0.0.1:80/'),'http://127.0.0.1');
  for(const v of [undefined,'bad','https://127.0.0.1:1','http://localhost:1','http://127.0.0.1:1/x','http://u:p@127.0.0.1:1','http://127.0.0.1:1/?x=1']) assert.throws(()=>origin(v));
  const a=new Store(':memory:','a');
  try {
    const before=a.envelope();
    for(const value of [null,[],1,false,'1',{}, {amount:0},{amount:7},{amount:1.5},{amount:'1'},{amount:{toString:null}},{amount:1,extra:0}]) for(const action of [()=>a.spend(value),()=>a.transfer(value)]) { assert.throws(action,{status:400}); assert.deepEqual(a.envelope(),before); }
  } finally { a.close(); }
});

import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('integration: SQLite reopens identity and exact snapshot; wrong identity leaves database unchanged',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'escrow-unit-'));
  try {
    const path=join(dir,'a.db'); const a=new Store(path,'a');
    try { a.transfer({amount:2}); a.spend({amount:1}); } finally { a.close(); }
    const bytes=await readFile(path);
    assert.throws(()=>new Store(path,'b'),/identity conflict/);
    assert.deepEqual(await readFile(path),bytes);
    const reopened=new Store(path,'a');
    try { assert.deepEqual(reopened.envelope(),{replica:'a',snapshot:{spent:{a:1,b:0},transferred:{ab:2,ba:0}},rights:{a:0,b:5},remaining:5}); } finally { reopened.close(); }
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('unit: silent entrypoint imports ignore invalid runtime configuration',async()=>{
  const child=spawn(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../replica.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('../sync.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('./fixture.mts',import.meta.url).href)});`],{env:{PATH:process.env.PATH??'',REPLICA_ID:'bad',DB_PATH:'/invalid/path',PORT:'bad',A_ORIGIN:'bad',B_ORIGIN:'bad',TEACHING_CONTROLS:'1'},stdio:['ignore','pipe','pipe']});
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

import { readReply } from '../sync.mts';
import { isInvariantError } from '../model.mts';

test('unit: complete upstream JSON has a finite byte budget and exact invariant error',async()=>{
  const body={replica:'a',snapshot:{spent:{a:0,b:0},transferred:{ab:0,ba:0}},rights:{a:3,b:3},remaining:6};
  const wire=JSON.stringify(body);
  const headers={'content-type':'application/json'};
  assert.deepEqual(await readReply(new Response(wire,{headers}),AbortSignal.timeout(500)),body);
  await assert.rejects(()=>readReply(new Response(' '.repeat(2049)+wire,{headers}),AbortSignal.timeout(500)),/too large/);
  await assert.rejects(()=>readReply(new Response('{',{headers}),AbortSignal.timeout(500)));
  await assert.rejects(()=>readReply(new Response(wire),AbortSignal.timeout(500)),/JSON/);
  assert.equal(isInvariantError({error:{code:'invariant_conflict',message:'Snapshot violates escrow invariants'}}),true);
  for(const v of [null,[],4,false,'x',{}, {error:null},{error:[]},{error:{code:1,message:'x'}},{error:{code:'internal_error',message:'Unexpected service error'}},{error:{code:'insufficient_rights',message:'Insufficient local rights'}},{error:{code:'invariant_conflict',message:'wrong'}},{error:{code:'invariant_conflict',message:'Snapshot violates escrow invariants',extra:0}},{error:{code:'invariant_conflict',message:'Snapshot violates escrow invariants'},extra:0}]) assert.equal(isInvariantError(v),false);
});

import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { object } from '../model.mts';

async function post(url:string,body:unknown,status=200):Promise<unknown> {
  const response=await jsonRequest(url,body);
  assert.equal(response.status,status,await response.clone().text());
  return response.json();
}
async function get(url:string):Promise<unknown> {
  const response=await fetch(url,{signal:AbortSignal.timeout(2000)});
  assert.equal(response.status,200); return response.json();
}
async function launch(services:RunningService[],entry:string,env:Record<string,string>={}) {
  // startService protects a failed startup itself; register each success before the next acquisition.
  const service=await startService(new URL(entry,import.meta.url),env);
  services.push(service); return service;
}
async function cleanup(services:RunningService[]):Promise<void> {
  const results=await Promise.allSettled(services.reverse().map(s=>s.stop()));
  const failures=results.filter(r=>r.status==='rejected');
  if(failures.length) throw new AggregateError(failures,'Service cleanup failed');
}

test('integration: independent private replicas spend safely, sync idempotently and retain identity on restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'escrow-http-'));
  const services:RunningService[]=[];
  try {
    const aPath=join(dir,'a.db'),bPath=join(dir,'b.db');
    let a=await launch(services,'../replica.mts',{REPLICA_ID:'a',DB_PATH:aPath});
    let b=await launch(services,'../replica.mts',{REPLICA_ID:'b',DB_PATH:bPath});
    let relay=await launch(services,'../sync.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
    const zero={spent:{a:0,b:0},transferred:{ab:0,ba:0}};
    assert.deepEqual(await get(a.url+'/state'),{replica:'a',snapshot:zero,rights:{a:3,b:3},remaining:6});
    assert.deepEqual(await post(a.url+'/spend',{amount:4},409),{error:{code:'insufficient_rights',message:'Insufficient local rights'}});
    await post(b.url+'/transfer',{amount:2});
    await post(a.url+'/spend',{amount:4},409);
    assert.deepEqual(await post(relay.url+'/sync',{from:'b'}),{replica:'a',snapshot:{spent:{a:0,b:0},transferred:{ab:0,ba:2}},rights:{a:5,b:1},remaining:6});
    assert.deepEqual(await post(a.url+'/spend',{amount:5}),{replica:'a',snapshot:{spent:{a:5,b:0},transferred:{ab:0,ba:2}},rights:{a:0,b:1},remaining:1});
    await post(a.url+'/spend',{amount:1},409);
    await post(relay.url+'/sync',{from:'a'});
    await post(b.url+'/spend',{amount:1});
    // Model an application discarding a committed reply: snapshot retry must be harmless.
    const committed=await jsonRequest(a.url+'/merge',{spent:{a:5,b:1},transferred:{ab:0,ba:2}});
    assert.equal(committed.status,200); await committed.body?.cancel();
    await post(relay.url+'/sync',{from:'b'}); await post(relay.url+'/sync',{from:'a'});
    const finalA={replica:'a',snapshot:{spent:{a:5,b:1},transferred:{ab:0,ba:2}},rights:{a:0,b:0},remaining:0};
    const finalB={...finalA,replica:'b'};
    assert.deepEqual(await get(a.url+'/state'),finalA);
    assert.deepEqual(await get(b.url+'/state'),finalB);
    for(const s of [zero,finalA.snapshot,zero]) assert.deepEqual(await post(a.url+'/merge',s),finalA);
    for(const route of ['/spend','/transfer','/merge']) {
      for(const bad of [null,[],1,true,'x',{}, {amount:1,extra:0}]) await post(a.url+route,bad,400);
    }
    for(const amount of [0,7,1.5,'1',null,{toString:null}]) for(const route of ['/spend','/transfer']) await post(a.url+route,{amount},400);
    await post(a.url+'/merge',{spent:{a:4,b:0},transferred:{ab:0,ba:0}},409);
    await post(a.url+'/merge',{spent:{a:0,b:0},transferred:{ab:17,ba:0}},400);
    assert.deepEqual(await get(a.url+'/state'),finalA);
    for(const bad of [null,[],1,true,'x',{}, {from:'a',to:'b'},{from:{toString:null}},{from:'c'},{from:'a',origin:a.url}]) await post(relay.url+'/sync',bad,400);
    const malformed=await fetch(a.url+'/merge',{method:'POST',headers:{'content-type':'application/json'},body:'{',signal:AbortSignal.timeout(2000)});
    assert.equal(malformed.status,400); await malformed.body?.cancel();
    await relay.stop(); await a.stop(); await b.stop();
    const stored=await readFile(aPath);
    await assert.rejects(()=>launch(services,'../replica.mts',{REPLICA_ID:'b',DB_PATH:aPath}),/identity conflict/);
    assert.deepEqual(await readFile(aPath),stored);
    a=await launch(services,'../replica.mts',{REPLICA_ID:'a',DB_PATH:aPath});
    b=await launch(services,'../replica.mts',{REPLICA_ID:'b',DB_PATH:bPath});
    relay=await launch(services,'../sync.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
    assert.deepEqual(await get(a.url+'/state'),finalA); assert.deepEqual(await get(b.url+'/state'),finalB);
    assert.deepEqual(await post(relay.url+'/sync',{from:'a'}),finalB);
    await post(a.url+'/spend',{amount:1},409); await post(b.url+'/transfer',{amount:1},409);
    await assert.rejects(()=>launch(services,'../sync.mts',{A_ORIGIN:a.url+'/',B_ORIGIN:a.url}),/Distinct origins/);
  } finally { try { await cleanup(services); } finally { await rm(dir,{recursive:true,force:true}); } }
});

async function configure(service:RunningService,route:'/state'|'/merge',body:unknown,mode='json',status=200,delay=0) {
  await post(service.url+'/control',{route,mode,body,status,delay});
}
async function count(service:RunningService,name:'state'|'merge'|'sink'):Promise<number> {
  const v=await get(service.url+'/counts'); assert.ok(object(v));
  const n=v[name]; if(typeof n!=='number') throw new Error('Bad fixture counter'); return n;
}

test('integration: sync validates both whole envelopes, finite escaped bodies, errors and redirect containment',async()=>{
  const services:RunningService[]=[];
  try {
    const sink=await launch(services,'./fixture.mts');
    const a=await launch(services,'./fixture.mts',{TEACHING_CONTROLS:'1',SINK_ORIGIN:sink.url});
    const b=await launch(services,'./fixture.mts',{TEACHING_CONTROLS:'1',SINK_ORIGIN:sink.url});
    const relay=await launch(services,'../sync.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
    // Reachable by 16 one-unit round trips, then each actor spends3.
    const snapshot={spent:{a:3,b:3},transferred:{ab:16,ba:16}};
    const fullA={replica:'a',snapshot,rights:{a:0,b:0},remaining:0};
    const fullB={...fullA,replica:'b'};
    await configure(a,'/state',fullA); await configure(b,'/merge',fullB);
    assert.deepEqual(await post(relay.url+'/sync',{from:'a'}),fullB);
    assert.deepEqual(await get(b.url+'/received'),{body:snapshot});
    for(const [service,route,valid] of [[a,'/state',fullA],[b,'/merge',fullB]] satisfies [RunningService,'/state'|'/merge',unknown][]) {
      const wrongReplica=service===a?'b':'a';
      for(const bad of [null,[],false,4,'x',{}, {...fullA,replica:wrongReplica},{...fullA,replica:service===a?'a':'b',extra:0},{...fullA,replica:service===a?'a':'b',rights:{a:1,b:0}},{...fullA,replica:service===a?'a':'b',remaining:'0'},{...fullA,replica:service===a?'a':'b',rights:{a:0,b:0,extra:0}},{...fullA,replica:service===a?'a':'b',snapshot:{spent:{a:3,b:3},transferred:{ab:17,ba:16}}},{...fullA,replica:service===a?'a':'b',snapshot:{spent:{a:6,b:3},transferred:{ab:16,ba:16}}},{error:{code:'internal_error',message:'Unexpected service error'}}]) {
        await configure(service,route,bad);
        const before=await count(b,'merge');
        await post(relay.url+'/sync',{from:'a'},502);
        if(service===a) assert.equal(await count(b,'merge'),before);
      }
      for(const mode of ['malformed','oversize','drop','redirect','body-slow']) {
        await configure(service,route,valid,mode);
        const beforeSink=await count(sink,'sink'),beforeMerge=await count(b,'merge');
        await post(relay.url+'/sync',{from:'a'},502);
        // Check the reachable distinct redirect destination before any mode change.
        assert.equal(await count(sink,'sink'),beforeSink);
        if(service===a) assert.equal(await count(b,'merge'),beforeMerge);
      }
      await configure(service,route,valid,'escaped');
      assert.deepEqual(await post(relay.url+'/sync',{from:'a'}),fullB);
      await configure(service,route,valid);
    }
    // All source failures are 502, even a well-formed known invariant error.
    const invariant={error:{code:'invariant_conflict',message:'Snapshot violates escrow invariants'}};
    for(const status of [404,409,422,429,503]) for(const error of [invariant,{error:{code:'internal_error',message:'Unexpected service error'}}]) {
      await configure(a,'/state',error,'json',status);
      const before=await count(b,'merge'); await post(relay.url+'/sync',{from:'a'},502);
      assert.equal(await count(b,'merge'),before);
    }
    await configure(a,'/state',fullA);
    for(const status of [404,422,429,500,503]) {
      await configure(b,'/merge',invariant,'json',status); await post(relay.url+'/sync',{from:'a'},502);
    }
    for(const error of [null,[],false,4,'x',{}, {error:null},{error:[]},{error:{code:1,message:'x'}},{error:{code:'internal_error',message:'Unexpected service error'}},{error:{code:'insufficient_rights',message:'Insufficient local rights'}},{error:{code:'invariant_conflict',message:'wrong'}},{error:{...invariant.error,extra:0}},{...invariant,extra:0},fullB]) {
      await configure(b,'/merge',error,'json',409); await post(relay.url+'/sync',{from:'a'},502);
    }
    await configure(b,'/merge',invariant,'escaped',409);
    assert.deepEqual(await post(relay.url+'/sync',{from:'a'},409),invariant);
    await configure(b,'/merge',invariant,'oversize',409); await post(relay.url+'/sync',{from:'a'},502);
    await configure(b,'/merge',fullB);
    // Reverse direction checks the requested origin's identity too.
    await configure(b,'/state',fullB,'escaped'); await configure(a,'/merge',fullA,'escaped');
    assert.deepEqual(await post(relay.url+'/sync',{from:'b'}),fullA);
    assert.deepEqual(await get(a.url+'/received'),{body:snapshot});
    for(const body of [null,[],false,3,'x',{}, {route:'/state',mode:{toString:null},body:fullA,status:200,delay:0},{route:'/state',mode:'json',body:fullA,status:'200',delay:0},{route:'/state',mode:'json',body:fullA,status:200,delay:0,extra:0}]) await post(a.url+'/control',body,400);
    await post(sink.url+'/control',{route:'/state',mode:'json',body:fullA,status:200,delay:0},404);
  } finally { await cleanup(services); }
});

test('integration: one500ms budget covers both headers and complete bodies, with transport failure502',async()=>{
  const services:RunningService[]=[];
  try {
    const sink=await launch(services,'./fixture.mts');
    const a=await launch(services,'./fixture.mts',{TEACHING_CONTROLS:'1',SINK_ORIGIN:sink.url});
    const b=await launch(services,'./fixture.mts',{TEACHING_CONTROLS:'1',SINK_ORIGIN:sink.url});
    const relay=await launch(services,'../sync.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
    const snapshot={spent:{a:0,b:0},transferred:{ab:0,ba:0}};
    const fullA={replica:'a',snapshot,rights:{a:3,b:3},remaining:6},fullB={...fullA,replica:'b'};
    await configure(a,'/state',fullA,'json',200,300);
    await configure(b,'/merge',fullB,'json',200,300);
    const before=await count(b,'merge');
    await post(relay.url+'/sync',{from:'a'},502);
    assert.equal(await count(b,'merge'),before+1);
    // 700ms headers on either hop must exhaust the same fixed budget.
    for(const [service,route,valid] of [[a,'/state',fullA],[b,'/merge',fullB]] satisfies [RunningService,'/state'|'/merge',unknown][]) {
      await configure(a,'/state',fullA); await configure(b,'/merge',fullB);
      await configure(service,route,valid,'json',200,700);
      await post(relay.url+'/sync',{from:'a'},502);
    }
    await a.stop();
    await post(relay.url+'/sync',{from:'a'},502);
    await configure(b,'/state',fullB);
    await post(relay.url+'/sync',{from:'b'},502);
  } finally { await cleanup(services); }
});

test('integration: genuine target invariant409 is preserved and the conflicting max join is atomic',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'escrow-conflict-'));
  const services:RunningService[]=[];
  try {
    const a=await launch(services,'../replica.mts',{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')});
    const b=await launch(services,'../replica.mts',{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')});
    const relay=await launch(services,'../sync.mts',{A_ORIGIN:a.url,B_ORIGIN:b.url});
    await post(a.url+'/spend',{amount:3});
    // Deliberately inject a conflicting history for A: not reachable with one trusted writer.
    await post(b.url+'/merge',{spent:{a:0,b:0},transferred:{ab:3,ba:0}});
    const beforeA=await get(a.url+'/state'),beforeB=await get(b.url+'/state');
    const error={error:{code:'invariant_conflict',message:'Snapshot violates escrow invariants'}};
    assert.deepEqual(await post(relay.url+'/sync',{from:'a'},409),error);
    assert.deepEqual(await post(relay.url+'/sync',{from:'b'},409),error);
    assert.deepEqual(await get(a.url+'/state'),beforeA); assert.deepEqual(await get(b.url+'/state'),beforeB);
  } finally { try { await cleanup(services); } finally { await rm(dir,{recursive:true,force:true}); } }
});
