import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cents, translate, LEGACY_LIMIT } from '../translation.mts';

test('unit: decimal price is converted exactly, including cents beyond floating precision', () => {
  assert.equal(cents('12.34'), 1234);
  assert.equal(cents('90071992547409.91'), Number.MAX_SAFE_INTEGER);
});

test('unit: prices reject malformed decimals and unsafe integers', () => {
  for (const value of ['1.001', '1e2', '-1.00', '01.00', '90071992547409.92', 1.23, null]) {
    assert.throws(() => cents(value));
  }
});

import { canonical, CANONICAL_LIMIT } from '../model.mts';
const legacy = (changes: Record<string, unknown> = {}) => ({sku: 'L:pen', unit_price: '12.34', currency: 'USD', packs: 3, pack_size: 4, status: 'A', description: 'Bút', ...changes});
const product = {id: 'pen', name: 'Bút', unitCents: 1234, currency: 'USD', availableUnits: 12, availability: 'available'};
test('unit: translation owns aliases, packs and both legacy formats', () => {
  assert.deepEqual(translate(legacy(), 'pen'), product);
  assert.deepEqual(translate({item: 'N:pen', price: '12.34', money: 'USD', boxes: 3, units_per_box: 4, state: 'A', label: 'Bút'}, 'pen'), product);
  for (const status of ['O', 'D']) assert.equal(translate(legacy({status, packs: 0}), 'pen').availability, 'unavailable');
});
test('unit: reject missing, ambiguous, mismatched, unsafe and unknown semantics', () => {
  const missing = legacy(); Reflect.deleteProperty(missing, 'unit_price');
  for (const value of [missing, legacy({item:'N:pen'}), legacy({sku:'L:other'}), legacy({currency:'EUR'}),
    legacy({status:'?' }), legacy({status:['A']}), legacy({currency:['USD']}), legacy({status:{toString:'A'}}),
    legacy({packs:1_000_000, pack_size:1000}), legacy({packs:Number.MAX_SAFE_INTEGER}), legacy({pack_size:0}),
    legacy({packs:0}), legacy({status:'D'}), legacy({unit_price:'NaN'})]) assert.throws(() => translate(value, 'pen'));
  for (const availability of [['available'], {}, null]) assert.throws(() => canonical({...product, availability}, 'pen'));
});
test('unit: maximum identifiers and escaped names fit derived response limits', () => {
  const key = 'x'.repeat(64);
  const value = legacy({sku:`L:${key}`, description:'\u0000'.repeat(80), unit_price:'90071992547409.91', packs:1000, pack_size:1000});
  const translated = translate(value, key);
  assert.equal(translated.availableUnits, 1_000_000);
  assert.ok(Buffer.byteLength(JSON.stringify(value)) <= LEGACY_LIMIT);
  assert.ok(Buffer.byteLength(JSON.stringify(translated)) <= CANONICAL_LIMIT);
});

