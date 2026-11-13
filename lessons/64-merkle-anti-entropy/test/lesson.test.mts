import test from 'node:test';
import assert from 'node:assert/strict';
import { Pair,oracle,source,target } from './oracle.mts';
import { repairSnapshot } from '../repair.mts';

test('unit: only k5 differs; traverse its branch and skip equal subtrees with golden hashes',async()=>{
  const p=new Pair();p.source[5]='null';p.sourceRevision=1;
  assert.equal(oracle(p.target).get('101'),'30852e04832f48d4833542a8be30c295384c247d41155c63b74fa11fd36f995f');
  assert.equal(oracle(p.target).get(''),'c3f85e1c1f500145fe1cf7654af3bad5b9864bec7ed2824285a07ec5ca07be8a');
  assert.equal(oracle(p.source).get('101'),'fe15432d8e871959a32f60e5ef12b08d5870af57e24fb607496d9c13be96fc85');
  const report=await repairSnapshot(source,target,p.fetcher);
  assert.deepEqual(report,{changed:['k5'],sourceRevision:1,targetRevision:1});
  assert.deepEqual(p.calls.filter(c=>c.path.startsWith('/node')).map(c=>[c.side,new URL(c.path,source).searchParams.get('path')]),[
    ['source',''],['target',''],['source','1'],['target','1'],['source','10'],['target','10'],['source','101'],['target','101'],
  ]);
  assert.deepEqual(p.calls.filter(c=>c.path.startsWith('/record')).map(c=>[c.side,c.path]),[['source','/record?key=k5&revision=1']]);
  assert.deepEqual(p.calls.filter(c=>c.path==='/apply').map(c=>c.body),[{expectedRevision:0,records:[{key:'k5',value:'null'}]}]);
  assert.deepEqual(p.target,p.source);
});

// These assertions catch loss of domain separation, key identity or stable binary order.
test('unit: canonical hashes separate null, strings, keys and internal nodes',async()=>{
  const {leafHash,branchHash,tree}=await import('../protocol.mts');
  const values=Array<null|string>(8).fill(null);
  assert.equal(leafHash('k5',null),'30852e04832f48d4833542a8be30c295384c247d41155c63b74fa11fd36f995f');
  assert.equal(leafHash('k5','null'),'fe15432d8e871959a32f60e5ef12b08d5870af57e24fb607496d9c13be96fc85');
  assert.equal(tree(values).get(''),'c3f85e1c1f500145fe1cf7654af3bad5b9864bec7ed2824285a07ec5ca07be8a');
  assert.notEqual(leafHash('k4',null),leafHash('k5',null));
  assert.notEqual(branchHash(leafHash('k4',null),leafHash('k5',null)),branchHash(leafHash('k5',null),leafHash('k4',null)));
  assert.notEqual(branchHash(leafHash('k5',null),leafHash('k5',null)),leafHash('k5',null));
  const varied=[null,'A','null','_-','Z9',null,'0','last'];
  assert.deepEqual([...tree(varied)].sort(),[...oracle(varied)].sort());
});

test('unit: equal roots read no nodes, records or apply; all differences use canonical left-first order',async()=>{
  const p=new Pair();
  assert.deepEqual(await repairSnapshot(source,target,p.fetcher),{changed:[],sourceRevision:0,targetRevision:0});
  assert.deepEqual(p.calls.map(c=>c.path),['/root','/root']);
  p.calls=[];p.source=['A','B','C','D','E','F','G','H'];p.sourceRevision=8;
  assert.deepEqual(await repairSnapshot(source,target,p.fetcher),{changed:['k0','k1','k2','k3','k4','k5','k6','k7'],sourceRevision:8,targetRevision:1});
  assert.deepEqual(p.calls.filter(c=>c.path.startsWith('/record')).map(c=>c.path),Array.from({length:8},(_,i)=>`/record?key=k${i}&revision=8`));
  assert.equal(p.calls.filter(c=>c.path==='/apply').length,1);
});

