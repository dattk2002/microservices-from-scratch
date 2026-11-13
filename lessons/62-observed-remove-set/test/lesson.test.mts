import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../state.mts';

test('unit: observed removal preserves concurrent add; replay cannot resurrect tombstones', () => {
  const da = new DatabaseSync(':memory:');
  try {
    const db = new DatabaseSync(':memory:');
    try {
      const a = new Store(da, 'a'); const b = new Store(db, 'b');
      a.add('red'); b.merge(a.snapshot()); b.remove('red'); a.add('red');
      a.merge(b.snapshot());
      assert.deepEqual(a.values(), ['red']);
      const old = a.snapshot(); b.merge(old); b.remove('red'); a.merge(b.snapshot());
      a.merge(old); b.merge(old);
      assert.deepEqual(a.values(), []); assert.deepEqual(b.values(), []);
      a.add('red'); b.merge(a.snapshot()); assert.deepEqual(b.values(), ['red']);
    } finally { db.close(); }
  } finally { da.close(); }
});

test('unit: joins obey hand-derived commutativity associativity idempotence', () => {
  const x = {adds:[{actor:'a',seq:1,element:'red'}],removed:[]};
  const y = {adds:[{actor:'b',seq:1,element:'blue'}],removed:[]};
  const z = {adds:[{actor:'a',seq:1,element:'red'}],removed:[{actor:'a',seq:1}]};
  const want = {adds:[{actor:'a',seq:1,element:'red'},{actor:'b',seq:1,element:'blue'}],removed:[{actor:'a',seq:1}]};
  for (const states of [[x,y,z],[z,y,x],[y,x,z],[x,x,y,z,z]]) {
    const db = new DatabaseSync(':memory:');
    try { const s = new Store(db,'a'); for (const state of states) s.merge(state); assert.deepEqual(s.snapshot(), want); }
    finally { db.close(); }
  }
  const db = new DatabaseSync(':memory:');
  try { const s = new Store(db,'b'); s.merge(y); s.merge(z); const yz = s.snapshot();
    const other = new DatabaseSync(':memory:');
    try { const t = new Store(other,'a'); t.merge(x); t.merge(yz); assert.deepEqual(t.snapshot(),want); } finally { other.close(); }
  } finally { db.close(); }
});

test('unit: strict schema conflicts exhaustion and persisted actor leave state unchanged', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new Store(db,'a'); s.add('red'); const before = s.snapshot();
    for (const bad of [null,[],true,1,'x',{}, {adds:[],removed:[],extra:0},
      {adds:[{actor:'a',seq:2,element:'red'}],removed:[]},
      {adds:[{actor:'a',seq:1,element:'red'},{actor:'a',seq:1,element:'red'}],removed:[]},
      {adds:[{actor:'b',seq:1,element:'red'},{actor:'a',seq:1,element:'red'}],removed:[]},
      {adds:[],removed:[{actor:'a',seq:1}]},
      {adds:[{actor:'a',seq:1,element:'red',extra:0}],removed:[]},
      {adds:[{actor:'a',seq:1,element:'red'}],removed:[{actor:'a',seq:1},{actor:'a',seq:1}]}]) {
      assert.throws(() => s.merge(bad), {status:400}); assert.deepEqual(s.snapshot(),before);
    }
    assert.throws(() => s.merge({adds:[{actor:'a',seq:1,element:'blue'}],removed:[]}),{status:409});
    assert.deepEqual(s.snapshot(),before);
    assert.throws(() => new Store(db,'b'), /identity/);
    assert.deepEqual(new Store(db,'a').snapshot(), before);
    for (let i=1;i<8;i++) s.add('red');
    const full = s.snapshot(); assert.throws(() => s.add('red'),{status:429}); assert.deepEqual(s.snapshot(),full);
    s.remove('green'); assert.deepEqual(s.snapshot(),full);
    s.remove('red'); assert.deepEqual(s.values(),[]);
  } finally { db.close(); }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

const entry = (name: string) => new URL(`../${name}.mts`, import.meta.url);
async function post(url: string, path: string, body: unknown, status=200): Promise<unknown> {
  const r=await jsonRequest(url+path,body); assert.equal(r.status,status); return r.json();
}
async function get(url: string,path: string): Promise<unknown> {
  const r=await fetch(url+path,{signal:AbortSignal.timeout(2000)}); assert.equal(r.status,200); return r.json();
}

