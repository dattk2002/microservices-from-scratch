import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateClaims, signContext, verifyContext, Store } from '../model.mts';

const claims = {iss:'demo-gateway', aud:'documents', tenant:'red', sub:'alice', exp:130};
test('unit: context requires primitive claims, bounded expiry and correct audience', () => {
  assert.equal(validateClaims(claims,100), true);
  for (const patch of [{tenant:['red']},{sub:7},{aud:'other'},{exp:100},{exp:161},{iss:'other'}]) {
    assert.equal(validateClaims({...claims,...patch},100),false);
  }
});
test('unit: pinned signature rejects tampering and wrong key', () => {
  const keys=generateKeyPairSync('ed25519');
  const token=signContext(claims,keys.privateKey);
  assert.deepEqual(verifyContext(token,keys.publicKey,100),claims);
  assert.throws(()=>verifyContext(token+'x',keys.publicKey,100));
  assert.throws(()=>verifyContext(token,generateKeyPairSync('ed25519').publicKey,100));
});
test('unit: SQLite keys and receipts isolate identical IDs and conflicts', () => {
  const db=new DatabaseSync(':memory:'); const store=new Store(db);
  try {
    assert.equal(store.put('red','same','op','red').replay,false);
    assert.equal(store.put('blue','same','op','blue').replay,false);
    assert.equal(store.put('red','same','op','red').replay,true);
    assert.throws(()=>store.put('red','same','op','changed'),/conflict/);
    assert.deepEqual(store.list('blue'),[{id:'same',text:'blue'}]);
    assert.equal(store.get('blue','missing'),null);
    assert.equal(store.get('red','same')?.text,'red');
  } finally {db.close();}
});
test('unit: tenant capacity rejects without evicting receipts or blocking another tenant', () => {
 const db=new DatabaseSync(':memory:'); const s=new Store(db);
 try {
  for(let i=0;i<20;i++) s.put('red',`d${i}`,`o${i}`,'x');
  assert.throws(()=>s.put('red','extra','new','x'),/capacity/);
  for(let i=20;i<40;i++) s.put('red','d0',`o${i}`,'x');
  assert.throws(()=>s.put('red','d0','o40','x'),/capacity/);
  assert.equal(s.put('red','d0','o0','x').replay,true);
  assert.equal(s.put('blue','extra','o40','y').replay,false);
 } finally {db.close();}
});

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

const keys=generateKeyPairSync('ed25519');
const privatePem=keys.privateKey.export({type:'pkcs8',format:'pem'}).toString();
const publicPem=keys.publicKey.export({type:'spki',format:'pem'}).toString();
const entry=(name:string)=>new URL(`../${name}.mts`,import.meta.url);
async function request(base:string,path:string,principal?:string,body?:unknown,extra:Record<string,string>={}) {
 const response=await fetch(base+path,{method:body===undefined?'GET':'POST',
  headers:{...(principal?{'x-demo-principal':principal}:{}),'content-type':'application/json',...extra},
  body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(4000),redirect:'error'});
 return {status:response.status,value:await response.json() as unknown};
}
function context(patch:Record<string,unknown>={}) {
 // Deliberately sign arbitrary claims: negative HTTP fixtures must have valid signatures.
 const payload=Buffer.from(JSON.stringify({iss:'demo-gateway',aud:'documents',tenant:'red',sub:'alice',exp:Math.floor(Date.now()/1000)+30,...patch})).toString('base64url');
 return `${payload}.${cryptoSign(null,Buffer.from(payload),keys.privateKey).toString('base64url')}`;
}
import { sign as cryptoSign } from 'node:crypto';

test('unit: importing every entrypoint ignores invalid runtime configuration silently',async()=>{
 const script=`await import(${JSON.stringify(entry('gateway').href)}); await import(${JSON.stringify(entry('documents').href)});`;
 const result=await new Promise<{code:number|null;out:string;err:string}>((resolve,reject)=>{
  const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',script],{
   env:{PATH:process.env.PATH??'',PORT:'invalid',PRIVATE_KEY_PEM:'invalid',PUBLIC_KEY_PEM:'invalid',DB_PATH:'/cannot/open/db',DOCUMENT_ORIGIN:'invalid'},stdio:['ignore','pipe','pipe']});
  let out='',err='';const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
  child.stdout.on('data',(b:Buffer)=>{out+=b.toString();});child.stderr.on('data',(b:Buffer)=>{err+=b.toString();});
  child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve({code,out,err});});
 });
 assert.deepEqual(result,{code:0,out:'',err:''});
});

