import test from 'node:test';
import assert from 'node:assert/strict';
import {record} from '../policy.mts';
import {HttpError} from '../../../lib/http.mts';

test('unit: invalid control object has an explicit client error',()=>{
 for(const input of [null,[],true,false,0,'bad'])assert.throws(()=>record(input),(error:unknown)=>error instanceof HttpError&&error.status===400);
 assert.deepEqual(record({failed:false}),{failed:false});
});
test('unit: deterministic cohort vector', async () => {
  const { bucket } = await import('../policy.mts');
  assert.equal(bucket('demo', 'alice'), 6066);
  assert.equal(bucket('demo', 'bob'), 9823);
  assert.equal(bucket('rotated', 'alice'), 808);
});

test('unit: boundaries, monotonic cohorts, validation, versions and failed refresh age', async () => {
  const { Snapshot, parseConfig, bucket } = await import('../policy.mts');
  let now = 0;
  const cache = new Snapshot(100, () => now);
  assert.equal(cache.choose('alice').reason, 'cold');
  const config = {version: 1, enabled: true, rollout: 0, salt: 'demo'};
  cache.accept(config);
  assert.equal(cache.choose('alice').variant, 'stable');
  cache.accept({...config, version: 2, rollout: 10000});
  assert.equal(cache.choose('alice').variant, 'canary');
  now = 90;
  assert.throws(() => cache.accept({...config, version: 1}));
  assert.throws(() => cache.accept({...config, version: 2}));
  assert.throws(() => cache.accept({...config, version: 3, enabled: 'true'}));
  now = 100;
  assert.equal(cache.choose('alice').reason, 'expired');
  cache.accept({...config, version: 2, rollout: 10000});
  assert.equal(cache.choose('alice').variant, 'canary');
  cache.accept({...config, version: 3, enabled: false, rollout: 10000});
  assert.equal(cache.choose('alice').reason, 'disabled');
  for (const value of [null, [], true, {...config, rollout: '1'}, {...config, salt: 1}, {...config, version: Number.MAX_SAFE_INTEGER + 1}]) assert.throws(() => parseConfig(value));
  for (let i = 0; i < 100; i++) {
    const b = bucket('demo', `person-${i}`);
    assert.ok(b >= 0 && b < 10000);
    for (const rollout of [0, 2000, 5000, 10000]) {
      cache.accept({version: 4 + i * 4 + [0,2000,5000,10000].indexOf(rollout), enabled: true, rollout, salt: 'demo'});
      assert.equal(cache.choose(`person-${i}`).variant, b < rollout ? 'canary' : 'stable');
    }
  }
});

import { openControl } from '../control.mts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: SQLite validates before write, rejects stale publication and accepts maximal escaped salt', () => {
  const store = openControl(':memory:');
  try {
    assert.equal(store.get().version,0);
    const maximal = {expectedVersion:0,enabled:true,rollout:10000,salt:'\u0001'.repeat(64)};
    assert.equal(store.publish(maximal).salt,maximal.salt);
    assert.throws(() => store.publish(maximal), /Read current/);
    for (const enabled of ['true', 1, [], null]) assert.throws(() => store.publish({...maximal,expectedVersion:1,enabled}));
    assert.throws(() => store.publish({...maximal,expectedVersion:1,rollout:10001}));
    assert.equal(store.get().version,1);
  } finally { store.db.close(); }
});

