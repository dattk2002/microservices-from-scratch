import test from 'node:test';
import assert from 'node:assert/strict';
import { sessions } from '../core.mts';
import type { Event } from '../core.mts';

const event = (id: string, time: number, value = 1, key: 'a' | 'b' = 'a'): Event => ({id,key,time,value});

// Catches using fixed buckets, a strict gap, or merging only the immediately preceding arrival.
test('unit: out-of-order bridge merges inclusive gap3 components in every arrival order', () => {
  const first=event('first',0,1), last=event('last',6,2), bridge=event('bridge',3,4);
  assert.deepEqual(sessions([first,last],-1),[
    {key:'a',start:0,end:0,count:1,sum:1,final:false},
    {key:'a',start:6,end:6,count:1,sum:2,final:false},
  ]);
  for (const order of [[first,last,bridge],[first,bridge,last],[last,first,bridge],
    [last,bridge,first],[bridge,first,last],[bridge,last,first]]) {
    assert.deepEqual(sessions(order,8),[{key:'a',start:0,end:6,count:3,sum:7,final:false}]);
    assert.deepEqual(sessions(order,9),[{key:'a',start:0,end:6,count:3,sum:7,final:true}]);
  }
});

import { SessionStore } from '../store.mts';
import { eventValid, watermarkValid, input, replyValid, origin } from '../contracts.mts';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('unit: gap4 separates, equal-time ids count, keys stay separate and input is not mutated', () => {
  const events=[event('b',3,9,'b'),event('z',4,2),event('a',0,0),event('n',4,3)];
  const before=structuredClone(events);
  assert.deepEqual(sessions(events,6),[
    {key:'a',start:0,end:0,count:1,sum:0,final:true},
    {key:'a',start:4,end:4,count:2,sum:5,final:false},
    {key:'b',start:3,end:3,count:1,sum:9,final:true},
  ]);
  assert.deepEqual(events,before);
});
test('unit: durable acceptance merges receipts, finalizes at9 and checks replay before lateness', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try {
    const s=new SessionStore(db);
    assert.deepEqual(s.state(),{watermark:-1,sessions:[]});
    assert.deepEqual(s.event(event('first',0,1)),{id:'first',duplicate:false});
    s.event(event('last',6,2)); s.event(event('bridge',3,4)); s.event(event('b',0,8,'b'));
    assert.deepEqual(s.watermark(8),{watermark:8});
    assert.deepEqual(s.state(),{watermark:8,sessions:[
      {key:'a',start:0,end:6,count:3,sum:7,final:false},
      {key:'b',start:0,end:0,count:1,sum:8,final:true},
    ]});
    s.watermark(9);
    const closed=s.state();
    assert.ok(closed.sessions.every(s=>s.final));
    assert.throws(()=>s.event(event('new',9)),{status:409,code:'late_event',message:'late_event'});
    assert.deepEqual(s.event(event('bridge',3,4)),{id:'bridge',duplicate:true});
    for (const e of [event('bridge',3,5),event('bridge',4,4),event('bridge',3,4,'b')]) {
      assert.throws(()=>s.event(e),{status:409,code:'id_conflict',message:'id_conflict'});
    }
    assert.throws(()=>s.watermark(8),{status:409,code:'watermark_regression'});
    assert.deepEqual(s.state(),closed);
    s.event(event('future',10));
    assert.deepEqual(s.state().sessions.slice(0,1),closed.sessions.slice(0,1));
  } finally { db.close(); }
});
test('unit: global32 receipt cap never recycles and rejected writes are atomic', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try {
    const s=new SessionStore(db);
    for (let i=0;i<32;i++) s.event(event(`e${i}`,i,1,i%2===0?'a':'b'));
    const full=s.state();
    assert.throws(()=>s.event(event('overflow',90)),{status:429,code:'capacity',message:'capacity'});
    assert.deepEqual(s.state(),full);
    s.watermark(50);
    assert.throws(()=>s.event(event('overflow',90)),{code:'capacity'});
    assert.deepEqual(s.event(event('e0',0)),{id:'e0',duplicate:true});
    assert.throws(()=>s.event(event('e0',0,2)),{code:'id_conflict'});
    assert.throws(()=>s.event(event('late',50)),{code:'late_event'});
    assert.ok(s.state().sessions.every(s=>s.final));
  } finally { db.close(); }
});
test('unit: receipt and watermark transactions roll back SQL failures', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try {
    const s=new SessionStore(db); s.event(event('first',0));
    const before=s.state();
    db.exec("CREATE TRIGGER fail_event AFTER INSERT ON receipts BEGIN SELECT RAISE(ABORT,'injected event'); END");
    assert.throws(()=>s.event(event('second',3)),/injected event/);
    assert.deepEqual(s.state(),before);
    db.exec('DROP TRIGGER fail_event');
    assert.deepEqual(s.event(event('second',3)),{id:'second',duplicate:false});
    const provisional=s.state();
    db.exec("CREATE TRIGGER fail_mark AFTER UPDATE ON watermark BEGIN SELECT RAISE(ABORT,'injected watermark'); END");
    assert.throws(()=>s.watermark(6),/injected watermark/);
    assert.deepEqual(s.state(),provisional);
    db.exec('DROP TRIGGER fail_mark');
    assert.deepEqual(s.watermark(6),{watermark:6});
    assert.equal(s.state().sessions[0]?.final,true);
  } finally { db.close(); }
});
test('unit: reinitializing a store preserves receipts, watermark and configured identity', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try {
    const first=new SessionStore(db,'sourceone'); first.event(event('kept',7)); first.watermark(10);
    assert.throws(()=>new SessionStore(db,'other'),/configuration mismatch/);
    const s=new SessionStore(db,'sourceone');
    assert.deepEqual(s.state(),{watermark:10,sessions:[{key:'a',start:7,end:7,count:1,sum:1,final:true}]});
    assert.deepEqual(s.event(event('kept',7)),{id:'kept',duplicate:true});
    assert.throws(()=>s.watermark(9),{code:'watermark_regression'});
    assert.throws(()=>s.event(event('new',10)),{code:'late_event'});
  } finally { db.close(); }
});
test('unit: request schemas reject coercion, extras, primitives and out-of-range values', () => {
  for (const v of [null,[],0,false,'x',{}, {...event('x',0),extra:0}, {...event('x',0),id:'X'},
    {...event('x',0),id:''}, {...event('x',0),id:'a'.repeat(17)}, {...event('x',0),id:{toString:null}},
    {...event('x',0),key:{toString:null}}, {...event('x',0),time:'0'}, {...event('x',0),time:101},
    {...event('x',0),time:-1}, {...event('x',0),value:10}, {...event('x',0),value:0.5}]) {
    assert.equal(eventValid(v),false); assert.throws(()=>input('/events',v),{status:400,code:'invalid_request'});
  }
  for (const v of [null,[],1,true,'0',{}, {time:'0'}, {time:{toString:null}}, {time:-1}, {time:104},
    {time:0.5}, {time:0,extra:1}]) {
    assert.equal(watermarkValid(v),false); assert.throws(()=>input('/watermark',v),{status:400,code:'invalid_request'});
  }
  assert.deepEqual(input('/events',event('abc012',100,9)),event('abc012',100,9));
  assert.deepEqual(input('/watermark',{time:103}),{time:103});
  assert.ok(watermarkValid({time:0}));
});
test('unit: relay preserves only exact ACKs and endpoint-specific recognized semantic errors', () => {
  const e=event('x',10), w={time:13};
  assert.ok(replyValid('/events',e,201,{id:'x',duplicate:false}));
  assert.ok(replyValid('/events',e,200,{id:'x',duplicate:true}));
  assert.ok(replyValid('/watermark',w,200,{watermark:13}));
  for (const [code,status] of [['id_conflict',409],['late_event',409],['capacity',429]] as const) {
    assert.ok(replyValid('/events',e,status,{error:{code,message:code}}));
  }
  assert.ok(replyValid('/watermark',w,409,{error:{code:'watermark_regression',message:'watermark_regression'}}));
  for (const path of ['/events','/watermark']) {
    for (const status of [409,429]) {
      for (const v of [null,[],1,'x',{}, {error:{code:'internal_error',message:'internal_error'}},
        {error:{code:'late_event',message:'wrong'}}, {error:{code:'late_event',message:'late_event',extra:1}},
        {error:{code:'capacity',message:'capacity'},extra:1}]) {
        assert.equal(replyValid(path,path==='/events'?e:w,status,v),false);
      }
    }
  }
  for (const v of [{id:'other',duplicate:false},{id:'x',duplicate:true},{id:'x',duplicate:0},
    {id:'x',duplicate:false,source:'lesson71'}]) assert.equal(replyValid('/events',e,201,v),false);
  for (const v of [{watermark:12},{watermark:'13'},{watermark:13,source:'lesson71'},null,[]]) assert.equal(replyValid('/watermark',w,200,v),false);
  assert.equal(replyValid('/events',e,409,{error:{code:'watermark_regression',message:'watermark_regression'}}),false);
  assert.equal(replyValid('/watermark',w,409,{error:{code:'late_event',message:'late_event'}}),false);
  assert.equal(replyValid('/watermark',w,429,{error:{code:'capacity',message:'capacity'}}),false);
  assert.equal(replyValid('/events',e,500,{error:{code:'late_event',message:'late_event'}}),false);
});
test('unit: configured origin normalizes loopback HTTP and rejects paths, credentials and other hosts', () => {
  assert.equal(origin('http://127.0.0.1:7072/'),'http://127.0.0.1:7072');
  assert.equal(origin('http://127.0.0.1:080/'),'http://127.0.0.1');
  for (const raw of [undefined,'invalid','http://localhost:7072','https://127.0.0.1:7072',
    'http://127.0.0.1:0','http://user:pass@127.0.0.1:7072','http://127.0.0.1:7072/path',
    'http://127.0.0.1:7072/?q=1','http://127.0.0.1:7072/#x']) assert.throws(()=>origin(raw));
});

