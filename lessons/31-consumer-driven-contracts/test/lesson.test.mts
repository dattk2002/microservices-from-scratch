import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, parseReply, catalogue, record } from '../contracts.mts';

test('unit: consumer builds only bounded known interactions', () => {
  assert.deepEqual(buildRequest('product-found'), {method: 'GET', path: '/products/tea'});
  assert.deepEqual(buildRequest('product-missing'), {method: 'GET', path: '/products/absent'});
  for (const id of ['unknown', {}, 1, null, ['product-found']]) assert.throws(() => buildRequest(id));
  assert.equal(catalogue.length, 2);
});

test('unit: minimal fields allow additions but reject missing fields, types and statuses', () => {
  assert.deepEqual(parseReply('product-found', 200, {id: 'tea', priceCents: 1250, internal: true}), {kind: 'found', priceCents: 1250});
  assert.deepEqual(parseReply('product-missing', 404, {code: 'PRODUCT_MISSING', trace: 'extra'}), {kind: 'missing'});
  for (const body of [{id: 'tea'}, {priceCents: 1250}, {id: 'tea', priceCents: '1250'}, {id: ['tea'], priceCents: 1250}, null, [], 1, true]) {
    assert.throws(() => parseReply('product-found', 200, body));
  }
  for (const price of [-1, 1.5, Infinity, NaN, {}, null, true, 100001]) assert.throws(() => parseReply('product-found', 200, {id: 'tea', priceCents: price}));
  assert.throws(() => parseReply('product-found', 201, {id: 'tea', priceCents: 1250}));
  assert.throws(() => parseReply('product-missing', 200, {code: 'PRODUCT_MISSING'}));
  for (const code of [undefined, ['PRODUCT_MISSING'], 1, null, true, 'other']) assert.throws(() => parseReply('product-missing', 404, {code}));
  assert.throws(() => parseReply('unknown', 200, {}));
});

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { loopbackOrigin, readBytes, RESPONSE_BYTES, CONTROL_BYTES } from '../transport.mts';
import { quote } from '../client.mts';
import { startService } from '../../../test/support.mts';

const execute = promisify(execFile);
const here = (file: string) => new URL(`../${file}.mts`, import.meta.url);
async function get(url: string) { return fetch(url, {signal: AbortSignal.timeout(3000)}); }
async function setRevision(url: string, revision: unknown) {
  return fetch(`${url}/__teaching`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({revision}), signal: AbortSignal.timeout(3000)});
}