test('integration: independent processes isolate reads, writes, receipts, concurrent tenants and restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tenant-'));const services:RunningService[]=[];
 try {
  const env={PUBLIC_KEY_PEM:publicPem,DB_PATH:join(dir,'db.sqlite')};
  let docs=await startService(entry('documents'),env);services.push(docs);
  let gateway=await startService(entry('gateway'),{PRIVATE_KEY_PEM:privatePem,DOCUMENT_ORIGIN:docs.url,TEACHING_CONTROLS:'1'});services.push(gateway);
  const put=(who:string,id:string,op:string,text:string)=>request(gateway.url,`/documents/${id}`,who,{op,text});
  assert.deepEqual(await put('alice','same','op','red'),{status:200,value:{document:{id:'same',text:'red'},replay:false}});
  assert.deepEqual(await put('bob','same','op','blue'),{status:200,value:{document:{id:'same',text:'blue'},replay:false}});
  assert.deepEqual(await put('alice','same','op','red'),{status:200,value:{document:{id:'same',text:'red'},replay:true}});
  assert.equal((await put('alice','same','op','changed')).status,409);
  await put('alice','secret','secret','private');
  assert.deepEqual(await request(gateway.url,'/documents/secret','bob'),await request(gateway.url,'/documents/absent','bob'));
  assert.deepEqual((await request(gateway.url,'/documents','bob')).value,{documents:[{id:'same',text:'blue'}]});
  const mixed=await Promise.all(Array.from({length:12},(_,i)=>put(i%2?'alice':'bob',`mixed${i}`,`mix${i}`,`text${i}`)));
  assert.ok(mixed.every(r=>r.status===200));
  for(let i=0;i<12;i++) {
   assert.deepEqual((await request(gateway.url,`/documents/mixed${i}`,i%2?'alice':'bob')).value,{id:`mixed${i}`,text:`text${i}`});
   assert.equal((await request(gateway.url,`/documents/mixed${i}`,i%2?'bob':'alice')).status,404);
  }
  await gateway.stop();await docs.stop();
  docs=await startService(entry('documents'),env);services.push(docs);
  gateway=await startService(entry('gateway'),{PRIVATE_KEY_PEM:privatePem,DOCUMENT_ORIGIN:docs.url,TEACHING_CONTROLS:'1'});services.push(gateway);
  assert.deepEqual((await request(gateway.url,'/documents/same','bob')).value,{id:'same',text:'blue'});
  assert.deepEqual(await put('alice','same','op','red'),{status:200,value:{document:{id:'same',text:'red'},replay:true}});
  assert.equal((await put('bob','same','op','wrong')).status,409);
 } finally {await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});

test('integration: verified context alone selects storage and simulated identity is gated',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tenant-auth-'));const services:RunningService[]=[];
 try {
  const docs=await startService(entry('documents'),{PUBLIC_KEY_PEM:publicPem,DB_PATH:join(dir,'db')});services.push(docs);
  const gateway=await startService(entry('gateway'),{PRIVATE_KEY_PEM:privatePem,DOCUMENT_ORIGIN:docs.url,TEACHING_CONTROLS:'1'});services.push(gateway);
  const disabled=await startService(entry('gateway'),{PRIVATE_KEY_PEM:privatePem,DOCUMENT_ORIGIN:docs.url});services.push(disabled);
  assert.equal((await request(disabled.url,'/documents','alice')).status,401);
  assert.equal((await request(gateway.url,'/documents','unknown')).status,401);
  assert.equal((await request(docs.url,'/documents',undefined,undefined,{'x-tenant':'red'})).status,401);
  for(const token of [context({exp:1}),context({aud:'other'}),context({iss:'other'}),context({tenant:['red']}),context({sub:1}),context({padding:'x'.repeat(2100)}),context({exp:Math.floor(Date.now()/1000)+120}),context()+'x']) {
   assert.equal((await request(docs.url,'/documents/safe',undefined,{op:'valid',text:'valid'},{'x-tenant-context':token})).status,401);
  }
  const wrong=signContext({iss:'demo-gateway',aud:'documents',tenant:'red',sub:'alice',exp:Math.floor(Date.now()/1000)+30},generateKeyPairSync('ed25519').privateKey);
  assert.equal((await request(docs.url,'/documents',undefined,undefined,{'x-tenant-context':wrong})).status,401);
  assert.equal((await request(docs.url,'/documents?tenant=blue',undefined,undefined,{'x-tenant-context':context()})).status,400);
  assert.equal((await request(docs.url,'/documents/safe',undefined,{op:'other',text:'x',tenant:'blue'},{'x-tenant-context':context()})).status,400);
  const hints={'x-tenant':'blue','x-tenant-context':context({tenant:'blue',sub:'bob'})};
  assert.equal((await request(gateway.url,'/documents/safe','alice',{op:'valid',text:'red'},hints)).status,200);
  assert.equal((await request(gateway.url,'/documents/safe','bob')).status,404);
  assert.equal((await request(gateway.url,'/documents?tenant=blue','alice')).status,400);
  assert.equal((await request(gateway.url,'/documents/safe','alice',{op:'other',text:'x',tenant:'blue'})).status,400);
  assert.deepEqual((await request(docs.url,'/documents/safe',undefined,undefined,{'x-tenant-context':context(),'x-tenant':'blue'})).value,{id:'safe',text:'red'});
 } finally {await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});

