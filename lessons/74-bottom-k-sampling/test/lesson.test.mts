import test from 'node:test';
import assert from 'node:assert/strict';
import { priority, compareEntries, bottom4, mergeSamples, algorithm, eventValid, sampleValid, snapshotValid, origins } from '../contracts.mts';
import type { Entry } from '../contracts.mts';
import { SampleStore } from '../store.mts';
import { collectSamples } from '../aggregate.mts';
import { ReadableStream } from 'node:stream/web';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

// Literal SHA-256 vectors; changing UTF-8 input, sort direction, k, or deduplication breaks these.
const golden: Entry[] = [
  {id:'j',priority:'189f40034be7a199f1fa9891668ee3ab6049f82d38c68be70f596eab2e1857b7'},
  {id:'d',priority:'18ac3e7343f016890c510e93f935261169d9e3f565436429830faf0934f4f8e4'},
  {id:'f',priority:'252f10c83610ebca1a059c0bae8255eba2f95be4d1d7bcfa89d7248a82d9f111'},
  {id:'c',priority:'2e7d2c03a9507ae265ecf5b5356885a53393a2029d241394997265a1a25aefc6'},
];
const ids = [...'abcdefghijkl'];
test('unit: fixed golden hashes and input permutations produce the global four lowest distinct ids', () => {
  assert.equal(priority('a'),'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  for (const row of golden) assert.equal(priority(row.id),row.priority);
  for (let offset=0;offset<ids.length;offset++) {
    const rotated=[...ids.slice(offset),...ids.slice(0,offset)];
    for (const order of [rotated,rotated.toReversed()]) {
      let sample: Entry[]=[];
      for (const id of [...order,...order]) sample=bottom4([...sample.map(row=>row.id),id]);
      assert.deepEqual(sample,golden);
      // 'a' was received, then evicted; replay must not change the sample.
      assert.deepEqual(bottom4([...sample.map(row=>row.id),'a']),golden);
    }
  }
});
test('unit: ties in an injected pure comparator fixture use ascending id as total-order tiebreaker', () => {
  const tied=[{id:'z',priority:'1'.repeat(64)},{id:'a',priority:'1'.repeat(64)},{id:'c',priority:'0'.repeat(64)}];
  assert.deepEqual(tied.toSorted(compareEntries).map(row=>row.id),['c','a','z']);
  assert.equal(compareEntries(tied[0]!,tied[0]!),0);
  assert.ok(compareEntries(tied[0]!,tied[1]!)>0);
});
test('unit: empty short overlapping disjoint unequal shards merge associatively commutatively and idempotently', () => {
  assert.deepEqual(bottom4([]),[]);
  assert.deepEqual(bottom4(['c','c','d']),[golden[1],golden[3]]);
  const partitions = [
    [ids,[]],
    [['a'],ids.slice(1)],
    [ids.slice(0,6),ids.slice(6)],
    [ids.slice(0,8),ids.slice(4)],
  ];
  for (const [left=[],right=[]] of partitions) {
    const a=bottom4(left), b=bottom4(right);
    assert.deepEqual(mergeSamples(a,b),golden);
    assert.deepEqual(mergeSamples(b,a),golden);
    assert.deepEqual(mergeSamples(a,a),a);
    assert.deepEqual(mergeSamples(mergeSamples(a,b),a,b),golden);
  }
  const a=bottom4(ids.slice(0,4)), b=bottom4(ids.slice(4,8)), c=bottom4(ids.slice(8));
  assert.deepEqual(mergeSamples(mergeSamples(a,b),c),golden);
  assert.deepEqual(mergeSamples(a,mergeSamples(b,c)),golden);
});

test('unit: exact event schema rejects primitive and noncoercible ids before hashing', () => {
  for (const id of ['a','0','a0','a'.repeat(16)]) assert.ok(eventValid({id}));
  for (const value of [null,[],false,3,'a',{}, {id:'a',extra:0}, {id:[]}, {id:{toString:null}},
    {id:null},{id:3},{id:''},{id:'A'},{id:'a-b'},{id:'é'},{id:'a'.repeat(17)}]) assert.equal(eventValid(value),false);
});
test('unit: snapshots reject wrong identities algorithms hashes order duplicates extras and primitive entries', () => {
  for (const sample of [[],[golden[0]],golden]) assert.ok(snapshotValid({id:'a',algorithm,sample},'a'));
  const valid={id:'a',algorithm,sample:golden};
  for (const value of [null,[],true,1,'snapshot', {...valid,extra:0}, {...valid,id:'b'}, {...valid,algorithm:'bottom4-v2'},
    {...valid,sample:null},{...valid,sample:golden.toReversed()}, {...valid,sample:[golden[0],golden[0]]},
    {...valid,sample:[...golden,golden[0]]}, {...valid,sample:[{...golden[0],priority:'0'.repeat(64)}]},
    {...valid,sample:[{...golden[0],priority:golden[0]!.priority.toUpperCase()}]},
    {...valid,sample:[{...golden[0],extra:1}]}, {...valid,sample:[null]}, {...valid,sample:[[]]},
    {...valid,sample:[{id:{toString:null},priority:'0'.repeat(64)}]},
    {...valid,sample:[{id:'J',priority:golden[0]!.priority}]}]) assert.equal(snapshotValid(value,'a'),false);
  assert.ok(sampleValid(golden));
});
test('unit: upstream origins normalize before rejecting identical origins and non-loopback URLs', () => {
  assert.deepEqual(origins('http://127.0.0.1:080/','http://127.0.0.1:8001/'),['http://127.0.0.1','http://127.0.0.1:8001']);
  assert.throws(()=>origins('http://127.0.0.1:080','http://127.0.0.1/'),/distinct/);
  for (const value of [undefined,'invalid','https://127.0.0.1:80','http://localhost:80','http://127.0.0.1:0',
    'http://user@127.0.0.1:80','http://127.0.0.1:80/path','http://127.0.0.1:80/?x=1','http://127.0.0.1:80/#x']) {
    assert.throws(()=>origins(value,'http://127.0.0.1:8001'));
    assert.throws(()=>origins('http://127.0.0.1:8001',value));
  }
});
test('unit: durable store keeps only the bottom four rows after many arrivals and evicted replay', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try {
    const store=new SampleStore(db,'a');
    assert.deepEqual(store.snapshot(),{id:'a',algorithm,sample:[]});
    assert.deepEqual(store.event('a'),{retained:true});
    for (const id of ids) store.event(id);
    assert.deepEqual(store.snapshot(),{id:'a',algorithm,sample:golden});
    assert.deepEqual(store.event('a'),{retained:false});
    assert.deepEqual(store.event('j'),{retained:true});
    assert.deepEqual(new SampleStore(db,'a').snapshot(),{id:'a',algorithm,sample:golden});
    for (let i=0;i<128;i++) store.event(`item${i}`);
    assert.equal(store.snapshot().sample.length,4);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sample').get()?.n,4);
    // No durable receipts, total counter, or exact distinct set disguised in another table.
    assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>row.name),['config','sample']);
    assert.deepEqual(db.prepare('PRAGMA table_info(config)').all().map(row=>row.name),['singleton','id','algorithm']);
    assert.deepEqual(db.prepare('PRAGMA table_info(sample)').all().map(row=>row.name),['id','priority']);
    const before=store.snapshot();
    assert.throws(()=>store.event('A'));
    assert.deepEqual(store.snapshot(),before);
  } finally { db.close(); }
});
test('unit: identity algorithm and persisted hash corruption fail closed', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try {
    const store=new SampleStore(db,'a'); store.event('j');
    assert.throws(()=>new SampleStore(db,'b'),/configuration mismatch/);
    assert.deepEqual(store.snapshot().sample,[golden[0]]);
    db.prepare('UPDATE config SET algorithm=?').run('other');
    assert.throws(()=>new SampleStore(db,'a'),/configuration mismatch/);
    db.prepare('UPDATE config SET algorithm=?').run(algorithm);
    db.prepare('UPDATE sample SET priority=?').run('0'.repeat(64));
    assert.throws(()=>new SampleStore(db,'a'),/Corrupt sample/);
  } finally { db.close(); }
});
test('unit: failed SQLite replacement rolls back eviction and insertion atomically', async () => {
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(':memory:');
  try {
    const store=new SampleStore(db,'b');
    for (const id of ['a','b','c','d']) store.event(id);
    const before=store.snapshot();
    db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON sample WHEN NEW.id='j' BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(()=>store.event('j'),/injected/);
    assert.deepEqual(store.snapshot(),before);
    db.exec('DROP TRIGGER fail_insert');
    store.event('j');
    assert.deepEqual(store.snapshot().sample.map(row=>row.id),['j','d','c','b']);
  } finally { db.close(); }
});

