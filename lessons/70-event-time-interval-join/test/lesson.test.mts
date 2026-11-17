import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { JoinStore } from '../store.mts';
const event = (id: string, side: 'left' | 'right', time: number, key: 'a' | 'b' = 'a') => ({id, side, key, time, value: 1});
test('unit: right-first inclusive interval boundary excludes right time14', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const store = new JoinStore(db);
    store.event(event('r13', 'right', 13));
    store.event(event('r14', 'right', 14));
    store.event(event('l10', 'left', 10));
    assert.deepEqual(store.state().pairs, [{leftId:'l10',rightId:'r13',key:'a',leftTime:10,rightTime:13,final:false}]);
  } finally { db.close(); }
});

test('unit: inclusive lower bound is directional and state uses deterministic id ordering', () => {
  const db=new DatabaseSync(':memory:');
  try {
    const s=new JoinStore(db);
    for (const time of [14,9,13,10]) s.event(event(`r${time}`,'right',time));
    s.event(event('l10','left',10));
    assert.deepEqual(s.state().pairs.map(p=>p.rightId),['r10','r13']);
    assert.deepEqual(s.state().events.map(e=>e.id),['l10','r10','r13','r14','r9']);
    assert.deepEqual(s.watermark('right',13),s.watermark('right',13));
  } finally { db.close(); }
});
test('unit: distinct watermarks, no premature eviction, finalization and late replay precedence', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new JoinStore(db);
    s.event(event('l10','left',10));
    s.watermark('right',12);
    s.watermark('left',13);
    s.event(event('r13','right',13));
    assert.equal(s.state().pairs[0]?.final, false);
    s.watermark('right',13);
    assert.equal(s.state().pairs[0]?.final, true);
    const snapshot = s.state();
    assert.deepEqual(s.event(event('r13','right',13)), {id:'r13',duplicate:true});
    assert.deepEqual(s.state(),snapshot);
    assert.throws(() => s.event(event('rnew','right',13)), {code:'late_event'});
    assert.throws(() => s.event(event('r13','left',14)), {code:'id_conflict'});
    assert.throws(() => s.watermark('right',12), {code:'watermark_regression'});
    assert.deepEqual(s.state(),snapshot);
  } finally { db.close(); }
});
test('unit: each endpoint needs its own closing promise, keys and arrival order', () => {
  for (const reverse of [false,true]) {
    const db = new DatabaseSync(':memory:');
    try {
      const s = new JoinStore(db);
      const inputs = [event('l','left',10),event('r','right',11),event('other','right',12,'b')];
      for (const e of reverse ? inputs.toReversed() : inputs) s.event(e);
      s.watermark('right',13);
      assert.equal(s.state().pairs[0]?.final,false);
      s.watermark('left',10);
      assert.equal(s.state().pairs[0]?.final,false);
      s.watermark('left',11);
      assert.equal(s.state().pairs[0]?.final,true);
      assert.equal(s.state().pairs.length,1);
    } finally { db.close(); }
  }
});
test('unit: dense pairs, global ids and capacity do not recycle after closure', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new JoinStore(db);
    for (let i=0;i<16;i++) { s.event(event(`l${i}`,'left',10)); s.event(event(`r${i}`,'right',13)); }
    assert.equal(s.state().pairs.length,256);
    const before=s.state();
    assert.throws(() => s.event(event('overflow','left',10)), {code:'capacity'});
    assert.deepEqual(s.state(),before);
    assert.throws(() => s.event(event('overflowr','right',14)), {code:'capacity'});
    s.watermark('right',13); s.watermark('left',13);
    assert.throws(() => s.event(event('fresh','left',14)), {code:'capacity'});
    s.watermark('left',104); s.watermark('right',104);
    assert.ok(s.state().pairs.every(p=>p.final));
    assert.deepEqual(s.event(event('l0','left',10)),{id:'l0',duplicate:true});
    assert.throws(()=>s.event(event('overflow','left',100)),{code:'late_event'});
  } finally { db.close(); }
});
test('unit: SQL failures roll back event/pairs and watermark/finalization together', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const s = new JoinStore(db); s.event(event('l','left',10));
    db.exec("CREATE TRIGGER fail_pair BEFORE INSERT ON pairs BEGIN SELECT RAISE(ABORT,'injected'); END");
    const before=s.state();
    assert.throws(()=>s.event(event('r','right',13)),/injected/);
    assert.deepEqual(s.state(),before);
    db.exec('DROP TRIGGER fail_pair'); s.event(event('r','right',13)); s.watermark('left',13);
    db.exec("CREATE TRIGGER fail_final BEFORE UPDATE ON pairs BEGIN SELECT RAISE(ABORT,'injected'); END");
    const provisional=s.state();
    assert.throws(()=>s.watermark('right',13),/injected/);
    assert.deepEqual(s.state(),provisional);
  } finally { db.close(); }
});

