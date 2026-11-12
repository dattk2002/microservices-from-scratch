import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, object } from '../tracker.mts';

test('unit: exponential threshold crosses between 460 and 461ms', () => {
  const t = new Tracker();
  for (let i=0;i<4;i++) t.accept({incarnation:1,sequence:i+1},i*100);
  assert.deepEqual(t.state(760), {status:'healthy',phiMilli:1997,intervals:[100,100,100],last:{incarnation:1,sequence:4,receivedAt:300}});
  assert.deepEqual(t.state(761), {status:'suspect',phiMilli:2002,intervals:[100,100,100],last:{incarnation:1,sequence:4,receivedAt:300}});
});

test('unit: duplicates, invalid and stale replies cannot revive suspicion', () => {
  const t=new Tracker();
  for(let i=0;i<4;i++) t.accept({incarnation:1,sequence:i+1},i*100);
  const before=t.state(800);
  t.accept({incarnation:1,sequence:4},800);
  assert.deepEqual(t.state(800),before);
  for(const value of [null,[],true,1,{incarnation:9,sequence:5},{incarnation:1,sequence:33},{incarnation:1,sequence:0},{incarnation:1,sequence:1.5},{incarnation:1,sequence:3},{incarnation:0,sequence:5},{incarnation:1,sequence:5,x:1},{incarnation:1,sequence:'5'}]) {
    assert.throws(()=>t.accept(value,800)); assert.deepEqual(t.state(800),before);
  }
  t.accept({incarnation:1,sequence:5},800);
  assert.equal(t.state(800).status,'healthy');
  assert.deepEqual(t.state(800).intervals,[100,100,100,500]);
  t.accept({incarnation:1,sequence:6},800);
  assert.deepEqual(t.state(800).intervals,[100,100,100,500]);
  t.accept({incarnation:1,sequence:7},1000);
  assert.deepEqual(t.state(1000).intervals,[100,100,500,200]);
  t.accept({incarnation:2,sequence:1},1100);
  assert.deepEqual(t.state(1100),{status:'warming',phiMilli:null,intervals:[],last:{incarnation:2,sequence:1,receivedAt:1100}});
  assert.throws(()=>t.accept({incarnation:1,sequence:32},1200));
  assert.equal(new Tracker().state(1200).status,'unknown');
});

import { openBeacon, heartbeat } from '../beacon.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startService,jsonRequest } from '../../../test/support.mts';

test('unit: SQLite sequence ceiling leaves sequence unchanged',()=>{
  const db=openBeacon(':memory:','a');
  try {
    assert.throws(()=>heartbeat(db,true));
    for(let i=1;i<=32;i++) assert.equal(heartbeat(db).sequence,i);
    assert.throws(()=>heartbeat(db));assert.equal(heartbeat(db,true).sequence,32);
  } finally {db.close();}
});

