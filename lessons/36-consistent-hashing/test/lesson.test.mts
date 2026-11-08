import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as ring from '../ring.mts';
test('unit: clockwise wrap and canonical collision winner', () => {
  assert.equal(ring.clockwise('ff', [{point:'10',member:'b',index:0},{point:'10',member:'a',index:1}]), 'a');
  assert.equal(ring.clockwise('10', [{point:'10',member:'b',index:0},{point:'10',member:'a',index:1}]), 'a');
});
test('unit: deterministic SHA256 placement and membership movement', () => {
  const digest = createHash('sha256').update('a:0').digest('hex');
  assert.ok(ring.tokens(['a']).some(t => t.point === digest));
  let added = 0; let removed = 0;
  for (let i=0;i<512;i++) {
    const key = `catalogue-${i}`;
    const before = ring.owner(key,['a','b']);
    assert.equal(before,ring.owner(key,['b','a']));
    const after = ring.owner(key,['a','b','c']);
    if (before !== after) { assert.equal(after,'c'); added++; }
    const without = ring.owner(key,['a']);
    if (before !== without) { assert.equal(before,'b'); removed++; }
  }
  assert.ok(added > 0 && removed > 0);
});
import * as cacheModule from '../cache.mts';
test('unit: maximal escaped identities and LRU recomputation', () => {
  const cache = new cacheModule.Cache();
  const key = '\u0001'.repeat(64);
  assert.equal(cacheModule.catalogue('item-1'),'9da5af12f724249afb964c8ae978f425e696d12bf17b3ab2bd4fc8da082f88b5');
  const first = cache.get(key);
  assert.equal(first.hit,false);
  assert.equal(cache.get(key).hit,true);
  for (let i=0;i<31;i++) cache.get(`k${i}`);
  cache.get(key); // refresh recency, then evict k0
  cache.get('new');
  assert.equal(cache.get(key).hit,true);
  assert.equal(cache.get('k0').hit,false);
  for (let i=0;i<32;i++) cache.get(`other${i}`);
  assert.deepEqual(cache.get(key),first);
});
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { origin } from '../runtime.mts';
test('unit: cache origin alias falls back to legacy and never masks an invalid preferred origin', () => {
  const saved = {preferred:process.env.CACHE_A_ORIGIN, legacy:process.env.NODE_A_ORIGIN};
  try {
    delete process.env.CACHE_A_ORIGIN;
    process.env.NODE_A_ORIGIN='http://127.0.0.1:45101';
    assert.doesNotThrow(() => assert.equal(origin('CACHE_A_ORIGIN','NODE_A_ORIGIN'),'http://127.0.0.1:45101'));
    process.env.CACHE_A_ORIGIN='http://127.0.0.1:45102';
    assert.equal(origin('CACHE_A_ORIGIN','NODE_A_ORIGIN'),'http://127.0.0.1:45102');
    process.env.CACHE_A_ORIGIN='https://example.invalid';
    assert.throws(() => origin('CACHE_A_ORIGIN','NODE_A_ORIGIN'),/Invalid/);
  } finally {
    if(saved.preferred===undefined) delete process.env.CACHE_A_ORIGIN;else process.env.CACHE_A_ORIGIN=saved.preferred;
    if(saved.legacy===undefined) delete process.env.NODE_A_ORIGIN;else process.env.NODE_A_ORIGIN=saved.legacy;
  }
});
const entry = (name: string) => new URL(`../${name}.mts`,import.meta.url);
async function get(url: string) { return fetch(url,{signal:AbortSignal.timeout(3000)}); }
async function body(url: string): Promise<Record<string, unknown>> {
  const res = await get(url); assert.equal(res.status,200);
  return await res.json() as Record<string, unknown>;
}
async function cluster(controls = true) {
  const services: RunningService[] = [];
  try {
    const a = await startService(entry('node'),{NODE_ID:'a'}); services.push(a);
    const b = await startService(entry('node'),{NODE_ID:'b'}); services.push(b);
    const c = await startService(entry('node'),{NODE_ID:'c'}); services.push(c);
    const env = {NODE_A_ORIGIN:a.url,NODE_B_ORIGIN:b.url,NODE_C_ORIGIN:c.url,TEACHING_CONTROLS: controls ? '1':'0'};
    const router = await startService(entry('router'),env); services.push(router);
    return {a,b,c,router,env,stop:async () => {await Promise.all(services.map(s=>s.stop()));}};
  } catch (error) { await Promise.all(services.map(s=>s.stop())); throw error; }
}
test('integration: Playground safe cache aliases start nodes and router without changing legacy support', async () => {
  const services:RunningService[]=[];
  try {
    const a=await startService(entry('node'),{CACHE_ID:'a',NODE_ID:'invalid'});services.push(a);
    const b=await startService(entry('node'),{CACHE_ID:'b'});services.push(b);
    const c=await startService(entry('node'),{CACHE_ID:'c'});services.push(c);
    const router=await startService(entry('router'),{CACHE_A_ORIGIN:a.url,CACHE_B_ORIGIN:b.url,CACHE_C_ORIGIN:c.url,NODE_A_ORIGIN:'invalid'});services.push(router);
    assert.deepEqual(await body(`${router.url}/placement/catalogue-9`),{key:'catalogue-9',owner:'a',epoch:1});
    const cold=await body(`${router.url}/objects/catalogue-9`);assert.equal(cold.hit,false);assert.equal(cold.owner,'a');
    const warm=await body(`${router.url}/objects/catalogue-9`);assert.equal(warm.hit,true);assert.equal(warm.value,cold.value);
  } finally {await Promise.all(services.map(s=>s.stop()));}
});
test('integration: warm affinity, membership changes reconstruct same values, retained owners stay warm', async () => {
  const s = await cluster();
  try {
    const keys = Array.from({length:32},(_,i)=>`catalogue-${i}`);
    const initial = new Map<string,Record<string,unknown>>();
    for (const key of keys) {
      const url = `${s.router.url}/objects/${key}`;
      const cold = await body(url); assert.equal(cold.hit,false);
      const warm = await body(url); assert.equal(warm.hit,true); initial.set(key,warm);
    }
    assert.equal((await jsonRequest(`${s.router.url}/ring`,{members:['c','a','b']})).status,200);
    let moved = 0; let retained = 0;
    for (const key of keys) {
      const old = initial.get(key)!;
      const now = await body(`${s.router.url}/objects/${key}`);
      assert.equal(now.value,old.value); assert.equal(now.epoch,2);
      if (now.owner !== old.owner) {assert.equal(now.owner,'c'); assert.equal(now.hit,false); moved++;}
      else {assert.equal(now.hit,true); retained++;}
    }
    assert.ok(moved>0 && retained>0);
    assert.equal((await jsonRequest(`${s.router.url}/ring`,{members:['a','c']})).status,200);
    for (const key of keys) {
      const prior = ring.owner(key,['a','b','c']);
      const now = await body(`${s.router.url}/objects/${key}`);
      if (now.owner !== prior) {assert.equal(prior,'b'); assert.equal(now.hit,false);}
      else assert.equal(now.hit,true);
      assert.equal(now.value,initial.get(key)!.value);
    }
  } finally {await s.stop();}
});
test('integration: owner failure has no fallback and restart loses only its cache',async () => {
  const s = await cluster(); let restarted: RunningService | undefined; let router: RunningService | undefined;
  try {
    const keyA = Array.from({length:100},(_,i)=>`a${i}`).find(k=>ring.owner(k,['a','b'])==='a')!;
    const keyB = Array.from({length:100},(_,i)=>`b${i}`).find(k=>ring.owner(k,['a','b'])==='b')!;
    const old = await body(`${s.router.url}/objects/${keyA}`);
    await body(`${s.router.url}/objects/${keyB}`);
    await s.a.stop();
    assert.equal((await get(`${s.router.url}/objects/${keyA}`)).status,502);
    assert.equal((await body(`${s.router.url}/objects/${keyB}`)).hit,true);
    // Direct read on b proves router did not try the second owner during failure.
    assert.equal((await body(`${s.b.url}/objects/${keyA}`)).hit,false);
    restarted = await startService(entry('node'),{NODE_ID:'a'});
    router = await startService(entry('router'),{...s.env,NODE_A_ORIGIN:restarted.url});
    const fresh = await body(`${router.url}/objects/${keyA}`);
    assert.equal(fresh.hit,false); assert.equal(fresh.value,old.value);
    assert.equal((await body(`${router.url}/objects/${keyB}`)).hit,true);
  } finally {await router?.stop(); await restarted?.stop(); await s.stop();}
});
test('integration: control schemas, epoch idempotency, maximal escaping and disabled controls',async () => {
  const s = await cluster(); let disabled: RunningService | undefined;
  try {
    for (const members of [[],['a','a'],['d'],[{}],[1],null,'a',['a','b','c','a']]) {
      assert.equal((await jsonRequest(`${s.router.url}/ring`,{members})).status,400);
    }
    assert.equal((await jsonRequest(`${s.router.url}/ring`,{members:['b','a']})).status,200);
    assert.equal((await body(`${s.router.url}/placement/x`)).epoch,1);
    const ringBody = JSON.stringify({members:['a','b']});
    for(const [size,status] of [[8192,200],[8193,413]] as const) {
      const res = await fetch(`${s.router.url}/ring`,{method:'POST',headers:{'content-type':'application/json'},body:ringBody+' '.repeat(size-Buffer.byteLength(ringBody)),signal:AbortSignal.timeout(3000)});
      assert.equal(res.status,status);
    }
    const key = '\u0001'.repeat(64);
    const maximal = await body(`${s.router.url}/objects/${encodeURIComponent(key)}`);
    assert.equal(maximal.key,key); assert.equal(typeof maximal.value,'string');
    assert.equal((await get(`${s.router.url}/objects/${'x'.repeat(65)}`)).status,400);
    assert.equal((await get(`${s.router.url}/objects/%ED%A0%80`)).status,400);
    disabled = await startService(entry('router'),{...s.env,TEACHING_CONTROLS:'0'});
    assert.equal((await jsonRequest(`${disabled.url}/ring`,{members:['c']})).status,404);
    assert.equal((await body(`${disabled.url}/placement/x`)).epoch,1);
  } finally {await disabled?.stop(); await s.stop();}
});
test('integration: upstream byte, schema, identity, redirect and deadline boundaries',async () => {
  for (const mode of ['maximal','bytes','schema','identity','value','type','status','redirect','hang','bodyhang']) {
    const target = await startService(new URL('./upstream.mts',import.meta.url),{MODE:'maximal'});
    let fixture: RunningService | undefined;
    try { fixture = await startService(new URL('./upstream.mts',import.meta.url),{MODE:mode,DESTINATION:target.url}); }
    catch(error) {await target.stop(); throw error;}
    let router: RunningService | undefined;
    try {
      router = await startService(entry('router'),{NODE_A_ORIGIN:fixture.url,NODE_B_ORIGIN:fixture.url,NODE_C_ORIGIN:fixture.url,TEACHING_CONTROLS:'1',UPSTREAM_TIMEOUT_MS:'500'});
      await jsonRequest(`${router.url}/ring`,{members:['a']});
      const res = await get(`${router.url}/objects/${encodeURIComponent('\u0001'.repeat(64))}`);
      assert.equal(res.status,mode==='maximal'?200:502,mode);
      const stats = await body(`${fixture.url}/stats`);
      assert.equal(stats.requests,1,mode);
      assert.equal(stats.redirects,0,mode);
      assert.equal((await body(`${target.url}/stats`)).redirects,0,mode); // Different fixed origin must never receive a redirected request.
    } finally {await Promise.all([router?.stop(),fixture.stop(),target.stop()]);}
  }
});
test('unit: importing entrypoints ignores invalid runtime config and is silent',async () => {
  const script = `await import(${JSON.stringify(entry('router').href)}); await import(${JSON.stringify(entry('node').href)}); await import(${JSON.stringify(entry('sample').href)});`;
  const child = spawn(process.execPath,['--input-type=module','-e',script],{
    env:{PATH:process.env.PATH ?? '',PORT:'invalid',NODE_ID:'invalid',NODE_A_ORIGIN:'invalid',UPSTREAM_TIMEOUT_MS:'invalid'},stdio:['ignore','pipe','pipe']});
  let output = ''; child.stdout.on('data',(b:Buffer)=>{output+=b.toString();}); child.stderr.on('data',(b:Buffer)=>{output+=b.toString();});
  const kill = setTimeout(()=>child.kill('SIGKILL'),3000);
  try { const [code] = await once(child,'exit'); assert.equal(code,0,output); assert.equal(output,''); }
  finally {clearTimeout(kill); if(child.exitCode===null) child.kill('SIGKILL');}
});