import { eventValid, watermarkValid, input, replyValid, origin, messages, exact } from '../contracts.mts';
import { spawnSync } from 'node:child_process';
test('unit: schemas reject primitives, extras, coercion and invalid bounds', () => {
  for (const v of [null,[],true,1,'event',{}, {...event('x','left',0),extra:1}, {...event('x','left',0),id:'X'},
    {...event('x','left',0),time:'0'}, {...event('x','left',0),time:101}, {...event('x','left',0),value:10},
    {...event('x','left',0),side:{toString:null}}, {...event('x','left',0),key:'c'}, {...event('x','left',0),id:'a'.repeat(17)}]) {
    assert.equal(eventValid(v),false); assert.throws(()=>input('/events',v),{code:'invalid_request'});
  }
  for (const v of [null,[],false,0,'left',{side:'left',time:-1},{side:'right',time:105},{side:'left',time:1.5},
    {side:{toString:null},time:0},{side:'left',time:0,extra:1}]) assert.equal(watermarkValid(v),false);
  assert.ok(eventValid(event('0','right',100))); assert.ok(watermarkValid({side:'left',time:104}));
});
test('unit: exact upstream envelopes, recognized semantic codes and fixed messages only', () => {
  const e=event('x','left',10);
  assert.ok(replyValid('/events',e,201,{id:'x',duplicate:false}));
  assert.ok(replyValid('/events',e,200,{id:'x',duplicate:true}));
  for (const [code,status] of [['late_event',409],['id_conflict',409],['capacity',429]] as const) {
    assert.ok(replyValid('/events',e,status,{error:{code,message:messages[code]}}));
  }
  const w={side:'right',time:13} as const;
  assert.ok(replyValid('/watermark',w,200,{watermarks:{left:-1,right:13}}));
  assert.ok(replyValid('/watermark',w,409,{error:{code:'watermark_regression',message:messages.watermark_regression}}));
  for (const path of ['/events','/watermark']) {
    for (const v of [null,[],1,'ok',{error:{code:'internal_error',message:'Unexpected service error'}},
      {error:{code:'late_event',message:'wrong'}},{error:{code:'late_event',message:messages.late_event,extra:1}}]) {
      assert.equal(replyValid(path,path==='/events'?e:w,409,v),false);
    }
  }
  for (const v of [{id:'other',duplicate:false},{id:'x',duplicate:true},{id:'x',duplicate:false,extra:1}]) {
    assert.equal(replyValid('/events',e,201,v),false);
  }
  assert.equal(replyValid('/watermark',w,200,{watermarks:{left:-1,right:12}}),false);
  assert.equal(replyValid('/events',e,500,{error:{code:'capacity',message:messages.capacity}}),false);
});
test('unit: normalized fixed loopback origins reject caller paths and self-invalid ports', () => {
  assert.equal(origin('http://127.0.0.1:7070/'),'http://127.0.0.1:7070');
  assert.equal(origin('http://127.0.0.1:080/'),'http://127.0.0.1');
  for (const v of [undefined,'http://localhost:7070','https://127.0.0.1:7070','http://127.0.0.1:0',
    'http://user@127.0.0.1:7070','http://127.0.0.1:7070/path','http://127.0.0.1:7070/?x=1']) assert.throws(()=>origin(v));
});
test('unit: persistent configured identity cannot be silently replaced', () => {
  const db=new DatabaseSync(':memory:');
  try {
    const s=new JoinStore(db,'first'); s.event(event('l','left',10));
    assert.throws(()=>new JoinStore(db,'second'),/configuration mismatch/);
    assert.deepEqual(new JoinStore(db,'first').state(),s.state());
  } finally { db.close(); }
});
test('unit: all entrypoints are silent on import despite invalid configuration', () => {
  for (const file of ['join.mts','ingress.mts']) {
    const url=new URL(`../${file}`,import.meta.url);
    const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(url.href)})`],{
      env:{PATH:process.env.PATH ?? '',PORT:'invalid',DB_PATH:'/unavailable',JOIN_ORIGIN:'invalid'},encoding:'utf8',timeout:3000,
    });
    assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,''); assert.equal(result.stderr,'');
  }
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import type { Pair, State } from '../contracts.mts';
const entry=(name: string)=>new URL(`../${name}.mts`,import.meta.url);
async function post(url: string, path: string, body: unknown, status: number): Promise<unknown> {
  const response=await jsonRequest(url+path,body);
  const value: unknown=await response.json();
  assert.equal(response.status,status,JSON.stringify(value)); return value;
}
async function snapshot(url: string): Promise<unknown> {
  const response=await fetch(url+'/state',{signal:AbortSignal.timeout(2000)});
  assert.equal(response.status,200); const value: unknown=await response.json(); return value;
}
// Validate state for type-safe test inspection; deepEqual additionally checks exact expected content.
function state(value: unknown): State {
  assert.ok(exact(value,['watermarks','events','pairs']));
  assert.ok(exact(value.watermarks,['left','right']));
  assert.ok(typeof value.watermarks.left === 'number' && typeof value.watermarks.right === 'number');
  assert.ok(Array.isArray(value.events) && value.events.every(eventValid));
  assert.ok(Array.isArray(value.pairs));
  const pairs=value.pairs.map((p: unknown): Pair=>{
    assert.ok(exact(p,['leftId','rightId','key','leftTime','rightTime','final']));
    assert.ok(typeof p.leftId === 'string' && typeof p.rightId === 'string');
    assert.ok(p.key === 'a' || p.key === 'b');
    assert.ok(typeof p.leftTime === 'number' && typeof p.rightTime === 'number' && typeof p.final === 'boolean');
    return {leftId:p.leftId,rightId:p.rightId,key:p.key,leftTime:p.leftTime,rightTime:p.rightTime,final:p.final};
  });
  return {watermarks:{left:value.watermarks.left,right:value.watermarks.right},events:value.events,pairs};
}
test('integration: two processes preserve out-of-order pairs across restart before and after finalization', async () => {
  const dir=await mkdtemp(join(tmpdir(),'interval70-'));
  let service: RunningService | undefined;
  let ingress: RunningService | undefined;
  try {
    const env={DB_PATH:join(dir,'join.sqlite'),STORE_ID:'restartdemo'};
    service=await startService(entry('join'),env);
    const originalURL=service.url;
    ingress=await startService(entry('ingress'),{JOIN_ORIGIN:originalURL});
    const url=ingress.url;
    assert.deepEqual(await post(url,'/events',event('r13','right',13),201),{id:'r13',duplicate:false});
    await post(url,'/events',event('r14','right',14),201);
    await post(url,'/events',event('l10','left',10),201);
    await post(url,'/events',event('b','left',10,'b'),201);
    const before=state(await snapshot(originalURL));
    assert.deepEqual(before.pairs,[{leftId:'l10',rightId:'r13',key:'a',leftTime:10,rightTime:13,final:false}]);
    await service.stop(); service=undefined;
    service=await startService(entry('join'),{...env,PORT:new URL(originalURL).port});
    assert.deepEqual(await snapshot(originalURL),before);
    assert.deepEqual(await post(url,'/events',event('r13','right',13),200),{id:'r13',duplicate:true});
    await post(url,'/watermark',{side:'right',time:12},200);
    await post(url,'/watermark',{side:'left',time:13},200);
    await post(url,'/events',event('r12','right',12),409);
    await post(url,'/events',event('r13','left',14),409);
    assert.equal(state(await snapshot(originalURL)).pairs[0]?.final,false);
    await post(url,'/watermark',{side:'right',time:13},200);
    const closed=state(await snapshot(originalURL)); assert.equal(closed.pairs[0]?.final,true);
    await service.stop(); service=undefined;
    service=await startService(entry('join'),{...env,PORT:new URL(originalURL).port});
    assert.deepEqual(await snapshot(originalURL),closed);
    await post(url,'/events',event('r13','right',13),200);
    await post(url,'/events',event('new','right',13),409);
    await post(url,'/watermark',{side:'right',time:12},409);
    assert.deepEqual(await snapshot(originalURL),closed);
    const direct=await fetch(url+'/state'); assert.equal(direct.status,404); await direct.arrayBuffer();
    for (const target of [url,originalURL]) {
      for (const value of [null,[],1,false,'x',{...event('x','left',15),extra:1},{...event('x','left',15),side:{toString:null}}]) await post(target,'/events',value,400);
      for (const value of [null,[],0,{side:'left',time:105},{side:{toString:null},time:14},{side:'right',time:14,extra:1}]) await post(target,'/watermark',value,400);
      const method=await fetch(target+'/events'); assert.equal(method.status,405); await method.arrayBuffer();
      const type=await fetch(target+'/events',{method:'POST',body:'{}'}); assert.equal(type.status,415); await type.arrayBuffer();
    }
    assert.deepEqual(await snapshot(originalURL),closed);
    await service.stop(); service=undefined;
    await assert.rejects(startService(entry('join'),{...env,STORE_ID:'different'}),/configuration mismatch/);
  } finally {
    try { await ingress?.stop(); } finally { try { await service?.stop(); } finally { await rm(dir,{recursive:true,force:true}); } }
  }
});
test('integration: 256-pair state exceeds relay bound while watermark acknowledgements remain small', async () => {
  const dir=await mkdtemp(join(tmpdir(),'dense70-'));
  let service: RunningService | undefined; let ingress: RunningService | undefined;
  try {
    service=await startService(entry('join'),{DB_PATH:join(dir,'dense.sqlite')});
    ingress=await startService(entry('ingress'),{JOIN_ORIGIN:service.url});
    for (let i=0;i<16;i++) {
      await post(ingress.url,'/events',event(`l${i}`,'left',10),201);
      await post(ingress.url,'/events',event(`r${i}`,'right',13),201);
    }
    const full=await snapshot(service.url);
    assert.ok(Buffer.byteLength(JSON.stringify(full))>8192); assert.equal(state(full).pairs.length,256);
    await post(ingress.url,'/events',event('overflow','left',10),429);
    assert.deepEqual(await snapshot(service.url),full);
    assert.deepEqual(await post(ingress.url,'/watermark',{side:'right',time:13},200),{watermarks:{left:-1,right:13}});
    assert.deepEqual(await post(ingress.url,'/watermark',{side:'left',time:13},200),{watermarks:{left:13,right:13}});
    assert.ok(state(await snapshot(service.url)).pairs.every(p=>p.final));
    await post(ingress.url,'/events',event('l0','left',10),200);
  } finally {
    try { await ingress?.stop(); } finally { try { await service?.stop(); } finally { await rm(dir,{recursive:true,force:true}); } }
  }
});
test('integration: ingress validates every semantic reply and bounds full bodies, deadlines and redirects', async () => {
  const fixture=await startService(new URL('./adversary.mts',import.meta.url));
  let ingress: RunningService | undefined;
  try {
    ingress=await startService(entry('ingress'),{JOIN_ORIGIN:fixture.url+'/'});
    const url=ingress.url;
    const control=async (mode: string)=>{ await post(fixture.url,'/control',{mode},200); };
    const e=event('x','left',10); const w={side:'right',time:13};
    for (const [mode,path,body,status] of [
      ['created','/events',e,201],['duplicate','/events',e,200],['late','/events',e,409],['conflict','/events',e,409],
      ['capacity','/events',e,429],['watermark','/watermark',w,200],['regression','/watermark',w,409],
    ] as const) { await control(mode); await post(url,path,body,status); }
    for (const path of ['/events','/watermark']) {
      for (const mode of ['unknown409','unknown429','primitive409','array429','wrongfields409','extraerror','wrongmessage','unexpected500']) {
        await control(mode); const body=await post(url,path,path==='/events'?e:w,502);
        assert.deepEqual(body,{error:{code:'upstream_failure',message:'Join reply unavailable or invalid'}});
      }
    }
    for (const mode of ['null','extra','wrongid','wrongduplicate','type','malformed','disconnect','oversize','oversize409','headersdelay','bodydelay']) {
      await control(mode); const began=performance.now(); await post(url,'/events',e,502);
      if (mode.endsWith('delay')) assert.ok(performance.now()-began<1200,'deadline covers full body');
    }
    await control('wrongmarks'); await post(url,'/watermark',w,502);
    await control('redirect'); await post(url,'/events',e,502);
    // Read this BEFORE any next fixture control; a 502 by itself is insufficient.
    const counter=await fetch(fixture.url+'/counter'); assert.deepEqual(await counter.json(),{count:0});
    await ingress.stop(); ingress=undefined;
    await assert.rejects(startService(entry('ingress'),{JOIN_ORIGIN:fixture.url,PORT:new URL(fixture.url).port}),/Origins must be distinct/);
    await fixture.stop();
    ingress=await startService(entry('ingress'),{JOIN_ORIGIN:fixture.url});
    await post(ingress.url,'/events',e,502); // reachable origin became unavailable
  } finally { try { await ingress?.stop(); } finally { await fixture.stop(); } }
});