test('unit: entrypoints import silently even with invalid environment', () => {
  for (const file of ['sessions.mts','ingress.mts']) {
    const entry=new URL(`../${file}`,import.meta.url);
    const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(entry.href)})`],{
      env:{PATH:process.env.PATH ?? '',PORT:'invalid',HOST:'invalid',DB_PATH:'/unavailable',SOURCE_ID:'!',SESSION_ORIGIN:'invalid'},
      encoding:'utf8',timeout:3000,
    });
    assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,''); assert.equal(result.stderr,'');
  }
});

import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
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
const error=(code: string)=>({error:{code,message:code}});

test('integration: independent relay and SQLite service merge a late bridge and persist finality across restart', async () => {
  const dir=await mkdtemp(join(tmpdir(),'session71-http-'));
  let service: RunningService | undefined; let ingress: RunningService | undefined;
  try {
    const env={DB_PATH:join(dir,'sessions.sqlite'),SOURCE_ID:'restartdemo'};
    service=await startService(entry('sessions'),env);
    const sourceURL=service.url;
    ingress=await startService(entry('ingress'),{SESSION_ORIGIN:sourceURL+'/'});
    const url=ingress.url;
    assert.deepEqual(await snapshot(sourceURL),{watermark:-1,sessions:[]});
    assert.deepEqual(await post(url,'/events',event('first',0,1),201),{id:'first',duplicate:false});
    await post(url,'/events',event('last',6,2),201);
    assert.deepEqual(await snapshot(sourceURL),{watermark:-1,sessions:[
      {key:'a',start:0,end:0,count:1,sum:1,final:false},
      {key:'a',start:6,end:6,count:1,sum:2,final:false},
    ]});
    await post(url,'/events',event('bridge',3,4),201);
    await post(url,'/events',event('b',0,8,'b'),201);
    const merged={watermark:8,sessions:[
      {key:'a',start:0,end:6,count:3,sum:7,final:false},
      {key:'b',start:0,end:0,count:1,sum:8,final:true},
    ]};
    assert.deepEqual(await post(url,'/watermark',{time:8},200),{watermark:8});
    assert.deepEqual(await post(url,'/watermark',{time:8},200),{watermark:8});
    assert.deepEqual(await snapshot(sourceURL),merged);
    await service.stop(); service=undefined;
    service=await startService(entry('sessions'),{...env,PORT:new URL(sourceURL).port});
    assert.deepEqual(await snapshot(sourceURL),merged);
    assert.deepEqual(await post(url,'/events',event('bridge',3,4),200),{id:'bridge',duplicate:true});
    await post(url,'/watermark',{time:9},200);
    const closed={watermark:9,sessions:[
      {key:'a',start:0,end:6,count:3,sum:7,final:true},
      {key:'b',start:0,end:0,count:1,sum:8,final:true},
    ]};
    assert.deepEqual(await snapshot(sourceURL),closed);
    assert.deepEqual(await post(url,'/events',event('new',9),409),error('late_event'));
    assert.deepEqual(await post(url,'/events',event('bridge',3,5),409),error('id_conflict'));
    assert.deepEqual(await post(url,'/watermark',{time:8},409),error('watermark_regression'));
    await service.stop(); service=undefined;
    service=await startService(entry('sessions'),{...env,PORT:new URL(sourceURL).port});
    assert.deepEqual(await snapshot(sourceURL),closed);
    await post(url,'/events',event('first',0,1),200);
    assert.deepEqual(await post(url,'/events',event('new',9),409),error('late_event'));
    for (const target of [url,sourceURL]) {
      for (const v of [null,[],false,1,'x',{...event('x',10),extra:1},{...event('x',10),key:{toString:null}}]) {
        assert.deepEqual(await post(target,'/events',v,400),error('invalid_request'));
      }
      for (const v of [null,[],1,{time:104},{time:{toString:null}},{time:10,extra:1}]) {
        assert.deepEqual(await post(target,'/watermark',v,400),error('invalid_request'));
      }
      const method=await fetch(target+'/events'); assert.equal(method.status,405); await method.arrayBuffer();
      const type=await fetch(target+'/events',{method:'POST',body:'{}'}); assert.equal(type.status,415); await type.arrayBuffer();
      const malformed=await fetch(target+'/events',{method:'POST',headers:{'content-type':'application/json'},body:'{'});
      assert.equal(malformed.status,400); assert.deepEqual(await malformed.json(),error('invalid_json'));
    }
    const hidden=await fetch(url+'/state'); assert.equal(hidden.status,404); await hidden.arrayBuffer();
    assert.deepEqual(await snapshot(sourceURL),closed);
    await service.stop(); service=undefined;
    await assert.rejects(startService(entry('sessions'),{...env,SOURCE_ID:'different'}),/configuration mismatch/);
  } finally {
    try { await ingress?.stop(); } finally { try { await service?.stop(); } finally { await rm(dir,{recursive:true,force:true}); } }
  }
});
test('integration: global receipt cap remains atomic after closure and process restart', async () => {
  const dir=await mkdtemp(join(tmpdir(),'session71-cap-'));
  let service: RunningService | undefined; let ingress: RunningService | undefined;
  try {
    const env={DB_PATH:join(dir,'capacity.sqlite')};
    service=await startService(entry('sessions'),env);
    const sourceURL=service.url;
    ingress=await startService(entry('ingress'),{SESSION_ORIGIN:sourceURL});
    for (let i=0;i<32;i++) await post(ingress.url,'/events',event(`e${i}`,i),201);
    const full=await snapshot(sourceURL);
    assert.deepEqual(await post(ingress.url,'/events',event('overflow',100),429),error('capacity'));
    assert.deepEqual(await snapshot(sourceURL),full);
    await post(ingress.url,'/watermark',{time:50},200);
    const closed=await snapshot(sourceURL);
    await service.stop(); service=undefined;
    service=await startService(entry('sessions'),{...env,PORT:new URL(sourceURL).port});
    assert.deepEqual(await snapshot(sourceURL),closed);
    assert.deepEqual(await post(ingress.url,'/events',event('overflow',100),429),error('capacity'));
    assert.deepEqual(await post(ingress.url,'/events',event('e0',0),200),{id:'e0',duplicate:true});
    assert.deepEqual(await post(ingress.url,'/events',event('e0',0,2),409),error('id_conflict'));
    assert.deepEqual(await snapshot(sourceURL),closed);
  } finally {
    try { await ingress?.stop(); } finally { try { await service?.stop(); } finally { await rm(dir,{recursive:true,force:true}); } }
  }
});
test('integration: relay rejects hostile schemas, redirects and full-body deadline/byte violations', async () => {
  const fixture=await startService(new URL('./adversary.mts',import.meta.url));
  let ingress: RunningService | undefined;
  try {
    ingress=await startService(entry('ingress'),{SESSION_ORIGIN:fixture.url});
    const url=ingress.url;
    const control=async (mode: string)=>{ await post(fixture.url,'/control',{mode},200); };
    const e=event('x',10), w={time:13};
    assert.deepEqual(await post(fixture.url,'/control',{mode:{toString:null}},400),error('invalid_request'));
    for (const [mode,path,body,status] of [
      ['created','/events',e,201],['duplicate','/events',e,200],['conflict','/events',e,409],
      ['late','/events',e,409],['capacity','/events',e,429],['watermark','/watermark',w,200],['regression','/watermark',w,409],
    ] as const) { await control(mode); await post(url,path,body,status); }
    for (const path of ['/events','/watermark']) {
      for (const mode of ['unknown409','unknown429','primitive409','array429','wrongfields409','extraerror','wrongmessage','unexpected500']) {
        await control(mode);
        assert.deepEqual(await post(url,path,path==='/events'?e:w,502),error('upstream_failure'));
      }
    }
    for (const mode of ['null','extra','wrongid','wrongduplicate','type','malformed','disconnect','oversize','oversize409',
      'headersdelay','bodydelay','combineddelay']) {
      await control(mode); const began=performance.now();
      assert.deepEqual(await post(url,'/events',e,502),error('upstream_failure'));
      if (mode.endsWith('delay')) assert.ok(performance.now()-began<1200,'one500ms deadline includes full response body');
    }
    await control('wrongmark'); await post(url,'/watermark',w,502);
    await control('regression'); await post(url,'/events',e,502);
    await control('late'); await post(url,'/watermark',w,502);
    await control('capacity'); await post(url,'/watermark',w,502);
    await control('redirect'); await post(url,'/events',e,502);
    // Inspect the reachable OTHER origin's counter before any fixture control/reset.
    const counter=await fetch(fixture.url+'/counter',{signal:AbortSignal.timeout(2000)});
    assert.equal(counter.status,200); assert.deepEqual(await counter.json(),{count:0});
    await ingress.stop(); ingress=undefined;
    await assert.rejects(startService(entry('ingress'),{SESSION_ORIGIN:fixture.url+'/',PORT:new URL(fixture.url).port}),/Origins must be distinct/);
    await fixture.stop();
    ingress=await startService(entry('ingress'),{SESSION_ORIGIN:fixture.url});
    assert.deepEqual(await post(ingress.url,'/events',e,502),error('upstream_failure'));
  } finally { try { await ingress?.stop(); } finally { await fixture.stop(); } }
});

import { oversizeWire } from './adversary.mts';
test('unit: oversize wire fixture stays valid JSON and exact schema while escaping only string tokens', () => {
  for (const [path,request,status,value] of [
    ['/events',event('x',10),201,{id:'x',duplicate:false}],
    ['/events',event('x',10),409,{error:{code:'late_event',message:'late_event'}}],
    ['/watermark',{time:13},200,{watermark:13}],
  ] as const) {
    const wire=oversizeWire(value);
    assert.ok(Buffer.byteLength(wire)>8192);
    const decoded: unknown=JSON.parse(wire);
    assert.deepEqual(decoded,value);
    assert.ok(replyValid(path,request,status,decoded));
  }
});

import { assertRemoteOrigin, ingressHandler } from '../ingress.mts';
import { HttpError } from '../../../lib/http.mts';
test('unit: actual assigned listener port rejects a self relay before forwarding', () => {
  assert.throws(() => assertRemoteOrigin('http://127.0.0.1:42173',42173),
    (error: unknown) => error instanceof HttpError && error.status === 502 && error.code === 'upstream_failure');
  assert.doesNotThrow(() => assertRemoteOrigin('http://127.0.0.1:42173',42174));
});

import { createServer } from 'node:http';
test('integration: PORT0 self relay uses actual socket port and sends no recursive request', async () => {
  let calls=0;
  let handler=ingressHandler('http://127.0.0.1:1');
  const server=createServer((req,res)=>{
    calls++;
    // The sentinel bounds the RED run and detects even one self-forward.
    if(calls>1) {res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify(error('upstream_failure')));return;}
    void handler(req,res);
  });
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    const address=server.address();assert.ok(address&&typeof address!=='string');
    const self=`http://127.0.0.1:${address.port}`;handler=ingressHandler(self);
    const response=await fetch(self+'/events',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(event('self',10)),signal:AbortSignal.timeout(3000)});
    assert.equal(response.status,502);assert.deepEqual(await response.json(),error('upstream_failure'));
    assert.equal(calls,1,'self origin must be rejected before ANY recursive HTTP request');
  } finally {await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});}
});
