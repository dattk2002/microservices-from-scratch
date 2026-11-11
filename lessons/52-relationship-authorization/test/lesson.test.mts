import { test } from 'node:test';
import assert from 'node:assert/strict';
// RED: replacing graph traversal by deny-all must fail this assertion.
test('unit: nested group grants view through an editor', async () => {
  const { Policy } = await import('../policy.mts');
  const p = new Policy(':memory:');
  try {
    p.mutate('add', {objectType:'group',object:'eng',relation:'member',subjectType:'user',subject:'alice'});
    p.mutate('add', {objectType:'group',object:'leads',relation:'member',subjectType:'group',subject:'eng'});
    p.mutate('add', {objectType:'document',object:'plan',relation:'editor',subjectType:'group',subject:'leads'});
    assert.deepEqual(p.check('alice','plan','view',0), {allowed:true,revision:3});
  } finally { p.close(); }
});
import { Policy } from '../policy.mts';
import { tuple, type Tuple } from '../contract.mts';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const g = (object:string,subject:string,subjectType='group'): Tuple => ({objectType:'group',object,relation:'member',subjectType,subject});
const d = (subject:string,relation='viewer',subjectType='group'): Tuple => ({objectType:'document',object:'plan',relation,subjectType,subject});
test('unit: cycles terminate, reachable users and diamond paths grant, viewer cannot edit',() => {
 const p = new Policy(':memory:');
 try {
  for (const t of [g('eng','ops'),g('ops','eng'),d('eng')]) p.mutate('add',t);
  assert.deepEqual(p.check('alice','plan','view'),{allowed:false,revision:3});
  for (const t of [g('ops','alice','user'),g('eng','leads'),g('leads','ops')]) p.mutate('add',t);
  assert.equal(p.check('alice','plan','view').allowed,true);
  assert.equal(p.check('bob','plan','view').allowed,false);
  assert.equal(p.check('alice','plan','edit').allowed,false);
  p.mutate('remove',g('ops','alice','user'));
  assert.equal(p.check('alice','plan','view').allowed,false);
 } finally { p.close(); }
});
test('unit: no-ops, future minimum, capacity and revision overflow are atomic',() => {
 const p = new Policy(':memory:');
 try {
  assert.deepEqual(p.mutate('remove',d('alice','editor','user')),{changed:false,revision:0});
  const all: Tuple[] = [];
  for (const object of ['plan','runbook']) for (const relation of ['viewer','editor']) for (const subjectType of ['user','group']) for (const subject of subjectType === 'user' ? ['alice','bob','carol'] : ['eng','ops','leads']) all.push({objectType:'document',object,relation,subjectType,subject});
  for (const object of ['eng','ops','leads']) for (const subject of ['alice','bob','carol']) all.push(g(object,subject,'user'));
  for (const t of all.slice(0,32)) p.mutate('add',t);
  const full = p.state();
  assert.equal(full.tuples.length,32);
  assert.throws(() => p.mutate('add',all[32]),{status:409});
  assert.deepEqual(p.state(),full);
  assert.deepEqual(p.mutate('add',all[0]),{changed:false,revision:32});
  assert.throws(() => p.check('alice','plan','view',33),{status:409});
  for (let i=0;i<16;i++) { p.mutate('remove',all[0]); p.mutate('add',all[0]); }
  const end = p.state(); assert.equal(end.revision,64);
  assert.throws(() => p.mutate('remove',all[0]),{status:409});
  assert.deepEqual(p.state(),end);
  assert.deepEqual(p.mutate('add',all[0]),{changed:false,revision:64});
 } finally { p.close(); }
});
test('unit: primitive and tuple domains reject coercion',() => {
 const p = new Policy(':memory:');
 try {
  for (const v of [null,[],true,{},1]) assert.throws(() => tuple(v),{status:400});
  for (const field of ['objectType','object','relation','subjectType','subject']) assert.throws(() => tuple({...g('eng','alice','user'),[field]:['eng']}),{status:400});
  assert.throws(() => tuple({...g('eng','alice','user'),relation:'viewer'}),{status:400});
  for (const value of [null,true,'0',[],{},-1,65,0.5]) assert.throws(() => p.check('alice','plan','view',value),{status:400});
 } finally { p.close(); }
});
test('unit: imports are silent even with invalid runtime configuration',() => {
 const r = spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../policy.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('../documents.mts',import.meta.url).href)});`],{env:{...process.env,DB_PATH:'/impossible/path',POLICY_ORIGIN:'invalid',PORT:'invalid'},encoding:'utf8',timeout:3000});
 assert.equal(r.status,0,r.stderr); assert.equal(r.stdout,'');
 assert.equal(r.stderr,'');
});
test('integration: separate services grant transitively, revoke next read and retain revision on restart',async() => {
 const dir = await mkdtemp(join(tmpdir(),'relations-')); const path = join(dir,'policy.db');
 let policy: RunningService | undefined;
 let docs: RunningService | undefined;
 try {
  policy = await startService(new URL('../policy.mts',import.meta.url),{DB_PATH:path});
  docs = await startService(new URL('../documents.mts',import.meta.url),{POLICY_ORIGIN:policy.url});
  for (const t of [g('eng','alice','user'),g('leads','eng'),d('leads','editor')]) assert.equal((await jsonRequest(policy.url+'/tuples',{operation:'add',tuple:t})).status,200);
  let r = await jsonRequest(docs.url+'/read',{user:'alice',document:'plan',minRevision:3});
  assert.deepEqual(await r.json(),{document:'plan',text:'Kế hoạch giả tưởng: trồng cây trên Mặt Trăng.',policyRevision:3});
  assert.equal((await jsonRequest(docs.url+'/read',{user:'bob',document:'plan'})).status,403);
  await jsonRequest(policy.url+'/tuples',{operation:'remove',tuple:g('eng','alice','user')});
  r = await jsonRequest(docs.url+'/read',{user:'alice',document:'plan',minRevision:4}); assert.equal(r.status,403); assert.equal(JSON.stringify(await r.json()).includes('Mặt Trăng'),false);
  assert.equal((await jsonRequest(docs.url+'/read',{user:'alice',document:'plan',minRevision:5})).status,409);
  const primitiveTargets: string[] = [policy.url+'/tuples',policy.url+'/check',docs.url+'/read'];
  for (const value of [null,[],true]) for (const target of primitiveTargets) assert.equal((await jsonRequest(target,value)).status,400);
  for (const [url,valid,fields] of [[policy.url+'/tuples',{operation:'add',tuple:d('alice','viewer','user')},['operation','tuple']],[policy.url+'/check',{user:'alice',document:'plan',permission:'view',minRevision:0},['user','document','permission','minRevision']],[docs.url+'/read',{user:'alice',document:'plan',minRevision:0},['user','document','minRevision']]] as const) for (const field of fields) assert.equal((await jsonRequest(url,{...valid,[field]:true})).status,400);
  // Fill the largest legal current snapshot through the real route.
  for (const object of ['plan','runbook']) for (const relation of ['viewer','editor']) for (const subjectType of ['user','group']) for (const subject of subjectType === 'user' ? ['alice','bob','carol'] : ['eng','ops','leads']) await jsonRequest(policy.url+'/tuples',{operation:'add',tuple:{objectType:'document',object,relation,subjectType,subject}});
  for (const object of ['eng','ops','leads']) for (const subject of ['alice','bob']) await jsonRequest(policy.url+'/tuples',{operation:'add',tuple:g(object,subject,'user')});
  await jsonRequest(policy.url+'/tuples',{operation:'add',tuple:g('ops','carol','user')});
  const snapshotResponse = await fetch(policy.url+'/state',{signal:AbortSignal.timeout(1000)});
  const snapshot = await snapshotResponse.json() as {revision:number;tuples:Tuple[]};
  assert.equal(snapshot.tuples.length,32);
  const escaped = JSON.stringify({operation:'add',tuple:snapshot.tuples[0]}).replace(/[a-z]/g,c => '\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
  assert.equal((await fetch(policy.url+'/tuples',{method:'POST',headers:{'content-type':'application/json'},body:escaped,signal:AbortSignal.timeout(1000)})).status,200);
  await policy.stop(); policy = await startService(new URL('../policy.mts',import.meta.url),{DB_PATH:path});
  const r2 = await jsonRequest(policy.url+'/check',{user:'alice',document:'plan',permission:'view',minRevision:snapshot.revision}); assert.deepEqual(await r2.json(),{allowed:true,revision:snapshot.revision});
 } finally { await docs?.stop(); await policy?.stop(); await rm(dir,{recursive:true,force:true}); }
});
test('integration: bounded policy variants fail closed and redirects never reach target',async() => {
 const services: RunningService[] = [];
 try {
  const target = await startService(new URL('./upstream.mts',import.meta.url)); services.push(target);
  const fixture = await startService(new URL('./upstream.mts',import.meta.url),{REDIRECT_ORIGIN:target.url}); services.push(fixture);
  const docs = await startService(new URL('../documents.mts',import.meta.url),{POLICY_ORIGIN:fixture.url}); services.push(docs);
  for (const mode of ['invalid','oversized','slow','redirect','low','denied','future','unavailable']) {
   assert.equal((await jsonRequest(fixture.url+'/mode',{mode})).status,200);
   const r = await jsonRequest(docs.url+'/read',{user:'alice',document:'plan',minRevision:1});
   assert.equal(r.status,mode === 'denied' ? 403 : mode === 'future' ? 409 : 502);
   const body = await r.text(); assert.equal(body.includes('Mặt Trăng'),false); assert.equal(body.includes('"text"'),false);
   if (mode === 'redirect') {
    const counters = await fetch(target.url+'/counts',{signal:AbortSignal.timeout(1000)});
    assert.deepEqual(await counters.json(),{redirectHits:0},'redirect target must receive no request even if its reply would be rejected');
   }
  }
  const counters = await fetch(target.url+'/counts',{signal:AbortSignal.timeout(1000)}); assert.deepEqual(await counters.json(),{redirectHits:0});
 } finally { for (const service of services.reverse()) await service.stop(); }
});
