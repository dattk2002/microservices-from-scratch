import { test } from 'node:test';
import { HttpError } from '../../../lib/http.mts';
import assert from 'node:assert/strict';
import { merge, Store, validateState } from '../model.mts';
const red = {context:{a:1,b:0},siblings:[{dot:{actor:'a',counter:1},value:'red'}]};
const blue = {context:{a:0,b:1},siblings:[{dot:{actor:'b',counter:1},value:'blue'}]};
const both = {context:{a:1,b:1},siblings:[{dot:{actor:'a',counter:1},value:'red'},{dot:{actor:'b',counter:1},value:'blue'}]};
const resolved = {context:{a:2,b:1},siblings:[{dot:{actor:'a',counter:2},value:'purple'}]};
const deleted = {context:{a:3,b:1},siblings:[{dot:{actor:'a',counter:3},value:null}]};
test('unit: concurrent dots survive, observed resolution and deletion suppress old values',()=>{
 assert.deepEqual(merge(red,blue),both);
 assert.deepEqual(merge(both,resolved),resolved);
 assert.deepEqual(merge(deleted,both),deleted);
});
test('unit: reachable merges commute, associate and are idempotent',()=>{
 for(const x of [red,blue,both,resolved,deleted]) {
 assert.deepEqual(merge(x,x),x);
 for(const y of [red,blue,both,resolved,deleted]) {
 assert.deepEqual(merge(x,y),merge(y,x));
 for(const z of [red,blue,both,resolved,deleted]) assert.deepEqual(merge(merge(x,y),z),merge(x,merge(y,z)));
 }}
});
test('unit: strict states reject contradictory and empty histories',()=>{
 for(const x of [null,[],1,true,{context:{a:1,b:0},siblings:[]},{...red,extra:0},{context:{a:2,b:0},siblings:red.siblings}]) assert.throws(()=>validateState(x));
 assert.throws(()=>merge(red,{...red,siblings:[{dot:{actor:'a',counter:1},value:'other'}]}));
 assert.throws(()=>merge({context:{a:1,b:1},siblings:red.siblings},{context:{a:1,b:1},siblings:blue.siblings}));
});
test('unit: SQLite writes are atomic, stale contexts and capacity leave state unchanged',()=>{
 const store=new Store(':memory:','a');
 try {
 assert.deepEqual(store.read(),{context:{a:0,b:0},siblings:[]});
 assert.deepEqual(store.write({context:{a:0,b:0},value:'red'}),red);
 assert.throws(()=>store.write({context:{a:0,b:0},value:'bad'}),(e:unknown)=>e instanceof HttpError&&e.status===409);
 assert.deepEqual(store.read(),red);
 store.merge(blue);
 assert.deepEqual(store.write({context:{a:1,b:1},value:'purple'}),resolved);
 assert.deepEqual(store.write({context:{a:2,b:1},value:null}),deleted);
 for(let n=3;n<16;n++) store.write({context:{a:n,b:1},value:'x'});
 const last=store.read();
 assert.throws(()=>store.write({context:last.context,value:'overflow'}),(e:unknown)=>e instanceof HttpError&&e.status===429);
 assert.throws(()=>store.merge({context:{a:16,b:1},siblings:[]}));
 assert.deepEqual(store.read(),last);
 } finally {store.close();}
});

