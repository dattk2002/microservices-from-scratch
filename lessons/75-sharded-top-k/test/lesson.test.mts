import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeTop } from '../ranking.mts';

test('unit: top three can all belong to one shard; equal scores use ID order',()=>{
  assert.deepEqual(mergeTop([{id:'a0',score:100},{id:'a1',score:99},{id:'a2',score:99}], [{id:'b0',score:99}],3),[
    {id:'a0',score:100},{id:'a1',score:99},{id:'a2',score:99},
  ]);
});

import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../../lib/http.mts';
import { ShardStore } from '../store.mts';
import { parseQuery, validateReply, origins } from '../ranking.mts';
import type { Item } from '../ranking.mts';
import { aggregate } from '../query.mts';

function status(code:number) { return (e:unknown)=>e instanceof HttpError&&e.status===code&&e.message===e.code; }
function memory(shard:'a'|'b'='a'):ShardStore {
  const db=new DatabaseSync(':memory:');
  try {return new ShardStore(db,shard);} catch(error) {db.close();throw error;}
}

test('unit: merging local K equals union sorting across skew, ties, empty shards, K1 and K8',()=>{
  for(let seed=0;seed<64;seed++) {
    const a:Item[]=[],b:Item[]=[];
    for(let i=0;i<8;i++) {
      if((seed+i)%4!==0) a.push({id:`a${i}`,score:(seed*13+i*7)%11});
      if((seed+i)%3!==0) b.push({id:`b${i}`,score:(seed*3+i*17)%11});
    }
    // Independent oracle: numeric score first, ASCII ID comparison only for ties.
    const sorted=[...a,...b].sort((x,y)=>y.score-x.score||(x.id<y.id?-1:x.id>y.id?1:0));
    const local=(xs:Item[],k:number)=>xs.toSorted((x,y)=>y.score-x.score||(x.id<y.id?-1:x.id>y.id?1:0)).slice(0,k);
    for(let k=1;k<=8;k++) assert.deepEqual(mergeTop(local(a,k),local(b,k),k),sorted.slice(0,k));
  }
  assert.deepEqual(mergeTop([],[{id:'b7',score:0}],8),[{id:'b7',score:0}]);
  assert.deepEqual(mergeTop([],[],1),[]);
});

test('unit: query decimals, exact keys and distinct normalized configured origins',()=>{
  assert.deepEqual(parseQuery(new URLSearchParams('k=8&a=0&b=16')), {k:8,a:0,b:16});
  for(const raw of ['k=0&a=0&b=0','k=9&a=0&b=0','k=01&a=0&b=0','k=1&a=17&b=0','k=1&a=-1&b=0','k=1&a=0&b=0&k=1','k=1&a=0&b=0&url=x','k=1&a=0','k=1&a=0&b=1.0','k=1&a=+1&b=0']) assert.throws(()=>parseQuery(new URLSearchParams(raw)),status(400));
  assert.deepEqual(origins('http://127.0.0.1:1234/','http://127.0.0.1:1235'),{a:'http://127.0.0.1:1234',b:'http://127.0.0.1:1235'});
  for(const [a,b] of [['http://127.0.0.1:1234','http://127.0.0.1:1234/'],['http://127.0.0.1:80','http://127.0.0.1'],['https://127.0.0.1:1234','http://127.0.0.1:1235'],['http://localhost:1234','http://127.0.0.1:1235'],['http://127.0.0.1:1234/path','http://127.0.0.1:1235'],['http://u:p@127.0.0.1:1234','http://127.0.0.1:1235']]) assert.throws(()=>origins(a!,b!));
});