test('integration: maximal escaped payload, valid oversized JSON and independent tenant capacities',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tenant-cap-'));const services:RunningService[]=[];
 try {
  const docs=await startService(entry('documents'),{PUBLIC_KEY_PEM:publicPem,DB_PATH:join(dir,'db')});services.push(docs);
  const gateway=await startService(entry('gateway'),{PRIVATE_KEY_PEM:privatePem,DOCUMENT_ORIGIN:docs.url,TEACHING_CONTROLS:'1'});services.push(gateway);
  const text='\u0000'.repeat(1024),id='d'.repeat(64),op='o'.repeat(64);
  assert.deepEqual(await request(gateway.url,`/documents/${id}`,'alice',{op,text}),{status:200,value:{document:{id,text},replay:false}});
  // Whitespace changes only bytes: schema, identity and payload remain legal.
  for(const [base,headers] of [[gateway.url,{'x-demo-principal':'alice'}],[docs.url,{'x-tenant-context':context()}]] as const) {
   const response=await fetch(base+'/documents/oversized',{method:'POST',headers:{'content-type':'application/json',...headers},body:' '.repeat(8192)+JSON.stringify({op:'oversized',text:'valid'}),signal:AbortSignal.timeout(4000)});
   assert.equal(response.status,413);await response.arrayBuffer();
  }
  for(let i=1;i<20;i++) assert.equal((await request(gateway.url,`/documents/d${i}`,'alice',{op:`o${i}`,text})).status,200);
  assert.equal((await request(gateway.url,'/documents','alice')).status,200);
  const full=await request(gateway.url,'/documents/extra','alice',{op:'extra',text:'x'});assert.equal(full.status,409);
  for(let i=20;i<40;i++) assert.equal((await request(gateway.url,`/documents/${id}`,'alice',{op:`o${i}`,text:'x'})).status,200);
  assert.equal((await request(gateway.url,`/documents/${id}`,'alice',{op:'o40',text:'x'})).status,409);
  assert.equal((await request(gateway.url,`/documents/${id}`,'alice',{op,text})).status,200);
  assert.equal((await request(gateway.url,'/documents/extra','bob',{op:'o40',text:'blue'})).status,200);
  assert.deepEqual((await request(gateway.url,'/documents','bob')).value,{documents:[{id:'extra',text:'blue'}]});
 } finally {await Promise.all(services.map(s=>s.stop()));await rm(dir,{recursive:true,force:true});}
});

test('integration: fixed upstream rejects redirects without leaking signed context or payload',async()=>{
 const services:RunningService[]=[];
 try {
  const sink=await startService(new URL('./upstream.mts',import.meta.url),{MODE:'sink'});services.push(sink);
  const redirect=await startService(new URL('./upstream.mts',import.meta.url),{MODE:'redirect',TARGET:sink.url});services.push(redirect);
  const gateway=await startService(entry('gateway'),{PRIVATE_KEY_PEM:privatePem,DOCUMENT_ORIGIN:redirect.url,TEACHING_CONTROLS:'1'});services.push(gateway);
  assert.equal((await request(gateway.url,'/documents/private','alice',{op:'op',text:'secret'})).status,502);
  assert.deepEqual((await request(sink.url,'/stats')).value,{received:0});
  for(const mode of ['malformed','oversized']) {
   const upstream=await startService(new URL('./upstream.mts',import.meta.url),{MODE:mode});services.push(upstream);
   const proxy=await startService(entry('gateway'),{PRIVATE_KEY_PEM:privatePem,DOCUMENT_ORIGIN:upstream.url,TEACHING_CONTROLS:'1'});services.push(proxy);
   assert.equal((await request(proxy.url,'/documents/safe','alice',{op:'op',text:'valid'})).status,502);
  }
 } finally {await Promise.all(services.map(s=>s.stop()));}
});
