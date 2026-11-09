import { test } from 'node:test';
import assert from 'node:assert/strict';
// Missing implementation is represented as an absent result so RED is an assertion.
test('unit: canonical signed grant has a fixed independently encoded payload', async () => {
  const path = '../capability.mts';
  const module = await import(path).catch(() => undefined);
  assert.equal(module?.sign(['doc', 1010, 'r'], 'public-demo-secret-0123456789abcdef')?.split('.')[0],
    'WzEsIm9iamVjdHMtZGVtbyIsIkdFVCIsImRvYyIsMTAxMCwiciJd');
});
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sign, verify, Ledger, parseIssue, clock } from '../capability.mts';
import { startService, jsonRequest } from '../../../test/support.mts';
const secret = 'public-demo-secret-0123456789abcdef';
const raw = (value: unknown) => { const p = Buffer.from(JSON.stringify(value)).toString('base64url'); return p + '.' + createHmac('sha256', secret).update(p).digest('hex'); };
test('unit: HMAC vector, tamper, canonical tuple, scope and exact expiry', () => {
  const ticket = sign(['doc', 1010, 'r'], secret);
  assert.equal(ticket, 'WzEsIm9iamVjdHMtZGVtbyIsIkdFVCIsImRvYyIsMTAxMCwiciJd.e70b4df9caa380f59ab6c35b912a79667e48a46cb768100da139c9a6d4682ad2');
  assert.equal(verify(ticket, 'doc', 1009, secret), 'r');
  for (const [token,id,now] of [[ticket,'photo',1000],[ticket,'doc',1010],[ticket+'a','doc',1000],[ticket.slice(0,-1)+'0','doc',1000],[ticket+'.'.repeat(1024),'doc',1000],
    [raw([1,'other','GET','doc',1010,'r']),'doc',1000], [raw([1,'objects-demo','POST','doc',1010,'r']),'doc',1000],
    [raw([1,'objects-demo','GET','doc','1010','r']),'doc',1000], [raw([1,'objects-demo','GET','doc',1010,1]),'doc',1000],
    [raw([1,'objects-demo','GET','doc',1010,'r',0]),'doc',1000], [raw(null),'doc',1000], [raw([2,'objects-demo','GET','doc',1010,'r']),'doc',1000], [raw([1,'objects-demo','GET','doc',1010,{}]),'doc',1000]] as const) {
    assert.throws(() => verify(token,id,now,secret));
  }
  const noncanonical = Buffer.from('[1, "objects-demo","GET","doc",1010,"r"]').toString('base64url');
  assert.throws(() => verify(noncanonical+'.'+createHmac('sha256',secret).update(noncanonical).digest('hex'),'doc',1000,secret));
});
test('unit: primitive validation and maximal escaped request ID', () => {
  for (const value of [null, [], true, {requestId:1,objectId:'doc',ttlSeconds:1}, {requestId:'r',objectId:['doc'],ttlSeconds:1}, {requestId:'r',objectId:'doc',ttlSeconds:'1'}]) assert.throws(() => parseIssue(value));
  assert.deepEqual(parseIssue({requestId:'"'.repeat(32),objectId:'report',ttlSeconds:60}), {requestId:'"'.repeat(32),objectId:'report',ttlSeconds:60});
  assert.throws(() => clock({TEACHING_EPOCH_SECONDS:'1000'}));
});
test('unit: immutable issuance, exact expiry, transactional one-use and retained capacity', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new Ledger(db, secret);
    const input = {requestId:'r',objectId:'doc',ttlSeconds:10};
    const first = ledger.issue(input,1000);
    assert.deepEqual(ledger.issue(input,1009),first);
    assert.deepEqual(ledger.issue(input,2000),first);
    assert.throws(() => ledger.issue({...input,ttlSeconds:11},1000));
    ledger.consume('r'); assert.throws(() => ledger.consume('r'));
    for (let i=1;i<16;i++) { ledger.issue({...input,requestId:`r${i}`},1000); ledger.consume(`r${i}`); }
    assert.throws(() => ledger.issue({...input,requestId:'full'},1000));
    assert.throws(() => ledger.consume('full'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM spent').get()?.n,16);
    assert.equal(db.prepare('SELECT count(*) AS n FROM issues').get()?.n,16);
  } finally { db.close(); }
});
test('unit: imports ignore deliberately invalid runtime settings and stay silent', () => {
  const result = spawnSync(process.execPath,['--disable-warning=ExperimentalWarning','--input-type=module','-e',
    `await import(${JSON.stringify(new URL('../issuer.mts',import.meta.url).href)}); await import(${JSON.stringify(new URL('../objects.mts',import.meta.url).href)});`],
    {env:{...process.env,CAPABILITY_SECRET:'bad',DB_PATH:'/not/available',PORT:'bad',TEACHING_EPOCH_SECONDS:'bad'},timeout:5000,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr); assert.equal(result.stdout,''); assert.equal(result.stderr,'');
});
test('integration: independent durable issuance and consumption survive restarts without token logging', async () => {
  const dir = await mkdtemp(join(tmpdir(),'capability-'));
  const env = {CAPABILITY_SECRET:secret,TEACHING_CONTROLS:'1',TEACHING_EPOCH_SECONDS:'1000'};
  let issuer: Awaited<ReturnType<typeof startService>> | undefined;
  let objects: Awaited<ReturnType<typeof startService>> | undefined;
  let logs = '';
  const launch = async (name: string) => { const s = await startService(new URL(`../${name}.mts`,import.meta.url), {...env,DB_PATH:join(dir,name+'.sqlite')}); s.child.stdout?.on('data',(b:Buffer)=>{logs+=b.toString();}); s.child.stderr?.on('data',(b:Buffer)=>{logs+=b.toString();}); return s; };
  const get = (path:string, method='GET') => fetch(objects!.url+path,{method,signal:AbortSignal.timeout(3000),redirect:'error'});
  const issue = async (requestId:string,objectId='doc',ttlSeconds=10) => {
    const response = await jsonRequest(issuer!.url+'/tickets',{requestId,objectId,ttlSeconds}); assert.equal(response.status,200);
    const value: unknown = await response.json(); assert.ok(typeof value==='object' && value!==null && 'path' in value && typeof value.path==='string'); return value.path;
  };
  try {
    issuer=await launch('issuer'); objects=await launch('objects');
    const path=await issue('first');
    assert.equal((await get(path.replace('/doc?','/photo?'))).status,403);
    assert.equal((await get(path,'POST')).status,405);
    assert.equal((await get(path+'&ticket=x')).status,400);
    assert.equal((await get(path+'a')).status,403);
    assert.equal((await get('/objects/doc')).status,403);
    assert.equal((await get(path.slice(0,-1)+(path.endsWith('0')?'1':'0'))).status,403);
    const oversized=await fetch(issuer.url+'/tickets',{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(8192)+JSON.stringify({requestId:'byte-limit',objectId:'doc',ttlSeconds:1}),signal:AbortSignal.timeout(3000),redirect:'error'});
    assert.equal(oversized.status,413);
    assert.equal((await get('/objects/doc?ticket='+raw([1,'objects-demo','GET','doc','1010','future']))).status,403);
    assert.equal((await get(path)).status,200); assert.equal((await get(path)).status,409);
    await objects.stop(); objects=await launch('objects'); assert.equal((await get(path)).status,409);
    await issuer.stop(); issuer=await launch('issuer'); assert.equal(await issue('first'),path);
    assert.equal((await jsonRequest(issuer.url+'/tickets',{requestId:'first',objectId:'photo',ttlSeconds:10})).status,409);
    const expired=await issue('expired');
    assert.equal((await jsonRequest(objects.url+'/teaching/advance',{seconds:10})).status,200);
    assert.equal((await get(expired)).status,403);
    for (const invalid of [null,[],false,{seconds:'1'},{seconds:0}]) assert.equal((await jsonRequest(objects.url+'/teaching/advance',invalid)).status,400);
    for (const invalid of [null,[],false,{requestId:'x',objectId:true,ttlSeconds:1}]) assert.equal((await jsonRequest(issuer.url+'/tickets',invalid)).status,400);
    await issue('"'.repeat(32),'report',60);
    for(let i=0;i<13;i++) await issue('fill'+i);
    assert.equal((await jsonRequest(issuer.url+'/tickets',{requestId:'overflow',objectId:'doc',ttlSeconds:1})).status,503);
    for(let i=0;i<15;i++) assert.equal((await get('/objects/doc?ticket='+raw([1,'objects-demo','GET','doc',1060,'spent'+i]))).status,200);
    assert.equal((await get('/objects/doc?ticket='+raw([1,'objects-demo','GET','doc',1060,'spent-overflow']))).status,503);
    assert.equal((await get(path)).status,403); // Expiry has priority over replay after clock advance.
    assert.ok(!logs.includes(path.split('ticket=')[1]!));
    await objects.stop();
    objects=await startService(new URL('../objects.mts',import.meta.url),{CAPABILITY_SECRET:secret,DB_PATH:join(dir,'objects.sqlite')});
    assert.equal((await jsonRequest(objects.url+'/teaching/advance',{seconds:1})).status,404);
  } finally { await Promise.all([issuer?.stop(),objects?.stop()]); await rm(dir,{recursive:true,force:true}); }
});
