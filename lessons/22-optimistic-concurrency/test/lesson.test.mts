import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMatch, Store } from '../model.mts';

test('unit: narrow strong version parser and bounds', () => {
  assert.equal(parseMatch('"v1"'), 1);
  assert.equal(parseMatch('"v9007199254740991"'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parseMatch(undefined), {status:428});
  for (const h of ['', '*', 'W/"v1"', '"v1", "v2"', '"v01"', '"v0"', '"v-1"', '"v1.0"', '"v9007199254740992"', 'v1']) {
    assert.throws(() => parseMatch(h), {status:400}, h);
  }
});
test('unit: atomic compare update and validation never lose data', () => {
  const store = new Store(':memory:');
  try {
    assert.deepEqual(store.read(), {value:'initial', version:1});
    assert.deepEqual(store.update(1, 'editor A'), {value:'editor A', version:2});
    assert.throws(() => store.update(1, 'editor B'), {status:412});
    for (const value of ['', ' '.repeat(2), 'x'.repeat(201), null, 4, {}]) {
      assert.throws(() => store.update(2, value), {status:400});
    }
    for (const version of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => store.update(version, 'valid'), {status:400});
    }
    assert.deepEqual(store.read(), {value:'editor A', version:2});
  } finally { store.close(); }
});

test('unit: version exhaustion and stale version leave state intact', () => {
  const store = new Store(':memory:');
  try {
    store.db.prepare('UPDATE resource SET version=? WHERE id=1').run(Number.MAX_SAFE_INTEGER);
    assert.throws(() => store.update(1, 'stale'), {status:412});
    assert.throws(() => store.update(Number.MAX_SAFE_INTEGER, 'overflow'), {status:409});
    assert.deepEqual(store.read(), {value:'initial',version:Number.MAX_SAFE_INTEGER});
  } finally { store.close(); }
});

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: inert entrypoints import silently with invalid configuration', async () => {
  const script = ['owner','client'].map(n => `await import(${JSON.stringify(new URL(`../${n}.mts`, import.meta.url).href)});`).join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env:{PATH:process.env.PATH ?? '', PORT:'bad', DB_PATH:'/no/such/parent/data.sqlite', OWNER_URL:'invalid', DEADLINE_MS:'bad'},
    stdio:['ignore','pipe','pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const code = await new Promise<number | null>((resolve,reject) => { child.once('error',reject); child.once('close',resolve); });
    assert.equal(code,0,stderr); assert.equal(stdout,''); assert.equal(stderr,'');
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
});

async function request(url: string, value?: unknown, tag?: string, method = 'PUT') {
  return fetch(url + '/resource', {
    method:value === undefined ? 'GET' : method,
    headers:{'content-type':'application/json', ...(tag === undefined ? {} : {'if-match':tag})},
    ...(value === undefined ? {} : {body:JSON.stringify({value})}),
    signal:AbortSignal.timeout(3000),
  });
}
test('integration: two editors race, restart preserves winner, explicit revision succeeds', {timeout:14000}, async () => {
  const dir = await mkdtemp(join(tmpdir(),'optimistic-'));
  const running: RunningService[] = [];
  const start = async (name: string, env: Record<string,string>) => {
    const service = await startService(new URL(`../${name}.mts`,import.meta.url),env);
    running.push(service); return service;
  };
  try {
    const env = {DB_PATH:join(dir,'owner.sqlite')};
    const owner = await start('owner',env);
    const a = await start('client',{OWNER_URL:owner.url});
    const b = await start('client',{OWNER_URL:owner.url});
    const reads = await Promise.all([request(a.url),request(b.url)]);
    const tag = reads[0]!.headers.get('etag')!;
    assert.equal(tag,'"v1"'); assert.equal(reads[1]!.headers.get('etag'),tag);
    for (const r of reads) assert.deepEqual(await r.json(),{value:'initial',version:1});
    // Both reads have completed before the gate opens. No timing sleeps.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writes = [a,b].map(async (editor,i) => { await gate; return request(editor.url, i === 0 ? 'A' : 'B',tag); });
    release();
    const results = await Promise.all(writes);
    assert.deepEqual(results.map(r => r.status).sort(),[200,412]);
    const winner = results[0]!.status === 200 ? 'A' : 'B';
    for (const r of results) await r.arrayBuffer();
    const saved = {value:winner,version:2};
    assert.deepEqual(await (await request(owner.url)).json(),saved);
    await owner.stop();
    const restarted = await start('owner',env);
    const reread = await request(restarted.url);
    assert.deepEqual(await reread.json(),saved);
    const freshTag = reread.headers.get('etag')!;
    const editor = await start('client',{OWNER_URL:restarted.url});
    const revised = await request(editor.url,'reviewed after conflict',freshTag,'PATCH');
    assert.equal(revised.status,200);
    assert.deepEqual(await revised.json(),{value:'reviewed after conflict',version:3});
    for (const [badTag,status] of [[undefined,428],['W/"v3"',400],['*',400],['"v3", "v2"',400],['"v2"',412]] as const) {
      const failed = await request(restarted.url,'valid body',badTag);
      assert.equal(failed.status,status); await failed.arrayBuffer();
    }
    const invalid = await request(restarted.url,'','"v3"');
    assert.equal(invalid.status,400); await invalid.arrayBuffer();
    assert.deepEqual(await (await request(restarted.url)).json(),{value:'reviewed after conflict',version:3});
    await restarted.stop();
    const unavailable = await request(editor.url,'valid mutation','"v3"');
    assert.equal(unavailable.status,503); await unavailable.arrayBuffer();
  } finally {
    for (const service of running.reverse()) await service.stop();
    await rm(dir,{recursive:true,force:true});
  }
});

test('integration: dependency deadline is bounded and mutation is sent only once', {timeout:7000}, async () => {
  let calls = 0;
  const hanging = createServer((req) => { calls++; req.resume(); });
  let editor: RunningService | undefined;
  try {
    await new Promise<void>(resolve => hanging.listen(0,'127.0.0.1',resolve));
    const address = hanging.address();
    assert.ok(address && typeof address !== 'string');
    editor = await startService(new URL('../client.mts',import.meta.url),{OWNER_URL:`http://127.0.0.1:${address.port}`,DEADLINE_MS:'100'});
    const before = performance.now();
    const failed = await request(editor.url,'valid input','"v1"');
    assert.equal(failed.status,504); await failed.arrayBuffer();
    assert.ok(performance.now()-before < 2000);
    assert.equal(calls,1);
  } finally {
    await editor?.stop();
    hanging.closeAllConnections();
    await new Promise<void>((resolve,reject) => hanging.close(e => e ? reject(e) : resolve()));
  }
});