test('unit: importing all entrypoints ignores invalid runtime settings and stays silent', async () => {
  const urls = ['control','gateway','backend'].map(name => new URL(`../${name}.mts`,import.meta.url).href);
  const child = spawn(process.execPath,['--input-type=module','-e',`for (const url of ${JSON.stringify(urls)}) await import(url)`], {
    env: {PATH:process.env.PATH ?? '',PORT:'broken',DB_PATH:'/not/a/database',VARIANT:'invalid',CONTROL_ORIGIN:'invalid'},stdio:['ignore','pipe','pipe'],
  });
  let out = '', err = '';
  child.stdout.on('data',(b:Buffer) => {out += b.toString();});
  child.stderr.on('data',(b:Buffer) => {err += b.toString();});
  const timer = setTimeout(() => child.kill('SIGKILL'),2000);
  try {
    const [code] = await once(child,'exit');
    assert.equal(code,0,err);
    assert.equal(out,'');
    assert.equal(err,'');
  } finally { clearTimeout(timer); child.kill('SIGKILL'); }
});

async function get(url: string) {
  return fetch(url,{signal:AbortSignal.timeout(2000),redirect:'error'});
}
async function hello(service: RunningService,subject='alice') {
  const response = await get(`${service.url}/hello?subject=${subject}`);
  assert.equal(response.status,200);
  return await response.json() as {variant:string;reason:string;version:number|null;backend:string};
}
const entry = (name:string) => new URL(`../${name}.mts`,import.meta.url);

test('integration: two processes converge, persist config, expire independently and fail closed during outage', async () => {
  const directory = await mkdtemp(join(tmpdir(),'flags-'));
  const services: RunningService[] = [];
  const start = async(name:string,env:Record<string,string>={}) => { const s=await startService(entry(name),env); services.push(s); return s; };
  try {
    const controlEnv = {DB_PATH:join(directory,'control.sqlite'),TEACHING_CONTROLS:'1'};
    let control = await start('control',controlEnv);
    const stable = await start('backend',{VARIANT:'stable'}), canary = await start('backend',{VARIANT:'canary'});
    const gatewayEnv = {CONTROL_ORIGIN:control.url,STABLE_ORIGIN:stable.url,CANARY_ORIGIN:canary.url,TEACHING_CONTROLS:'1',TTL_MS:'60000'};
    const a = await start('gateway',gatewayEnv), b = await start('gateway',gatewayEnv);
    assert.equal((await hello(a)).reason,'cold');
    const publish = async(version:number,enabled:boolean,rollout:number,salt='demo') => {
      const response = await jsonRequest(`${control.url}/config`,{expectedVersion:version,enabled,rollout,salt});
      assert.equal(response.status,200); return response.json();
    };
    const refresh = async(s:RunningService,status=200) => assert.equal((await jsonRequest(`${s.url}/refresh`,{})).status,status);
    await publish(0,true,3000);
    await refresh(a); await refresh(b);
    const before:string[]=[];
    for(let i=0;i<24;i++) {
      const x=await hello(a,`p-${i}`),y=await hello(b,`p-${i}`);
      assert.deepEqual(x,y); before.push(x.variant);
    }
    await publish(1,true,7000); await refresh(a); await refresh(b);
    const larger:string[]=[];
    for(let i=0;i<24;i++) {
      const x=await hello(a,`p-${i}`); assert.deepEqual(x,await hello(b,`p-${i}`));
      if(before[i]==='canary') assert.equal(x.variant,'canary'); larger.push(x.variant);
    }
    await publish(2,true,7000,'rotated'); await refresh(a); await refresh(b);
    const rotated:string[]=[];
    for(let i=0;i<24;i++) { const x=await hello(a,`p-${i}`); assert.deepEqual(x,await hello(b,`p-${i}`)); rotated.push(x.variant); }
    assert.notDeepEqual(rotated,larger);
    await a.stop(); await b.stop();
    // Control restart preserves a safe version and content; gateway cold restart does not.
    await control.stop();
    control=await start('control',controlEnv);
    const durable=await (await get(`${control.url}/config`)).json() as {version:number;salt:string};
    assert.equal(durable.version,3); assert.equal(durable.salt,'rotated');
    const freshEnv={...gatewayEnv,CONTROL_ORIGIN:control.url};
    const c=await start('gateway',freshEnv),d=await start('gateway',freshEnv);
    assert.equal((await hello(c)).reason,'cold');
    await publish(3,true,10000); await refresh(c); await refresh(d);
    await publish(4,false,10000); await refresh(c);
    assert.equal((await hello(c)).reason,'disabled');
    assert.equal((await hello(d)).variant,'canary'); // kill switch is not fleet-wide magic
    await jsonRequest(`${control.url}/teaching/failure`,{failed:true});
    await jsonRequest(`${d.url}/teaching/advance`,{ms:59000});
    await refresh(d,502);
    assert.equal((await hello(d)).variant,'canary');
    await jsonRequest(`${d.url}/teaching/advance`,{ms:1000});
    assert.equal((await hello(d)).reason,'expired');
    assert.equal((await hello(d)).variant,'stable');
    await jsonRequest(`${control.url}/teaching/failure`,{failed:false}); await refresh(d);
    assert.equal((await hello(d)).reason,'disabled');
    await publish(5,true,10000); await refresh(d); await canary.stop();
    assert.equal((await get(`${d.url}/hello?subject=alice`)).status,502);
    assert.equal((await get(`${d.url}/hello?subject=%5Bobject%20Object%5D`)).status,400);
    for(const enabled of [null,'false',0,{}]) assert.equal((await jsonRequest(`${control.url}/config`,{expectedVersion:6,enabled,rollout:10000,salt:'demo'})).status,400);
    assert.equal((await jsonRequest(`${control.url}/config`,{expectedVersion:4,enabled:true,rollout:0,salt:'demo'})).status,409);
    assert.equal((await jsonRequest(`${control.url}/config`,{expectedVersion:6,enabled:true,rollout:10000,salt:'\u0001'.repeat(64)})).status,200);
  } finally { await Promise.all(services.map(s=>s.stop())); await rm(directory,{recursive:true,force:true}); }
});

