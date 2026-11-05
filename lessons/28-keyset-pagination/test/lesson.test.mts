import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Owner,ScannerStore } from '../store.mts';
import { startService,jsonRequest } from '../../../test/support.mts';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
test('unit: immutable snapshot seeks, binding and bounded replay',()=>{
 const s=new Owner(':memory:');try{
 for(let i=1;i<=25;i++)s.put(i,i%2?'a':'b',`v${i}`);
 const t=s.create('a',3);s.put(1,'a','changed');s.db.prepare('DELETE FROM live WHERE id=3').run();s.put(26,'a','later');
 const first=s.page(t,'a',3);assert.deepEqual(first.rows.map(r=>r.id),[1,3,5]);assert.equal(first.rows[0]!.value,'v1');
 for(let i=0;i<20;i++)assert.deepEqual(s.page(t,'a',3),first);
 assert.equal(s.db.prepare('SELECT count(*) n FROM tokens').get()!.n,2);
 assert.throws(()=>s.page(t,'b',3),/binding_mismatch/);assert.throws(()=>s.page(t,'a',4),/binding_mismatch/);
 const ids=first.rows.map(r=>r.id);let next=first.next;while(next){const p=s.page(next,'a',3);ids.push(...p.rows.map(r=>r.id));next=p.next;}
 assert.deepEqual(ids,Array.from({length:13},(_,i)=>i*2+1));
 assert.match(String(s.db.prepare('EXPLAIN QUERY PLAN SELECT id FROM frozen WHERE session=? AND id>? ORDER BY id LIMIT ?').all('x',0,3)[0]!.detail),/SEARCH.*INDEX/);
 }finally{s.close();}
});
test('unit: clock expiry boundary, capacity, malformed tokens and primitive enums',()=>{
 let now=1000;const s=new Owner(':memory:',()=>now,100);try{
 const t=s.create('a',1);for(let i=1;i<8;i++)s.create('a',1);
 assert.throws(()=>s.create('a',1),/snapshot_capacity/);now=1099;assert.deepEqual(s.page(t,'a',1),{rows:[],next:null});now=1100;assert.throws(()=>s.page(t,'a',1),/cursor_unavailable/);
 s.create('a',1);assert.throws(()=>s.page(t,'a',1),/cursor_unavailable/);
 assert.throws(()=>s.page('bad','a',1),/malformed_token/);assert.throws(()=>s.page('f'.repeat(48),'a',1),/cursor_unavailable/);
 for(const kind of [['a'],{toString:()=> 'a'},null,1])assert.throws(()=>s.create(kind,1),/invalid_binding/);
 for(let i=1;i<=100;i++)s.put(i,'a','v');assert.throws(()=>s.put(101,'a','v'),/live_capacity/);s.put(1,'b','updated');
 }finally{s.close();}
});
test('unit: interrupted application rolls back rows and checkpoint',()=>{
 const s=new ScannerStore(':memory:');try{s.begin('one','a',1,500);const p={rows:[{id:1,kind:'a',value:'v'}],next:'two'};
 assert.throws(()=>s.apply('one',p,true),/before_commit/);assert.deepEqual(s.rows(),[]);assert.equal(s.state()!.token,'one');s.apply('one',p);assert.equal(s.rows().length,1);assert.throws(()=>s.apply('one',p),/checkpoint_changed/);assert.equal(s.rows().length,1);
 }finally{s.close();}
});
test('unit: imports are silent with invalid runtime configuration',async()=>{
 const code=`await import(${JSON.stringify(new URL('../owner.mts',import.meta.url).href)});await import(${JSON.stringify(new URL('../scanner.mts',import.meta.url).href)});`;
 const child=spawn(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',code],{env:{...process.env,PORT:'invalid',TTL_MS:'bad',DB_PATH:'/nonexistent/no',OWNER_URL:'bad'}});
 let output='';child.stdout.on('data',(b:Buffer)=>output+=b.toString());child.stderr.on('data',(b:Buffer)=>output+=b.toString());const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
 try{const [status]=await once(child,'exit');assert.equal(status,0);assert.equal(output,'');}finally{clearTimeout(timer);child.kill();}
});
test('integration: process barriers preserve snapshot, retry rollback and restart checkpoint',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'keyset-'));let owner:Awaited<ReturnType<typeof startService>>|undefined;let scanner:typeof owner;
 const post=async(url:string,path:string,body:unknown,status=200)=>{const r=await jsonRequest(url+path,body);assert.equal(r.status,status,await r.clone().text());return r.json() as Promise<Record<string,unknown>>;};
 try{
 const ownerEnv={DB_PATH:join(dir,'owner.sqlite'),TTL_MS:'60000'};owner=await startService(new URL('../owner.mts',import.meta.url),ownerEnv);
 for(let i=1;i<=7;i++)await post(owner.url,'/resources',{id:i,kind:'a',value:`old${i}`});
 const scannerEnv={DB_PATH:join(dir,'scanner.sqlite'),OWNER_URL:owner.url,TEACHING_CONTROLS:'1'};scanner=await startService(new URL('../scanner.mts',import.meta.url),scannerEnv);
 await post(scanner.url,'/begin',{kind:['a'],size:2},400);await post(scanner.url,'/begin',{kind:'a',size:2},201);
 await post(scanner.url,'/step',{});
 // Completed HTTP responses form deterministic barriers between pages.
 await post(owner.url,'/delete',{id:3});await post(owner.url,'/resources',{id:4,kind:'b',value:'changed'});await post(owner.url,'/resources',{id:8,kind:'a',value:'later'});
 await post(scanner.url,'/step',{interrupt:true},500);
 await scanner.stop();await owner.stop();
 owner=await startService(new URL('../owner.mts',import.meta.url),ownerEnv);
 scanner=await startService(new URL('../scanner.mts',import.meta.url),{...scannerEnv,OWNER_URL:owner.url});
 for(let i=0;i<3;i++)await post(scanner.url,'/step',{});
 const response=await fetch(scanner.url+'/state',{signal:AbortSignal.timeout(1500)});const result=await response.json() as {rows:{id:number;value:string}[];checkpoint:{done:number}};
 assert.equal(result.checkpoint.done,1);assert.deepEqual(result.rows.map(r=>[r.id,r.value]),Array.from({length:7},(_,i)=>[i+1,`old${i+1}`]));
 await post(owner.url,'/page',{token:'bad',kind:'a',size:2},400);await post(owner.url,'/page',{token:'f'.repeat(48),kind:'a',size:2},410);
 for(let i=0;i<7;i++)await post(owner.url,'/snapshots',{kind:'a',size:2},201);await post(owner.url,'/snapshots',{kind:'a',size:2},409);
 }finally{await scanner?.stop();await owner?.stop();await rm(dir,{recursive:true,force:true});}
});
test('integration: persisted token expires at finite retention',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'keyset-expiry-'));let service:Awaited<ReturnType<typeof startService>>|undefined;
 try{service=await startService(new URL('../owner.mts',import.meta.url),{DB_PATH:join(dir,'db'),TTL_MS:'100'});
 const r=await jsonRequest(service.url+'/snapshots',{kind:'a',size:1});assert.equal(r.status,201);const {token}=await r.json() as {token:string};
 await new Promise(resolve=>setTimeout(resolve,150));const expired=await jsonRequest(service.url+'/page',{token,kind:'a',size:1});assert.equal(expired.status,410);
 }finally{await service?.stop();await rm(dir,{recursive:true,force:true});}
});

