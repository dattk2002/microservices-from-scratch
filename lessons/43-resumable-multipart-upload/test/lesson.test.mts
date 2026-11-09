import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../store.mts';
const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const meta = (uploadId = 'demo', parts = 2, size = 2, sha256 = hash('ab')) => ({uploadId, parts, size, sha256});
test('unit: create binds immutable metadata without resetting progress', () => {
  const s = new Store();
  try { assert.deepEqual(s.create(meta()), {id:'demo',status:'open',parts:2,size:2,sha256:hash('ab'),received:[]}); }
  finally { s.close(); }
});
test('unit: out of order resume, immutable parts, atomic completion and replay', () => {
 const s = new Store(); try {
 s.create(meta()); s.put('demo',2,{base64:'Yg==',sha256:hash('b')});
 assert.deepEqual(s.get('demo').received,[{number:2,size:1,sha256:hash('b')}]);
 assert.equal(s.object('demo'),undefined);
 assert.throws(()=>s.complete('demo'),{status:409});
 s.create(meta()); assert.equal(s.get('demo').received.length,1);
 s.put('demo',2,{base64:'Yg==',sha256:hash('b')});
 assert.throws(()=>s.put('demo',2,{base64:'Yw==',sha256:hash('c')}),{status:409});
 s.put('demo',1,{base64:'YQ==',sha256:hash('a')});
 s.complete('demo'); s.complete('demo');
 assert.deepEqual(s.object('demo'),{id:'demo',base64:'YWI=',size:2,sha256:hash('ab')});
 assert.throws(()=>s.abort('demo'),{status:409});
 } finally {s.close();}
});
test('unit: canonical base64, raw checksum and full checksum reject without publication',()=>{
 const s=new Store(); try {
 s.create(meta('bad',1,1,hash('z')));
 for(const base64 of ['YQ','YR==',' YQ==','', 'YQ===']) assert.throws(()=>s.put('bad',1,{base64,sha256:hash('a')}),{status:400});
 assert.throws(()=>s.put('bad',1,{base64:'YQ==',sha256:hash('b')}),{status:400});
 for(const input of [null,[],true,{base64:1,sha256:hash('a')}]) assert.throws(()=>s.put('bad',1,input),{status:400});
 s.put('bad',1,{base64:'YQ==',sha256:hash('a')});
 assert.throws(()=>s.complete('bad'),{status:409}); assert.equal(s.object('bad'),undefined);
 } finally{s.close();}
});
test('unit: abort retains identity, releases parts and capacity never evicts tombstones',()=>{
 const s=new Store();try{
 s.create(meta());s.put('demo',1,{base64:'YQ==',sha256:hash('a')});s.abort('demo');s.abort('demo');
 assert.deepEqual(s.get('demo').received,[]); assert.equal(s.get('demo').status,'aborted');
 assert.throws(()=>s.put('demo',1,{base64:'YQ==',sha256:hash('a')}),{status:409});
 assert.equal(s.create(meta()).status,'aborted');
 assert.throws(()=>s.create(meta('demo',1,1,hash('a'))),{status:409});
 for(let i=0;i<15;i++)s.create(meta(`x${i}`));
 assert.throws(()=>s.create(meta('overflow')),{status:409});
 for(const input of [null,[],true,meta('bad',true as unknown as number),meta('bad',8,7),meta('bad',1,1025)])assert.throws(()=>s.create(input),{status:400});
 }finally{s.close();}
});