test('unit: upstream reply validates full schema, identity, revision, ownership and total order',()=>{
  const good={shard:'a',revision:2,items:[{id:'a0',score:9},{id:'a1',score:9}]};
  assert.deepEqual(validateReply(good,'a',2,2),good.items);
  for(const bad of [null,[],1,{...good,extra:true},{...good,shard:'b'},{...good,revision:1},{...good,revision:'2'},
    {...good,items:[{id:'a1',score:9},{id:'a0',score:9}]},{...good,items:[{id:'a0',score:8},{id:'a1',score:9}]},
    {...good,items:[{id:'a0',score:9},{id:'a0',score:9}]},{...good,items:[{id:'b0',score:9}]},
    {...good,items:[{id:'a8',score:9}]},{...good,items:[{id:'a0',score:101}]},{...good,items:[{id:'a0',score:'9'}]},
    {...good,items:[{id:'a0',score:9,extra:0}]},{...good,items:[{id:'a0',score:9},{id:'a1',score:8},{id:'a2',score:7}]}]) assert.throws(()=>validateReply(bad,'a',2,2),status(502));
});

test('unit: snapshots start empty, remain immutable and publish idempotently at capacity',()=>{
  const s=memory();try {
    assert.deepEqual(s.top(0,8),{shard:'a',revision:0,items:[]});
    assert.deepEqual(s.publish({}),{revision:0});
    assert.deepEqual(s.write('a0',{score:10}),{revision:1});s.publish({});
    s.write('a0',{score:99});s.publish({});
    s.write('a1',{score:99});assert.deepEqual(s.publish({}),{revision:3});
    assert.deepEqual(s.publish({}),{revision:3});
    assert.deepEqual(s.top(1,8).items,[{id:'a0',score:10}]);
    assert.deepEqual(s.top(3,8).items,[{id:'a0',score:99},{id:'a1',score:99}]);
    s.write('a2',{score:100});assert.throws(()=>s.publish({}),status(429));
    assert.throws(()=>s.top(4,8),status(404));
    assert.deepEqual(s.top(0,1).items,[]);
  } finally {s.close();}
});

test('unit: revision16 allows no-op and rejects actual changes without corrupting live state',()=>{
  const s=memory();try {
    for(let i=1;i<=16;i++) assert.deepEqual(s.write('a0',{score:i}),{revision:i});
    assert.deepEqual(s.write('a0',{score:16}),{revision:16});
    assert.throws(()=>s.write('a0',{score:17}),status(409));
    assert.deepEqual(s.publish({}),{revision:16});
    assert.deepEqual(s.top(16,1).items,[{id:'a0',score:16}]);
  } finally {s.close();}
});

test('unit: writes reject primitive, extra, noncoercible, foreign and invalid score inputs',()=>{
  const s=memory();try {
    for(const body of [null,[],3,'x',{}, {score:0,extra:1},{score:'1'},{score:1.5},{score:-1},{score:101},{score:{toString:null}}]) assert.throws(()=>s.write('a0',body),status(400));
    for(const id of ['b0','a8','a00','a-1',null,{}]) assert.throws(()=>s.write(id,{score:0}),status(400));
    for(const body of [null,[],1,{x:1}]) assert.throws(()=>s.publish(body),status(400));
    assert.deepEqual(s.write('a7',{score:0}),{revision:1});
    for(const [r,k] of [[-1,1],[17,1],[0,0],[0,9],[0,1.5]]) assert.throws(()=>s.top(r,k),status(400));
  } finally {s.close();}
});

test('unit: query reads exact local K from both sources and fails the entire ranking on any bad source',async()=>{
  const config=origins('http://127.0.0.1:1234','http://127.0.0.1:1235');
  const fetcher:typeof fetch=async(input,init)=>{
    const u=new URL(String(input));assert.equal(init?.redirect,'error');
    assert.equal(u.search,'?k=3');assert.equal(u.pathname,u.port==='1234'?'/snapshots/2/top':'/snapshots/4/top');
    return Response.json({shard:u.port==='1234'?'a':'b',revision:u.port==='1234'?2:4,items:u.port==='1234'?[{id:'a0',score:100},{id:'a1',score:99},{id:'a2',score:98}]:[{id:'b0',score:1}]});
  };
  assert.deepEqual(await aggregate(config,{k:3,a:2,b:4},fetcher),{snapshots:{a:2,b:4},items:[{id:'a0',score:100},{id:'a1',score:99},{id:'a2',score:98}]});
  for(const response of [Response.json({error:{code:'unknown_snapshot',message:'unknown_snapshot'}},{status:404}),Response.json({error:{code:'internal_error',message:'internal_error'}},{status:404}),Response.json([],{status:404}),Response.json(null,{status:200}),Response.json({shard:'a',revision:2,items:[]},{status:503})]) {
    await assert.rejects(aggregate(config,{k:3,a:2,b:4},async()=>response.clone()),status(502));
  }
});

