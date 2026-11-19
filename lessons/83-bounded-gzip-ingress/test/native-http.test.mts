import assert from 'node:assert/strict';
import test from 'node:test';
import {startService} from '../../../test/support.mts';
import {relayMessage} from '../upstream.mts';
const peerEntry = new URL('./native-peer.mts', import.meta.url);
const settings = {"REPLY": "{\"id\":\"a\",\"duplicate\":false}", "MEDIA": "application/json", "STATUS": "201"};

test('integration: an initial421 is rejected after exactly one HTTP attempt', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'retry'});
  try {
    await assert.rejects(relayMessage(peer.url, {id: 'a', text: 'Hello'}));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['POST'], bodies: [{id: 'a', text: 'Hello'}]});
  } finally { await peer.stop(); }
});

test('integration: duplicate malformed media fields cannot be folded into a receipt', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'duplicate'});
  try {
    await assert.rejects(relayMessage(peer.url, {id: 'a', text: 'Hello'}));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['POST'], bodies: [{id: 'a', text: 'Hello'}]});
  } finally { await peer.stop(); }
});

test('integration: a late encoding field remains visible within the bounded header block', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'flood'});
  try {
    await assert.rejects(relayMessage(peer.url, {id: 'a', text: 'Hello'}));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['POST'], bodies: [{id: 'a', text: 'Hello'}]});
  } finally { await peer.stop(); }
});

import {request as wireRequest} from 'node:http';
import type {IncomingMessage} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {jsonRequest} from '../../../test/support.mts';
import type {RunningService} from '../../../test/support.mts';

async function rawWire(origin: string, method: string, path: string, fields: string[], body = '') {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const call = wireRequest(origin, {method, path, headers: ['host', new URL(origin).host, ...fields],
      signal: AbortSignal.timeout(3000)}, resolve);
    call.once('error', reject);
    call.end(body);
  });
  try {
    response.setEncoding('utf8');
    let text = '';
    for await (const chunk of response) {
      if (typeof chunk !== 'string') throw new Error('Expected text fixture response');
      text += chunk;
      assert.ok(Buffer.byteLength(text) <= 8192);
    }
    return {status: response.statusCode, text};
  } finally { response.destroy(); }
}

function filler(): string[] {
  const fields: string[] = [];
  for (let i = 0; i < 1100; i++) fields.push('x', 'x');
  return fields;
}

function errorCode(code: string) { return {error: {code, message: code}}; }

async function lab(work: (dir: string, acquire: (entry: string, env?: Record<string, string>) => Promise<RunningService>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'native-header-contract-'));
  const services: RunningService[] = [];
  try {
    const acquire = async (entry: string, env: Record<string, string> = {}) => {
      const service = await startService(new URL('../' + entry, import.meta.url), env);
      services.push(service);
      return service;
    };
    await work(dir, acquire);
  } finally {
    const errors: unknown[] = [];
    for (const service of services.reverse()) { try { await service.stop(); } catch (error) { errors.push(error); } }
    await rm(dir, {recursive: true, force: true});
    if (errors.length) throw new AggregateError(errors, 'Fixture cleanup failed');
  }
}

test('integration: late coding and declared size are checked before any sink mutation', async () => {
  await lab(async (dir, acquire) => {
    const sink = await acquire('sink.mts', {DB_PATH: join(dir, 'sink.sqlite')});
    const ingress = await acquire('ingress.mts', {SINK_ORIGIN: sink.url});
    const message = '{"id":"a","text":"Hello"}';
    const coding = ['content-type', 'application/json', ...filler(), 'content-encoding', 'br',
      'content-length', String(Buffer.byteLength(message))];
    const rejected = await rawWire(ingress.url, 'POST', '/messages', coding, message);
    assert.equal(rejected.status, 415); assert.deepEqual(JSON.parse(rejected.text), errorCode('unsupported_encoding'));
    const tooLarge = await rawWire(ingress.url, 'POST', '/messages',
      ['content-type', 'application/json', ...filler(), 'content-length', '1025'], message.padEnd(513));
    assert.equal(tooLarge.status, 413); assert.deepEqual(JSON.parse(tooLarge.text), errorCode('encoded_too_large'));
    const stats = await fetch(sink.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const before: unknown = await stats.json(); assert.deepEqual(before, {count: 0, requests: 0});
    const direct = await rawWire(sink.url, 'POST', '/messages', coding, message);
    assert.equal(direct.status, 415); assert.deepEqual(JSON.parse(direct.text), errorCode('unsupported_encoding'));
    const statsAfter = await fetch(sink.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const after: unknown = await statsAfter.json(); assert.deepEqual(after, {count: 0, requests: 1});
  });
});
