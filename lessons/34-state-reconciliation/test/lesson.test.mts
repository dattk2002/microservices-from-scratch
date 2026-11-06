import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../model.mts';

test('unit: duplicate, stale, conflict and tombstone cannot overwrite monotonic state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal(apply(db, {id:'a',version:1,value:'one'}), 'applied');
    assert.equal(apply(db, {id:'a',version:1,value:'one'}), 'duplicate');
    assert.equal(apply(db, {id:'a',version:1,value:'other'}), 'conflict');
    assert.equal(apply(db, {id:'a',version:2,value:null}), 'applied');
    assert.equal(apply(db, {id:'a',version:1,value:'late'}), 'stale');
    assert.equal(apply(db, {id:'a',version:2,value:'resurrect'}), 'conflict');
    assert.equal(apply(db, {id:'a',version:2,value:null}), 'duplicate');
  } finally { db.close(); }
});

import { parse, parseSnapshot, snapshot } from '../model.mts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: validates primitive types, bounded snapshots and retained identity admission', () => {
  for (const bad of [true, 1, {}, ['a']]) {
    assert.throws(() => parse({id:bad,version:1,value:null}));
    if (bad !== 1) assert.throws(() => parse({id:'a',version:bad,value:null}));
  }
  assert.throws(() => parse({id:'a',version:1,value:{}}));
  assert.throws(() => parseSnapshot([{id:'a',version:1,value:null},{id:'a',version:2,value:null}]));
  const db = new DatabaseSync(':memory:');
  try {
    for (let i=0;i<16;i++) apply(db, {id:`r${i}`,version:1,value:null});
    assert.throws(() => apply(db, {id:'extra',version:1,value:'x'}));
    assert.equal(apply(db, {id:'r0',version:2,value:'new incarnation'}), 'applied');
    assert.equal(snapshot(db).length,16);
    assert.throws(() => parseSnapshot(Array.from({length:17}, (_,i) => ({id:`a${i}`,version:1,value:null}))));
    const maximum = {id:'z'.repeat(64),version:Number.MAX_SAFE_INTEGER,value:'\u0000'.repeat(256)};
    assert.deepEqual(parse(JSON.parse(JSON.stringify(maximum))),maximum);
    assert.equal(parseSnapshot(Array.from({length:16},(_,i) => ({...maximum,id:`${i}`.padEnd(64,'z')}))).length,16);
  } finally { db.close(); }
});

