import test from 'node:test';
import assert from 'node:assert/strict';
// Removing transit-delay accounting must break this hand-derived expectation.
test('unit: corrected age includes skewed Date and transit delay', async () => {
  const { initialAge } = await import('../model.mts');
  assert.equal(initialAge(100, 103, 102, 4), 7);
  assert.equal(initialAge(100, 103, 90, 0), 13);
});
import { Cache, parseDocument, object } from '../model.mts';
const epoch = 1700000000;
function reply(policy = 'public,max-age=5,must-revalidate', status = 200, version = 1, language = 'en') {
  return new Response(status === 304 ? null : JSON.stringify({language,version,text:'Hello'}), {status, headers:{etag:`"${language}-${version}"`,vary:'Accept-Language',date:new Date(epoch*1000).toUTCString(),age:'0','cache-control':policy}});
}
test('unit: age4 hit age5 revalidates same language and reuses body', async () => {
  let now=epoch; const conditions: (string|undefined)[]=[];
  const cache=new Cache(()=>now, async (language, etag)=>{conditions.push(etag); return reply(undefined,etag?304:200,1,language);});
  assert.equal((await cache.get('en')).kind,'miss'); now+=4;
  assert.equal((await cache.get('en')).kind,'hit'); now++;
  const result=await cache.get('en'); assert.equal(result.kind,'revalidated'); assert.equal(result.body.text,'Hello');
  assert.deepEqual(conditions,[undefined,'"en-1"']);
  assert.equal((await cache.get('vi')).body.language,'vi');
  assert.deepEqual(cache.state(),[{language:'en',etag:'"en-1"',version:1,age:5},{language:'vi',etag:'"vi-1"',version:1,age:5}]);
});
test('unit: every policy survives bypass including conditional304', async()=>{
  for(const policy of ['private','no-store']) {
    let now=epoch; let current='public,max-age=5,must-revalidate';
    const cache=new Cache(()=>now,async (_language,etag)=>reply(current,etag?304:200));
    await cache.get('en'); now+=5; current=policy;
    const result=await cache.get('en'); assert.equal(result.policy,policy); assert.equal(result.kind,'bypass'); assert.deepEqual(cache.state(),[]);
    assert.equal((await cache.get('en')).policy,policy); assert.deepEqual(cache.state(),[]);
  }
});
test('unit: invalid metadata and representation never replace stored body',async()=>{
  let now=epoch; let response=reply(); const cache=new Cache(()=>now,async()=>response);
  await cache.get('en'); now+=5;
  for(const headers of [{vary:'Cookie'},{age:'-1'},{date:'bad'},{etag:'"vi-1"'},{'cache-control':'public'}]) {
    response=reply(undefined,304); for(const [key,value] of Object.entries(headers)) response.headers.set(key,value);
    await assert.rejects(cache.get('en')); assert.equal(cache.state()[0]?.version,1);
  }
  response=reply(undefined,200,2,'vi'); await assert.rejects(cache.get('en'));
  const empty=new Cache(()=>now,async()=>reply(undefined,304)); await assert.rejects(empty.get('en'));
  for(const value of [null,[],true,{language:'en',version:'1',text:'Hello'},{language:'en',version:9,text:'Hello'}]) assert.throws(()=>parseDocument(value,'en'));
});
test('unit: late304 cannot refresh a newer replacement generation',async()=>{
  let now=epoch; let calls=0; let release: ((value:Response)=>void)|undefined;
  const cache=new Cache(()=>now,async()=>{calls++; if(calls===2)return new Promise<Response>(resolve=>{release=resolve;}); const response=reply(undefined,200,calls===1?1:2);response.headers.set('date',new Date(now*1000).toUTCString());return response;});
  await cache.get('en'); now+=5; const late=cache.get('en'); await Promise.resolve();
  await cache.get('en'); now+=2; release!(reply(undefined,304)); await late;
  assert.equal(cache.state()[0]?.version,2);assert.equal(cache.state()[0]?.age,2);
});
import {startService,jsonRequest} from '../../../test/support.mts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {escapedStrings} from './fixture.mts';
const teaching={TEACHING_CONTROLS:'1',TEACHING_EPOCH_SECONDS:String(epoch)};
// Undici injects Accept-Language:* if omitted; this protocol accepts en/vi.
// Explicit caller headers still override en so rejection cases test that input.
const get=(url:string,headers:Record<string,string>={})=>fetch(url,{headers:{'accept-language':'en',...headers},signal:AbortSignal.timeout(3000)});
async function advance(url:string){assert.equal((await jsonRequest(url+'/teaching/advance',{seconds:5})).status,200);}
test('unit: maximal string escaping preserves JSON primitives and legal representation',()=>{
  const wire=escapedStrings(JSON.stringify({language:'en',version:8,text:'A'.repeat(32)}));
  assert.equal(parseDocument(JSON.parse(wire) as unknown,'en').version,8);
  assert.equal(parseDocument(JSON.parse(wire) as unknown,'en').text.length,32);
});
test('unit: entrypoint imports ignore invalid runtime configuration silently',async()=>{
  const entries=['origin','cache','runtime','model'];
  const code=entries.map(name=>`await import(${JSON.stringify(new URL('../'+name+'.mts',import.meta.url).href)})`).join(';');
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH??'',DB_PATH:'/nonexistent/no.sqlite',ORIGIN_URL:'invalid',TEACHING_EPOCH_SECONDS:'bad',PORT:'bad'},stdio:['ignore','pipe','pipe']});
  let stdout='';let stderr='';child.stdout.on('data',(b:Buffer)=>{stdout+=b.toString();});child.stderr.on('data',(b:Buffer)=>{stderr+=b.toString();});
  const timer=setTimeout(()=>child.kill('SIGKILL'),3000);
  try{const exit=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(exit,0,stderr);assert.equal(stdout,'');assert.equal(stderr,'');}finally{clearTimeout(timer);child.kill();}
});
test('integration: public variants revalidate, bypass, fail closed and restart with durable origin only',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cache-revalidation-'));
  try{
    const origin=await startService(new URL('../origin.mts',import.meta.url),{...teaching,DB_PATH:join(directory,'origin.sqlite')});
    try{
      const cache=await startService(new URL('../cache.mts',import.meta.url),{...teaching,ORIGIN_URL:origin.url});
      try{
        const first=await get(cache.url+'/document');assert.equal(first.status,200);assert.equal(first.headers.get('x-cache'),'miss');assert.equal(first.headers.get('cache-control'),'public,max-age=5,must-revalidate');assert.equal(object(await first.json()).text,'Hello');
        assert.equal((await get(cache.url+'/document')).headers.get('x-cache'),'hit');
        assert.equal(object(await (await get(origin.url+'/teaching/state')).json()).requests,1);
        const vi=await get(cache.url+'/document',{'accept-language':'vi'});assert.equal(object(await vi.json()).text,'Xin_chao');assert.equal(vi.headers.get('vary'),'Accept-Language');
        await advance(origin.url);await advance(cache.url);
        const unchanged=await get(cache.url+'/document');assert.equal(unchanged.headers.get('x-cache'),'revalidated');assert.equal(object(await unchanged.json()).text,'Hello');
        assert.equal(object(await (await get(origin.url+'/teaching/state')).json()).notModified,1);
        assert.equal((await jsonRequest(origin.url+'/teaching/content',{language:'en',version:2,text:'Next',policy:'public'})).status,200);
        await advance(origin.url);await advance(cache.url);
        const changed=await get(cache.url+'/document');assert.equal(changed.headers.get('x-cache'),'miss');assert.equal(object(await changed.json()).version,2);
        await jsonRequest(origin.url+'/teaching/availability',{available:false});await advance(origin.url);await advance(cache.url);
        assert.equal((await get(cache.url+'/document')).status,502);
        await jsonRequest(origin.url+'/teaching/availability',{available:true});
        for(const [version,policy] of [[3,'private'],[4,'no-store']] as const){
          await jsonRequest(origin.url+'/teaching/content',{language:'en',version,text:'Restricted',policy});
          const response=await get(cache.url+'/document');assert.equal(response.headers.get('x-cache'),'bypass');assert.equal(response.headers.get('cache-control'),policy);
          assert.equal((await get(cache.url+'/document')).headers.get('x-cache'),'bypass');
        }
        for(const body of [null,[],true,{available:'false'}])assert.equal((await jsonRequest(origin.url+'/teaching/availability',body)).status,400);
        for(const body of [null,[],true,{seconds:'5'}])assert.equal((await jsonRequest(cache.url+'/teaching/advance',body)).status,400);
        for(const body of [null,[],true,{language:'en',version:'5',text:'Hello',policy:'public'},{language:'en',version:5,text:'Hello',policy:[]}])assert.equal((await jsonRequest(origin.url+'/teaching/content',body)).status,400);
        assert.equal((await jsonRequest(origin.url+'/teaching/content',{language:'en',version:4,text:'Other',policy:'no-store'})).status,409);
        assert.equal((await get(cache.url+'/document',{'accept-language':'fr'})).status,400);
        assert.equal((await get(cache.url+'/document',{authorization:'Bearer teaching'})).status,400);
        assert.equal((await get(cache.url+'/document',{cookie:'example=1'})).status,400);
        const escaped=escapedStrings(JSON.stringify({language:'en',version:5,text:'Persisted',policy:'public'}));
        assert.equal((await fetch(origin.url+'/teaching/content',{method:'POST',headers:{'content-type':'application/json'},body:escaped,signal:AbortSignal.timeout(3000)})).status,200);
        assert.equal((await get(cache.url+'/document')).headers.get('x-cache'),'miss');
      }finally{await cache.stop();}
    }finally{await origin.stop();}
    const restarted=await startService(new URL('../origin.mts',import.meta.url),{DB_PATH:join(directory,'origin.sqlite')});
    try{
      assert.equal((await get(restarted.url+'/teaching/state')).status,404);
      assert.equal(object(await (await get(restarted.url+'/document',{'accept-language':'vi'})).json()).text,'Xin_chao');
      const cold=await startService(new URL('../cache.mts',import.meta.url),{ORIGIN_URL:restarted.url});
      try{const response=await get(cold.url+'/document');assert.equal(response.headers.get('x-cache'),'miss');assert.equal(object(await response.json()).text,'Persisted');assert.equal((await jsonRequest(cold.url+'/teaching/advance',{seconds:1})).status,404);}finally{await cold.stop();}
    }finally{await restarted.stop();}
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('integration: bounded upstream rejects invalid bodies and never follows redirect to distinct reachable origin',async()=>{
  const sink=await startService(new URL('./fixture.mts',import.meta.url),teaching);
  try{
    const source=await startService(new URL('./fixture.mts',import.meta.url),teaching);
    try{
      const cache=await startService(new URL('../cache.mts',import.meta.url),{...teaching,ORIGIN_URL:source.url});
      try{
        const mode=async(value:string)=>{assert.equal((await jsonRequest(source.url+'/teaching/mode',{mode:value,destination:sink.url})).status,200);};
        await mode('redirect');assert.equal((await get(cache.url+'/document')).status,502);
        // Inspect before any mode change: redirects must leave this reachable origin untouched.
        assert.equal(object(await (await get(sink.url+'/teaching/state')).json()).requests,0);
        for(const value of ['oversize','malformed','slow','bad-age','bad-date','bad-vary','bad-policy','bad-etag','wrong-language','unsolicited']){
          const before=object(await (await get(source.url+'/teaching/state')).json());assert.ok(typeof before.requests==='number');
          await mode(value);assert.equal((await get(cache.url+'/document')).status,502,value);assert.deepEqual(await (await get(cache.url+'/state')).json(),[]);
          assert.equal(object(await (await get(source.url+'/teaching/state')).json()).requests,before.requests+1);
        }
        await mode('escaped');const accepted=await get(cache.url+'/document');assert.equal(accepted.status,200);assert.equal(object(await accepted.json()).text,'A'.repeat(32));
      }finally{await cache.stop();}
    }finally{await source.stop();}
  }finally{await sink.stop();}
});
test('unit: origin Age influences hit eligibility and policy is kept on every public path',async()=>{
  let now=epoch;let calls=0;
  const cache=new Cache(()=>now,async()=>{calls++;const response=reply(undefined,calls===1?200:304);response.headers.set('age','3');response.headers.set('date',new Date(now*1000).toUTCString());return response;});
  const miss=await cache.get('en');assert.equal(miss.age,3);assert.equal(miss.policy,'public,max-age=5,must-revalidate');
  now++;const hit=await cache.get('en');assert.equal(hit.kind,'hit');assert.equal(hit.age,4);assert.equal(hit.policy,'public,max-age=5,must-revalidate');
  now++;const fresh=await cache.get('en');assert.equal(fresh.kind,'revalidated');assert.equal(fresh.age,3);assert.equal(fresh.policy,'public,max-age=5,must-revalidate');
});
test('unit: a late public200 cannot resurrect a newer no-store generation',async()=>{
  let now=epoch;let calls=0;let release:((response:Response)=>void)|undefined;
  const cache=new Cache(()=>now,async()=>{calls++;if(calls===2)return new Promise<Response>(resolve=>{release=resolve;});return reply(calls===3?'no-store':undefined,200,calls===3?2:1);});
  await cache.get('en');now+=5;const late=cache.get('en');await Promise.resolve();
  assert.equal((await cache.get('en')).kind,'bypass');release!(reply(undefined,200));await late;
  assert.deepEqual(cache.state(),[]);
});
