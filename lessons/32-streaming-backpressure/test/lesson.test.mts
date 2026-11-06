import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { Parser, pump, LINE_BYTES, STREAM_BYTES } from '../stream.mts';

const line = (v: unknown) => Buffer.from(JSON.stringify(v) + '\n');
const record = (seq: number, text = 'Việt 🌱') => ({ type: 'item', seq, text });
const terminal = (count: number) => ({ type: 'end', count });
function valid(text = 'Việt 🌱') { return Buffer.concat([line(record(0, text)), line(terminal(1))]); }

test('unit: parser accepts byte-split UTF-8 and maximal escaped payload', () => {
  for (const text of ['Việt 🌱', '\u0000'.repeat(320)]) {
    const p = new Parser();
    for (const byte of valid(text)) p.feed(Buffer.from([byte]));
    assert.deepEqual(p.finish(), { count: 1 });
  }
});
test('unit: parser rejects missing/invalid terminal, sequence, schema and truncation', () => {
  for (const bytes of [line(record(0)), Buffer.concat([line(record(0)), line(terminal(2))]),
    Buffer.concat([line(record(1)), line(terminal(1))]), line({type:'item',seq:0,text:42}),
    valid().subarray(0, -1), Buffer.concat([valid(), line(record(1))])]) {
    assert.throws(() => { const p = new Parser(); p.feed(bytes); p.finish(); });
  }
});
test('unit: exact line and total byte boundaries use otherwise valid records', () => {
  const padded = (v: unknown, size: number) => { const b = line(v); return Buffer.concat([b.subarray(0,-1), Buffer.alloc(size-b.length,32), Buffer.from('\n')]); };
  const p = new Parser(); p.feed(padded(record(0),2048)); p.feed(line(terminal(1))); assert.equal(p.finish().count,1);
  assert.throws(() => new Parser().feed(padded(record(0),2049)), /line/);
  const q = new Parser();
  for(let i=0;i<63;i++) q.feed(padded(record(i),2048));
  q.feed(padded(record(63), 2048-line(terminal(64)).length)); q.feed(line(terminal(64))); assert.equal(q.finish().count,64);
  assert.throws(() => { const r = new Parser(); for(let i=0;i<64;i++) r.feed(padded(record(i),2048)); r.feed(line(terminal(64))); }, /stream/);
});
class Writer extends EventEmitter {
  destroyed = false; calls = 0;
  write(_chunk: Uint8Array): boolean { this.calls++; return false; }
}
test('unit: false write stops generation until drain and removes wait listeners', async () => {
  const w = new Writer(); let pulls = 0;
  async function* source() { pulls++; yield line(record(0)); pulls++; yield line(terminal(1)); }
  const pending = pump(w, source(), AbortSignal.timeout(1000));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(pulls,1); assert.equal(w.calls,1);
  w.emit('drain'); await new Promise<void>(r => setImmediate(r));
  assert.equal(pulls,2); w.emit('drain'); await pending;
  for(const event of ['drain','error','close']) assert.equal(w.listenerCount(event),0);
});
test('unit: close, error, caller abort and deadline clean waiting writer', async () => {
  for(const mode of ['close','error','abort','deadline']) {
    const w = new Writer(); const ac = new AbortController();
    const signal = mode === 'deadline' ? AbortSignal.timeout(20) : ac.signal;
    const task = pump(w, [line(record(0))], signal);
    const rejected = assert.rejects(task);
    await new Promise<void>(r => setImmediate(r));
    if(mode==='abort') ac.abort(); else if(mode!=='deadline') w.emit(mode, new Error('fixture'));
    const keepAlive = setTimeout(()=>{},40); await rejected; clearTimeout(keepAlive);
    for(const event of ['drain','error','close']) assert.equal(w.listenerCount(event),0);
    assert.equal(getEventListeners(signal,'abort').length,0);
  }
});

