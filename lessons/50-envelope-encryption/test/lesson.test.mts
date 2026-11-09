import test from 'node:test';
import assert from 'node:assert/strict';

// Removing authentication, canonical validation or CAS must break these assertions.
test('unit: AES-256-GCM independently published zero vector and authenticated identity', async () => {
  const module = await import('../core.mts').catch(() => undefined);
  assert.ok(module, 'encryption implementation must exist');
  const sealed = module.encrypt(Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(16), Buffer.alloc(0));
  assert.equal(sealed.ciphertext, 'zqdAPU1ga24HTsXTuvOdGA==');
  assert.equal(sealed.tag, '0NHIp5mZa/AmW5i11Iq5GQ==');
  assert.throws(() => module.decrypt(Buffer.alloc(32), sealed, Buffer.from('wrong AAD')));
});

test('unit: canonical bytes, Unicode bounds and durable CAS reject unsafe inputs', async () => {
  const m = await import('../core.mts');
  assert.throws(() => m.bytes('AB==', 1));
  assert.throws(() => m.bytes('AA', 1));
  assert.equal(m.plaintext('\0'.repeat(256)).length, 256);
  assert.equal(m.plaintext('😀'.repeat(64)).length, 256);
  for (const value of [null, [], true, '\ud800', '😀'.repeat(65), '']) assert.throws(() => m.plaintext(value));
  assert.throws(() => m.objectId(['a']));
  const canonical = {kekId:'v1', iv:'AAAAAAAAAAAAAAAA', tag:'AAAAAAAAAAAAAAAAAAAAAA==', ciphertext:'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='};
  assert.equal(m.wrapped(canonical).kekId, 'v1');
  for (const value of [null, [], {...canonical,kekId:['v1']}, {...canonical,iv:'AAAAAAAAAAAAAAA='}, {...canonical,tag:'AAAAAAAAAAAAAAAAAAAAAB=='}, {...canonical,ciphertext:canonical.ciphertext + '\n'}]) assert.throws(() => m.wrapped(value));
  const db = m.openStore(':memory:');
  try {
    const data = m.encrypt(Buffer.alloc(32), Buffer.alloc(12), Buffer.from('a'), Buffer.from('[1,"a"]'));
    const wrapped = { ...m.encrypt(Buffer.alloc(32), Buffer.alloc(12), Buffer.alloc(32), Buffer.from('[1,"a","v1"]')), kekId: 'v1' as const };
    m.insert(db, 'a', data, wrapped);
    assert.throws(() => m.decrypt(Buffer.alloc(32), data, Buffer.from('[1,"b"]')));
    assert.throws(() => m.decrypt(Buffer.alloc(32), {...data, tag: Buffer.alloc(16).toString('base64')}, Buffer.from('[1,"a"]')));
    m.replace(db, 'a', 1, wrapped);
    assert.throws(() => m.replace(db, 'a', 1, wrapped));
    for (let version = 2; version < 8; version++) m.replace(db, 'a', version, wrapped);
    assert.throws(() => m.replace(db, 'a', 8, wrapped));
    assert.equal(m.load(db, 'a').version, 8);
    assert.deepEqual(m.load(db, 'a').data, data);
  } finally { db.close(); }
});

import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
const demo = { WRAP_KEY_V1: '11'.repeat(32), WRAP_KEY_V2: '22'.repeat(32), TEACHING_CONTROLS:'1' };
async function get(url: string) { return fetch(url, {signal:AbortSignal.timeout(3000)}); }
async function body(response: Response): Promise<Record<string, unknown>> { return record(await response.json()); }
import { record, bytes } from '../core.mts';