const pair: [string,string]=['http://127.0.0.1:8001','http://127.0.0.1:8002'];
test('unit: aggregate fetches both fixed snapshot paths with redirect containment and exact identities', async () => {
  const requested: string[]=[];
  const fetcher: typeof fetch=async (url,options)=>{
    assert.equal(options?.redirect,'error');
    assert.ok(options?.signal);
    const side=String(url) === pair[0]+'/snapshot' ? 'a' : String(url) === pair[1]+'/snapshot' ? 'b' : undefined;
    assert.ok(side,'only configured snapshot URLs may be called');
    requested.push(side);
    return Response.json({id:side,algorithm,sample:side === 'a' ? [golden[0],golden[1]] : [golden[0],golden[2],golden[3]]});
  };
  assert.deepEqual(await collectSamples(pair,fetcher),{algorithm,sample:golden});
  assert.deepEqual(requested.sort(),['a','b']);
});
test('unit: aggregate rejects either upstream with unexpected status or envelope even well-shaped internal errors', async () => {
  for (const side of ['a','b'] as const) {
    for (const status of [200,404,409,422,429,500]) {
      const invalid: unknown[]=[null,[],false,1,'reply',{error:{code:'internal_error',message:'internal_error'}},
        {id:side,algorithm,sample:golden,extra:0}, {id:side === 'a'?'b':'a',algorithm,sample:golden}, {id:side,algorithm,sample:golden.toReversed()}];
      if (status !== 200) invalid.push({id:side,algorithm,sample:golden});
      for (const value of invalid) {
        const fetcher: typeof fetch=async url=>{
          const id=String(url) === pair[0]+'/snapshot' ? 'a' : 'b';
          return Response.json(id === side ? value : {id,algorithm,sample:[]},{status:id === side ? status : 200});
        };
        await assert.rejects(collectSamples(pair,fetcher),{status:502,code:'upstream_failure',message:'upstream_failure'});
      }
    }
  }
});
test('unit: byte limit accepts 8192 but rejects 8193 bytes of otherwise valid snapshot JSON', async () => {
  const raw=JSON.stringify({id:'a',algorithm,sample:golden});
  const validWire=raw+' '.repeat(8192-Buffer.byteLength(raw));
  assert.ok(snapshotValid(JSON.parse(validWire),'a'));
  const fetcher=(wire: string): typeof fetch=>async url=>new Response(String(url).startsWith(pair[0]) ? wire : JSON.stringify({id:'b',algorithm,sample:[]}),{headers:{'content-type':'application/json'}});
  assert.deepEqual(await collectSamples(pair,fetcher(validWire)),{algorithm,sample:golden});
  assert.ok(snapshotValid(JSON.parse(validWire+' '),'a'));
  await assert.rejects(collectSamples(pair,fetcher(validWire+' ')),{code:'upstream_failure'});
  for (const [wire,type] of [['{','application/json'],[raw,'text/plain']]) {
    await assert.rejects(collectSamples(pair,async url=>String(url) === pair[0]+'/snapshot'
      ? new Response(wire,{headers:{'content-type':type!}}) : Response.json({id:'b',algorithm,sample:[]})),{code:'upstream_failure'});
  }
});
test('unit: one deadline covers delayed headers and an unfinished body and cancels the body', async () => {
  const timers=new Set<ReturnType<typeof setTimeout>>();
  let cancelled=0;
  const later=(action: ()=>void,ms: number)=>{
    const timer=setTimeout(()=>{timers.delete(timer);action();},ms); timers.add(timer);
  };
  const fetcher: typeof fetch=async url=>{
    if (String(url).startsWith(pair[1])) return Response.json({id:'b',algorithm,sample:[]});
    await new Promise<void>(resolve=>later(resolve,280));
    const stream=new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"id":"a",'));
        later(()=>{controller.enqueue(Buffer.from('"algorithm":"bottom4-sha256-v1","sample":[]}'));controller.close();},400);
      },
      cancel() { cancelled++; for (const timer of timers) clearTimeout(timer); timers.clear(); },
    });
    return new Response(stream,{headers:{'content-type':'application/json'}});
  };
  const began=performance.now();
  try {
    await assert.rejects(collectSamples(pair,fetcher),{code:'upstream_failure'});
    assert.ok(performance.now()-began<1200,'single 500ms budget must include the streamed body');
    assert.equal(cancelled,1);
  } finally { for (const timer of timers) clearTimeout(timer); }
});

