import test from 'node:test';
import assert from 'node:assert/strict';
// This assertion catches resetting the logical counter during physical rollback.
test('unit: rollback and receive tie branches have independently calculated stamps', async () => {
  const { advance } = await import('../model.mts');
  assert.deepEqual(advance({wall:100,counter:4}, 90), {wall:100,counter:5});
  assert.deepEqual(advance({wall:100,counter:4}, 100, {wall:100,counter:8}), {wall:100,counter:9});
  assert.deepEqual(advance({wall:100,counter:4}, 90, {wall:95,counter:8}), {wall:100,counter:5});
  assert.deepEqual(advance({wall:100,counter:4}, 90, {wall:110,counter:8}), {wall:110,counter:9});
  assert.deepEqual(advance({wall:100,counter:4}, 120, {wall:110,counter:8}), {wall:120,counter:0});
});
import { Store,advance,compare } from '../model.mts';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { spawnSync } from 'node:child_process';

test('unit: counter boundary, same time, future rejection and replay are atomic',()=>{
  assert.deepEqual(advance({wall:100,counter:0},100),{wall:100,counter:1});
  assert.deepEqual(advance({wall:100,counter:65534},90),{wall:100,counter:65535});
  const last={wall:100,counter:65535}; assert.throws(()=>advance(last,90),{status:429}); assert.deepEqual(last,{wall:100,counter:65535});
  assert.ok(compare({wall:100,counter:1,replica:'a'},{wall:100,counter:1,replica:'b'})<0);
  assert.ok(compare({wall:100,counter:65535,replica:'b'},{wall:101,counter:0,replica:'a'})<0);
  assert.ok(compare({wall:100,counter:2,replica:'a'},{wall:100,counter:1,replica:'b'})>0);
  assert.equal(compare({wall:100,counter:1,replica:'a'},{wall:100,counter:1,replica:'a'}),0);
  const s=new Store(':memory:','b');
  try {
    const e={id:'r',payload:'x',stamp:{wall:1100,counter:65534,replica:'a'}};
    assert.deepEqual(s.receive(e,100),{status:201,body:{clock:{wall:1100,counter:65535}}});
    const before=s.state();
    assert.equal(s.receive(e,0).status,200); assert.deepEqual(s.state(),before);
    assert.throws(()=>s.create({id:'x',payload:'x'},100),{status:429});
    assert.throws(()=>s.receive({...e,payload:'y'},100),{status:409});
    assert.throws(()=>s.receive({...e,id:'far',stamp:{...e.stamp,wall:1101}},100),{status:422});
    assert.deepEqual(s.state(),before);
    for(const invalid of [null,[],false,1,'x',{id:'x',payload:'x',extra:1}]) assert.throws(()=>s.create(invalid,1),{status:400});
    for(const invalid of [null,[],false,{}, {...e,extra:1},{...e,stamp:{...e.stamp,counter:'1'}}]) assert.throws(()=>s.receive(invalid,1),{status:400});
  } finally {s.db.close();}
});

test('unit: eight events in each direction, local replay before capacity',()=>{
  const s=new Store(':memory:','a');
  try {
    for(let i=0;i<8;i++) {s.create({id:`c${i}`,payload:'x'},100);s.receive({id:`r${i}`,payload:'x',stamp:{wall:100,counter:i,replica:'b'}},100);}
    const before=s.state(); assert.equal(before.created.length+before.received.length,16);
    assert.equal(s.create({id:'c0',payload:'x'},0).status,200);
    assert.throws(()=>s.create({id:'overflow',payload:'x'},100),{status:429});
    assert.throws(()=>s.receive({id:'overflow',payload:'x',stamp:{wall:100,counter:0,replica:'b'}},100),{status:429});
    assert.deepEqual(s.state(),before);
  } finally {s.db.close();}
});