test('unit: stale source or target discards the plan; concurrent target write survives apply conflict',async()=>{
  const {semantic}=await import('./oracle.mts');
  for(const side of ['source','target']) {
    const p=new Pair();p.source[0]='A';p.sourceRevision=1;
    p.hook=(s,url)=>s===side&&url.pathname==='/node'?semantic(409):undefined;
    await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:409,code:'revision_changed'});
    assert.equal(p.calls.some(c=>c.path==='/apply'),false);
    assert.deepEqual(p.target,Array<null>(8).fill(null));
  }
  const p=new Pair();p.source[0]='A';p.sourceRevision=1;
  p.hook=(side,url)=>{if(side==='target'&&url.pathname==='/apply'){p.target[7]='concurrent';p.targetRevision++;}return undefined;};
  await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:409});
  assert.equal(p.target[0],null);assert.equal(p.target[7],'concurrent');
});

test('unit: malformed later leaf or forged parent commitment never sends a partial patch',async()=>{
  for(const variant of ['later-record','node-hash','composition','revision','identity','leaf-children']) {
    const p=new Pair();p.source[0]='A';p.source[7]='H';p.sourceRevision=2;
    p.hook=async(side,url,body)=>{
      if(side!=='source') return;
      const reply:unknown=await p.respond(side,url,body).json();
      if(typeof reply!=='object'||reply===null||Array.isArray(reply)) throw new Error('Bad fixture');
      if(variant==='later-record'&&url.pathname==='/record'&&url.searchParams.get('key')==='k7') return Response.json({...reply,value:'forged'});
      if(url.pathname==='/node'&&url.searchParams.get('path')===(variant==='leaf-children'?'000':'1')) {
        if(variant==='node-hash') return Response.json({...reply,hash:'0'.repeat(64)});
        if(variant==='composition') return Response.json({...reply,children:{left:'0'.repeat(64),right:'1'.repeat(64)}});
        if(variant==='revision') return Response.json({...reply,revision:0});
        if(variant==='identity') return Response.json({...reply,path:'0'});
        if(variant==='leaf-children') return Response.json({...reply,children:{left:'0'.repeat(64),right:'0'.repeat(64)}});
      }
      return;
    };
    await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502},variant);
    assert.equal(p.calls.some(c=>c.path==='/apply'),false,variant);
    assert.deepEqual(p.target,Array<null>(8).fill(null));
  }
});

test('unit: only exact recognized semantic errors preserve status on either store',async()=>{
  const {semantic}=await import('./oracle.mts');
  for(const side of ['source','target']) for(const body of [null,[],1,'oops',{}, {error:{code:'revision_changed',message:'wrong'}},{error:{code:'internal_error',message:'Revision changed'}},{error:{code:'revision_changed',message:'Revision changed'},extra:1}]) {
    const p=new Pair();p.source[0]='A';p.sourceRevision=1;
    p.hook=(s,url)=>s===side&&url.pathname==='/node'?Response.json(body,{status:409}):undefined;
    await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502});
    assert.equal(p.calls.some(c=>c.path==='/apply'),false);
  }
  for(const body of [null,[],{}, {error:{code:'internal_error',message:'Revision limit reached'}},{error:{code:'revision_limit',message:'wrong'}}]) {
    const p=new Pair();p.source[0]='A';p.sourceRevision=1;
    p.hook=(_s,url)=>url.pathname==='/apply'?Response.json(body,{status:429}):undefined;
    await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502});
  }
  const p=new Pair();p.source[0]='A';p.sourceRevision=1;
  p.hook=(_s,url)=>url.pathname==='/apply'?semantic(429):undefined;
  await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:429,code:'revision_limit'});
  // A 409 root is outside the /root contract, even if its envelope is recognized.
  p.hook=(_s,url)=>url.pathname==='/root'?semantic(409):undefined;
  await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502});
});

test('unit: success schemas, statuses, apply revision and transport fail closed',async()=>{
  for(const route of ['/root','/node','/record','/apply']) for(const body of [null,[],true,42,'x',{}, {revision:0,hash:'A'.repeat(64)}]) {
    const p=new Pair();p.source[0]='A';p.sourceRevision=1;
    p.hook=(_s,url)=>url.pathname===route?Response.json(body):undefined;
    await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502},route);
  }
  for(const status of [201,204,302,400,404,422,429,500,503]) {
    const p=new Pair();p.hook=()=>new Response(null,{status});
    await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502});
  }
  const p=new Pair();p.source[0]='A';p.sourceRevision=1;
  p.hook=(_s,url)=>url.pathname==='/apply'?Response.json({revision:2}):undefined;
  await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502});
  p.hook=()=>{throw new Error('connection lost');};
  await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502});
});