test('unit: entrypoint imports are silent with invalid environment without loading SQLite', () => {
  for (const name of ['sampler','aggregate']) {
    const url=new URL(`../${name}.mts`,import.meta.url);
    const result=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(url.href)})`],{
      encoding:'utf8',timeout:3000,
      env:{PATH:process.env.PATH ?? '',HOST:'invalid',PORT:'invalid',SAMPLE_ID:'invalid',DB_PATH:'/unavailable',SOURCE_A_ORIGIN:'invalid',SOURCE_B_ORIGIN:'invalid'},
    });
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout,'');assert.equal(result.stderr,'');
  }
});

const entry=(name: string)=>new URL(`../${name}.mts`,import.meta.url);
async function post(url: string, body: unknown, status=200): Promise<unknown> {
  const response=await jsonRequest(url,body);
  const value: unknown=await response.json();
  assert.equal(response.status,status,JSON.stringify(value));return value;
}
async function get(url: string,status=200): Promise<unknown> {
  const response=await fetch(url,{signal:AbortSignal.timeout(2500)});
  const value: unknown=await response.json();
  assert.equal(response.status,status,JSON.stringify(value));return value;
}
async function cleanup(services: RunningService[]): Promise<void> {
  const results=await Promise.allSettled(services.toReversed().map(service=>service.stop()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}
test('integration: three processes merge overlap and short samples, repeated reads and restart preserve bounded durable state', async () => {
  const dir=await mkdtemp(join(tmpdir(),'bottom74-'));
  const services: RunningService[]=[];
  try {
    const aEnv={DB_PATH:join(dir,'a.sqlite'),SAMPLE_ID:'a'};
    const bEnv={DB_PATH:join(dir,'b.sqlite'),SAMPLE_ID:'b'};
    const a=await startService(entry('sampler'),aEnv);services.push(a);
    const b=await startService(entry('sampler'),bEnv);services.push(b);
    const aggregate=await startService(entry('aggregate'),{SOURCE_A_ORIGIN:a.url+'/',SOURCE_B_ORIGIN:b.url});services.push(aggregate);
    assert.deepEqual(await get(aggregate.url+'/sample'),{algorithm,sample:[]});
    assert.deepEqual(await post(a.url+'/events',{id:'a'}),{retained:true});
    await post(b.url+'/events',{id:'a'});
    const one=[{id:'a',priority:'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'}];
    assert.deepEqual(await get(aggregate.url+'/sample'),{algorithm,sample:one});
    for (const id of ids.slice(0,8)) await post(a.url+'/events',{id});
    for (const id of ids.slice(4)) await post(b.url+'/events',{id});
    const expected={algorithm,sample:golden};
    for (let i=0;i<3;i++) assert.deepEqual(await get(aggregate.url+'/sample'),expected);
    const before=await get(a.url+'/snapshot');
    assert.deepEqual(await post(a.url+'/events',{id:'a'}),{retained:false});
    assert.deepEqual(await get(a.url+'/snapshot'),before);
    await a.stop();
    const restarted=await startService(entry('sampler'),{...aEnv,PORT:new URL(a.url).port});services.push(restarted);
    assert.deepEqual(await get(a.url+'/snapshot'),before);
    assert.deepEqual(await get(aggregate.url+'/sample'),expected);
    for (const value of [null,[],false,1,'a',{}, {id:'a',extra:1},{id:{toString:null}},{id:'A'},{id:16},{id:'a'.repeat(17)}]) {
      assert.deepEqual(await post(a.url+'/events',value,400),{error:{code:'invalid_request',message:'invalid_request'}});
    }
    const malformed=await fetch(a.url+'/events',{method:'POST',headers:{'content-type':'application/json'},body:'{',signal:AbortSignal.timeout(2500)});
    assert.equal(malformed.status,400);assert.deepEqual(await malformed.json(),{error:{code:'invalid_json',message:'invalid_json'}});
    const large=await fetch(a.url+'/events',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'a'})+' '.repeat(8193),signal:AbortSignal.timeout(2500)});
    assert.equal(large.status,413);assert.deepEqual(await large.json(),{error:{code:'body_too_large',message:'body_too_large'}});
    const wrongType=await fetch(a.url+'/events',{method:'POST',body:'{}',signal:AbortSignal.timeout(2500)});
    assert.equal(wrongType.status,415);assert.deepEqual(await wrongType.json(),{error:{code:'unsupported_media_type',message:'unsupported_media_type'}});
    assert.deepEqual(await get(a.url+'/events',405),{error:{code:'method_not_allowed',message:'method_not_allowed'}});
    assert.deepEqual(await post(aggregate.url+'/sample',{},405),{error:{code:'method_not_allowed',message:'method_not_allowed'}});
    assert.deepEqual(await get(aggregate.url+'/sample?url='+encodeURIComponent(a.url),404),{error:{code:'not_found',message:'not_found'}});
    for (let i=0;i<96;i++) await post((i%2 === 0?a.url:b.url)+'/events',{id:`item${i}`});
    assert.deepEqual(await get(aggregate.url+'/sample'),{algorithm,sample:[
      {id:'item29',priority:'02cfbd3c36aa05fd6ddfbabc453cd8764eb57dbf8cf0018e04f70c39887db683'},
      {id:'item4',priority:'035688b8098b0f69844df485a82355939bb855c5ced3d48efa8ecb32ffcb90b7'},
      {id:'item90',priority:'05175218107f9d5fc1766beee31520e86159c35c3972cf6e2ec2347808c83477'},
      {id:'item32',priority:'0a7f0672a2e1574a73f307d078b597df5a9274bb390b3c01247451b98ecf9636'},
    ]});
    await restarted.stop();await b.stop();
    const {DatabaseSync}=await import('node:sqlite');
    for (const env of [aEnv,bEnv]) {
      assert.equal((await stat(env.DB_PATH)).mode & 0o077,0);
      const db=new DatabaseSync(env.DB_PATH,{readOnly:true});
      try {
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sample').get()?.n,4);
        assert.deepEqual(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row=>row.name),['config','sample']);
      } finally { db.close(); }
    }
    await assert.rejects(startService(entry('sampler'),{...aEnv,SAMPLE_ID:'b'}),/configuration mismatch/);
  } finally { try { await cleanup(services); } finally { await rm(dir,{recursive:true,force:true}); } }
});
test('integration: every upstream is validated and bodies have finite bytes time and redirect containment', async () => {
  const services: RunningService[]=[];
  try {
    const fixture=await startService(new URL('./adversary.mts',import.meta.url));services.push(fixture);
    const configured=await get(fixture.url+'/origins');
    assert.ok(configured !== null && typeof configured === 'object' && 'b' in configured && typeof configured.b === 'string');
    const aggregate=await startService(entry('aggregate'),{SOURCE_A_ORIGIN:fixture.url,SOURCE_B_ORIGIN:configured.b});services.push(aggregate);
    const control=async (side: 'a'|'b',mode: string)=>{await post(fixture.url+'/control',{side,mode});};
    const failure={error:{code:'upstream_failure',message:'upstream_failure'}};
    for (const side of ['a','b'] as const) {
      await control(side,'boundary');
      assert.deepEqual(await get(aggregate.url+'/sample'),{algorithm,sample:golden});
      for (const mode of ['null','array','primitive','extra','identity','algorithm','sort','duplicate','hash','entryextra','five',
        'type','malformed','oversize','disconnect','status404','status409','status422','status429','status500','valid409','valid500']) {
        await control(side,mode);
        assert.deepEqual(await get(aggregate.url+'/sample',502),failure,`${side}:${mode}`);
      }
      for (const mode of ['headersdelay','bodydelay','combineddelay']) {
        await control(side,mode);const began=performance.now();
        assert.deepEqual(await get(aggregate.url+'/sample',502),failure);
        assert.ok(performance.now()-began<1200,`${mode}: deadline includes full body`);
      }
      await control(side,'redirect');
      assert.deepEqual(await get(aggregate.url+'/sample',502),failure);
      // Inspect before any control/reset: the distinct reachable target never received a request.
      assert.deepEqual(await get(fixture.url+'/counter'),{count:0});
      await control(side,'valid');
    }
    await control('a','empty');await control('b','short');
    assert.deepEqual(await get(aggregate.url+'/sample'),{algorithm,sample:[{id:'a',priority:'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'}]});
    await assert.rejects(startService(entry('aggregate'),{SOURCE_A_ORIGIN:fixture.url+'/',SOURCE_B_ORIGIN:fixture.url}),/distinct/);
    await assert.rejects(startService(entry('aggregate'),{SOURCE_A_ORIGIN:fixture.url,SOURCE_B_ORIGIN:configured.b,PORT:new URL(fixture.url).port}),/distinct/);
    await fixture.stop();
    assert.deepEqual(await get(aggregate.url+'/sample',502),failure);
  } finally { await cleanup(services); }
});