import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
const entry=(name:string)=>new URL('../'+name+'.mts',import.meta.url);
async function get(url:string):Promise<unknown>{const r=await fetch(url,{signal:AbortSignal.timeout(2000)});assert.equal(r.status,200);return r.json();}
async function post(url:string,body:unknown,status=200):Promise<unknown>{const r=await jsonRequest(url,body);assert.equal(r.status,status);return r.json();}
test('integration: partitions, bidirectional sync, resolution, deletion and durable identity',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mv-register-'));
 const services:RunningService[]=[];
 try {
 const a=await startService(entry('replica'),{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')});services.push(a);
 const b=await startService(entry('replica'),{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')});services.push(b);
 const relay=await startService(entry('sync'),{A_ORIGIN:a.url,B_ORIGIN:b.url});services.push(relay);
 assert.deepEqual(await post(a.url+'/write',{context:{a:0,b:0},value:'red'}),red);
 assert.deepEqual(await post(b.url+'/write',{context:{a:0,b:0},value:'blue'}),blue);
 assert.deepEqual(await post(relay.url+'/sync',{from:'a'}),both);
 assert.deepEqual(await post(relay.url+'/sync',{from:'b'}),both);
 assert.deepEqual(await post(a.url+'/write',{context:{a:1,b:1},value:'purple'}),resolved);
 assert.deepEqual(await post(relay.url+'/sync',{from:'a'}),resolved);
 assert.deepEqual(await post(a.url+'/write',{context:{a:2,b:1},value:null}),deleted);
 assert.deepEqual(await post(relay.url+'/sync',{from:'a'}),deleted);
 assert.deepEqual(await post(b.url+'/merge',both),deleted);
 for(const input of [null,[],true,1,'a',{from:1},{from:'a',extra:0}])await post(relay.url+'/sync',input,400);
 for(const input of [null,[],false,{context:{a:0,b:0},value:'old'},{context:{a:3,b:1},value:'!'}])await post(a.url+'/write',input,input!==null&&typeof input==='object'&&!Array.isArray(input)&&'value' in input&&input.value==='old'?409:400);
 await post(a.url+'/merge',{...deleted,siblings:[{dot:{actor:'a',counter:3},value:'forged'}]},409);
 assert.deepEqual(await get(a.url+'/value'),deleted);
 await b.stop();
 const bRestarted=await startService(entry('replica'),{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')});services.push(bRestarted);
 assert.deepEqual(await get(bRestarted.url+'/value'),deleted);
 await a.stop();
 await assert.rejects(startService(entry('replica'),{REPLICA_ID:'b',DB_PATH:join(dir,'a.db')}));
 const restarted=await startService(entry('replica'),{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')});services.push(restarted);
 assert.deepEqual(await get(restarted.url+'/value'),deleted);
 assert.deepEqual(await post(restarted.url+'/write',{context:{a:3,b:1},value:'next'}),{context:{a:4,b:1},siblings:[{dot:{actor:'a',counter:4},value:'next'}]});
 }finally {for(const s of services.reverse())await s.stop();await rm(dir,{recursive:true,force:true});}
});
test('integration: bounded reusable upstreams, redirects contained and total deadline',async()=>{
 const services:RunningService[]=[];
 try {
 const destination=await startService(new URL('./fixture.mts',import.meta.url),{TEACHING_CONTROLS:'1'});services.push(destination);
 const source=await startService(new URL('./fixture.mts',import.meta.url),{TEACHING_CONTROLS:'1',DESTINATION:destination.url});services.push(source);
 const target=await startService(new URL('./fixture.mts',import.meta.url),{TEACHING_CONTROLS:'1',DESTINATION:destination.url});services.push(target);
 const relay=await startService(entry('sync'),{A_ORIGIN:source.url,B_ORIGIN:target.url});services.push(relay);
 const control=(s:RunningService,mode:string)=>post(s.url+'/control',{mode});
 await assert.rejects(startService(entry('sync'),{A_ORIGIN:source.url,B_ORIGIN:source.url+'/'}));
 for(const s of [source,target]) {
 for(const mode of ['escaped','oversize','status','missing','malformed','primitive','slow','slowbody','redirect','drop']) {
 await control(s,mode);
 const before=await get(destination.url+'/hits');
 await post(relay.url+'/sync',{from:'a'},mode==='escaped'?200:502);
 if(mode==='redirect')assert.deepEqual(await get(destination.url+'/hits'),before);
 await control(s,'ok');
 }
 }
 await control(source,'delay');await control(target,'delay');
 await post(relay.url+'/sync',{from:'a'},502);
 await control(source,'ok');await control(target,'ok');
 for(const mode of ['conflict-null','conflict-array','conflict-number','conflict-unrelated','conflict-extra']) {
 await control(target,mode);await post(relay.url+'/sync',{from:'a'},502);
 }
 await control(target,'conflict');await post(relay.url+'/sync',{from:'a'},409);
 await control(source,'conflict');await post(relay.url+'/sync',{from:'a'},502);
 }finally {for(const s of services.reverse())await s.stop();}
});
test('unit: imports are silent despite invalid runtime configuration',async()=>{
 const code=`await import(${JSON.stringify(entry('replica').href)});await import(${JSON.stringify(entry('sync').href)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH??'',REPLICA_ID:'invalid',DB_PATH:'/unusable',A_ORIGIN:'invalid',B_ORIGIN:'invalid'},stdio:['ignore','pipe','pipe']});
 const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
 try {
 let stdout='',stderr='';child.stdout.on('data',(b:Buffer)=>{stdout+=b.toString();});child.stderr.on('data',(b:Buffer)=>{stderr+=b.toString();});
 const exit=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
 assert.equal(exit,0,stderr);assert.equal(stdout,'');assert.equal(stderr.replace(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\n/g,''),'');
 }finally {clearTimeout(timer);if(child.exitCode===null)child.kill('SIGKILL');}
});
test('unit: exact JSON primitives, ordering, bounds and failed merges preserve the stored snapshot',()=>{
 const store=new Store(':memory:','a');
 try {
 store.merge(both);
 const invalid:unknown[]=[null,[],false,17,'state',{context:{a:'1',b:1},siblings:both.siblings},{context:{a:1,b:1,c:0},siblings:both.siblings},{context:{a:17,b:1},siblings:both.siblings},{context:{a:1,b:1},siblings:[...both.siblings].reverse()},{context:{a:1,b:1},siblings:[both.siblings[0],both.siblings[0]]},{context:{a:1,b:1},siblings:[{dot:{actor:'a',counter:1,extra:1},value:'red'}]},{context:{a:1,b:1},siblings:[{dot:{actor:'a',counter:1},value:''}]},{context:{a:1,b:1},siblings:[{dot:{actor:'a',counter:1},value:'x'.repeat(33)}]}];
 for(const x of invalid){assert.throws(()=>store.merge(x));assert.deepEqual(store.read(),both);}
 assert.throws(()=>store.merge({...red,siblings:[{dot:{actor:'a',counter:1},value:null}]}));assert.deepEqual(store.read(),both);
 for(const x of [null,[],true,{context:{a:1,b:1},value:3},{context:{a:1,b:1},value:'ok',extra:0},{context:{a:2,b:1},value:'forged'}]){assert.throws(()=>store.write(x));assert.deepEqual(store.read(),both);}
 assert.deepEqual(merge({context:{a:0,b:0},siblings:[]},red),red);
 assert.deepEqual(merge(deleted,red),deleted);assert.deepEqual(merge(deleted,blue),deleted);
 }finally {store.close();}
});