test('integration: maximum escaped values and safe-integer keys fit a complete scan', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'keyset-escaped-'));
 let owner: Awaited<ReturnType<typeof startService>> | undefined;
 let scanner: typeof owner;
 try {
  owner = await startService(new URL('../owner.mts', import.meta.url), {DB_PATH:join(dir,'owner.sqlite')});
  const ids = Array.from({length:11}, (_,i) => Number.MAX_SAFE_INTEGER-i).sort((a,b) => a-b);
  const value = '\u0000'.repeat(128);
  for (const id of ids) assert.equal((await jsonRequest(owner.url+'/resources',{id,kind:'a',value})).status,200);
  scanner = await startService(new URL('../scanner.mts', import.meta.url), {DB_PATH:join(dir,'scanner.sqlite'),OWNER_URL:owner.url});
  assert.equal((await jsonRequest(scanner.url+'/begin',{kind:'a',size:10})).status,201);
  for (let i=0;i<2;i++) {
   const response = await jsonRequest(scanner.url+'/step',{});
   assert.equal(response.status,200,await response.clone().text());
  }
  const response = await fetch(scanner.url+'/state',{signal:AbortSignal.timeout(1500)});
  const state: unknown = await response.json();
  assert.ok(state && typeof state==='object' && 'rows' in state && Array.isArray(state.rows));
  assert.deepEqual(state.rows,ids.map(id=>({id,kind:'a',value})));
 } finally {await scanner?.stop();await owner?.stop();await rm(dir,{recursive:true,force:true});}
});

test('integration: malformed snapshot replies cannot create a scanner checkpoint', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'keyset-reply-'));
 let reply: unknown = {token:7};
 const upstream = createServer((_req,res) => {res.writeHead(201,{'content-type':'application/json'});res.end(JSON.stringify(reply));});
 let scanner: Awaited<ReturnType<typeof startService>> | undefined;
 try {
  upstream.listen(0,'127.0.0.1');
  await once(upstream,'listening',{signal:AbortSignal.timeout(1500)});
  const address=upstream.address();assert.ok(address && typeof address!=='string');
  scanner=await startService(new URL('../scanner.mts',import.meta.url),{DB_PATH:join(dir,'scanner.sqlite'),OWNER_URL:`http://127.0.0.1:${address.port}`});
  for (reply of [{token:7},{},null,{token:'bad'}]) {
   const response=await jsonRequest(scanner.url+'/begin',{kind:'a',size:1});
   assert.equal(response.status,502,await response.clone().text());
   const stateResponse: Response=await fetch(scanner.url+'/state',{signal:AbortSignal.timeout(1500)});
   assert.deepEqual(await stateResponse.json(),{rows:[]});
  }
  reply={token:'a'.repeat(48)};
  assert.equal((await jsonRequest(scanner.url+'/begin',{kind:'a',size:1})).status,201);
 } finally {await scanner?.stop();upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