test('unit: atomic patches validate all records, compare revision first and stop at 32',async()=>{
  const {Store}=await import('../store.mts');
  const s=await Store.open(':memory:','unit');
  try {
    assert.deepEqual(s.root(),{revision:0,hash:'c3f85e1c1f500145fe1cf7654af3bad5b9864bec7ed2824285a07ec5ca07be8a'});
    assert.deepEqual(s.write({key:'k5',value:'A'}),{revision:1});
    assert.deepEqual(s.write({key:'k5',value:'A'}),{revision:1});
    assert.deepEqual(s.apply({expectedRevision:1,records:[{key:'k0',value:'first'},{key:'k5',value:null}]}),{revision:2});
    const before=s.root();
    for(const records of [null,{},[{key:'k0',value:'changed'},{key:'k7',value:'space invalid'}],[{key:'k1',value:null},{key:'k0',value:null}],[{key:'k0',value:null},{key:'k0',value:'a'}],Array(9).fill({key:'k0',value:null}),[{key:'k2',value:1}],[{key:'k2',value:null,extra:true}]]) {
      assert.throws(()=>s.apply({expectedRevision:2,records}),{status:400});assert.deepEqual(s.root(),before);
    }
    assert.throws(()=>s.apply({expectedRevision:1,records:null}),{status:409});
    for(const body of [null,[],true,1,'x',{}, {key:'k0',value:null,extra:1},{key:'k8',value:null},{key:'k0',value:''},{key:'k0',value:'a'.repeat(17)},{key:{toString:null},value:null}]) assert.throws(()=>s.write(body),{status:400});
    for(const body of [null,[],false,{}, {expectedRevision:'2',records:[]},{expectedRevision:2,records:[],extra:1}]) assert.throws(()=>s.apply(body),{status:400});
    for(let i=3;i<=32;i++) assert.deepEqual(s.write({key:'k1',value:String(i)}),{revision:i});
    const full=s.root();
    assert.deepEqual(s.apply({expectedRevision:32,records:[]}),{revision:32});
    assert.deepEqual(s.apply({expectedRevision:32,records:[{key:'k1',value:'32'}]}),{revision:32});
    assert.deepEqual(s.write({key:'k1',value:'32'}),{revision:32});
    assert.throws(()=>s.write({key:'k1',value:null}),{status:429});
    assert.throws(()=>s.apply({expectedRevision:32,records:[{key:'k0',value:'new'},{key:'k1',value:null}]}),{status:429});
    assert.deepEqual(s.root(),full);
    assert.throws(()=>s.node('101',31),{status:409});assert.throws(()=>s.record('k5',31),{status:409});
    assert.deepEqual(s.record('k5',32),{revision:32,key:'k5',value:null,hash:'30852e04832f48d4833542a8be30c295384c247d41155c63b74fa11fd36f995f'});
  } finally {s.close();}
});

