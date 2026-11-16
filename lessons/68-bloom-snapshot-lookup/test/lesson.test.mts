import test from 'node:test';
import assert from 'node:assert/strict';
import { positions, buildBits, mayContain } from '../protocol.mts';

test('unit: golden SHA256 positions, unsigned bit31 and no false negatives',()=>{
  assert.deepEqual(positions('k0'),[26,14]);
  assert.deepEqual(positions('k1'),[11,8]);
  assert.equal(buildBits([]),'00000000');
  assert.deepEqual(positions('probe14'),[23,31]);
  assert.equal(buildBits(['probe14']),'80800000');
  assert.equal(mayContain('80800000','probe14'),true);
  assert.equal(mayContain('ffffffff','k31'),true);
  const keys=Array.from({length:32},(_,i)=>`k${i}`);
  const bits=buildBits(keys);
  for(const key of keys) assert.equal(mayContain(bits,key),true,key);
});

import { Catalog } from '../catalog.mts';
import { lookup, normalizeOrigin } from '../lookup.mts';
import { validFilter, exact } from '../protocol.mts';
import { spawnSync } from 'node:child_process';

const origin='http://127.0.0.1:18068';
const filter={revision:1,m:32,k:2,bits:'00000900'};
const absent={error:{code:'absent',message:'absent'}};
const unknown={error:{code:'unknown_snapshot',message:'unknown_snapshot'}};

test('unit: exact filter schema rejects malformed constants, bits and primitive types',()=>{
  assert.equal(validFilter(filter,1),true);
  for(const body of [null,[],true,1,'x',{}, {...filter,revision:0},{...filter,m:'32'}, {...filter,k:3}, {...filter,bits:'0000090G'}, {...filter,bits:'FFFFFFFF'}, {...filter,bits:'0'.repeat(9)}, {...filter,extra:1}]) assert.equal(validFilter(body,1),false);
  assert.equal(mayContain('80000000','k0'),false);
  assert.equal(mayContain('00000900','k1'),true);
  assert.equal(mayContain('00000900','k2'),true);
  assert.equal(buildBits(['k1']),'00000900');
});

test('unit: immutable publication, no-op and capacity are atomic in private SQLite',async()=>{
  const c=await Catalog.open(':memory:','unit');
  try {
    assert.deepEqual(c.state(),{identity:'unit',revision:0,keys:[],published:[]});
    assert.throws(()=>c.filter(0),{status:404,code:'unknown_snapshot'});
    assert.deepEqual(c.publish({}),{revision:0});
    assert.equal(c.filter(0).bits,'00000000');
    assert.deepEqual(c.write('k1',{value:'A'}),{revision:1});
    assert.deepEqual(c.write('k1',{value:'A'}),{revision:1});
    assert.deepEqual(c.publish({}),{revision:1});
    assert.deepEqual(c.item(1,'k1'),{revision:1,key:'k1',value:'A'});
    assert.throws(()=>c.item(0,'k1'),{code:'absent'});
    c.write('k2',{value:'B'}); c.publish({});
    c.write('k3',{value:'C'}); c.publish({});
    assert.deepEqual(c.publish({}),{revision:3});
    c.write('k1',{value:'Changed'});
    const before=c.state();
    assert.throws(()=>c.publish({}),{status:429,code:'snapshot_capacity'});
    assert.deepEqual(c.state(),before);
    assert.deepEqual(c.item(1,'k1'),{revision:1,key:'k1',value:'A'});
    assert.equal(c.filter(1).bits,'00000900');
    for(let i=5;i<=16;i++) c.write('k0',{value:'A'.repeat(i)});
    assert.deepEqual(c.write('k0',{value:'A'.repeat(16)}),{revision:16});
    const end=c.state();
    assert.throws(()=>c.write('k0',{value:'Z'}),{status:409,code:'revision_exhausted'});
    assert.deepEqual(c.state(),end);
  } finally {c.close();}
});

