import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../model.mts';
test('unit: canonical SHA256 uses version, sequence, previous hash and immutable payload',()=>{
 assert.equal(m.digest(1,'0'.repeat(64),'a','created','order-1'),'8f8b8781b73b401f8134d0af191bec04fbf21de3af703107c204dd8d1fca5616');
});
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
const zero='0'.repeat(64);
// Independent test builder intentionally does not call the production hash helper.
function chain(n:number,subject='order-1') {
 let prev=zero;
 const entries=Array.from({length:n},(_,i)=>{const e={seq:i+1,prev,id:`a${i}`,action:'created',subject,hash:''};e.hash=createHash('sha256').update(JSON.stringify([1,e.seq,e.prev,e.id,e.action,e.subject])).digest('hex');prev=e.hash;return e;});
 return {entries,head:{count:n,hash:prev}};
}

test('unit: immutable receipts replay before capacity and conflicting payload never changes chain',async()=>{
 const db=new DatabaseSync(':memory:');try{
 const log=new m.Log(db);const first=log.append({id:'a',action:'created',subject:'order-1'});
 assert.deepEqual(first,{seq:1,prev:zero,id:'a',action:'created',subject:'order-1',hash:'8f8b8781b73b401f8134d0af191bec04fbf21de3af703107c204dd8d1fca5616'});
 for(let i=1;i<16;i++)log.append({id:`a${i}`,action:'approved',subject:'_'.repeat(32)});
 assert.deepEqual(log.append({id:'a',action:'created',subject:'order-1'}),first);
 assert.throws(()=>log.append({id:'a',action:'cancelled',subject:'order-1'}),/conflict/);
 assert.throws(()=>log.append({id:'overflow',action:'created',subject:'x'}),/capacity/);
 assert.equal(log.export().head.count,16);assert.deepEqual(new m.Log(db).export(),log.export());
 }finally{db.close();}
});
test('unit: full canonical validation rejects edits, ordering, duplicates, hash and head errors',async()=>{
 assert.deepEqual(m.validate(chain(16)),chain(16));
 const edited=chain(2);edited.entries[0]!.subject='other';
 const reordered=chain(2);reordered.entries.reverse();
 const badHead=chain(2);badHead.head.count=1;
 const duplicate=chain(2);duplicate.entries[1]!.id='a0';
 for(const bad of [null,[],true,edited,reordered,badHead,duplicate,{...chain(1),extra:1}])assert.throws(()=>m.validate(bad));
});
test('unit: checkpoint pins prefix, permits extension, rejects consistent rollback/fork and remains durable',async()=>{
 const db=new DatabaseSync(':memory:');try{
 let pin=new m.Anchor(db);assert.deepEqual(pin.state(),{count:0,hash:zero});
 pin.accept(m.validate(chain(0)),true);pin.accept(m.validate(chain(2)),true);
 assert.equal(pin.accept(m.validate(chain(3)),false).checkpoint.count,2);
 for(const fork of [chain(1),chain(2,'rewritten'),chain(3,'rewritten')])assert.throws(()=>pin.accept(m.validate(fork),true),/prefix/);
 pin=new m.Anchor(db);assert.equal(pin.state().count,2);pin.accept(m.validate(chain(3)),true);assert.equal(pin.state().count,3);
 // Unanchored suffix rewriting is deliberately undetectable.
 const suffix=chain(4);suffix.entries[3]!.subject='new';const e=suffix.entries[3]!;e.hash=createHash('sha256').update(JSON.stringify([1,e.seq,e.prev,e.id,e.action,e.subject])).digest('hex');suffix.head.hash=e.hash;
 assert.equal(pin.accept(m.validate(suffix),false).count,4);
 }finally{db.close();}
});
test('unit: reject wrong primitive payloads and accept URL-safe maximum',async()=>{
 for(const bad of [null,[],true,{id:['a'],action:'created',subject:'x'},{id:'a',action:['created'],subject:'x'},{id:'a',action:'created',subject:1},{id:'a',action:'created',subject:'x',extra:1}])assert.throws(()=>m.input(bad));
 assert.deepEqual(m.input({id:'_'.repeat(32),action:'cancelled',subject:'-'.repeat(32)}),{id:'_'.repeat(32),action:'cancelled',subject:'-'.repeat(32)});
});
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startService,jsonRequest} from '../../../test/support.mts';
import type {RunningService} from '../../../test/support.mts';
test('unit: imports succeed silently despite invalid runtime configuration',async()=>{
 const code=`await import(${JSON.stringify(new URL('../logger.mts',import.meta.url).href)});await import(${JSON.stringify(new URL('../auditor.mts',import.meta.url).href)});`;
 const r=await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{timeout:3000,env:{...process.env,DB_PATH:'/missing/impossible/db',PORT:'bad',LOGGER_ORIGIN:'bad',VERIFY_TIMEOUT_MS:'bad'}});
 assert.equal(r.stdout,'');assert.equal(r.stderr,'');
});
async function get(s:RunningService,path:string){const r=await fetch(s.url+path,{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);return m.object(await r.json());}
async function post(s:RunningService,path:string,body:unknown,status=200){const r=await jsonRequest(s.url+path,body);assert.equal(r.status,status,`${path}: ${await r.clone().text()}`);return r;}
test('integration: independent checkpoint detects corruption, rollback and fork; extension and both restarts retain trust',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'audit-'));let log:RunningService|undefined;let audit:RunningService|undefined;
 try{
 const le={DB_PATH:join(dir,'l.sqlite'),TEACHING_CONTROLS:'1'};
 log=await startService(new URL('../logger.mts',import.meta.url),le);
 const ae={DB_PATH:join(dir,'a.sqlite'),LOGGER_ORIGIN:log.url};audit=await startService(new URL('../auditor.mts',import.meta.url),ae);
 await post(audit,'/checkpoint',{});assert.deepEqual((await get(audit,'/state')).checkpoint,{count:0,hash:zero});
 for(const mode of ['edit','truncate','rewrite'])await post(log,'/teaching/view',{mode},409);
 for(let i=0;i<2;i++)await post(log,'/entries',{id:`a${i}`,action:'created',subject:'order-1'});
 const pin=await (await post(audit,'/checkpoint',{})).json();assert.equal(m.object(m.object(pin).checkpoint).count,2);
 await post(log,'/entries',{id:'a2',action:'created',subject:'order-1'});
 await post(audit,'/verify',{});assert.deepEqual((await get(audit,'/state')).checkpoint,m.object(pin).checkpoint);
 for(const [mode,status] of [['edit',502],['truncate',200],['rewrite',409]] as const){await post(log,'/teaching/view',{mode});await post(audit,'/verify',{},status);}
 // Truncating exactly to the anchor is allowed; truncating below it is a rollback.
 await post(log,'/teaching/view',{mode:'clean'});await post(audit,'/checkpoint',{});
 await post(log,'/teaching/view',{mode:'truncate'});await post(audit,'/checkpoint',{},409);
 await post(log,'/teaching/view',{mode:'clean'});
 for(const bad of [null,[],false,{mode:['clean']}])await post(log,'/teaching/view',bad,400);
 for(const bad of [null,[],false,{id:'x',action:['created'],subject:'x'}])await post(log,'/entries',bad,400);
 for(const route of ['/verify','/checkpoint'])for(const bad of [null,[],false,{unexpected:1}])await post(audit,route,bad,400);
 await audit.stop();await log.stop();log=await startService(new URL('../logger.mts',import.meta.url),le);
 audit=await startService(new URL('../auditor.mts',import.meta.url),{...ae,LOGGER_ORIGIN:log.url});
 assert.equal(m.object((await get(audit,'/state')).checkpoint).count,3);await post(audit,'/verify',{});
 for(let i=3;i<16;i++)await post(log,'/entries',{id:`a${i}`,action:'cancelled',subject:'-'.repeat(32)});
 await post(log,'/entries',{id:'a0',action:'created',subject:'order-1'});
 await post(log,'/entries',{id:'a0',action:'approved',subject:'order-1'},409);
 await post(log,'/entries',{id:'overflow',action:'created',subject:'x'},409);
 await post(audit,'/checkpoint',{});assert.equal(m.object((await get(audit,'/state')).checkpoint).count,16);
 }finally{await audit?.stop();await log?.stop();await rm(dir,{recursive:true,force:true});}
});
async function barrier(s:RunningService){for(let i=0;i<100;i++){if((await get(s,'/state')).held===true)return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('source never held export');}
test('integration: bounded reusable source rejects invalid/oversized/slow/redirect; concurrent old snapshot cannot overwrite new checkpoint',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'audit-source-'));let src:RunningService|undefined;let sink:RunningService|undefined;let audit:RunningService|undefined;
 try{
 src=await startService(new URL('./source.mts',import.meta.url));sink=await startService(new URL('./source.mts',import.meta.url));
 audit=await startService(new URL('../auditor.mts',import.meta.url),{DB_PATH:join(dir,'audit.sqlite'),LOGGER_ORIGIN:src.url,VERIFY_TIMEOUT_MS:'600'});
 await post(audit,'/checkpoint',{});const before=(await get(audit,'/state')).checkpoint;
 for(const mode of ['invalid','oversize','slow','redirect']){
 await post(src,'/control',{mode,count:3,target:sink.url});await post(audit,'/checkpoint',{},502);
 assert.deepEqual((await get(audit,'/state')).checkpoint,before);
 const metrics=await get(src,'/state');assert.equal(metrics.calls,1);assert.equal(metrics.leaks,0);assert.equal((await get(sink,'/state')).leaks,0);
 }
 // Capture an old valid snapshot; a newer request commits before it is released.
 await post(src,'/control',{mode:'hold',count:2,target:sink.url});
 const old=post(audit,'/checkpoint',{},409);await barrier(src);
 await post(src,'/control',{mode:'valid',count:3,target:sink.url});await post(audit,'/checkpoint',{});
 await post(src,'/release',{});await old;
 assert.equal(m.object((await get(audit,'/state')).checkpoint).count,3);
 // All 16 maximum-length fields, even escaped six bytes per character, fit budget.
 await post(src,'/control',{mode:'escaped',count:16,target:sink.url});await post(audit,'/checkpoint',{});
 assert.equal(m.object((await get(audit,'/state')).checkpoint).count,16);
 }finally{await audit?.stop();await src?.stop();await sink?.stop();await rm(dir,{recursive:true,force:true});}
});
test('integration: teaching controls disabled; maximally escaped normal input accepted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'audit-input-'));let log:RunningService|undefined;
 try{log=await startService(new URL('../logger.mts',import.meta.url),{DB_PATH:join(dir,'l.sqlite')});
 await post(log,'/teaching/view',{mode:'edit'},404);
 const body=JSON.stringify({id:'_'.repeat(32),action:'cancelled',subject:'-'.repeat(32)}).replace(/[A-Za-z0-9_-]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
 const r=await fetch(log.url+'/entries',{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);
 assert.equal(m.object((await get(log,'/export')).head).count,1);
 }finally{await log?.stop();await rm(dir,{recursive:true,force:true});}
});