test('unit: fixed distinct origins normalize before listening; imports ignore invalid configuration',async()=>{
  const {origins}=await import('../repair.mts');
  const {spawnSync}=await import('node:child_process');
  assert.deepEqual(origins('http://127.0.0.1:010001/','http://127.0.0.1:10002'),[source,target]);
  for(const pair of [[source,source+'/'],['http://localhost:80','http://LOCALHOST/'],[source+'/path',target],[source+'?x=1',target],['file:///tmp/a',target],['http://user@127.0.0.1',target]]) assert.throws(()=>origins(pair[0],pair[1]));
  const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../store.mts',import.meta.url).href)});await import(${JSON.stringify(new URL('../repair.mts',import.meta.url).href)});`],{encoding:'utf8',timeout:3000,env:{PATH:process.env.PATH,PORT:'bad',DB_PATH:'/unavailable/file',REPLICA_ID:'!',SOURCE_ORIGIN:'bad',TARGET_ORIGIN:'bad'}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

test('unit: maximal string escaping preserves JSON tokens; oversize valid bytes fail before apply',async()=>{
  const {escaped}=await import('./oracle.mts');
  assert.deepEqual(JSON.parse(escaped({yes:true,no:false,n:null,number:32,text:'A_9'})),{yes:true,no:false,n:null,number:32,text:'A_9'});
  const p=new Pair();p.source[5]='A'.repeat(16);p.sourceRevision=1;
  p.hook=async(side,url,body)=>new Response(escaped(await p.respond(side,url,body).json()),{headers:{'content-type':'application/json'}});
  assert.deepEqual(await repairSnapshot(source,target,p.fetcher),{changed:['k5'],sourceRevision:1,targetRevision:1});
  for(const side of ['source','target']) {
    const q=new Pair();q.source[5]='A';q.sourceRevision=1;
    q.hook=async(s,url,body)=>s===side?new Response(escaped(await q.respond(s,url,body).json())+' '.repeat(4096),{headers:{'content-type':'application/json'}}):undefined;
    await assert.rejects(repairSnapshot(source,target,q.fetcher),{status:502});
    assert.equal(q.calls.some(c=>c.path==='/apply'),false);
  }
});

test('unit: deadline covers headers and bodies across hops; fetch always forbids redirects',async()=>{
  const {performance}=await import('node:perf_hooks');
  const p=new Pair();p.source[5]='A';p.sourceRevision=1;
  let hops=0;
  const fetcher:typeof fetch=async(input,init)=>{
    assert.equal(init?.redirect,'error');assert.ok(init?.signal);
    hops++;
    if(hops<=2) await new Promise<void>(resolve=>setTimeout(resolve,200));
    if(hops===3) return new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('{'));}}),{headers:{'content-type':'application/json'}});
    return p.fetcher(input,init);
  };
  const start=performance.now();
  await assert.rejects(repairSnapshot(source,target,fetcher),{status:502});
  const elapsed=performance.now()-start;
  assert.ok(elapsed>=900&&elapsed<1400,`total ${elapsed} ms`);
  assert.equal(hops,3);assert.equal(p.calls.some(c=>c.path==='/apply'),false);
});

import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService,jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { exact } from '../protocol.mts';

async function get(url:string):Promise<unknown> {
  const r=await fetch(url,{signal:AbortSignal.timeout(2500)});assert.equal(r.status,200);return r.json();
}
async function post(url:string,body:unknown,status=200):Promise<unknown> {
  const r=await jsonRequest(url,body);assert.equal(r.status,status,`${url}: ${await (r.status===status?Promise.resolve(''):r.text())}`);return r.json();
}
async function stats(url:string) {
  const v=await get(url+'/teaching/stats');
  assert.ok(exact(v,['root','node','record','apply'])||exact(v,['root','node','record','apply','received','target','targetRevision']));
  assert.ok(typeof v.root==='number'&&typeof v.node==='number'&&typeof v.record==='number'&&typeof v.apply==='number');
  return {root:v.root,node:v.node,record:v.record,apply:v.apply,received:v.received,target:v.target,targetRevision:v.targetRevision};
}
async function stopAll(services:RunningService[]):Promise<void> {
  const results=await Promise.allSettled([...services].reverse().map(s=>s.stop()));
  const failures=results.filter(r=>r.status==='rejected');
  if(failures.length) throw new AggregateError(failures.map(r=>r.reason),'Cleanup failed');
}