test('unit: imports remain silent despite invalid runtime settings',()=>{
  const r=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../clock-service.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('../relay.mts',import.meta.url).href)});`],{encoding:'utf8',env:{PATH:process.env.PATH,REPLICA_ID:'invalid',PORT:'bad',DB_PATH:'/unavailable/no',A_ORIGIN:'bad',B_ORIGIN:'bad'}});
  assert.equal(r.status,0,r.stderr);assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});

async function value(url:string):Promise<unknown> {return (await fetch(url,{signal:AbortSignal.timeout(2000)})).json();}

test('integration: causal delivery, rollback, replay, restart and replica identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hlc-'));
  const services:RunningService[]=[];
  try {
    const start=async(replica:string)=>{const s=await startService(new URL('../clock-service.mts',import.meta.url),{REPLICA_ID:replica,DB_PATH:join(dir,`${replica}.db`),TEACHING_CONTROLS:'1'});services.push(s);return s;};
    const a=await start('a');let b=await start('b');
    const relay=await startService(new URL('../relay.mts',import.meta.url),{A_ORIGIN:a.url,B_ORIGIN:b.url});services.push(relay);
    const a1=await jsonRequest(a.url+'/events',{id:'a1',payload:'hello'});assert.equal(a1.status,201);
    const original:unknown=await a1.json();assert.deepEqual(original,{id:'a1',payload:'hello',stamp:{wall:1700000000000,counter:0,replica:'a'}});
    const deliver=()=>jsonRequest(relay.url+'/deliver',{from:'a',id:'a1'});
    assert.deepEqual(await (await deliver()).json(),{clock:{wall:1700000000000,counter:1}});
    assert.deepEqual(await (await jsonRequest(b.url+'/events',{id:'b1',payload:'world'})).json(),{id:'b1',payload:'world',stamp:{wall:1700000000000,counter:2,replica:'b'}});
    const before=await value(b.url+'/state');
    assert.deepEqual(await (await deliver()).json(),{clock:{wall:1700000000000,counter:1}});
    assert.deepEqual(await value(b.url+'/state'),before);
    const aBefore=await value(a.url+'/state');
    assert.deepEqual(await (await jsonRequest(a.url+'/events',{id:'a1',payload:'hello'})).json(),original);
    assert.deepEqual(await value(a.url+'/state'),aBefore);
    assert.equal((await jsonRequest(a.url+'/events',{id:'a1',payload:'changed'})).status,409);
    assert.equal((await jsonRequest(b.url+'/receive',{id:'a1',payload:'changed',stamp:{wall:1700000000000,counter:0,replica:'a'}})).status,409);
    assert.deepEqual(await value(b.url+'/state'),before);
    await jsonRequest(b.url+'/teaching/clock',{offset:-2000});
    assert.deepEqual(await (await jsonRequest(b.url+'/events',{id:'b2',payload:'rollback'})).json(),{id:'b2',payload:'rollback',stamp:{wall:1700000000000,counter:3,replica:'b'}});
    await b.stop();b=await start('b');
    assert.deepEqual(await (await jsonRequest(b.url+'/events',{id:'b3',payload:'restart'})).json(),{id:'b3',payload:'restart',stamp:{wall:1700000000000,counter:4,replica:'b'}});
    const stable=await value(b.url+'/state');
    await assert.rejects(startService(new URL('../clock-service.mts',import.meta.url),{REPLICA_ID:'a',DB_PATH:join(dir,'b.db')}),/identity mismatch/);
    assert.deepEqual(await value(b.url+'/state'),stable);
    await jsonRequest(a.url+'/teaching/clock',{offset:10000});
    assert.equal((await jsonRequest(a.url+'/events',{id:'future',payload:'x'})).status,201);
    assert.equal((await jsonRequest(b.url+'/receive',{id:'future',payload:'x',stamp:{wall:1700000010000,counter:0,replica:'a'}})).status,422);
    assert.deepEqual(await value(b.url+'/state'),stable);
    for(const invalid of [null,[],true,3,{offset:'1'},{offset:1,extra:0}]) assert.equal((await jsonRequest(b.url+'/teaching/clock',invalid)).status,400);
    for(const invalid of [null,[],true,3,{from:'a',id:'x',origin:a.url}]) assert.equal((await jsonRequest(relay.url+'/deliver',invalid)).status,400);
    assert.equal((await jsonRequest(relay.url+'/deliver',{from:'a',id:'absent'})).status,404);
  } finally {try {await Promise.all(services.map(s=>s.stop()));} finally {await rm(dir,{recursive:true,force:true});}}
});

test('integration: bounded relay validates both hops, escaping, redirects and deadline',async()=>{
  const services:RunningService[]=[];
  try {
    const start=async()=>{const s=await startService(new URL('./fixture.mts',import.meta.url));services.push(s);return s;};
    const source=await start(),receiver=await start(),destination=await start();
    const relay=await startService(new URL('../relay.mts',import.meta.url),{A_ORIGIN:source.url,B_ORIGIN:receiver.url});services.push(relay);
    const mode=async(s:RunningService,name:string)=>{assert.equal((await jsonRequest(s.url+'/mode',{mode:name,destination:destination.url+'/capture'})).status,200);};
    const deliver=()=>jsonRequest(relay.url+'/deliver',{from:'a',id:'abcdefghijklmnop'});
    assert.equal((await deliver()).status,200);
    for(const s of [source,receiver]) {
      await mode(s,'escaped');assert.deepEqual(await (await deliver()).json(),{clock:{wall:1700000000000,counter:1}});await mode(s,'ok');
      for(const variant of ['status','primitive','extra','malformed','oversize','slow','body-slow']) {
        await mode(s,variant);assert.equal((await deliver()).status,502,variant);await mode(s,'ok');
      }
      const before=await value(destination.url+'/hits');
      await mode(s,'redirect');assert.equal((await deliver()).status,502);
      assert.deepEqual(await value(destination.url+'/hits'),before); // Inspect BEFORE changing fixture mode.
      await mode(s,'ok');
    }
    await mode(source,'delay');await mode(receiver,'delay');assert.equal((await deliver()).status,502);
    await mode(source,'ok');await mode(receiver,'ok');
    for(const variant of ['absent-null','absent-array','absent-extra','absent-unexpected']) {
      await mode(source,variant);const before=await value(receiver.url+'/hits');assert.equal((await deliver()).status,502,variant);assert.deepEqual(await value(receiver.url+'/hits'),before);
    }
    await mode(source,'absent');const beforeAbsent=await value(receiver.url+'/hits');assert.equal((await deliver()).status,404);assert.deepEqual(await value(receiver.url+'/hits'),beforeAbsent);
    await mode(source,'ok');
    for(const variant of ['unexpected409','unexpected422','unexpected429']) {await mode(receiver,variant);assert.equal((await deliver()).status,502,variant);}
    await mode(receiver,'ok');
    for(const variant of ['wrong-id','wrong-replica']) {await mode(source,variant);assert.equal((await deliver()).status,502);}
    await mode(source,'ok');
    for(const variant of ['bad-clock','extra-clock','bad-error']) {await mode(receiver,variant);assert.equal((await deliver()).status,502);}
    for(const [variant,status] of [['reject',422],['reject409',409],['reject429',429]] as const) {await mode(receiver,variant);assert.equal((await deliver()).status,status);}
    await assert.rejects(startService(new URL('../relay.mts',import.meta.url),{A_ORIGIN:source.url,B_ORIGIN:source.url+'/'}),/Origins must differ/);
  } finally {await Promise.all(services.map(s=>s.stop()));}
});

test('integration: sixteen durable events, schema failures and disabled controls',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'hlc-capacity-'));const services:RunningService[]=[];
  try {
    const a=await startService(new URL('../clock-service.mts',import.meta.url),{REPLICA_ID:'a',DB_PATH:join(dir,'a.db'),TEACHING_CONTROLS:'1'});services.push(a);
    for(let i=0;i<8;i++) {
      assert.equal((await jsonRequest(a.url+'/events',{id:`c${i}`,payload:'x'})).status,201);
      assert.equal((await jsonRequest(a.url+'/receive',{id:`r${i}`,payload:'x',stamp:{wall:1700000000000,counter:i,replica:'b'}})).status,201);
    }
    const before=await value(a.url+'/state');
    assert.equal((await jsonRequest(a.url+'/events',{id:'extra',payload:'x'})).status,429);
    assert.equal((await jsonRequest(a.url+'/receive',{id:'extra',payload:'x',stamp:{wall:1700000000000,counter:0,replica:'b'}})).status,429);
    for(const path of ['/events','/receive']) for(const v of [null,[],true,1,'x',{}]) assert.equal((await jsonRequest(a.url+path,v)).status,400);
    assert.deepEqual(await value(a.url+'/state'),before);
    const normal=await startService(new URL('../clock-service.mts',import.meta.url),{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')});services.push(normal);
    assert.equal((await jsonRequest(normal.url+'/teaching/clock',{offset:1})).status,404);
  } finally {try {await Promise.all(services.map(s=>s.stop()));} finally {await rm(dir,{recursive:true,force:true});}}
});
