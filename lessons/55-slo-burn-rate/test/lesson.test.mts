import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, windowResult, parseSnapshot, Store, object } from '../model.mts';

test('unit: weighted aggregate is 1x, never mean of percentages', () => {
  assert.equal(windowResult([{slot:0,total:900,bad:0},{slot:1,total:100,bad:10}],2,2).burnMilli,1000);
});
test('unit: exact thresholds, sustained burn, spike and recovery', () => {
  const buckets = Array.from({length:12},(_,slot)=>({slot,total:100,bad:6}));
  assert.equal(evaluate(buckets,6).fast.firing,true);
  assert.equal(evaluate(buckets.map(b=>({...b,bad:5})),6).fast.firing,false);
  assert.equal(evaluate(buckets.map(b=>({...b,bad:b.slot===5?18:0})),6).fast.firing,true);
  assert.equal(evaluate(buckets.map(b=>({...b,bad:b.slot===5?6:0})),6).fast.firing,false);
  buckets[6]={slot:6,total:100,bad:0};
  assert.equal(evaluate(buckets,7).fast.firing,false);
  assert.equal(evaluate(buckets,7).fast.long.bad,12);
  assert.equal(evaluate(buckets.map(b=>({...b,bad:3})),6).slow.firing,true);
});
test('unit: half-open boundaries and readiness do not hide a firing pair',()=>{
  const buckets=Array.from({length:6},(_,slot)=>({slot,total:100,bad:6}));
  assert.equal(windowResult(buckets,6,1).start,5);
  assert.equal(windowResult(buckets,7,1).readiness,'missing');
  assert.equal(windowResult([{slot:5,total:0,bad:0}],6,1).readiness,'no_traffic');
  assert.equal(windowResult([{slot:5,total:99,bad:1}],6,1).readiness,'low_traffic');
  assert.equal(evaluate(buckets.slice(3),6).decision,'alert');
  assert.equal(evaluate([],6).decision,'insufficient_data');
  assert.equal(evaluate(buckets.map(b=>({...b,bad:0})),6).decision,'ok');
});
test('unit: strict full snapshot rejects invalid records outside windows',()=>{
  for(const value of [null,[],{buckets:[{slot:0,total:100,bad:101}]},{buckets:[{slot:11,total:1,bad:0},{slot:0,total:1,bad:0}]},{buckets:[{slot:0,total:1,bad:0},{slot:0,total:1,bad:0}]},{buckets:[{slot:'0',total:1,bad:0}]}]) assert.throws(()=>parseSnapshot(value));
});
test('unit: durable store deduplicates immutable slots and bounds capacity',()=>{
  const store=new Store(':memory:');
  try {
    for(let slot=0;slot<12;slot++) assert.equal(store.put({slot,total:1000,bad:1000}),201);
    assert.equal(store.put({slot:0,total:1000,bad:1000}),200);
    assert.equal(store.put({slot:0,total:999,bad:0}),409);
    assert.equal(store.all().length,12);
    assert.deepEqual(store.all()[0],{slot:0,total:1000,bad:1000});
  } finally {store.db.close();}
});

import { spawnSync } from 'node:child_process';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService,jsonRequest } from '../../../test/support.mts';

test('unit: imports stay silent with deliberately invalid runtime configuration',()=>{
  const urls=['collector.mts','evaluator.mts','test/upstream.mts'].map(name=>new URL(`../${name}`,import.meta.url).href);
  const child=spawnSync(process.execPath,['--input-type=module','-e',`for(const url of ${JSON.stringify(urls)}) await import(url);`],{env:{PATH:process.env.PATH??'',PORT:'invalid',DB_PATH:'/missing/invalid/db',COLLECTOR_ORIGIN:'invalid',DEADLINE_MS:'invalid'},encoding:'utf8',timeout:3000});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout,'');assert.equal(child.stderr,'');
});

async function get(url:string) {return fetch(url,{signal:AbortSignal.timeout(3000)});}
async function wire(url:string,body:string) {return fetch(url,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(3000)});}
const collectorEntry=new URL('../collector.mts',import.meta.url);
const evaluatorEntry=new URL('../evaluator.mts',import.meta.url);
const upstreamEntry=new URL('./upstream.mts',import.meta.url);

