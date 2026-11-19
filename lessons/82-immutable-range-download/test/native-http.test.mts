import assert from 'node:assert/strict';
import test from 'node:test';
import {startService} from '../../../test/support.mts';
import {download} from '../download.mts';
const peerEntry = new URL('./native-peer.mts', import.meta.url);
const settings = {"REPLY": "abc", "MEDIA": "application/octet-stream", "ETAG": "\"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\""};

test('integration: an initial421 is rejected after exactly one HTTP attempt', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'retry'});
  try {
    await assert.rejects(download(peer.url, {id: 'o0', prefix: '', etag: null}));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['GET'], bodies: [null]});
  } finally { await peer.stop(); }
});

test('integration: duplicate malformed media fields cannot be folded into a receipt', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'duplicate'});
  try {
    await assert.rejects(download(peer.url, {id: 'o0', prefix: '', etag: null}));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['GET'], bodies: [null]});
  } finally { await peer.stop(); }
});

test('integration: a late encoding field remains visible within the bounded header block', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'flood'});
  try {
    await assert.rejects(download(peer.url, {id: 'o0', prefix: '', etag: null}));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['GET'], bodies: [null]});
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

test('integration: late Range and If-Range fields retain byte selection and stale replacement', async () => {
  await lab(async (dir, acquire) => {
    const object = await acquire('object.mts', {DB_PATH: join(dir, 'objects.sqlite')});
    const created = await fetch(object.url + '/objects/o0', {method: 'PUT', headers: {'content-type': 'application/json'},
      body: '{"text":"abc"}', signal: AbortSignal.timeout(3000)});
    assert.equal(created.status, 201); await created.arrayBuffer();
    const partial = await rawWire(object.url, 'GET', '/objects/o0', [...filler(), 'range', 'bytes=1-']);
    assert.deepEqual(partial, {status: 206, text: 'bc'});
    const stale = '"' + '0'.repeat(64) + '"';
    const replaced = await rawWire(object.url, 'GET', '/objects/o0', ['range', 'bytes=1-', ...filler(), 'if-range', stale]);
    assert.deepEqual(replaced, {status: 200, text: 'abc'});
  });
});