test('unit: fixed origin rejects caller redirects, credentials and non-loopback addresses', () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:3131'), 'http://127.0.0.1:3131');
  for (const value of [undefined, {}, ['http://127.0.0.1:3131'], 'http://localhost:3131', 'https://127.0.0.1:3131', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:3131/', 'http://user:secret@127.0.0.1:3131', 'http://127.0.0.1:3131?url=x']) assert.throws(() => loopbackOrigin(value));
});

test('unit: derived maximal escaped addition fits budget; oversized schema-valid JSON fails bytes only', async () => {
  const legal = JSON.stringify({id: 'tea', priceCents: 100000, note: '\u0000'.repeat(256)});
  assert.ok(Buffer.byteLength(legal) <= RESPONSE_BYTES);
  assert.equal(parseReply('product-found', 200, JSON.parse(legal)).kind, 'found');
  assert.equal((await readBytes(Readable.from([Buffer.from(legal)]), RESPONSE_BYTES)).toString(), legal);
  const oversized = JSON.stringify({id: 'tea', priceCents: 1250, note: 'x'.repeat(2048)});
  assert.equal(parseReply('product-found', 200, JSON.parse(oversized)).kind, 'found');
  await assert.rejects(readBytes(Readable.from([Buffer.from(oversized)]), RESPONSE_BYTES), /byte limit/);
  const boundary = Buffer.from(legal + ' '.repeat(RESPONSE_BYTES - Buffer.byteLength(legal)));
  assert.equal(parseReply('product-found', 200, JSON.parse(boundary.toString())).kind, 'found');
  assert.equal((await readBytes(Readable.from([boundary]), RESPONSE_BYTES)).length, RESPONSE_BYTES);
  await assert.rejects(readBytes(Readable.from([boundary, Buffer.from('x')]), RESPONSE_BYTES), /byte limit/);
  assert.deepEqual(quote(parseReply('product-found', 200, {id: 'tea', priceCents: 1250})), {available: true, totalCents: 2500});
  assert.deepEqual(quote(parseReply('product-missing', 404, {code: 'PRODUCT_MISSING'})), {available: false, totalCents: 0});
});

test('unit: every entrypoint imports silently with deliberately invalid runtime configuration', async () => {
  for (const entry of ['provider', 'consumer', 'verifier']) {
    const {stdout, stderr} = await execute(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(here(entry).href)})`], {
      timeout: 3000, env: {PATH: process.env.PATH ?? '', HOST: 'invalid host', PORT: 'not-a-number', PROVIDER_ORIGIN: 'https://invalid.example', TEACHING_CONTROLS: '1'},
    });
    assert.equal(stdout, '');
    assert.equal(stderr, '');
  }
});

test('integration: independent processes verify revisions, consumer values, failures and recovery', async t => {
  const provider = await startService(here('provider'), {TEACHING_CONTROLS: '1'});
  t.after(provider.stop);
  const consumer = await startService(here('consumer'), {PROVIDER_ORIGIN: provider.url});
  t.after(consumer.stop);
  const verifier = await startService(here('verifier'), {PROVIDER_ORIGIN: provider.url});
  t.after(verifier.stop);
  const expectedResults = [
    {interaction: 'product-found', ok: true, value: {available: true, totalCents: 2500}},
    {interaction: 'product-missing', ok: true, value: {available: false, totalCents: 0}},
  ];
  for (const revision of ['compatible', 'additive']) {
    assert.equal((await setRevision(provider.url, revision)).status, 200);
    if (revision === 'additive') {
      const raw = await get(`${provider.url}/products/tea`);
      const text = await raw.text();
      assert.ok(Buffer.byteLength(text) <= RESPONSE_BYTES);
      const body: unknown = JSON.parse(text);
      assert.ok(record(body) && typeof body.note === 'string');
      assert.equal(body.note.length, 256);
    }
    const verified = await get(`${verifier.url}/verify`);
    assert.equal(verified.status, 200);
    assert.deepEqual(await verified.json(), {ok: true, results: expectedResults});
    const found = await get(`${consumer.url}/quote/tea`);
    assert.equal(found.status, 200);
    assert.deepEqual(await found.json(), {available: true, totalCents: 2500});
    const missing = await get(`${consumer.url}/quote/absent`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {available: false, totalCents: 0});
  }
  for (const [revision, mismatch] of [['removal', 'priceCents: expected integer'], ['type', 'priceCents: expected integer'], ['status', 'status: expected 200'], ['oversized', 'body: byte limit exceeded']]) {
    assert.equal((await setRevision(provider.url, revision)).status, 200);
    if (revision === 'oversized') {
      const raw = await get(`${provider.url}/products/tea`);
      const text = await raw.text();
      assert.ok(Buffer.byteLength(text) > RESPONSE_BYTES);
      assert.deepEqual(parseReply('product-found', raw.status, JSON.parse(text)), {kind: 'found', priceCents: 1250});
    }
    const verified = await get(`${verifier.url}/verify`);
    assert.equal(verified.status, 409);
    assert.deepEqual(await verified.json(), {ok: false, results: [{interaction: 'product-found', ok: false, mismatch}, expectedResults[1]]});
    const failed = await get(`${consumer.url}/quote/tea`);
    assert.equal(failed.status, 502);
    assert.deepEqual(await failed.json(), {error: 'provider_contract_or_transport'});
  }
  assert.equal((await setRevision(provider.url, 'compatible')).status, 200);
  assert.equal((await get(`${verifier.url}/verify`)).status, 200);
  assert.deepEqual(await (await get(`${consumer.url}/quote/tea`)).json(), {available: true, totalCents: 2500});
  assert.equal((await get(`${verifier.url}/verify?url=http://127.0.0.1:1`)).status, 404);
  assert.equal((await setRevision(provider.url, ['compatible'])).status, 400);
  // Maximum legal escaped enum spelling: each character uses six JSON bytes.
  const escaped = '{"revision":"' + [...'compatible'].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('') + '"}';
  assert.ok(Buffer.byteLength(escaped) < CONTROL_BYTES);
  const control = (body: string) => fetch(`${provider.url}/__teaching`, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal: AbortSignal.timeout(3000)});
  assert.equal((await control(escaped)).status, 200);
  assert.equal((await control(escaped + ' '.repeat(CONTROL_BYTES - Buffer.byteLength(escaped)))).status, 200);
  // Whitespace preserves the exact valid schema and revision; only bytes differ.
  assert.equal((await control(escaped + ' '.repeat(CONTROL_BYTES))).status, 400);
});

test('integration: deadlines fail closed and single-run admission is observable before recovery', async t => {
  const provider = await startService(here('provider'), {TEACHING_CONTROLS: '1'});
  t.after(provider.stop);
  const verifier = await startService(here('verifier'), {PROVIDER_ORIGIN: provider.url});
  t.after(verifier.stop);
  assert.equal((await setRevision(provider.url, 'slow')).status, 200);
  const pending = get(`${verifier.url}/verify`);
  // Counter barrier, never infer admission/concurrency from elapsed time alone.
  const deadline = AbortSignal.timeout(2500);
  for (;;) {
    deadline.throwIfAborted();
    const state: unknown = await (await get(`${provider.url}/__teaching`)).json();
    if (typeof state === 'object' && state !== null && 'requests' in state && typeof state.requests === 'number' && state.requests >= 1) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await get(`${verifier.url}/verify`)).status, 429);
  const failed = await pending;
  assert.equal(failed.status, 409);
  assert.deepEqual(await failed.json(), {ok: false, results: [
    {interaction: 'product-found', ok: false, mismatch: 'upstream: unavailable or deadline exceeded'},
    {interaction: 'product-missing', ok: false, mismatch: 'upstream: unavailable or deadline exceeded'},
  ]});
  assert.equal((await setRevision(provider.url, 'compatible')).status, 200);
  assert.equal((await get(`${verifier.url}/verify`)).status, 200);
});

test('integration: teaching controls are absent by default', async t => {
  const provider = await startService(here('provider'));
  t.after(provider.stop);
  assert.equal((await get(`${provider.url}/__teaching`)).status, 404);
  assert.equal((await setRevision(provider.url, 'type')).status, 405);
  assert.deepEqual(await (await get(`${provider.url}/products/tea`)).json(), {id: 'tea', priceCents: 1250});
});