import { spawnSync } from 'node:child_process';

test('unit: entrypoint imports are silent and inert even with invalid environment',()=>{
  const paths=['shard.mts','query.mts'].map(file=>new URL('../'+file,import.meta.url).href);
  const result=spawnSync(process.execPath,['--input-type=module','-e',paths.map(p=>`await import(${JSON.stringify(p)});`).join('\n')],{
    encoding:'utf8',timeout:3000,env:{PATH:process.env.PATH??'',HOST:'invalid',PORT:'invalid',DB_PATH:'',SHARD_ID:'invalid',SHARD_A_ORIGIN:'invalid',SHARD_B_ORIGIN:'invalid'},
  });
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
});

test('unit: upstream byte limit applies to valid schemas and complete bodies; malformed encoding fails',async()=>{
  const config=origins('http://127.0.0.1:1234','http://127.0.0.1:1235');
  for(const brokenShard of ['a','b']) for(const mode of ['oversize','json','utf8','media']) {
    const fetcher:typeof fetch=async input=>{
      const shard=String(input).startsWith(config.a)?'a':'b';
      const data={shard,revision:1,items:[{id:shard+'0',score:1}]};
      const wire=JSON.stringify(data)+' '.repeat(8192);
      // The oversize document is valid JSON AND valid application data.
      assert.deepEqual(validateReply(JSON.parse(wire),shard,1,3),data.items);
      if(shard!==brokenShard) return Response.json(data);
      return new Response(mode==='oversize'?wire:mode==='utf8'?Buffer.from([0xff]):mode==='json'?'{':JSON.stringify(data),{headers:{'content-type':mode==='media'?'text/plain':'application/json'}});
    };
    await assert.rejects(aggregate(config,{k:3,a:1,b:1},fetcher),status(502));
  }
});

test('unit: one total deadline cancels stalled full bodies and returns no partial ranking',async()=>{
  const config=origins('http://127.0.0.1:1234','http://127.0.0.1:1235');let cancelled=false;
  const fetcher:typeof fetch=async input=>String(input).startsWith(config.a)
    ?Response.json({shard:'a',revision:0,items:[{id:'a0',score:100}]})
    :new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.from('{'));},cancel(){cancelled=true;return new Promise<void>(()=>{});}}),{headers:{'content-type':'application/json'}});
  const start=performance.now();
  await assert.rejects(aggregate(config,{k:3,a:0,b:0},fetcher),status(502));
  assert.equal(cancelled,true);assert.ok(performance.now()-start>=450);assert.ok(performance.now()-start<1500);
});

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { exact } from '../ranking.mts';

async function stopAll(services:RunningService[]):Promise<void> {
  const results=await Promise.allSettled(services.map(s=>s.stop()));
  for(const result of results) if(result.status==='rejected') throw result.reason;
}
async function request(base:string,path:string,want=200,method='GET',data?:unknown):Promise<unknown> {
  const response=await fetch(base+path,{method,signal:AbortSignal.timeout(3000),...(data===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(data)})});
  const body:unknown=await response.json();assert.equal(response.status,want,`${method} ${path}: ${JSON.stringify(body)}`);return body;
}
const shardEntry=new URL('../shard.mts',import.meta.url),queryEntry=new URL('../query.mts',import.meta.url),fixtureEntry=new URL('./fixture.mts',import.meta.url);
const failure={error:{code:'upstream_failure',message:'upstream_failure'}};