import { spawn } from 'node:child_process';
import { startService } from '../../../test/support.mts';
const producerEntry = new URL('../producer.mts',import.meta.url);
const consumerEntry = new URL('../consumer.mts',import.meta.url);
test('unit: every module imports silently with invalid runtime configuration', async()=>{
  const entries=['producer','consumer','runtime','stream'].map(name=>new URL(`../${name}.mts`,import.meta.url).href);
  const child=spawn(process.execPath,['--input-type=module','-e',`for(const url of ${JSON.stringify(entries)}) await import(url);`], {
    env:{PATH:process.env.PATH ?? '',PORT:'invalid',HOST:'invalid',PRODUCER_URL:'invalid',TEACHING_CONTROLS:'1'},stdio:['ignore','pipe','pipe']
  });
  let out=''; let err='';child.stdout.on('data',(b:Buffer)=>{out+=b.toString();});child.stderr.on('data',(b:Buffer)=>{err+=b.toString();});
  const timer=setTimeout(()=>child.kill('SIGKILL'),2000);
  try {
    const code=await new Promise<number|null>((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});
    assert.equal(code,0,err);assert.equal(out,'');assert.equal(err,'');
  } finally {clearTimeout(timer);if(child.exitCode===null) child.kill('SIGKILL');}
});
async function request(url:string, method='GET', signal=AbortSignal.timeout(5000)) {
  return fetch(url,{method,signal});
}
async function counters(url:string):Promise<Record<string,number>> {
  const res=await request(url+'/control/stats');assert.equal(res.status,200);
  const v:unknown=await res.json();assert.ok(typeof v==='object' && v!==null);
  const result:Record<string,number>={};
  for(const [key,value] of Object.entries(v)) {assert.equal(typeof value,'number');if(typeof value==='number') result[key]=value;}
  return result;
}
async function until(url:string,predicate:(s:Record<string,number>)=>boolean) {
  const end=Date.now()+2500;
  while(Date.now()<end) {const s=await counters(url);if(predicate(s))return s;await new Promise<void>(r=>setTimeout(r,10));}
  assert.fail('observable barrier not reached');
}
test('integration: real processes complete, real false/drain counters, explicit failure modes and restart',async()=>{
  for(let cycle=0;cycle<2;cycle++) {
    const p=await startService(producerEntry,{TEACHING_CONTROLS:'1'});
    try {
      const c=await startService(consumerEntry,{TEACHING_CONTROLS:'1',PRODUCER_URL:p.url});
      try {
        const result=await request(c.url+'/summary');assert.equal(result.status,200);assert.deepEqual(await result.json(),{count:64});
        const s=await until(p.url,s=>s.active===0 && s.completed===1);
        assert.equal(s.generated,64);assert.ok((s.blocked ?? 0)>=64);assert.equal(s.drains,s.blocked);
        for(const mode of ['truncated','malformed','terminal','line','stream']) {
          const res=await request(c.url+'/summary?mode='+mode);assert.equal(res.status,502,mode);
          assert.deepEqual(await res.json(),{error:'invalid_stream'});
          await until(p.url,s=>s.active===0);
        }
        const recovered=await request(c.url+'/summary');assert.equal(recovered.status,200);await recovered.arrayBuffer();
      } finally {await c.stop();}
    } finally {await p.stop();}
  }
});
test('integration: observable hold barrier proves max-two admission, caller cancellation and release',async()=>{
  const p=await startService(producerEntry,{TEACHING_CONTROLS:'1'});
  const controllers=[new AbortController(),new AbortController()];
  try {
    await (await request(p.url+'/control/hold','POST')).arrayBuffer();
    const responses=await Promise.all(controllers.map(ac=>request(p.url+'/stream','GET',ac.signal)));
    const held=await until(p.url,s=>s.active===2 && s.waiting===2);
    assert.equal(held.generated,0);
    const rejected=await request(p.url+'/stream');assert.equal(rejected.status,503);await rejected.arrayBuffer();
    assert.equal((await counters(p.url)).rejected,1);
    controllers[0]?.abort();
    await responses[0]?.body?.cancel().catch(()=>{});
    const cancelled=await until(p.url,s=>s.active===1 && s.waiting===1 && s.cancelled===1);
    assert.equal(cancelled.generated,0);
    const third=await request(p.url+'/stream');
    await until(p.url,s=>s.active===2 && s.waiting===2);
    await (await request(p.url+'/control/release','POST')).arrayBuffer();
    for(const response of [responses[1],third]) {assert.ok(response);const parser=new Parser();parser.feed(new Uint8Array(await response.arrayBuffer()));assert.equal(parser.finish().count,64);}
    const done=await until(p.url,s=>s.active===0 && s.waiting===0);
    assert.equal(done.generated,128);assert.equal(done.completed,2);
  } finally {for(const ac of controllers) ac.abort();await p.stop();}
});
test('integration: consumer read deadline and caller cancellation release both admissions',async()=>{
  const p=await startService(producerEntry,{TEACHING_CONTROLS:'1'});
  try {
    const c=await startService(consumerEntry,{TEACHING_CONTROLS:'1',PRODUCER_URL:p.url});
    try {
      await (await request(p.url+'/control/hold','POST')).arrayBuffer();
      const ac=new AbortController();
      const first=request(c.url+'/summary','GET',ac.signal).catch(()=>undefined);
      await until(p.url,s=>s.waiting===1);
      const second=request(c.url+'/summary');
      await until(p.url,s=>s.waiting===2);
      const rejected=await request(c.url+'/summary');assert.equal(rejected.status,503);await rejected.arrayBuffer();
      assert.equal((await counters(c.url)).rejected,1);
      ac.abort();await first;
      await until(p.url,s=>s.waiting===1 && s.active===1);
      const deadline=await second;assert.equal(deadline.status,502);await deadline.arrayBuffer();
      await until(p.url,s=>s.waiting===0 && s.active===0);
      const done=await until(c.url,s=>s.active===0);assert.equal(done.failed,2);assert.equal(done.completed,0);
      await (await request(p.url+'/control/release','POST')).arrayBuffer();
      const good=await request(c.url+'/summary');assert.equal(good.status,200);assert.deepEqual(await good.json(),{count:64});
    } finally {await c.stop();}
  } finally {await p.stop();}
});
test('integration: teaching controls and malformed modes are disabled by default',async()=>{
  const p=await startService(producerEntry);
  try {
    assert.equal((await request(p.url+'/control/stats')).status,404);
    assert.equal((await request(p.url+'/stream?mode=malformed')).status,400);
  } finally {await p.stop();}
});
test('unit: maximal legal producer payload and strict primitive types',()=>{
  const p=new Parser();
  for(let seq=0;seq<64;seq++) p.feed(line(record(seq,'\u0000'.repeat(320))));
  p.feed(line(terminal(64)));assert.equal(p.finish().count,64);
  for(const value of [
    {type:['item'],seq:0,text:'x'}, {type:'item',seq:'0',text:'x'},
    {type:'item',seq:0,text:[]}, {type:'item',seq:0,text:'x'.repeat(321)},
    {type:'end',count:'0'}, {type:'end',count:false},
  ]) assert.throws(()=>new Parser().feed(line(value)));
  const invalid=Buffer.concat([Buffer.from('{"type":"item","seq":0,"text":"'),Buffer.from([0xff]),Buffer.from('"}\n')]);
  assert.throws(()=>new Parser().feed(invalid));
  const q=new Parser();for(let seq=0;seq<64;seq++)q.feed(line(record(seq)));
  assert.throws(()=>q.feed(line(record(64))));
});
test('integration: producer overall deadline removes held waiter and releases admission',async()=>{
  const p=await startService(producerEntry,{TEACHING_CONTROLS:'1'});
  try {
    await (await request(p.url+'/control/hold','POST')).arrayBuffer();
    const response=await request(p.url+'/stream');
    // Attach a rejection handler immediately: deadline destroys the partial response.
    const body=assert.rejects(response.arrayBuffer());
    await until(p.url,s=>s.waiting===1 && s.active===1);
    // Poll in two bounded phases; counters, not elapsed time, prove cleanup.
    const limit=Date.now()+5000;
    let done=false;
    while(Date.now()<limit) {
      const s=await counters(p.url);
      if(s.cancelled===1 && s.active===0 && s.waiting===0) {assert.equal(s.generated,0);done=true;break;}
      await new Promise<void>(r=>setTimeout(r,20));
    }
    assert.ok(done,'overall deadline must release admission');await body;
    await (await request(p.url+'/control/release','POST')).arrayBuffer();
    const recovery=await request(p.url+'/stream');assert.equal(recovery.status,200);await recovery.arrayBuffer();
    await until(p.url,s=>s.active===0 && s.completed===1);
  } finally {await p.stop();}
});

test('integration: line-limit fixture satisfies schema sequence terminal and total budget',async()=>{
  const producer=await startService(producerEntry,{TEACHING_CONTROLS:'1'});
  try{
    const response=await request(producer.url+'/stream?mode=line');assert.equal(response.status,200);
    const body=Buffer.from(await response.arrayBuffer());
    assert.ok(body.length<=STREAM_BYTES,`line fixture must not exceed total budget: ${body.length}`);
    const lines=body.toString('utf8').trimEnd().split('\n');assert.equal(lines.length,65);
    for(let i=0;i<64;i++){
      const parsed:unknown=JSON.parse(lines[i]!);
      assert.deepEqual(parsed,{type:'item',seq:i,text:'\u0000'.repeat(320)});
      if(i===0)assert.equal(Buffer.byteLength(lines[i]!)+1,LINE_BYTES+1);
      else assert.ok(Buffer.byteLength(lines[i]!)+1<=LINE_BYTES);
    }
    const end:unknown=JSON.parse(lines[64]!);assert.deepEqual(end,{type:'end',count:64});
    assert.throws(()=>new Parser().feed(body),/line byte limit/);
  }finally{await producer.stop();}
});