import { validateObject } from '../reader.mts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
const request=(origin:string,path:string,method='GET',data?:unknown)=>fetch(origin+path,{method,headers:{'content-type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(4000)});
test('unit: reader validates every primitive, canonical bytes, size and digest',()=>{
 const valid={id:'demo',base64:'YQ==',size:1,sha256:hash('a')};
 assert.deepEqual(validateObject(valid,'demo'),valid);
 for(const value of [null,[],false,{...valid,id:1},{...valid,size:'1'},{...valid,base64:'YR=='},{...valid,sha256:hash('b')},{...valid,size:2}])assert.throws(()=>validateObject(value,'demo'));
});
test('unit: imports stay silent with invalid runtime configuration',async()=>{
 const child=spawn(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../upload.mts',import.meta.url).href)});await import(${JSON.stringify(new URL('../reader.mts',import.meta.url).href)});`],{env:{...process.env,PORT:'invalid',STORE_DB:'/not/a/real/path',STORE_ORIGIN:'invalid'},stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=String(b));child.stderr.on('data',b=>output+=String(b));const timer=setTimeout(()=>child.kill('SIGKILL'),3000);try{const [code]=await once(child,'exit');assert.equal(code,0);assert.equal(output,'');}finally{clearTimeout(timer);}
});
test('integration: durable resume, atomic read, completion replay, abort restart and maximal upload',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'multipart-'));const services:RunningService[]=[];
 const start=async()=>{const s=await startService(new URL('../upload.mts',import.meta.url),{STORE_DB:join(dir,'store.sqlite')});services.push(s);return s;};
 try{
 let owner=await start();const reader=await startService(new URL('../reader.mts',import.meta.url),{STORE_ORIGIN:owner.url});services.push(reader);
 assert.equal((await request(owner.url,'/uploads','POST',meta())).status,200);
 assert.equal((await request(owner.url,'/uploads/demo/parts/2','PUT',{base64:'Yg==',sha256:hash('b')})).status,200);
 assert.equal((await request(reader.url,'/objects/demo')).status,404);
 owner.child.kill('SIGKILL');await once(owner.child,'exit');owner=await start();
 const resumed=await (await request(owner.url,'/uploads/demo')).json() as {received:{number:number}[]};assert.deepEqual(resumed.received.map(p=>p.number),[2]);
 assert.equal((await request(owner.url,'/uploads/demo/complete','POST',{})).status,409);
 assert.equal((await request(owner.url,'/uploads/demo/parts/1','PUT',{base64:'YQ==',sha256:hash('a')})).status,200);
 for(let i=0;i<2;i++)assert.equal((await request(owner.url,'/uploads/demo/complete','POST',{})).status,200);
 const r2=await startService(new URL('../reader.mts',import.meta.url),{STORE_ORIGIN:owner.url});services.push(r2);
 assert.deepEqual(await(await request(r2.url,'/objects/demo')).json(),{id:'demo',base64:'YWI=',size:2,sha256:hash('ab')});
 await request(owner.url,'/uploads','POST',meta('gone'));await request(owner.url,'/uploads/gone','DELETE');await owner.stop();owner=await start();
 assert.equal((await request(owner.url,'/uploads/gone/parts/1','PUT',{base64:'YQ==',sha256:hash('a')})).status,409);
 const bytes=Buffer.alloc(8192,255),part=Buffer.alloc(1024,255);assert.equal((await request(owner.url,'/uploads','POST',meta('max',8,8192,hash(bytes)))).status,200);
 for(let n=1;n<=8;n++){const text=JSON.stringify({base64:part.toString('base64'),sha256:hash(part)}).replaceAll('/', '\\u002f');assert.equal((await fetch(owner.url+`/uploads/max/parts/${n}`,{method:'PUT',headers:{'content-type':'application/json'},body:text,signal:AbortSignal.timeout(4000)})).status,200);}
 assert.equal((await request(owner.url,'/uploads/max/complete','POST',{})).status,200);
 const r3=await startService(new URL('../reader.mts',import.meta.url),{STORE_ORIGIN:owner.url});services.push(r3);assert.equal((await request(r3.url,'/objects/max')).status,200);
 const oversized=JSON.stringify({base64:part.toString('base64'),sha256:hash(part)})+' '.repeat(9001);assert.equal((await fetch(owner.url+'/uploads/max/parts/1',{method:'PUT',headers:{'content-type':'application/json'},body:oversized,signal:AbortSignal.timeout(4000)})).status,413);
 for(const value of [null,[],true,{...meta(),parts:true}])assert.equal((await request(owner.url,'/uploads','POST',value)).status,400);
 }finally{await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});
test('integration: fixed origin rejects redirects and malformed, oversized, slow upstream without partial success',async()=>{
 const services:RunningService[]=[];
 try{
 const target=await startService(new URL('./provider.mts',import.meta.url));services.push(target);
 const provider=await startService(new URL('./provider.mts',import.meta.url),{TARGET_ORIGIN:target.url});services.push(provider);
 const reader=await startService(new URL('../reader.mts',import.meta.url),{STORE_ORIGIN:provider.url,UPSTREAM_TIMEOUT_MS:'150'});services.push(reader);
 for(const mode of ['valid','malformed','oversized','slow','redirect','schema','checksum','missing','escaped']){
 assert.equal((await request(provider.url,'/control','POST',{mode})).status,200);
 const response=await request(reader.url,'/objects/demo');assert.equal(response.status,mode==='valid'||mode==='escaped'?200:mode==='missing'?404:502,mode);
 const payload=await response.json() as Record<string,unknown>;if(response.status!==200)assert.equal(payload.base64,undefined);
 }
 assert.deepEqual(await(await request(target.url,'/hits')).json(),{hits:0});
 }finally{await Promise.all(services.map(s=>s.stop()));}
});