test('integration: independent SQLite stores skip equal branches, patch once and survive restart with identity',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'merkle-'));
  const services:RunningService[]=[];
  try {
    const start=async(id:string,file:string,teaching='1')=>{
      const s=await startService(new URL('../store.mts',import.meta.url),{REPLICA_ID:id,DB_PATH:file,TEACHING_CONTROLS:teaching});services.push(s);return s;
    };
    const a=await start('alpha',join(dir,'a.db'));
    let b=await start('beta',join(dir,'b.db'));
    const relay=await startService(new URL('../repair.mts',import.meta.url),{SOURCE_ORIGIN:a.url,TARGET_ORIGIN:b.url});services.push(relay);
    assert.deepEqual(await post(relay.url+'/repair',{}),{changed:[],sourceRevision:0,targetRevision:0});
    let ac=await stats(a.url),bc=await stats(b.url);
    assert.equal(ac.node,0);assert.equal(ac.record,0);assert.equal(bc.node,0);assert.equal(bc.record,0);assert.equal(bc.apply,0);
    assert.deepEqual(await post(a.url+'/write',{key:'k5',value:'null'}),{revision:1});
    assert.deepEqual(await post(relay.url+'/repair',{}),{changed:['k5'],sourceRevision:1,targetRevision:1});
    ac=await stats(a.url);bc=await stats(b.url);
    assert.equal(ac.node,4);assert.equal(bc.node,4);assert.equal(ac.record,1);assert.equal(bc.record,0);assert.equal(bc.apply,1);
    assert.deepEqual(await get(b.url+'/record?key=k5&revision=1'),{revision:1,key:'k5',value:'null',hash:'fe15432d8e871959a32f60e5ef12b08d5870af57e24fb607496d9c13be96fc85'});
    await post(a.url+'/write',{key:'k0',value:'first'});await post(a.url+'/write',{key:'k7',value:'last'});
    assert.deepEqual(await post(relay.url+'/repair',{}),{changed:['k0','k7'],sourceRevision:3,targetRevision:2});
    const root=await get(b.url+'/root');
    await b.stop();
    await assert.rejects(start('wrong',join(dir,'b.db')),/identity mismatch/);
    b=await start('beta',join(dir,'b.db'),'0');
    assert.deepEqual(await get(b.url+'/root'),root);
    assert.deepEqual(await get(b.url+'/record?key=k0&revision=2'),{revision:2,key:'k0',value:'first',hash:oracle(['first',null,null,null,null,'null',null,'last']).get('000')});
    const disabled=await fetch(b.url+'/teaching/stats');assert.equal(disabled.status,404);await disabled.body?.cancel();
    for(let i=3;i<=32;i++) await post(b.url+'/write',{key:'k1',value:String(i)});
    assert.deepEqual(await post(b.url+'/apply',{expectedRevision:32,records:[]}),{revision:32});
    await post(b.url+'/apply',{expectedRevision:32,records:[{key:'k0',value:'new'},{key:'k7',value:null}]},429);
    const retained=await get(b.url+'/record?key=k0&revision=32');assert.ok(exact(retained,['revision','key','value','hash']));assert.equal(retained.value,'first');
  } finally {try {await stopAll(services);} finally {await rm(dir,{recursive:true,force:true});}}
});

test('integration: public bodies, query keys and methods reject invalid primitives and extra fields',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'merkle-schema-'));
  const services:RunningService[]=[];
  try {
    const a=await startService(new URL('../store.mts',import.meta.url),{REPLICA_ID:'a',DB_PATH:join(dir,'a.db')});services.push(a);
    const b=await startService(new URL('../store.mts',import.meta.url),{REPLICA_ID:'b',DB_PATH:join(dir,'b.db')});services.push(b);
    const r=await startService(new URL('../repair.mts',import.meta.url),{SOURCE_ORIGIN:a.url,TARGET_ORIGIN:b.url});services.push(r);
    for(const body of [null,[],false,1,'x',{}, {key:'k0',value:null,extra:1},{key:{toString:null},value:null}]) await post(a.url+'/write',body,400);
    for(const body of [null,[],true,'x',1,{source:a.url}]) await post(r.url+'/repair',body,400);
    for(const route of ['/root?x=1','/node','/node?path=0&revision=00','/node?path=0000&revision=0','/node?path=0&revision=0&revision=0','/record?key=k8&revision=0','/record?key=k0&revision=33','/record?key=k0&revision=0&extra=1']) {
      const response=await fetch(a.url+route);assert.equal(response.status,400,route);await response.body?.cancel();
    }
    const wrong=await fetch(a.url+'/write');assert.equal(wrong.status,405);assert.equal(wrong.headers.get('allow'),'POST');await wrong.body?.cancel();
    const missing=await fetch(a.url+'/absent');assert.equal(missing.status,404);await missing.body?.cancel();
    assert.deepEqual(await post(a.url+'/write',{key:'k0',value:'A'}),{revision:1});
    const stale=await fetch(a.url+'/node?path=&revision=0');assert.equal(stale.status,409);assert.deepEqual(await stale.json(),{error:{code:'revision_changed',message:'Revision changed'}});
    assert.deepEqual(await post(a.url+'/apply',{expectedRevision:1,records:[{key:'k0',value:'B'},{key:'k7',value:1}]},400),{error:{code:'invalid_request',message:'Invalid request'}});
    assert.deepEqual(await post(a.url+'/apply',{expectedRevision:0,records:null},409),{error:{code:'revision_changed',message:'Revision changed'}});
    const record=await get(a.url+'/record?key=k0&revision=1');assert.ok(exact(record,['revision','key','value','hash']));assert.equal(record.value,'A');
    await assert.rejects(startService(new URL('../repair.mts',import.meta.url),{SOURCE_ORIGIN:a.url,TARGET_ORIGIN:a.url+'/'}),/must be distinct/);
  } finally {try {await stopAll(services);} finally {await rm(dir,{recursive:true,force:true});}}
});