test('unit: imports are silent with invalid runtime settings', async () => {
  const script = `await import(${JSON.stringify(entry('replica').href)}); await import(${JSON.stringify(entry('sync').href)}); await import(${JSON.stringify(new URL('./fixture.mts',import.meta.url).href)});`;
  const child=spawn(process.execPath,['--input-type=module','-e',script],{
    env:{PATH:process.env.PATH??'',REPLICA_ID:'invalid',DB_PATH:'/unavailable/db',PORT:'invalid',A_ORIGIN:'bad',B_ORIGIN:'bad'},stdio:['ignore','pipe','pipe']});
  let out=''; let err=''; child.stdout.on('data',(b:Buffer)=>{out+=b;}); child.stderr.on('data',(b:Buffer)=>{err+=b;});
  const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
  try { const [code]=await once(child,'exit'); assert.equal(code,0,err); assert.equal(out,''); assert.equal(err,''); }
  finally { clearTimeout(timer); if(child.exitCode===null && child.signalCode===null) {child.kill('SIGKILL'); await once(child,'exit');} }
});

test('integration: independent replicas converge add-wins and retain tombstones and counters after restart', async () => {
  const dir=await mkdtemp(join(tmpdir(),'orset-')); const services: RunningService[]=[];
  try {
    let a=await startService(entry('replica'),{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')}); services.push(a);
    const b=await startService(entry('replica'),{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')}); services.push(b);
    const relay=await startService(entry('sync'),{A_ORIGIN:a.url,B_ORIGIN:b.url}); services.push(relay);
    await post(a.url,'/add',{element:'red'}); await post(relay.url,'/sync',{from:'a'});
    await post(b.url,'/remove',{element:'red'}); await post(a.url,'/add',{element:'red'});
    await post(relay.url,'/sync',{from:'b'}); await post(relay.url,'/sync',{from:'a'});
    assert.deepEqual(await get(a.url,'/values'),{values:['red']}); assert.deepEqual(await get(a.url,'/state'),await get(b.url,'/state'));
    const old=await get(a.url,'/state'); await post(b.url,'/remove',{element:'red'}); await post(relay.url,'/sync',{from:'b'});
    await a.stop();
    await assert.rejects(startService(entry('replica'),{REPLICA_ID:'b',DB_PATH:join(dir,'a.db')}),/identity mismatch/);
    a=await startService(entry('replica'),{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')}); services.push(a);
    await post(a.url,'/merge',old); assert.deepEqual(await get(a.url,'/values'),{values:[]});
    const fresh=await post(a.url,'/add',{element:'red'});
    assert.deepEqual(fresh,{adds:[{actor:'a',seq:1,element:'red'},{actor:'a',seq:2,element:'red'},{actor:'a',seq:3,element:'red'}],removed:[{actor:'a',seq:1},{actor:'a',seq:2}]});
    await post(b.url,'/merge',fresh); assert.deepEqual(await get(b.url,'/values'),{values:['red']});
    for(const bad of [null,[],1,true,'red',{element:{toString:null}},{element:'red',x:1}]) await post(a.url,'/add',bad,400);
    await post(a.url,'/remove',{element:{toString:null}},400);
    await post(a.url,'/control',{mode:'reset'},404);
    await post(a.url,'/merge',{adds:[{actor:'a',seq:1,element:'blue'}],removed:[]},409);
    assert.deepEqual(await get(a.url,'/state'),fresh);
    for(let i=3;i<8;i++) await post(a.url,'/add',{element:'red'});
    const full=await get(a.url,'/state'); await post(a.url,'/add',{element:'red'},429); assert.deepEqual(await get(a.url,'/state'),full);
  } finally { for(const s of services.reverse()) await s.stop(); await rm(dir,{recursive:true,force:true}); }
});

test('integration: bounded full-body relay rejects invalid upstream contracts, redirects and slow hops', async () => {
  const services: RunningService[]=[];
  try {
    const sink=await startService(new URL('./fixture.mts',import.meta.url),{TEACHING_CONTROLS:'1'}); services.push(sink);
    const source=await startService(new URL('./fixture.mts',import.meta.url),{TEACHING_CONTROLS:'1',REDIRECT_ORIGIN:sink.url}); services.push(source);
    const target=await startService(new URL('./fixture.mts',import.meta.url),{TEACHING_CONTROLS:'1',REDIRECT_ORIGIN:sink.url}); services.push(target);
    const relay=await startService(entry('sync'),{A_ORIGIN:source.url,B_ORIGIN:target.url}); services.push(relay);
    await assert.rejects(startService(entry('sync'),{A_ORIGIN:source.url,B_ORIGIN:source.url+'/'}),/distinct/);
    for(const bad of [null,[],true,1,{from:{toString:null}},{from:'a',origin:sink.url}]) await post(relay.url,'/sync',bad,400);
    for(const route of ['state','merge']) {
      const fixture=route==='state'?source:target;
      for(const mode of ['primitive','array','extra','gap','duplicate','unsorted','unknown-removal','bad-json','unexpected-status','wrong-error','unexpected-code','error-primitive','error-array','error-extra','wrong-message','rejected422','rejected429','not-found','wrong-content-type','oversize','slow']) {
        await post(fixture.url,'/control',{route,mode});
        const beforeSource=await get(source.url,'/count'); const beforeTarget=await get(target.url,'/count');
        await post(relay.url,'/sync',{from:'a'},502);
        assert.ok(typeof beforeSource==='object' && beforeSource!==null && 'count' in beforeSource && typeof beforeSource.count==='number');
        assert.ok(typeof beforeTarget==='object' && beforeTarget!==null && 'count' in beforeTarget && typeof beforeTarget.count==='number');
        assert.deepEqual(await get(source.url,'/count'),{count:beforeSource.count+1});
        assert.deepEqual(await get(target.url,'/count'),{count:beforeTarget.count+(route==='merge'?1:0)});
      }
      await post(fixture.url,'/control',{route,mode:'redirect'});
      const before=await get(sink.url,'/count');
      await post(relay.url,'/sync',{from:'a'},502);
      assert.deepEqual(await get(sink.url,'/count'),before);
      await post(fixture.url,'/control',{route,mode:'normal'});
    }
    await post(target.url,'/control',{route:'merge',mode:'conflict'});
    assert.deepEqual(await post(relay.url,'/sync',{from:'a'},409),{error:{code:'conflicting_tag',message:'Tag already names another element'}});
    await post(target.url,'/control',{route:'merge',mode:'escaped'});
    await post(source.url,'/control',{route:'state',mode:'escaped'});
    const full={adds:['a','b'].flatMap(actor=>Array.from({length:8},(_,i)=>({actor,seq:i+1,element:'green'}))),removed:['a','b'].flatMap(actor=>Array.from({length:8},(_,i)=>({actor,seq:i+1})))};
    assert.deepEqual(await post(relay.url,'/sync',{from:'a'}),full);
    await post(source.url,'/control',{route:'state',mode:'half-slow'});
    await post(target.url,'/control',{route:'merge',mode:'half-slow'});
    const began=performance.now(); await post(relay.url,'/sync',{from:'a'},502); assert.ok(performance.now()-began<900);
    await post(source.url,'/control',{route:'state',mode:'normal'});
    for(const bad of [null,[],{route:'state',mode:{toString:null}},{route:'state',mode:'normal',x:1}]) await post(target.url,'/control',bad,400);
    await target.stop(); await post(relay.url,'/sync',{from:'a'},502);
    await source.stop(); await post(relay.url,'/sync',{from:'a'},502);
  } finally { for(const s of services.reverse()) await s.stop(); }
});

test('integration: invalid content-type closes unfinished source and target responses promptly',async()=>{
  const services: RunningService[]=[];
  try {
    const source=await startService(new URL('./fixture.mts',import.meta.url),{TEACHING_CONTROLS:'1'}); services.push(source);
    const target=await startService(new URL('./fixture.mts',import.meta.url),{TEACHING_CONTROLS:'1'}); services.push(target);
    const relay=await startService(entry('sync'),{A_ORIGIN:source.url,B_ORIGIN:target.url}); services.push(relay);
    for(const route of ['state','merge']) {
      const fixture=route==='state'?source:target;
      assert.deepEqual(await get(fixture.url,'/pending'),{active:0,closed:0});
      await post(fixture.url,'/control',{route,mode:'unfinished-content-type'});
      const began=performance.now();
      await post(relay.url,'/sync',{from:'a'},502);
      const barrier=performance.now()+200;
      let observed: unknown;
      do {
        const response=await fetch(fixture.url+'/pending',{signal:AbortSignal.timeout(200)});
        assert.equal(response.status,200); observed=await response.json();
        if(typeof observed==='object' && observed!==null && 'active' in observed && observed.active===0 && 'closed' in observed && observed.closed===1) break;
        await delay(10);
      } while(performance.now()<barrier);
      assert.deepEqual(observed,{active:0,closed:1});
      assert.ok(performance.now()-began<450,'response must close before the 500 ms deadline');
      // Observe closure before changing modes or stopping either process.
      await post(fixture.url,'/control',{route,mode:'normal'});
    }
  } finally {for(const service of services.reverse()) await service.stop();}
});

import { origins, synchronize, WIRE_BYTES } from '../sync.mts';
import { parseSnapshot } from '../state.mts';
import { escapeStrings, full } from './fixture.mts';
for (const hop of ['source','target']) {
  test(`unit: early ${hop} content-type rejection aborts fetch with an unfinished body`,async()=>{
    const originalFetch=globalThis.fetch;
    const signals: AbortSignal[]=[];
    const pending=new ReadableStream<Uint8Array>({start(controller) {controller.enqueue(new TextEncoder().encode('{'));}});
    let calls=0;
    try {
      globalThis.fetch=async(_input,init)=>{
        assert.ok(init?.signal); signals.push(init.signal); calls++;
        if(hop==='target' && calls===1) return new Response('{"adds":[],"removed":[]}',{headers:{'content-type':'application/json'}});
        return new Response(pending,{headers:{'content-type':'text/plain'}});
      };
      await assert.rejects(synchronize('a',{a:'http://127.0.0.1:1',b:'http://127.0.0.1:2'}),{status:502});
      assert.equal(calls,hop==='source'?1:2);
      for(const signal of signals) assert.equal(signal.aborted,true,'rejected exchange must abort its fetch signal');
    } finally {globalThis.fetch=originalFetch; await pending.cancel();}
  });
}
test('unit: normalized fixed origins reject identical destinations and non-origin inputs',()=>{
  assert.deepEqual(origins('http://127.0.0.1:80/','http://127.0.0.1:81'),{a:'http://127.0.0.1',b:'http://127.0.0.1:81'});
  for(const [a,b] of [['http://127.0.0.1','http://127.0.0.1:80'],['http://127.0.0.1/a','http://127.0.0.1:81'],['http://u:p@127.0.0.1','http://127.0.0.1:81'],['https://127.0.0.1','http://127.0.0.1:81']]) assert.throws(()=>origins(a,b));
});
test('unit: maximum escaped wire remains valid schema and preserves non-string JSON tokens',()=>{
  const wire=escapeStrings(full);
  assert.deepEqual(parseSnapshot(JSON.parse(wire)), full); assert.ok(Buffer.byteLength(wire)<=WIRE_BYTES);
  assert.deepEqual(JSON.parse(escapeStrings({a:true,b:null,c:123})),{a:true,b:null,c:123});
  assert.deepEqual(parseSnapshot(JSON.parse(JSON.stringify(full)+' '.repeat(8193))),full);
});

test('unit: full retained history cannot be reclaimed and malformed tag primitives are rejected',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const s=new Store(db,'a'); s.merge(full); assert.deepEqual(s.values(),[]);
    const before=s.snapshot(); assert.throws(()=>s.add('green'),{status:429}); assert.deepEqual(s.snapshot(),before);
    for(const bad of [
      {adds:[{actor:'a',seq:'1',element:'red'}],removed:[]},
      {adds:[{actor:'a',seq:1.5,element:'red'}],removed:[]},
      {adds:[{actor:'a',seq:0,element:'red'}],removed:[]},
      {adds:[{actor:'a',seq:9,element:'red'}],removed:[]},
      {adds:[{actor:'a',seq:1,element:null}],removed:[]},
      {adds:[null],removed:[]}, {adds:[],removed:[null]},
      {adds:[{actor:'a',seq:1,element:'red'}],removed:[{actor:'a',seq:1,extra:0}]},
      {adds:[{actor:'a',seq:1,element:'red'},{actor:'b',seq:1,element:'blue'}],removed:[{actor:'b',seq:1},{actor:'a',seq:1}]},
      {adds:[...full.adds,{actor:'b',seq:9,element:'red'}],removed:full.removed}
    ]) {assert.throws(()=>s.merge(bad),{status:400}); assert.deepEqual(s.snapshot(),before);}
    const noRemove={adds:full.adds,removed:[]}; s.merge(noRemove); assert.deepEqual(s.snapshot(),before);
  } finally {db.close();}
});

test('integration: fixture teaching controls default to disabled',async()=>{
  const service=await startService(new URL('./fixture.mts',import.meta.url));
  try {
    await post(service.url,'/control',{route:'state',mode:'normal'},404);
    const response=await fetch(service.url+'/pending',{signal:AbortSignal.timeout(2000)});
    assert.equal(response.status,404); await response.arrayBuffer();
  }
  finally {await service.stop();}
});

test('unit: values sort lexically while remove targets exactly observed tags of one element',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const s=new Store(db,'a'); s.add('red'); s.add('green');
    s.merge({adds:[{actor:'b',seq:1,element:'blue'},{actor:'b',seq:2,element:'green'}],removed:[]});
    assert.deepEqual(s.values(),['blue','green','red']); s.remove('green');
    assert.deepEqual(s.snapshot(),{adds:[{actor:'a',seq:1,element:'red'},{actor:'a',seq:2,element:'green'},{actor:'b',seq:1,element:'blue'},{actor:'b',seq:2,element:'green'}],removed:[{actor:'a',seq:2},{actor:'b',seq:2}]});
    assert.deepEqual(s.values(),['blue','red']);
    const before=s.snapshot();
    assert.throws(()=>s.merge({adds:[{actor:'a',seq:1,element:'red'},{actor:'a',seq:2,element:'green'},{actor:'a',seq:3,element:'blue'},{actor:'b',seq:1,element:'red'}],removed:[]}),{status:409});
    assert.deepEqual(s.snapshot(),before);
  } finally {db.close();}
});