test('unit: imports are silent and inert despite invalid runtime configuration', async () => {
  const script = ['core', 'keys', 'vault'].map(name => `await import(${JSON.stringify(new URL(`../${name}.mts`, import.meta.url).href)});`).join('');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {PATH:process.env.PATH ?? '', PORT:'invalid', DB_PATH:'/not/allowed/db', KEYS_ORIGIN:'invalid', WRAP_KEY_V1:'invalid'}, stdio:['ignore','pipe','pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (v: Buffer) => { stdout += v.toString(); });
  child.stderr.on('data', (v: Buffer) => { stderr += v.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 0); assert.equal(stdout, ''); assert.equal(stderr, '');
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
});

test('integration: independent processes persist randomized ciphertext and rotate only envelopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'envelope-'));
  let keys: RunningService | undefined; let vault: RunningService | undefined;
  try {
    keys = await startService(new URL('../keys.mts', import.meta.url), demo);
    const env = {KEYS_ORIGIN:keys.url, DB_PATH:join(dir, 'vault.db')};
    vault = await startService(new URL('../vault.mts', import.meta.url), env);
    const v = () => vault!.url; const k = keys.url;
    for (const id of ['a','b']) assert.equal((await jsonRequest(`${v()}/objects`, {id, plaintext:'Xin chào 🔑'})).status, 201);
    const a = await body(await get(`${v()}/envelopes/a`));
    const b = await body(await get(`${v()}/envelopes/b`));
    assert.notDeepEqual(a.data, b.data);
    assert.equal((await jsonRequest(`${k}/unwrap`, {id:'b', wrapped:a.wrapped})).status, 409);
    assert.equal((await jsonRequest(`${v()}/objects`, {id:'a', plaintext:'duplicate'})).status, 409);
    // Worst escaping: 256 NULs can legally occupy 1536 JSON bytes; also escape all 32 id characters.
    const raw = '{"id":"' + '\\u006d'.repeat(32) + '","plaintext":"' + '\\u0000'.repeat(256) + '"}';
    assert.equal((await fetch(`${v()}/objects`, {method:'POST', headers:{'content-type':'application/json'}, body:raw, signal:AbortSignal.timeout(3000)})).status, 201);
    for (const value of [null, [], true, {id:[], plaintext:'ok'}, {id:'x', plaintext:'\ud800'}, {id:'x', plaintext:'😀'.repeat(65)}]) {
      assert.equal((await jsonRequest(`${v()}/objects`, value)).status, 400);
    }
    const dek = Buffer.alloc(32, 7).toString('base64');
    const keyEnvelope = await body(await jsonRequest(k + '/wrap', {id:'max',dek}));
    assert.equal((await body(await jsonRequest(k + '/unwrap', {id:'max',wrapped:keyEnvelope}))).dek, dek);
    const tag = bytes(keyEnvelope.tag, 16); tag[0] = (tag[0] ?? 0) ^ 1;
    assert.equal((await jsonRequest(k + '/unwrap', {id:'max',wrapped:{...keyEnvelope,tag:tag.toString('base64')}})).status, 409);
    assert.equal((await jsonRequest(k + '/wrap', {id:'max',dek:dek.replace('=', '')})).status, 400);
    for (const route of ['/wrap','/unwrap','/teaching/keys']) for (const value of [null, [], true]) {
      assert.equal((await jsonRequest(k + route, value)).status, 400);
    }
    for (const value of [{active:['v2'],disableV1:false}, {active:'v1',disableV1:true}, {active:'v2',disableV1:'false'}]) {
      assert.equal((await jsonRequest(k + '/teaching/keys', value)).status, 400);
    }
    assert.equal((await jsonRequest(`${k}/teaching/keys`, {active:'v2', disableV1:false})).status, 200);
    assert.equal((await jsonRequest(`${v()}/objects/a/rewrap`, {})).status, 200);
    const rotated = await body(await get(`${v()}/envelopes/a`));
    assert.equal(rotated.version, 2); assert.equal(record(rotated.wrapped).kekId, 'v2');
    assert.deepEqual(rotated.data, a.data);
    assert.equal((await jsonRequest(`${k}/teaching/keys`, {active:'v2', disableV1:true})).status, 200);
    assert.equal((await get(`${v()}/objects/b`)).status, 409);
    assert.deepEqual(await body(await get(`${v()}/objects/a`)), {id:'a', plaintext:'Xin chào 🔑'});
    await vault.stop(); vault = await startService(new URL('../vault.mts', import.meta.url), env);
    assert.deepEqual(await body(await get(`${v()}/envelopes/a`)), rotated);
    assert.equal((await get(`${v()}/objects/a`)).status, 200);
    // A process-local disable is reset on restart; the explicit public keys are unchanged.
    await keys.stop();
    keys = await startService(new URL('../keys.mts', import.meta.url), {...demo, TEACHING_CONTROLS:'0'});
    assert.equal((await jsonRequest(keys.url + '/teaching/keys', {active:'v2',disableV1:false})).status, 404);
    await vault.stop(); vault = await startService(new URL('../vault.mts', import.meta.url), {...env, KEYS_ORIGIN:keys.url});
    assert.equal((await get(`${v()}/objects/b`)).status, 200);
    const durable = await readFile(env.DB_PATH);
    assert.equal(durable.includes(Buffer.from('Xin chào 🔑')), false);
    for (let i = 0; i < 13; i++) assert.equal((await jsonRequest(`${v()}/objects`, {id:`c${i}`,plaintext:'ok'})).status, 201);
    assert.equal((await jsonRequest(`${v()}/objects`, {id:'overflow',plaintext:'ok'})).status, 409);
  } finally { await vault?.stop(); await keys?.stop(); await rm(dir, {recursive:true, force:true}); }
});

test('integration: bounded adversarial upstream cannot write or redirect; concurrent rewrap has one CAS winner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'envelope-fail-'));
  const services: RunningService[] = [];
  try {
    const keys = await startService(new URL('../keys.mts', import.meta.url), demo); services.push(keys);
    const sink = await startService(new URL('./upstream.mts', import.meta.url), {TARGET_ORIGIN:keys.url, TEACHING_CONTROLS:'1'}); services.push(sink);
    const fixture = await startService(new URL('./upstream.mts', import.meta.url), {TARGET_ORIGIN:keys.url, REDIRECT_ORIGIN:sink.url, TEACHING_CONTROLS:'1'}); services.push(fixture);
    const vault = await startService(new URL('../vault.mts', import.meta.url), {KEYS_ORIGIN:fixture.url, DB_PATH:join(dir,'vault.db')}); services.push(vault);
    const mode = async (value: string) => { assert.equal((await jsonRequest(fixture.url + '/teaching/mode', {mode:value})).status, 200); };
    assert.equal((await jsonRequest(vault.url + '/objects', {id:'a',plaintext:'unchanged'})).status, 201);
    const original = await body(await get(vault.url + '/envelopes/a'));
    for (const value of ['malformed','oversized','redirect','wrong-dek','error','hold']) {
      await mode(value);
      const result = await jsonRequest(vault.url + '/objects/a/rewrap', {});
      assert.ok(result.status >= 400, value);
      assert.deepEqual(await body(await get(vault.url + '/envelopes/a')), original, value);
      const create = await jsonRequest(vault.url + '/objects', {id:'new',plaintext:'not stored'});
      assert.ok(create.status >= 400, value);
      assert.equal((await get(vault.url + '/envelopes/new')).status, 404);
      assert.equal((await body(await get(sink.url + '/teaching/state'))).leaks, 0, 'different origin receives no forwarded payload');
      await mode('normal');
    }
    await mode('hold');
    const first = jsonRequest(vault.url + '/objects/a/rewrap', {});
    const second = jsonRequest(vault.url + '/objects/a/rewrap', {});
    const deadline = Date.now() + 900;
    for (;;) {
      const state = await body(await get(fixture.url + '/teaching/state'));
      if (state.pending === 2) break;
      assert.ok(Date.now() < deadline, 'both requests must reach observable wrap barrier');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    await mode('normal');
    assert.deepEqual((await Promise.all([first,second])).map(r => r.status).sort(), [200,409]);
    const after = await body(await get(vault.url + '/envelopes/a'));
    assert.equal(after.version, 2); assert.deepEqual(after.data, original.data);
    for (let i = 2; i < 8; i++) assert.equal((await jsonRequest(vault.url + '/objects/a/rewrap', {})).status, 200);
    assert.equal((await jsonRequest(vault.url + '/objects/a/rewrap', {})).status, 409);
  } finally { for (const service of services.reverse()) await service.stop(); await rm(dir, {recursive:true,force:true}); }
});