// This test catches reading live state, non-atomic publication, lost durability,
// accidental shared databases and successful partial rankings.
test('integration: three independent processes keep old vectors immutable across mutations and shard restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'top-k-75-'));
  const services:RunningService[]=[];
  try {
    const aEnv={DB_PATH:join(dir,'a.db'),SHARD_ID:'a'},bEnv={DB_PATH:join(dir,'b.db'),SHARD_ID:'b'};
    let a=await startService(shardEntry,aEnv);services.push(a);
    const b=await startService(shardEntry,bEnv);services.push(b);
    let q=await startService(queryEntry,{SHARD_A_ORIGIN:a.url+'/',SHARD_B_ORIGIN:b.url});services.push(q);
    assert.deepEqual(await request(q.url,'/top?k=8&a=0&b=0'),{snapshots:{a:0,b:0},items:[]});
    await request(a.url,'/items/a0',200,'PUT',{score:100});
    await request(a.url,'/items/a1',200,'PUT',{score:99});
    await request(a.url,'/items/a2',200,'PUT',{score:98});
    await request(b.url,'/items/b0',200,'PUT',{score:97});
    assert.deepEqual(await request(a.url,'/publish',200,'POST',{}),{revision:3});
    assert.deepEqual(await request(b.url,'/publish',200,'POST',{}),{revision:1});
    const old={snapshots:{a:3,b:1},items:[{id:'a0',score:100},{id:'a1',score:99},{id:'a2',score:98}]};
    assert.deepEqual(await request(q.url,'/top?k=3&a=3&b=1'),old);
    await request(a.url,'/items/a0',200,'PUT',{score:0});
    assert.deepEqual(await request(q.url,'/top?k=3&a=3&b=1'),old);
    assert.deepEqual(await request(q.url,'/top?k=3&a=4&b=1',502),failure);
    await request(a.url,'/publish',200,'POST',{});
    const changed={snapshots:{a:4,b:1},items:[{id:'a1',score:99},{id:'a2',score:98},{id:'b0',score:97}]};
    assert.deepEqual(await request(q.url,'/top?k=3&a=4&b=1'),changed);
    assert.deepEqual(await request(q.url,'/top?k=1&a=4&b=1'),{snapshots:{a:4,b:1},items:[{id:'a1',score:99}]});
    assert.deepEqual(await request(q.url,'/top?k=8&a=4&b=1'),{snapshots:{a:4,b:1},items:[{id:'a1',score:99},{id:'a2',score:98},{id:'b0',score:97},{id:'a0',score:0}]});
    assert.deepEqual(await request(q.url,'/top?k=3&a=0&b=1'),{snapshots:{a:0,b:1},items:[{id:'b0',score:97}]});
    await a.stop();await q.stop();
    await assert.rejects(startService(shardEntry,{...aEnv,SHARD_ID:'b'}),/identity mismatch/);
    a=await startService(shardEntry,aEnv);services.push(a);
    q=await startService(queryEntry,{SHARD_A_ORIGIN:a.url,SHARD_B_ORIGIN:b.url});services.push(q);
    assert.deepEqual(await request(q.url,'/top?k=3&a=3&b=1'),old);
    assert.deepEqual(await request(q.url,'/top?k=3&a=4&b=1'),changed);
    assert.deepEqual(await request(a.url,'/items/a0',200,'PUT',{score:0}),{revision:4});
    await request(a.url,'/items/a3',200,'PUT',{score:99});await request(a.url,'/publish',200,'POST',{});
    assert.deepEqual(await request(a.url,'/publish',200,'POST',{}),{revision:5});
    await request(a.url,'/items/a4',200,'PUT',{score:99});
    assert.deepEqual(await request(a.url,'/publish',429,'POST',{}),{error:{code:'snapshot_capacity',message:'snapshot_capacity'}});
    for(let revision=7;revision<=16;revision++) await request(a.url,'/items/a0',200,'PUT',{score:revision});
    assert.deepEqual(await request(a.url,'/items/a0',200,'PUT',{score:16}),{revision:16});
    assert.deepEqual(await request(a.url,'/items/a0',409,'PUT',{score:17}),{error:{code:'revision_exhausted',message:'revision_exhausted'}});
    assert.deepEqual(await request(q.url,'/top?k=3&a=3&b=1'),old);
    await b.stop();assert.deepEqual(await request(q.url,'/top?k=3&a=3&b=1',502),failure);
  } finally {try {await stopAll(services);} finally {await rm(dir,{recursive:true,force:true});}}
});