test('integration: immutable collector restart and logical end advance through independent evaluator',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'slo-'));
  try {
    const env={DB_PATH:join(directory,'db.sqlite')};
    const collector=await startService(collectorEntry,env);
    try {
      for(const badBody of [null,[],false,{slot:'0',total:100,bad:0},{slot:0,total:1,bad:2},{slot:12,total:1,bad:0},{slot:0,total:1.5,bad:0}]) assert.equal((await jsonRequest(`${collector.url}/buckets`,badBody)).status,400);
      for(let slot=0;slot<12;slot++) {
        const bucket={slot,total:1000,bad:slot<6?60:0};
        assert.equal((await wire(`${collector.url}/buckets`,escapeStrings(JSON.stringify(bucket)))).status,201);
        assert.equal((await jsonRequest(`${collector.url}/buckets`,bucket)).status,200);
      }
      const before=await (await get(`${collector.url}/buckets`)).json();
      assert.equal((await jsonRequest(`${collector.url}/buckets`,{slot:0,total:1000,bad:0})).status,409);
      assert.deepEqual(await (await get(`${collector.url}/buckets`)).json(),before);
      const evaluator=await startService(evaluatorEntry,{COLLECTOR_ORIGIN:collector.url});
      try {
        for(const value of [null,[],true,{end:'6'},{end:5},{end:13},{end:6.1},{end:6,origin:'http://example.invalid'}]) assert.equal((await jsonRequest(`${evaluator.url}/evaluate`,value)).status,400);
        for(const [end,decision] of [[6,'alert'],[7,'alert'],[12,'ok']] as const) {
          const response=await wire(`${evaluator.url}/evaluate`,escapeStrings(JSON.stringify({end})));
          assert.equal(response.status,200);
          const report=object(await response.json());assert.equal(report.decision,decision);assert.equal(report.end,end);
        }
      } finally {await evaluator.stop();}
      await collector.stop();
      const restarted=await startService(collectorEntry,env);
      try {
        assert.deepEqual(await (await get(`${restarted.url}/buckets`)).json(),before);
        assert.equal((await jsonRequest(`${restarted.url}/buckets`,{slot:0,total:1000,bad:60})).status,200);
        assert.equal((await jsonRequest(`${restarted.url}/buckets`,{slot:0,total:1000,bad:59})).status,409);
      } finally {await restarted.stop();}
    } finally {await collector.stop();}
  } finally {await rm(directory,{recursive:true,force:true});}
});

// Escape decoded STRING tokens only: numeric/boolean/null JSON tokens remain unchanged.
function escapeStrings(text:string):string {
  return text.replace(/"(?:[^"\\]|\\.)*"/g,token=>{
    const decoded:unknown=JSON.parse(token);
    assert.equal(typeof decoded,'string');
    if(typeof decoded!=='string') throw new Error('string token required');
    return '"'+Array.from(decoded,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}

test('integration: bounded full snapshots, schema failures, deadlines and redirect containment',async()=>{
  const sink=await startService(upstreamEntry);
  try {
    const source=await startService(upstreamEntry);
    try {
      const evaluator=await startService(evaluatorEntry,{COLLECTOR_ORIGIN:source.url,DEADLINE_MS:'200'});
      try {
        const maximum={buckets:Array.from({length:12},(_,slot)=>({slot,total:1000,bad:1000}))};
        const legal=escapeStrings(JSON.stringify(maximum));
        const control=async(body:string,mode='normal',status=200,location='')=>{
          assert.equal((await jsonRequest(`${source.url}/control`,{body,mode,status,location})).status,200);
        };
        const run=async()=>jsonRequest(`${evaluator.url}/evaluate`,{end:6});
        await control(legal);
        assert.equal((await run()).status,200);
        assert.deepEqual(await (await get(`${source.url}/count`)).json(),{requests:1});
        const invalidSnapshots:unknown[]=[null,[],{}, {buckets:false}, {buckets:Array.from({length:13},(_,slot)=>({slot,total:100,bad:0}))},
          {buckets:[{slot:0,total:100,bad:0},{slot:0,total:100,bad:0}]},
          {buckets:[{slot:1,total:100,bad:0},{slot:0,total:100,bad:0}]},
          ...[null,[],{slot:0,total:'100',bad:0},{slot:0,total:1001,bad:0},{slot:0,total:100,bad:-1},{slot:0,total:100,bad:101},{slot:12,total:100,bad:0},{slot:0.5,total:100,bad:0},{slot:0,total:100,bad:false},{slot:0,total:100,bad:0,extra:1}].map(b=>({buckets:[b]})),
          {buckets:[{slot:0,total:100,bad:0},{slot:11,total:100,bad:101}]}];
        for(const invalid of invalidSnapshots) {
          await control(JSON.stringify(invalid));
          const response=await run();assert.equal(response.status,502);assert.equal(object(await response.json()).decision,undefined);
        }
        // Still valid schema and identity: removing only the byte gate would return a report.
        const oversized=legal+' '.repeat(4097-Buffer.byteLength(legal));
        assert.deepEqual(JSON.parse(oversized),maximum);
        for(const [body,mode,status] of [[oversized,'normal',200],['{','normal',200],[legal,'normal',503],[legal,'broken',200],[legal,'headers',200],[legal,'body',200]] as const) {
          await control(body,mode,status);
          const response=await run();assert.equal(response.status,502);assert.equal(object(await response.json()).decision,undefined);
        }
        await control(legal,'normal',302,`${sink.url}/buckets`);
        assert.equal((await run()).status,502);
        // Inspect distinct reachable destination BEFORE any reset can erase evidence.
        assert.deepEqual(await (await get(`${sink.url}/count`)).json(),{requests:0});
        await control(legal);assert.equal((await run()).status,200);
        // Missing differs from no traffic; no stale successful report is retained.
        await control('{"buckets":[]}');
        const missing=object(await (await run()).json());assert.equal(missing.decision,'insufficient_data');
        await control(legal,'normal',503);assert.equal((await run()).status,502);
      } finally {await evaluator.stop();}
    } finally {await source.stop();}
  } finally {await sink.stop();}
});