import { spawn } from 'node:child_process';
import { bounded, origin } from '../transport.mts';
import { scenario } from '../legacy.mts';
import { quoteInput } from '../orders.mts';
import { startService, jsonRequest } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
test('unit: bounded reader accepts maximum legal response and rejects oversized JSON', async () => {
  const key='x'.repeat(64);
  const raw=legacy({sku:`L:${key}`,description:'\u0000'.repeat(80),unit_price:'90071992547409.91',packs:1000,pack_size:1000});
  const response=(value: unknown) => new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  assert.deepEqual(await bounded(response(raw),LEGACY_LIMIT),raw);
  const p=translate(raw,key);
  assert.deepEqual(await bounded(response(p),CANONICAL_LIMIT),p);
  await assert.rejects(bounded(response({padding:'x'.repeat(LEGACY_LIMIT)}),LEGACY_LIMIT),/too large/);
  await assert.rejects(bounded(new Response('{',{headers:{'content-type':'application/json'}}),LEGACY_LIMIT));
});
test('unit: control enum and quote boundary reject non-string/coerced inputs', () => {
  for (const value of [['valid'], {}, null, 1]) assert.throws(() => scenario(value));
  for (const value of [{productId:['pen'],quantity:1},{productId:'pen',quantity:'2'},{productId:'pen',quantity:0}]) assert.throws(() => quoteInput(value));
  for (const value of ['https://127.0.0.1:80','http://localhost:80','http://127.0.0.1:80/path','http://127.0.0.1:99999']) assert.throws(() => origin(value));
});
test('unit: all entrypoints import silently despite invalid runtime configuration', async () => {
  const entries=['legacy.mts','adapter.mts','orders.mts'];
  const script=entries.map(name => `await import(${JSON.stringify(new URL(`../${name}`,import.meta.url).href)});`).join('\n');
  const child=spawn(process.execPath,['--input-type=module','-e',script],{
    env:{PATH:process.env.PATH ?? '',PORT:'broken',HOST:'invalid',LEGACY_ORIGIN:'invalid',PRODUCTS_ORIGIN:'invalid',UPSTREAM_MS:'broken',TEACHING_CONTROLS:'1'},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',(chunk: Buffer) => {stdout+=chunk.toString();});
  child.stderr.on('data',(chunk: Buffer) => {stderr+=chunk.toString();});
  const timer=setTimeout(() => child.kill('SIGKILL'),5000);
  try {
    const status=await new Promise<number | null>((resolve,reject) => {child.once('error',reject);child.once('close',resolve);});
    assert.equal(status,0,stderr); assert.equal(stdout,''); assert.equal(stderr,'');
  } finally {clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');}
});

// Every listener lives in a child started inside this test; finally cleans partial startup too.
test('integration: independent legacy → adapter → Orders, stable formats and failures with recovery', {timeout:14000}, async () => {
  const children: RunningService[]=[];
  try {
    const legacyProcess=await startService(new URL('../legacy.mts',import.meta.url),{TEACHING_CONTROLS:'1'}); children.push(legacyProcess);
    const adapter=await startService(new URL('../adapter.mts',import.meta.url),{LEGACY_ORIGIN:legacyProcess.url,UPSTREAM_MS:'150'}); children.push(adapter);
    const orders=await startService(new URL('../orders.mts',import.meta.url),{PRODUCTS_ORIGIN:adapter.url,UPSTREAM_MS:'1000'}); children.push(orders);
    const control=async (value: unknown) => jsonRequest(`${legacyProcess.url}/teaching/scenario`,{scenario:value});
    const quote=async (productId='pen',quantity=2) => jsonRequest(`${orders.url}/quotes`,{productId,quantity});
    const first=await quote(); assert.equal(first.status,200);
    const expected={productId:'pen',quantity:2,unitCents:1234,currency:'USD',totalCents:2468};
    assert.deepEqual(await first.json(),expected);
    assert.equal((await control(['valid'])).status,400);
    assert.equal((await control({})).status,400);
    assert.equal((await quote('missing')).status,404);
    for (const [mode,status] of [['v2',200],['unavailable',409],['malformed',502],['ambiguous',502],['mismatch',502],['currency',502],['failure',503],['slow',504],['oversized',502],['redirect',502]] as const) {
      assert.equal((await control(mode)).status,200);
      const result=await quote(); assert.equal(result.status,status,mode);
      if (mode==='v2') assert.deepEqual(await result.json(),expected);
      assert.equal((await control('valid')).status,200);
      const recovered=await quote(); assert.equal(recovered.status,200,`recovery after ${mode}`);
      assert.deepEqual(await recovered.json(),expected);
    }
    assert.equal((await control('maximum')).status,200);
    const maximal=await fetch(`${adapter.url}/products/${'x'.repeat(64)}`,{signal:AbortSignal.timeout(2000),redirect:'manual'});
    assert.equal(maximal.status,200);
    const maxBody=canonical(await maximal.json(),'x'.repeat(64)); assert.equal(maxBody.unitCents,Number.MAX_SAFE_INTEGER);
    assert.equal((await quote('pen',2)).status,422);
    assert.equal((await quote('pen',1)).status,200);
  } finally {for (const child of children.reverse()) await child.stop();}
});

test('integration: teaching controls are disabled by default', async () => {
  const service=await startService(new URL('../legacy.mts',import.meta.url));
  try {assert.equal((await jsonRequest(`${service.url}/teaching/scenario`,{scenario:'failure'})).status,404);}
  finally {await service.stop();}
});

import { upstream } from '../transport.mts';
import { HttpError } from '../../../lib/http.mts';
test('unit: dependency status mappings preserve missing, unavailable and invalid responses', async (t) => {
  // In-memory fetch double: transport mapping assertions do not open sockets.
  let response=new Response();
  t.mock.method(globalThis,'fetch',async () => response);
  const cases: [number, unknown, number][] = [[404,{error:'not_found'},404],[503,{error:'temporary'},503],
    [504,{error:'deadline'},504],[502,{error:'invalid_upstream'},502],[404,{error:'something_else'},502],
    [302,{},502],[500,{error:'temporary'},502]];
  for (const [status,body,expected] of cases) {
    response=new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    await assert.rejects(upstream('http://127.0.0.1:1234/product',1000,100), (error: unknown) => error instanceof HttpError && error.status === expected);
  }
});
