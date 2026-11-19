import assert from 'node:assert/strict';
import test from 'node:test';
import {startService} from '../../../test/support.mts';
import {fetchOrigin} from '../upstream.mts';
const peerEntry = new URL('./native-peer.mts', import.meta.url);
const settings = {"REPLY": "{\"version\":0,\"value\":0}", "MEDIA": "application/json"};

test('integration: an initial421 is rejected after exactly one HTTP attempt', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'retry'});
  try {
    await assert.rejects(fetchOrigin(peer.url, new AbortController().signal));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['GET'], bodies: [null]});
  } finally { await peer.stop(); }
});

test('integration: duplicate malformed media fields cannot be folded into a receipt', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'duplicate'});
  try {
    await assert.rejects(fetchOrigin(peer.url, new AbortController().signal));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['GET'], bodies: [null]});
  } finally { await peer.stop(); }
});

test('integration: a late encoding field remains visible within the bounded header block', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'flood'});
  try {
    await assert.rejects(fetchOrigin(peer.url, new AbortController().signal));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['GET'], bodies: [null]});
  } finally { await peer.stop(); }
});


test('unit: malformed complete JSON media fields reject the refresh', async () => {
  for (const media of ['application/json; unparseable', 'application/json; charset=utf-8, text/plain']) {
    await assert.rejects(fetchOrigin('http://127.0.0.1:8080', new AbortController().signal,
      () => 0, async () => new Response('{"version":0,"value":0}', {headers: {'content-type': media}})));
  }
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

test('integration: late GET framing is rejected by cache and origin without an origin read', async () => {
  await lab(async (dir, acquire) => {
    const origin = await acquire('origin.mts', {DB_PATH: join(dir, 'origin.sqlite')});
    const cache = await acquire('cache.mts', {ORIGIN_ORIGIN: origin.url});
    for (const target of [origin.url, cache.url]) {
      const rejected = await rawWire(target, 'GET', '/value', [...filler(), 'content-length', '2'], '{}');
      assert.equal(rejected.status, 400); assert.deepEqual(JSON.parse(rejected.text), errorCode('invalid_body'));
    }
    const stats = await fetch(origin.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const decoded: unknown = await stats.json(); assert.deepEqual(decoded, {reads: 0});
  });
});