test('unit: request schemas reject arrays, null, non-coercible objects and extra fields',async()=>{
  const c=await Catalog.open(':memory:','schemas');
  try {
    for(const body of [null,[],true,'A',1,{}, {value:1},{value:null},{value:'A',extra:1},{value:{toString:null}},{value:''},{value:'é'},{value:'A'.repeat(33)}]) assert.throws(()=>c.write('k0',body),{status:400});
    for(const key of ['k00','k32',0,null,{},'k-1','k1/']) assert.throws(()=>c.write(key,{value:'A'}),{status:400});
    for(const body of [null,[],false,1,'x',{extra:1}]) assert.throws(()=>c.publish(body),{status:400});
    for(const revision of [-1,17,'1',null,{},1.5]) assert.throws(()=>c.filter(revision),{status:400});
    assert.equal(c.state().revision,0);
  } finally {c.close();}
});

test('unit: filter-negative bypasses items; deterministic collision always queries exact snapshot',async()=>{
  const calls:string[]=[];
  const upstream:typeof fetch=async(input,init)=>{
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    calls.push(String(input));
    return String(input).includes('/filter/')?Response.json(filter):Response.json(absent,{status:404});
  };
  assert.deepEqual(await lookup(origin,1,'k0',upstream),{status:404,body:{revision:1,key:'k0',source:'filter',value:null}});
  assert.deepEqual(calls,[origin+'/filter/1']);calls.length=0;
  assert.deepEqual(await lookup(origin,1,'k2',upstream),{status:404,body:{revision:1,key:'k2',source:'catalog',value:null}});
  assert.deepEqual(calls,[origin+'/filter/1',origin+'/snapshots/1/items/k2']);
  const present:typeof fetch=async input=>String(input).includes('/filter/')?Response.json(filter):Response.json({revision:1,key:'k1',value:'A'});
  assert.deepEqual(await lookup(origin,1,'k1',present),{status:200,body:{revision:1,key:'k1',source:'catalog',value:'A'}});
});

test('unit: both upstream branches validate exact known errors before preserving 404',async()=>{
  for(const branch of ['filter','item']) {
    for(const body of [null,[],false,3,'x',{}, {error:{code:'internal_error',message:'unknown_snapshot'}},{error:{code:'unknown_snapshot',message:'wrong'}},{error:{code:'absent',message:'absent',extra:1}},{...unknown,extra:1}]) {
      const fetcher:typeof fetch=async input=>branch==='item'&&String(input).includes('/filter/')?Response.json(filter):Response.json(body,{status:404});
      await assert.rejects(lookup(origin,1,'k2',fetcher),{status:502,code:'upstream_failure'});
    }
    const fetcher:typeof fetch=async input=>branch==='item'&&String(input).includes('/filter/')?Response.json(filter):Response.json(unknown,{status:404});
    await assert.rejects(lookup(origin,1,'k2',fetcher),{status:404,code:'unknown_snapshot'});
  }
  await assert.rejects(lookup(origin,1,'k1',async()=>Response.json(absent,{status:404})),{status:502});
});

test('unit: successful item identity, media, status, full-body bytes and UTF8 are validated',async()=>{
  for(const bad of [null,[],false,{revision:0,key:'k1',value:'A'},{revision:1,key:'k2',value:'A'},{revision:1,key:'k1',value:3},{revision:1,key:'k1',value:'A',extra:1}]) {
    const fetcher:typeof fetch=async input=>String(input).includes('/filter/')?Response.json(filter):Response.json(bad);
    await assert.rejects(lookup(origin,1,'k1',fetcher),{status:502});
  }
  for(const branch of ['filter','item']) for(const mode of ['bytes','utf8','media','status','escaped']) {
    const fetcher:typeof fetch=async input=>{
      const isFilter=String(input).includes('/filter/');
      const data=isFilter?filter:{revision:1,key:'k1',value:'A'};
      if((branch==='filter')!==isFilter) return Response.json(data);
      const wire=mode==='escaped'?JSON.stringify(data).replace(/"(?:[^"\\]|\\.)*"/g,token=>{
        const value:unknown=JSON.parse(token);assert.equal(typeof value,'string');
        if(typeof value!=='string') throw new Error('token');
        return '"'+Array.from(value,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
      }):JSON.stringify(data);
      return new Response(mode==='utf8'?Buffer.from([0xff]):wire+(mode==='bytes'?' '.repeat(8192):''),{status:mode==='status'?503:200,headers:{'content-type':mode==='media'?'text/plain':'application/json'}});
    };
    if(mode==='escaped') assert.equal((await lookup(origin,1,'k1',fetcher)).status,200);
    else await assert.rejects(lookup(origin,1,'k1',fetcher),{status:502});
  }
});