async function fixtures(services:RunningService[]) {
  const start=async(role:string,redirect?:string)=>{
    const s=await startService(new URL('./fixture.mts',import.meta.url),{FIXTURE_ROLE:role,TEACHING_CONTROLS:'1',...(redirect?{REDIRECT_ORIGIN:redirect}:{})});services.push(s);return s;
  };
  const sink=await start('sink');
  const a=await start('source',sink.url);
  const b=await start('target',sink.url);
  const r=await startService(new URL('../repair.mts',import.meta.url),{SOURCE_ORIGIN:a.url,TARGET_ORIGIN:b.url});services.push(r);
  return {sink,a,b,r};
}
async function mode(service:RunningService,name:string):Promise<void> {
  assert.deepEqual(await post(service.url+'/teaching/mode',{mode:name}),{mode:name});
}

test('integration: reusable upstreams reject forged later reads and unexpected semantic envelopes without partial apply',async()=>{
  const services:RunningService[]=[];
  try {
    const {a,b,r}=await fixtures(services);
    for(const [variant,status] of [
      ['node-stale',409],['record-stale',409],['unexpected-conflict',502],['primitive-conflict',502],
      ['later-invalid',502],['forged-child',502],['forged-revision',502],['wrong-identity',502],['node-array',502],['later-oversize',502],
    ] as const) {
      await mode(a,variant);await mode(b,'ok');
      const before=await stats(b.url);
      const response=await post(r.url+'/repair',{},status);
      assert.deepEqual(response,{error:status===409?{code:'revision_changed',message:'Revision changed'}:{code:'bad_upstream',message:'Invalid or unavailable upstream'}});
      const after=await stats(b.url);assert.equal(after.apply,before.apply,variant);assert.deepEqual(after.target,Array<null>(8).fill(null),variant);
    }
    await mode(a,'ok');
    for(const [variant,status,apply] of [
      ['node-stale',409,false],['unexpected-conflict',502,false],['primitive-conflict',502,false],
      ['apply-stale',409,true],['apply-capacity',429,true],['unexpected-capacity',502,true],
    ] as const) {
      await mode(b,variant);
      const before=await stats(b.url);assert.equal(typeof before.apply,'number');
      await post(r.url+'/repair',{},status);
      const after=await stats(b.url);assert.equal(typeof after.apply,'number');
      assert.equal(after.apply,before.apply+(apply?1:0),variant);assert.deepEqual(after.target,Array<null>(8).fill(null),variant);
    }
    for(const invalid of [null,[],{}, {mode:{toString:null}},{mode:1},{mode:'ok',extra:1}]) await post(a.url+'/teaching/mode',invalid,400);
    await mode(a,'ok');await mode(b,'concurrent');
    await post(r.url+'/repair',{},409);
    const concurrent=await stats(b.url);
    assert.deepEqual(concurrent.target,[null,null,null,'concurrent',null,null,null,null]);assert.equal(concurrent.targetRevision,1);
    await mode(b,'lost-apply');
    await post(r.url+'/repair',{},502);
    const committed=await stats(b.url);
    assert.deepEqual(committed.target,['A',null,null,null,null,null,null,'H']);assert.equal(committed.targetRevision,1);
  } finally {await stopAll(services);}
});

test('integration: fully escaped valid JSON passes; valid oversized bodies fail and redirects deliver no payload',async()=>{
  const services:RunningService[]=[];
  try {
    const {sink,a,b,r}=await fixtures(services);
    await mode(a,'escaped');await mode(b,'escaped');
    assert.deepEqual(await post(r.url+'/repair',{}),{changed:['k0','k7'],sourceRevision:2,targetRevision:1});
    for(const variant of ['oversize','chunked-oversize']) {
      await mode(a,variant);await mode(b,'ok');
      const before=await stats(b.url);await post(r.url+'/repair',{},502);
      assert.equal((await stats(b.url)).apply,before.apply);
    }
    await mode(a,'redirect');
    await post(r.url+'/repair',{},502);
    // Check the live, distinct destination BEFORE any mode operation can erase evidence.
    assert.equal((await stats(sink.url)).received,0);
    await mode(a,'ok');await mode(b,'redirect-apply');
    const before=await stats(b.url);assert.equal(typeof before.apply,'number');
    await post(r.url+'/repair',{},502);
    assert.equal((await stats(sink.url)).received,0);
    const after=await stats(b.url);assert.equal(after.apply,before.apply+1);assert.deepEqual(after.target,Array<null>(8).fill(null));
  } finally {await stopAll(services);}
});