test('integration: exact request bodies, owned IDs, canonical query parameters and startup origins',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'top-k-schema-75-'));
  const services:RunningService[]=[];
  try {
    await assert.rejects(startService(shardEntry,{DB_PATH:':memory:',SHARD_ID:'a'}),/Private DB_PATH file required/);
    const a=await startService(shardEntry,{DB_PATH:join(dir,'a.db'),SHARD_ID:'a'});services.push(a);
    const b=await startService(shardEntry,{DB_PATH:join(dir,'b.db'),SHARD_ID:'b'});services.push(b);
    const q=await startService(queryEntry,{SHARD_A_ORIGIN:a.url,SHARD_B_ORIGIN:b.url});services.push(q);
    for(const data of [null,[],false,1,'x',{}, {score:null},{score:[]},{score:{toString:null}},{score:'1'},{score:1.5},{score:-1},{score:101},{score:0,extra:1}]) await request(a.url,'/items/a0',400,'PUT',data);
    for(const data of [null,[],1,'x',{extra:1}]) await request(a.url,'/publish',400,'POST',data);
    for(const id of ['b0','a8','a00','a-1']) await request(a.url,'/items/'+id,400,'PUT',{score:1});
    for(const path of ['/snapshots/00/top?k=1','/snapshots/17/top?k=1','/snapshots/0/top?k=0','/snapshots/0/top?k=9','/snapshots/0/top?k=01','/snapshots/0/top?k=1&k=1','/snapshots/0/top?k=1&extra=1','/snapshots/0/top']) await request(a.url,path,400);
    for(const path of ['/top?k=0&a=0&b=0','/top?k=1&a=00&b=0','/top?k=1&a=0&b=17','/top?k=1&a=0&b=0&k=1','/top?k=1&a=0&b=0&url=x','/top?k=1&a=0','/top?k=1&a=0&b=0.0']) await request(q.url,path,400);
    await request(a.url,'/snapshots/1/top?k=1',404);
    await request(a.url,'/snapshots/0/top?k=1',405,'POST',{});
    await request(q.url,'/top?k=1&a=0&b=0',405,'POST',{});
    await request(a.url,'/publish?extra=1',400,'POST',{});
    assert.deepEqual(await request(a.url,'/publish',200,'POST',{}),{revision:0});
    await assert.rejects(startService(queryEntry,{SHARD_A_ORIGIN:a.url,SHARD_B_ORIGIN:a.url+'/'}),/distinct/);
    await assert.rejects(startService(queryEntry,{SHARD_A_ORIGIN:a.url+'/path',SHARD_B_ORIGIN:b.url}),/loopback/);
  } finally {try {await stopAll(services);} finally {await rm(dir,{recursive:true,force:true});}}
});