test('unit: imports remain silent despite invalid runtime settings',()=>{
  const imports=['beacon','monitor'].map(n=>`await import(${JSON.stringify(new URL(`../${n}.mts`,import.meta.url).href)})`).join(';');
  const result=spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',imports],{env:{PATH:process.env.PATH,PORT:'bad',DB_PATH:'/no/such/directory/x',REPLICA_ID:'!',BEACON_ORIGIN:'bad'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

test('integration: fixed beacon, duplicates and outage preserve suspicion; restart is cold',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'phi-'));
  try {
    let beacon=await startService(new URL('../beacon.mts',import.meta.url),{DB_PATH:join(directory,'b.sqlite'),REPLICA_ID:'a',TEACHING_CONTROLS:'1'});
    try {
      const monitor=await startService(new URL('../monitor.mts',import.meta.url),{BEACON_ORIGIN:beacon.url,TEACHING_CONTROLS:'1'});
      try {
        const state=async()=> (await fetch(monitor.url+'/state')).json();
        assert.deepEqual(await state(),{status:'unknown',phiMilli:null,intervals:[],last:null});
        for(const body of [null,[],1,'x',{x:1}]) assert.equal((await jsonRequest(monitor.url+'/sample',body)).status,400);
        for(let i=0;i<4;i++) {
          if(i) await jsonRequest(monitor.url+'/teaching/advance',{milliseconds:100});
          assert.equal((await jsonRequest(monitor.url+'/sample',{})).status,200);
        }
        await jsonRequest(monitor.url+'/teaching/advance',{milliseconds:461});
        const suspected=await state();
        assert.equal(object(suspected,['status','phiMilli','intervals','last']) && suspected.status,'suspect');
        await jsonRequest(beacon.url+'/teaching/behavior',{mode:'duplicate'});
        assert.deepEqual(await (await jsonRequest(monitor.url+'/sample',{})).json(),suspected);
        await jsonRequest(beacon.url+'/teaching/behavior',{mode:'unavailable'});
        assert.equal((await jsonRequest(monitor.url+'/sample',{})).status,502);assert.deepEqual(await state(),suspected);
        const restartPort=new URL(beacon.url).port;
        await beacon.stop();
        beacon=await startService(new URL('../beacon.mts',import.meta.url),{DB_PATH:join(directory,'b.sqlite'),REPLICA_ID:'a',TEACHING_CONTROLS:'1',PORT:restartPort});
        assert.deepEqual(await (await jsonRequest(monitor.url+'/sample',{})).json(),{status:'warming',phiMilli:null,intervals:[],last:{incarnation:2,sequence:1,receivedAt:761}});
        // A new monitor fixes its origin at startup; old origin is never supplied in requests.
        const fresh=await startService(new URL('../monitor.mts',import.meta.url),{BEACON_ORIGIN:beacon.url,TEACHING_CONTROLS:'1'});
        try {
          assert.deepEqual(await (await fetch(fresh.url+'/state')).json(),{status:'unknown',phiMilli:null,intervals:[],last:null});
          const reply:unknown=await (await jsonRequest(fresh.url+'/sample',{})).json();
          assert.deepEqual(reply,{status:'warming',phiMilli:null,intervals:[],last:{incarnation:2,sequence:2,receivedAt:0}});
        } finally {await fresh.stop();}
      } finally {await monitor.stop();}
    } finally {await beacon.stop();}
    assert.throws(()=>openBeacon(join(directory,'b.sqlite'),'other'));
    for(let incarnation=3;incarnation<=8;incarnation++) {
      const db=openBeacon(join(directory,'b.sqlite'),'a');
      try {assert.equal(heartbeat(db).incarnation,incarnation);} finally {db.close();}
    }
    assert.throws(()=>openBeacon(join(directory,'b.sqlite'),'a'));
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('integration: upstream body budget, deadline, redirects and overlap are contained',async()=>{
  const destination=await startService(new URL('./fixture.mts',import.meta.url));
  try {
    const source=await startService(new URL('./fixture.mts',import.meta.url),{TARGET_ORIGIN:destination.url+'/heartbeat'});
    try {
      const monitor=await startService(new URL('../monitor.mts',import.meta.url),{BEACON_ORIGIN:source.url,TEACHING_CONTROLS:'1'});
      try {
        for(const mode of ['normal','escaped']) {
          await jsonRequest(source.url+'/mode',{mode});assert.equal((await jsonRequest(monitor.url+'/sample',{})).status,200);
        }
        const before=await (await fetch(monitor.url+'/state')).json();
        for(const mode of ['redirect','oversize','invalid','unavailable','slow']) {
          await jsonRequest(source.url+'/mode',{mode});
          assert.equal((await jsonRequest(monitor.url+'/sample',{})).status,502);
          if(mode==='redirect') assert.deepEqual(await (await fetch(destination.url+'/count')).json(),{requests:0});
          assert.deepEqual(await (await fetch(monitor.url+'/state')).json(),before);
        }
        // Counter is a deterministic barrier: the first sample has entered the upstream.
        const initial:unknown=await (await fetch(source.url+'/count')).json();
        assert.ok(object(initial,['requests']) && typeof initial.requests==='number');
        const baseline=initial.requests;
        const pending=jsonRequest(monitor.url+'/sample',{});
        let entered=false;
        for(let n=0;n<50;n++) {
          const count:unknown=await (await fetch(source.url+'/count')).json();
          if(object(count,['requests']) && typeof count.requests==='number' && count.requests>baseline) {entered=true;break;}
        }
        assert.ok(entered,'upstream sample entered before overlap');
        assert.equal((await jsonRequest(monitor.url+'/sample',{})).status,409);
        assert.equal((await pending).status,502);
      } finally {await monitor.stop();}
    } finally {await source.stop();}
  } finally {await destination.stop();}
});

test('integration: teaching gates and strict clock/body validation',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'phi-gates-'));
  try {
    const beacon=await startService(new URL('../beacon.mts',import.meta.url),{DB_PATH:join(directory,'b')});
    try {
      assert.equal((await jsonRequest(beacon.url+'/teaching/behavior',{mode:'duplicate'})).status,404);
      const monitor=await startService(new URL('../monitor.mts',import.meta.url),{BEACON_ORIGIN:beacon.url});
      try {assert.equal((await jsonRequest(monitor.url+'/teaching/advance',{milliseconds:1})).status,404);} finally {await monitor.stop();}
      const controlled=await startService(new URL('../monitor.mts',import.meta.url),{BEACON_ORIGIN:beacon.url,TEACHING_CONTROLS:'1'});
      try {
        for(const value of [null,[],1,{milliseconds:'1'},{milliseconds:0},{milliseconds:1001},{milliseconds:1,x:1}]) assert.equal((await jsonRequest(controlled.url+'/teaching/advance',value)).status,400);
        for(let i=0;i<60;i++) assert.equal((await jsonRequest(controlled.url+'/teaching/advance',{milliseconds:1000})).status,200);
        assert.equal((await jsonRequest(controlled.url+'/teaching/advance',{milliseconds:1})).status,400);
      } finally {await controlled.stop();}
    } finally {await beacon.stop();}
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('integration: beacon sequence ceiling and strict teaching bodies',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'phi-sequence-'));
  try {
    const beacon=await startService(new URL('../beacon.mts',import.meta.url),{DB_PATH:join(directory,'b'),TEACHING_CONTROLS:'1'});
    try {
      for(const value of [null,[],1,{mode:1},{mode:[]},{mode:{toString:null}},{mode:'normal',x:1},{mode:'bogus'}]) assert.equal((await jsonRequest(beacon.url+'/teaching/behavior',value)).status,400);
      await jsonRequest(beacon.url+'/teaching/behavior',{mode:'duplicate'});
      assert.equal((await fetch(beacon.url+'/heartbeat')).status,409);
      await jsonRequest(beacon.url+'/teaching/behavior',{mode:'normal'});
      for(let sequence=1;sequence<=32;sequence++) assert.deepEqual(await (await fetch(beacon.url+'/heartbeat')).json(),{incarnation:1,sequence});
      assert.equal((await fetch(beacon.url+'/heartbeat')).status,429);
      await jsonRequest(beacon.url+'/teaching/behavior',{mode:'duplicate'});
      assert.deepEqual(await (await fetch(beacon.url+'/heartbeat')).json(),{incarnation:1,sequence:32});
    } finally {await beacon.stop();}
  } finally {await rm(directory,{recursive:true,force:true});}
});