test('integration: one absolute second covers multi-hop work and stalled response bodies',async()=>{
  const {performance}=await import('node:perf_hooks');
  const services:RunningService[]=[];
  try {
    const {a,b,r}=await fixtures(services);
    for(const variant of ['slow-chain','slow-headers','slow-body']) {
      await mode(a,variant);await mode(b,variant==='slow-chain'?'slow-chain':'ok');
      const before=await stats(b.url),started=performance.now();
      await post(r.url+'/repair',{},502);
      const elapsed=performance.now()-started;
      assert.ok(elapsed>=900&&elapsed<1600,`${variant} total ${elapsed} ms`);
      assert.equal((await stats(b.url)).apply,before.apply);
    }
  } finally {await stopAll(services);}
});

test('unit: self-consistent forged subtree still fails its parent; record identity and exact errors are checked at each branch',async()=>{
  const p=new Pair();p.source[0]='A';p.source[7]='H';p.sourceRevision=2;
  p.hook=async(side,url,body)=>{
    if(side==='source'&&url.pathname==='/node'&&url.searchParams.get('path')==='1') {
      const forged=oracle(Array<string>(8).fill('fake'));
      return Response.json({revision:2,path:'1',hash:forged.get('1'),children:{left:forged.get('10'),right:forged.get('11')}});
    }
    return;
  };
  await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502});
  assert.equal(p.calls.some(c=>c.path==='/apply'),false);
  for(const alteration of [{key:'k6'},{revision:1},{hash:'f'.repeat(64)},{value:null},{extra:1}]) {
    const q=new Pair();q.source[7]='H';q.sourceRevision=2;
    q.hook=async(side,url,body)=>{
      if(url.pathname!=='/record') return;
      const record:unknown=await q.respond(side,url,body).json();
      assert.ok(exact(record,['revision','key','value','hash']));
      return Response.json({...record,...alteration});
    };
    await assert.rejects(repairSnapshot(source,target,q.fetcher),{status:502});
    assert.equal(q.calls.some(c=>c.path==='/apply'),false);
  }
  for(const route of ['/record','/apply']) for(const code of ['internal_error','not_found','revision_limit']) {
    const q=new Pair();q.source[7]='H';q.sourceRevision=1;
    q.hook=(_side,url)=>url.pathname===route?Response.json({error:{code,message:'Revision changed'}},{status:409}):undefined;
    await assert.rejects(repairSnapshot(source,target,q.fetcher),{status:502});
  }
});

test('unit: full-body byte and UTF-8 checks cover late records and cancellation cannot extend the deadline',async()=>{
  for(const variant of ['bytes','utf8','extra-field','content-type']) {
    const p=new Pair();p.source[0]='A';p.source[7]='H';p.sourceRevision=2;
    p.hook=async(side,url,body)=>{
      if(url.pathname!=='/record'||url.searchParams.get('key')!=='k7') return;
      const original:unknown=await p.respond(side,url,body).json();
      assert.ok(exact(original,['revision','key','value','hash']));
      if(variant==='extra-field') return Response.json({...original,extra:true});
      return new Response(variant==='bytes'?JSON.stringify(original)+' '.repeat(4096):variant==='utf8'?Buffer.from([0xff]):JSON.stringify(original),{headers:{'content-type':variant==='content-type'?'text/plain':'application/json'}});
    };
    await assert.rejects(repairSnapshot(source,target,p.fetcher),{status:502});
    assert.equal(p.calls.some(c=>c.path==='/apply'),false);
  }
  const fetcher:typeof fetch=async()=>new Response(new ReadableStream<Uint8Array>({
    start(c){c.enqueue(Buffer.from('{'));},cancel(){return new Promise<void>(()=>{});},
  }),{headers:{'content-type':'application/json'}});
  const start=performance.now();
  await assert.rejects(repairSnapshot(source,target,fetcher),{status:502});
  assert.ok(performance.now()-start<1400);
});