test('unit: importing all entrypoints with invalid config is silent and inert', async () => {
  const entries = ['owner','projection','reconciler'].map(x => new URL(`../${x}.mts`,import.meta.url).href);
  const child = spawn(process.execPath,['--input-type=module','-e',entries.map(x => `await import(${JSON.stringify(x)});`).join('\n')], {
    env:{PATH:process.env.PATH ?? '',PORT:'invalid', DB_PATH:'/does/not/exist/db',OWNER_ORIGIN:'invalid',PROJECTION_ORIGIN:'invalid'},stdio:['ignore','pipe','pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data',(chunk:Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data',(chunk:Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'),3000);
  try {
    const [code] = await once(child,'close');
    assert.equal(code,0); assert.equal(stdout,''); assert.equal(stderr,'');
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('integration: dropped changes converge, partial retry, conflict, restart and dependency failure', async () => {
  const dir = await mkdtemp(join(tmpdir(),'reconciliation-'));
  const services: RunningService[] = [];
  async function start(name:string, env:Record<string,string>) {
    const service = await startService(new URL(`../${name}.mts`,import.meta.url),{TEACHING_CONTROLS:'1',...env});
    services.push(service); return service;
  }
  async function post(service:RunningService,path:string,body:unknown,status=200):Promise<unknown> {
    const response = await jsonRequest(service.url+path,body);
    assert.equal(response.status,status); return response.json();
  }
  async function states(service:RunningService) {
    const response = await fetch(service.url+'/states',{signal:AbortSignal.timeout(2000)});
    assert.equal(response.status,200); return response.json();
  }
  const ownerDb = join(dir,'owner.sqlite'); const projectionDb = join(dir,'projection.sqlite');
  try {
    let projection = await start('projection',{DB_PATH:projectionDb});
    let owner = await start('owner',{DB_PATH:ownerDb,PROJECTION_ORIGIN:projection.url});
    let reconciler = await start('reconciler',{OWNER_ORIGIN:owner.url,PROJECTION_ORIGIN:projection.url});
    await post(owner,'/change',{id:'a',value:'first'});
    await post(owner,'/change',{id:'a',value:'missed',drop:true});
    assert.deepEqual(await states(projection),[{id:'a',version:1,value:'first'}]);
    assert.deepEqual(await post(reconciler,'/run',{}),{results:[{id:'a',result:'applied'}],complete:true});
    assert.deepEqual(await post(reconciler,'/run',{}),{results:[{id:'a',result:'duplicate'}],complete:true});
    await post(owner,'/change',{id:'a',value:null,drop:true});
    await post(reconciler,'/run',{});
    assert.deepEqual(await post(projection,'/apply',{id:'a',version:2,value:'late'}),{result:'stale'});
    assert.deepEqual(await states(projection),[{id:'a',version:3,value:null}]);
    await post(owner,'/change',{id:'b',value:'repair b',drop:true});
    await post(owner,'/change',{id:'c',value:'repair c',drop:true});
    await post(projection,'/teaching/fail',{id:'c'});
    assert.deepEqual(await post(reconciler,'/run',{}),{results:[{id:'a',result:'duplicate'},{id:'b',result:'applied'},{id:'c',result:'failed'}],complete:false});
    assert.deepEqual(await states(projection),[{id:'a',version:3,value:null},{id:'b',version:1,value:'repair b'}]);
    await post(projection,'/teaching/fail',{id:null});
    assert.deepEqual(await post(reconciler,'/run',{}),{results:[{id:'a',result:'duplicate'},{id:'b',result:'duplicate'},{id:'c',result:'applied'}],complete:true});
    // Public notification ingestion intentionally trusts its configured producer in this local lesson.
    await post(projection,'/apply',{id:'d',version:1,value:'contradiction'});
    await post(owner,'/change',{id:'d',value:'authoritative',drop:true});
    const conflict = await post(reconciler,'/run',{});
    assert.deepEqual(conflict,{results:[{id:'a',result:'duplicate'},{id:'b',result:'duplicate'},{id:'c',result:'duplicate'},{id:'d',result:'conflict'}],complete:false});
    await post(reconciler,'/run',{ownerOrigin:'http://127.0.0.1:1'},400);
    await reconciler.stop(); await owner.stop(); await projection.stop();
    projection = await start('projection',{DB_PATH:projectionDb});
    owner = await start('owner',{DB_PATH:ownerDb,PROJECTION_ORIGIN:projection.url});
    reconciler = await start('reconciler',{OWNER_ORIGIN:owner.url,PROJECTION_ORIGIN:projection.url});
    assert.deepEqual((await states(owner) as {id:string;version:number;value:string|null}[])[0],{id:'a',version:3,value:null});
    assert.deepEqual((await states(projection) as {id:string;version:number;value:string|null}[])[0],{id:'a',version:3,value:null});
    assert.deepEqual(await post(projection,'/apply',{id:'a',version:2,value:'late'}),{result:'stale'});
    await post(owner,'/change',{id:'a',value:'reborn'});
    assert.deepEqual((await states(projection) as {id:string;version:number;value:string|null}[])[0],{id:'a',version:4,value:'reborn'});
    await projection.stop();
    assert.deepEqual(await post(owner,'/change',{id:'e',value:'saved despite failure'}),{state:{id:'e',version:1,value:'saved despite failure'},notification:'failed'});
    assert.deepEqual(await post(reconciler,'/run',{}),{results:['a','b','c','d','e'].map(id=>({id,result:'failed'})),complete:false});
    await owner.stop();
    await post(reconciler,'/run',{},502);
  } finally {
    await Promise.all(services.map(service => service.stop()));
    await rm(dir,{recursive:true,force:true});
  }
});

test('integration: maximum escaped state and request byte gate', async () => {
  const dir = await mkdtemp(join(tmpdir(),'reconciliation-budget-'));
  let service:RunningService|undefined;
  try {
    service = await startService(new URL('../projection.mts',import.meta.url),{DB_PATH:join(dir,'projection.sqlite')});
    const state = {id:'x'.repeat(64),version:Number.MAX_SAFE_INTEGER,value:'\u0000'.repeat(256)};
    assert.equal((await jsonRequest(service.url+'/apply',state)).status,200);
    // Whitespace is legal JSON, same schema/id/version. Without byte gate this becomes 200.
    const response = await fetch(service.url+'/apply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state)+' '.repeat(8193),signal:AbortSignal.timeout(2000)});
    assert.equal(response.status,413);
  } finally { await service?.stop(); await rm(dir,{recursive:true,force:true}); }
});

test('integration: invalid or oversized authoritative reply causes zero durable writes', async () => {
  const dir = await mkdtemp(join(tmpdir(),'reconciliation-upstream-'));
  const services:RunningService[]=[];
  try {
    const projection = await startService(new URL('../projection.mts',import.meta.url),{DB_PATH:join(dir,'db')});
    services.push(projection);
    for (const mode of ['oversize','malformed']) {
      const fixture = await startService(new URL('./snapshot-fixture.mts',import.meta.url),{MODE:mode}); services.push(fixture);
      const reconciler = await startService(new URL('../reconciler.mts',import.meta.url),{OWNER_ORIGIN:fixture.url,PROJECTION_ORIGIN:projection.url}); services.push(reconciler);
      assert.equal((await jsonRequest(reconciler.url+'/run',{})).status,502);
      const response = await fetch(projection.url+'/states',{signal:AbortSignal.timeout(2000)});
      assert.deepEqual(await response.json(),[]);
      await reconciler.stop(); await fixture.stop();
    }
  } finally { await Promise.all(services.map(x=>x.stop())); await rm(dir,{recursive:true,force:true}); }
});

test('integration: sixteen maximally escaped records fit snapshot and converge', async () => {
  const dir = await mkdtemp(join(tmpdir(),'reconciliation-max-'));
  const services:RunningService[]=[];
  try {
    const projection = await startService(new URL('../projection.mts',import.meta.url),{DB_PATH:join(dir,'projection')}); services.push(projection);
    const owner = await startService(new URL('../owner.mts',import.meta.url),{DB_PATH:join(dir,'owner'),PROJECTION_ORIGIN:projection.url,TEACHING_CONTROLS:'1'}); services.push(owner);
    for(let i=0;i<16;i++) assert.equal((await jsonRequest(owner.url+'/change',{id:`${i}`.padEnd(64,'x'),value:'\u0000'.repeat(256),drop:true})).status,200);
    assert.equal((await jsonRequest(owner.url+'/change',{id:'seventeenth',value:null,drop:true})).status,409);
    const reconciler = await startService(new URL('../reconciler.mts',import.meta.url),{OWNER_ORIGIN:owner.url,PROJECTION_ORIGIN:projection.url}); services.push(reconciler);
    const response = await jsonRequest(reconciler.url+'/run',{});
    assert.equal(response.status,200);
    const result = await response.json() as {complete:boolean;results:{id:string;result:string}[]};
    assert.equal(result.complete,true); assert.equal(result.results.length,16);
    assert.ok(result.results.every(x=>x.result==='applied'));
    const current = await fetch(projection.url+'/states',{signal:AbortSignal.timeout(2000)});
    const desired = await fetch(owner.url+'/states',{signal:AbortSignal.timeout(2000)});
    assert.deepEqual(await current.json(),await desired.json());
  } finally { await Promise.all(services.map(x=>x.stop())); await rm(dir,{recursive:true,force:true}); }
});

test('integration: redirects cannot move snapshot reads or apply payloads to another origin', async () => {
  const dir = await mkdtemp(join(tmpdir(),'reconciliation-redirect-'));
  const services:RunningService[]=[];
  async function start(entry:string,env:Record<string,string>) {
    const service=await startService(new URL(entry,import.meta.url),env);
    services.push(service);return service;
  }
  async function get(url:string):Promise<unknown> {
    const response=await fetch(url,{signal:AbortSignal.timeout(2000)});
    assert.equal(response.status,200);return response.json();
  }
  try {
    const target=await start('./snapshot-fixture.mts',{MODE:'valid'});
    const projection=await start('../projection.mts',{DB_PATH:join(dir,'projection')});
    for(const code of ['307','308']) {
      const snapshotRedirect=await start('./snapshot-fixture.mts',{MODE:'redirect',TARGET:target.url,REDIRECT_CODE:code});
      const snapshotReconciler=await start('../reconciler.mts',{OWNER_ORIGIN:snapshotRedirect.url,PROJECTION_ORIGIN:projection.url});
      const snapshotReply=await jsonRequest(snapshotReconciler.url+'/run',{});
      assert.equal(snapshotReply.status,502,'redirected snapshot must fail before any repair');
      assert.deepEqual(await get(target.url+'/hits'),{hits:0},'redirect target must never be contacted');
      assert.deepEqual(await get(projection.url+'/states'),[],'snapshot redirect must leave durable state empty');
      const applyRedirect=await start('./snapshot-fixture.mts',{MODE:'redirect',TARGET:projection.url,REDIRECT_CODE:code});
      const owner=await start('../owner.mts',{DB_PATH:join(dir,`owner-${code}`),PROJECTION_ORIGIN:applyRedirect.url});
      const change=await jsonRequest(owner.url+'/change',{id:'a',value:'valid'});
      assert.equal(change.status,200);
      assert.deepEqual(await change.json(),{state:{id:'a',version:1,value:'valid'},notification:'failed'});
      assert.deepEqual(await get(projection.url+'/states'),[],'owner must never forward a redirected apply');
      const applyReconciler=await start('../reconciler.mts',{OWNER_ORIGIN:owner.url,PROJECTION_ORIGIN:applyRedirect.url});
      const repair=await jsonRequest(applyReconciler.url+'/run',{});
      assert.equal(repair.status,200);
      assert.deepEqual(await repair.json(),{results:[{id:'a',result:'failed'}],complete:false});
      assert.deepEqual(await get(projection.url+'/states'),[],'reconciler must never forward a redirected apply');
      await Promise.all([snapshotRedirect,snapshotReconciler,applyRedirect,owner,applyReconciler].map(x=>x.stop()));
    }
  } finally { await Promise.all(services.map(x=>x.stop()));await rm(dir,{recursive:true,force:true}); }
});