test('integration: adversarial replies, full-body deadline and redirect destination receives zero requests',async()=>{
  const services:RunningService[]=[];
  try {
    const sink=await startService(fixtureEntry,{FIXTURE_ROLE:'sink'});services.push(sink);
    const a=await startService(fixtureEntry,{SHARD_ID:'a',REDIRECT_ORIGIN:sink.url});services.push(a);
    const b=await startService(fixtureEntry,{SHARD_ID:'b',REDIRECT_ORIGIN:sink.url});services.push(b);
    const q=await startService(queryEntry,{SHARD_A_ORIGIN:a.url,SHARD_B_ORIGIN:b.url});services.push(q);
    const expected={snapshots:{a:1,b:1},items:[{id:'a0',score:90},{id:'b0',score:90},{id:'a1',score:80}]};
    assert.deepEqual(await request(q.url,'/top?k=3&a=1&b=1'),expected);
    // Fixture controls also reject non-coercible objects without throwing 500.
    for(const body of [null,[],1,{mode:{toString:null}},{mode:'ok',extra:1}]) await request(a.url,'/mode',400,'POST',body);
    for(const peer of [a,b]) {
      for(const mode of ['null','array','primitive','extra','wrong-shard','wrong-revision','unsorted','duplicate','foreign','len','score','score-type','item-extra','unknown','error-code','error-message','error-null','error-array','error-extra','status409','status422','status429','status503','media','json','utf8','disconnect','oversize','chunked-oversize','slow-headers','slow-body','slow-error-body','slow-chain','redirect']) {
        await request(peer.url,'/mode',200,'POST',{mode});
        const started=performance.now();assert.deepEqual(await request(q.url,'/top?k=3&a=1&b=1',502),failure,`${peer.url} ${mode}`);
        if(mode.startsWith('slow-')) {assert.ok(performance.now()-started>=400);assert.ok(performance.now()-started<1500);}
        if(mode==='redirect') {
          // Inspect before ANY mode/reset operation can erase evidence.
          const stats=await request(sink.url,'/stats');
          assert.ok(exact(stats,['received']));assert.equal(stats.received,0);
        }
        await request(peer.url,'/mode',200,'POST',{mode:'ok'});
      }
      await request(peer.url,'/mode',200,'POST',{mode:'escaped'});
      assert.deepEqual(await request(q.url,'/top?k=3&a=1&b=1'),expected);
      await request(peer.url,'/mode',200,'POST',{mode:'ok'});
    }
  } finally {await stopAll(services);}
});

test('unit: header time and body time share one budget instead of receiving 500ms each',async()=>{
  const config=origins('http://127.0.0.1:1234','http://127.0.0.1:1235');
  const fetcher:typeof fetch=async(input,init)=>{
    if(String(input).startsWith(config.a)) return Response.json({shard:'a',revision:1,items:[]});
    await new Promise<void>((resolve,reject)=>{
      const signal=init?.signal;
      const abort=()=>{clearTimeout(timer);reject(new Error('aborted'));};
      const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},300);
      signal?.addEventListener('abort',abort,{once:true});
    });
    let timer:ReturnType<typeof setTimeout>|undefined;
    return new Response(new ReadableStream<Uint8Array>({
      start(c){timer=setTimeout(()=>{c.enqueue(Buffer.from('{"shard":"b","revision":1,"items":[]}'));c.close();},300);},
      cancel(){clearTimeout(timer);},
    }),{headers:{'content-type':'application/json'}});
  };
  const started=performance.now();
  await assert.rejects(aggregate(config,{k:3,a:1,b:1},fetcher),status(502));
  assert.ok(performance.now()-started>=450);assert.ok(performance.now()-started<1500);
});

import { privateDatabaseFile, listenerIsUpstream } from '../ranking.mts';
test('unit: service database configuration rejects volatile SQLite memory while stores support unit memory', () => {
  assert.throws(() => privateDatabaseFile(':memory:'), /private.*file/i);
  assert.throws(() => privateDatabaseFile(undefined), /private.*file/i);
  assert.equal(privateDatabaseFile('/tmp/top-k-private.db'),'/tmp/top-k-private.db');
});
test('unit: normalized default port80 listener cannot be its own shard origin', () => {
  const config=origins('http://127.0.0.1:80/','http://127.0.0.1:8080');
  assert.equal(listenerIsUpstream(config,80),true);
  assert.equal(listenerIsUpstream(config,8080),true);
  assert.equal(listenerIsUpstream(config,8081),false);
  assert.equal(listenerIsUpstream(config,0),false);
});