test('unit: one 500ms deadline includes stalled bodies without waiting for cancel',async()=>{
  const fetcher:typeof fetch=async()=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('{'));},cancel(){return new Promise<void>(()=>{});}}),{headers:{'content-type':'application/json'}});
  const started=performance.now();
  await assert.rejects(lookup(origin,1,'k0',fetcher),{status:502});
  assert.ok(performance.now()-started>=450);assert.ok(performance.now()-started<1200);
});

test('unit: origins are fixed normalized loopback and entrypoints are inert under invalid config',()=>{
  assert.equal(normalizeOrigin(origin+'/'),origin);
  for(const input of ['http://localhost:80','https://127.0.0.1:12','http://127.0.0.1:0','http://127.0.0.1:12/path','http://user@127.0.0.1:12','http://127.0.0.1:12?x=1']) assert.throws(()=>normalizeOrigin(input));
  const child=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../catalog.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('../lookup.mts',import.meta.url).href)});`],{encoding:'utf8',env:{PATH:process.env.PATH??'',DB_PATH:'',CATALOG_ID:'!',CATALOG_ORIGIN:'invalid',PORT:'invalid'},timeout:3000});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'');assert.equal(child.stderr,'');
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

async function stopAll(services:RunningService[]):Promise<void> {
  const results=await Promise.allSettled(services.map(s=>s.stop()));
  for(const result of results) if(result.status==='rejected') throw result.reason;
}
async function request(base:string,path:string,status=200,method='GET',data?:unknown):Promise<unknown> {
  const response=await fetch(base+path,{method,signal:AbortSignal.timeout(3000),...(data===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(data)})});
  const body:unknown=await response.json();assert.equal(response.status,status,`${method} ${path}: ${JSON.stringify(body)}`);return body;
}
async function counters(base:string):Promise<{filters:number,items:number,received:number}> {
  const b=await request(base,'/stats');
  assert.ok(exact(b,['filters','items'])||exact(b,['filters','items','received']));
  assert.equal(typeof b.filters,'number');assert.equal(typeof b.items,'number');
  if(typeof b.filters!=='number'||typeof b.items!=='number') throw new Error('Bad stats');
  return {filters:b.filters,items:b.items,received:typeof b.received==='number'?b.received:0};
}

test('integration: immutable snapshots, actual bypass, false positive, publication, restart and capacity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bloom-68-'));
  const services:RunningService[]=[];
  try {
    const env={DB_PATH:join(dir,'catalog.db'),CATALOG_ID:'catalog',TEACHING_CONTROLS:'1'};
    let catalog=await startService(new URL('../catalog.mts',import.meta.url),env);services.push(catalog);
    const relay=await startService(new URL('../lookup.mts',import.meta.url),{CATALOG_ORIGIN:catalog.url});services.push(relay);
    assert.deepEqual(await request(catalog.url,'/items/k1',200,'PUT',{value:'A'}),{revision:1});
    assert.deepEqual(await request(catalog.url,'/items/k1',200,'PUT',{value:'A'}),{revision:1});
    assert.deepEqual(await request(catalog.url,'/publish',200,'POST',{}),{revision:1});
    const f1=await request(catalog.url,'/filter/1');assert.deepEqual(f1,filter);
    const before=await counters(catalog.url);
    assert.deepEqual(await request(relay.url,'/lookup/1/k0',404),{revision:1,key:'k0',source:'filter',value:null});
    const negative=await counters(catalog.url);assert.equal(negative.filters,before.filters+1);assert.equal(negative.items,before.items);
    assert.deepEqual(await request(relay.url,'/lookup/1/k2',404),{revision:1,key:'k2',source:'catalog',value:null});
    const collision=await counters(catalog.url);assert.equal(collision.items,negative.items+1);
    assert.deepEqual(await request(catalog.url,'/items/k0',200,'PUT',{value:'B'}),{revision:2});
    assert.deepEqual(await request(catalog.url,'/filter/1'),f1);
    assert.deepEqual(await request(relay.url,'/lookup/1/k0',404),{revision:1,key:'k0',source:'filter',value:null});
    await request(relay.url,'/lookup/2/k0',404).then(b=>assert.deepEqual(b,unknown));
    await request(catalog.url,'/publish',200,'POST',{});
    assert.deepEqual(await request(relay.url,'/lookup/2/k0'),{revision:2,key:'k0',source:'catalog',value:'B'});
    await request(catalog.url,'/items/k1',200,'PUT',{value:'Changed'});await request(catalog.url,'/publish',200,'POST',{});
    assert.deepEqual(await request(relay.url,'/lookup/1/k1'),{revision:1,key:'k1',source:'catalog',value:'A'});
    await request(catalog.url,'/items/k3',200,'PUT',{value:'D'});await request(catalog.url,'/publish',200,'POST',{});
    // Same revision remains idempotent even when all four slots are occupied.
    assert.deepEqual(await request(catalog.url,'/publish',200,'POST',{}),{revision:4});
    await request(catalog.url,'/items/k4',200,'PUT',{value:'E'});
    const state=await request(catalog.url,'/state');
    assert.deepEqual(await request(catalog.url,'/publish',429,'POST',{}),{error:{code:'snapshot_capacity',message:'snapshot_capacity'}});
    assert.deepEqual(await request(catalog.url,'/state'),state);
    await relay.stop();await catalog.stop();
    await assert.rejects(startService(new URL('../catalog.mts',import.meta.url),{...env,CATALOG_ID:'other'}),/identity mismatch/);
    catalog=await startService(new URL('../catalog.mts',import.meta.url),{...env,TEACHING_CONTROLS:'0'});services.push(catalog);
    assert.deepEqual(await request(catalog.url,'/state'),state);
    assert.deepEqual(await request(catalog.url,'/filter/1'),f1);
    assert.deepEqual(await request(catalog.url,'/snapshots/1/items/k1'),{revision:1,key:'k1',value:'A'});
    assert.deepEqual(await request(catalog.url,'/snapshots/2/items/k0'),{revision:2,key:'k0',value:'B'});
    await request(catalog.url,'/stats',404);
    for(let r=6;r<=16;r++) await request(catalog.url,'/items/k0',200,'PUT',{value:'A'.repeat(r)});
    assert.deepEqual(await request(catalog.url,'/items/k0',200,'PUT',{value:'A'.repeat(16)}),{revision:16});
    const end=await request(catalog.url,'/state');
    assert.deepEqual(await request(catalog.url,'/items/k0',409,'PUT',{value:'Z'}),{error:{code:'revision_exhausted',message:'revision_exhausted'}});
    assert.deepEqual(await request(catalog.url,'/state'),end);
  } finally {try {await stopAll(services);} finally {await rm(dir,{recursive:true,force:true});}}
});

test('integration: exact public schemas, canonical paths and methods',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'bloom-schema-'));
  const services:RunningService[]=[];
  try {
    const c=await startService(new URL('../catalog.mts',import.meta.url),{DB_PATH:join(dir,'c.db'),CATALOG_ID:'schemas'});services.push(c);
    const l=await startService(new URL('../lookup.mts',import.meta.url),{CATALOG_ORIGIN:c.url+'/'});services.push(l);
    for(const data of [null,[],true,1,'x',{}, {value:null},{value:[]},{value:{toString:null}},{value:'A',extra:1},{value:'A1'},{value:'A'.repeat(33)}]) await request(c.url,'/items/k0',400,'PUT',data);
    for(const data of [null,[],false,1,'x',{extra:1}]) await request(c.url,'/publish',400,'POST',data);
    for(const path of ['/filter/00','/filter/17','/filter/-1','/filter/1?extra=1','/snapshots/0/items/k32','/snapshots/0/items/k00','/state?url=http://example.com']) await request(c.url,path,400);
    for(const path of ['/lookup/00/k0','/lookup/17/k0','/lookup/0/k32','/lookup/0/k00','/lookup/0/k1?url=http://example.com','/lookup/0/k1?x=1&x=2']) await request(l.url,path,400);
    const oversize=await fetch(c.url+'/publish',{method:'POST',headers:{'content-type':'application/json'},body:'{}'+' '.repeat(8192),signal:AbortSignal.timeout(3000)});assert.equal(oversize.status,413);await oversize.body?.cancel();
    for(const [base,path] of [[c.url,'/filter/0'],[c.url,'/publish'],[l.url,'/lookup/0/k0']]) {
      assert.ok(base&&path);const response=await fetch(base+path,{method:'DELETE',signal:AbortSignal.timeout(3000)});assert.equal(response.status,405);assert.ok(response.headers.get('allow'));await response.body?.cancel();
    }
    await request(c.url,'/snapshots/0/items/k0',404).then(b=>assert.deepEqual(b,unknown));
    await request(c.url,'/publish',200,'POST',{});
    assert.deepEqual(await request(c.url,'/snapshots/0/items/k0',404),absent);
    assert.deepEqual(await request(l.url,'/lookup/0/k0',404),{revision:0,key:'k0',source:'filter',value:null});
  } finally {try {await stopAll(services);} finally {await rm(dir,{recursive:true,force:true});}}
});

test('integration: adversarial upstream schemas, bounded bodies, redirects and one total deadline',async()=>{
  const services:RunningService[]=[];
  try {
    const sink=await startService(new URL('./fixture.mts',import.meta.url),{FIXTURE_ROLE:'sink'});services.push(sink);
    const upstream=await startService(new URL('./fixture.mts',import.meta.url),{REDIRECT_ORIGIN:sink.url});services.push(upstream);
    const relay=await startService(new URL('../lookup.mts',import.meta.url),{CATALOG_ORIGIN:upstream.url});services.push(relay);
    const mode=async(name:string)=>request(upstream.url,'/mode',200,'POST',{mode:name});
    for(const bad of [null,[],true,1,'x',{}, {mode:{toString:null}},{mode:3},{mode:'ok',extra:1}]) await request(upstream.url,'/mode',400,'POST',bad);
    for(const branch of ['filter','item']) {
      for(const variant of ['null','array','primitive','extra','wrong-revision','wrong-code','wrong-message','error-primitive','error-array','error-extra','unavailable','status409','status422','status429','oversize','chunked-oversize','error-oversize','utf8','media','uncertain']) {
        await mode(`${branch}-${variant}`);
        assert.deepEqual(await request(relay.url,'/lookup/1/k1',502),{error:{code:'upstream_failure',message:'upstream_failure'}});
      }
      await mode(`${branch}-unknown`);
      assert.deepEqual(await request(relay.url,'/lookup/1/k1',404),unknown);
      await mode(`${branch}-escaped`);
      assert.deepEqual(await request(relay.url,'/lookup/1/k1'),{revision:1,key:'k1',source:'catalog',value:'A'});
      await mode(`${branch}-redirect`);
      await request(relay.url,'/lookup/1/k1',502);
      // Read the reachable distinct destination before changing fixture mode.
      assert.equal((await counters(sink.url)).received,0);
    }
    await mode('item-absent');assert.deepEqual(await request(relay.url,'/lookup/1/k1',404),{revision:1,key:'k1',source:'catalog',value:null});
    for(const variant of ['filter-slow-headers','filter-slow-body','item-slow-body','filter-error-slow-body','item-error-slow-body','slow-chain']) {
      await mode(variant);const start=performance.now();
      await request(relay.url,'/lookup/1/k1',502);
      const ms=performance.now()-start;assert.ok(ms>=450&&ms<1100,`${variant}: ${ms}ms`);
    }
    // A failed request does not poison subsequent requests or cache a negative.
    await mode('ok');assert.equal((await counters(upstream.url)).items>0,true);
    assert.deepEqual(await request(relay.url,'/lookup/1/k1'),{revision:1,key:'k1',source:'catalog',value:'A'});
  } finally {await stopAll(services);}
});

import { validateHost } from '../protocol.mts';
import { configuredOrigin } from '../lookup.mts';
test('unit: startup confines both listeners to loopback and rejects an identical catalog origin',()=>{
  assert.doesNotThrow(()=>validateHost(undefined));
  assert.doesNotThrow(()=>validateHost('127.0.0.1'));
  for(const host of ['0.0.0.0','localhost','::1',{},null,1]) assert.throws(()=>validateHost(host));
  assert.equal(configuredOrigin(origin+'/',undefined,0),origin);
  assert.equal(configuredOrigin(origin,undefined,3168),origin);
  assert.throws(()=>configuredOrigin(origin+'/',undefined,18068),/distinct/);
  assert.throws(()=>configuredOrigin(origin,'0.0.0.0',3168));
});