async function fixture(handler:(req:IncomingMessage,res:ServerResponse)=>void) {
  const server=createServer(handler); server.requestTimeout=1000; server.headersTimeout=1000;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address(); if(!address || typeof address==='string') throw new Error('listener');
  return {url:`http://127.0.0.1:${address.port}`, stop:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

test('integration: refresh validation, exact repeat, byte/deadline bounds and redirect never leak headers or bodies',async()=>{
  let mode='good', seen=0;
  const sink=await fixture((req,res)=>{seen++;req.resume();res.end('{}');});
  const good={version:1,enabled:true,rollout:10000,salt:'\u0001'.repeat(64)};
  const source=await fixture((_req,res)=>{
    res.setHeader('content-type','application/json');
    if(mode==='redirect'){res.writeHead(307,{location:sink.url});res.end();return;}
    if(mode==='hang') return;
    if(mode==='status'){res.writeHead(503);res.end('{}');return;}
    if(mode==='malformed'){res.end('{');return;}
    if(mode==='older'){res.end(JSON.stringify({...good,version:0}));return;}
    if(mode==='conflict'){res.end(JSON.stringify({...good,rollout:0}));return;}
    // Legal config with JSON whitespace: only the byte gate distinguishes this fixture.
    if(mode==='oversized'){res.end(' '.repeat(1025)+JSON.stringify(good));return;}
    if (_req.url === '/hello') {
      if(mode==='backend-hang') return;
      const body=JSON.stringify({variant:'canary'});
      res.end(mode==='backend-oversized' ? ' '.repeat(1025)+body : body); return;
    }
    res.end(JSON.stringify(good));
  });
  const services:RunningService[]=[];
  try {
    const stable=await startService(entry('backend'),{VARIANT:'stable'});services.push(stable);
    const canary=await startService(entry('backend'),{VARIANT:'canary'});services.push(canary);
    const gateway=await startService(entry('gateway'),{CONTROL_ORIGIN:source.url,STABLE_ORIGIN:stable.url,CANARY_ORIGIN:canary.url,TEACHING_CONTROLS:'1',TTL_MS:'60000'});services.push(gateway);
    assert.equal((await jsonRequest(`${gateway.url}/refresh`,{})).status,200);
    assert.equal((await hello(gateway)).variant,'canary');
    for(mode of ['older','conflict','malformed','oversized','redirect','status','hang']) {
      assert.equal((await jsonRequest(`${gateway.url}/refresh`,{secret:'payload'},{authorization:'Bearer demo','x-signed-context':'demo'})).status,502,mode);
      assert.equal((await hello(gateway)).variant,'canary',mode);
    }
    assert.equal(seen,0);
    await jsonRequest(`${gateway.url}/teaching/advance`,{ms:60000});
    assert.equal((await hello(gateway)).reason,'expired');
    mode='good'; assert.equal((await jsonRequest(`${gateway.url}/refresh`,{})).status,200);
    assert.equal((await hello(gateway)).variant,'canary');
    // A selected backend redirect must also remain pinned, including incoming context.
    const badGateway=await startService(entry('gateway'),{CONTROL_ORIGIN:source.url,STABLE_ORIGIN:stable.url,CANARY_ORIGIN:source.url});services.push(badGateway);
    assert.equal((await jsonRequest(`${badGateway.url}/refresh`,{})).status,200);
    assert.equal((await hello(badGateway)).variant,'canary');
    for(mode of ['backend-oversized','backend-hang']) assert.equal((await get(`${badGateway.url}/hello?subject=alice`)).status,502,mode);
    mode='redirect';
    const reply=await fetch(`${badGateway.url}/hello?subject=alice`,{headers:{authorization:'Bearer demo','x-signed-context':'demo'},signal:AbortSignal.timeout(2000)});
    assert.equal(reply.status,502); assert.equal(seen,0);
  } finally { await Promise.all(services.map(s=>s.stop()));await source.stop();await sink.stop(); }
});


test('integration: invalid control object returns400 without toggling outage and teaching controls stay gated',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'flags-invalid-'));
 const services:RunningService[]=[];
 const start=async(name:string,env:Record<string,string>)=>{const service=await startService(entry(name),env);services.push(service);return service;};
 try{
  const control=await start('control',{DB_PATH:join(directory,'enabled.sqlite'),TEACHING_CONTROLS:'1'});
  for(const value of [null,[],true,false,0,'bad']){
   const reply=await jsonRequest(`${control.url}/teaching/failure`,value);
   assert.equal(reply.status,400,JSON.stringify(value));
   const state=await get(`${control.url}/config`);assert.equal(state.status,200);
   assert.deepEqual(await state.json(),{version:0,enabled:false,rollout:0,salt:'demo'});
  }
  assert.equal((await jsonRequest(`${control.url}/teaching/failure`,{failed:true})).status,200);
  assert.equal((await get(`${control.url}/config`)).status,503);
  assert.equal((await jsonRequest(`${control.url}/teaching/failure`,null)).status,400);
  assert.equal((await get(`${control.url}/config`)).status,503);
  assert.equal((await jsonRequest(`${control.url}/teaching/failure`,{failed:false})).status,200);
  assert.equal((await get(`${control.url}/config`)).status,200);
  const disabled=await start('control',{DB_PATH:join(directory,'disabled.sqlite')});
  assert.equal((await jsonRequest(`${disabled.url}/teaching/failure`,{failed:true})).status,404);
  assert.equal((await get(`${disabled.url}/config`)).status,200);
  const gateway=await start('gateway',{CONTROL_ORIGIN:control.url,STABLE_ORIGIN:control.url,CANARY_ORIGIN:control.url});
  assert.equal((await jsonRequest(`${gateway.url}/teaching/advance`,{ms:60000})).status,404);
 }finally{await Promise.all(services.map(service=>service.stop()));await rm(directory,{recursive:true,force:true});}
});
