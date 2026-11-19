import assert from 'node:assert/strict';
import test from 'node:test';
import {startService} from '../../../test/support.mts';
import {fetchReplay} from '../reader.mts';
const peerEntry = new URL('./native-peer.mts', import.meta.url);
const settings = {"REPLY": "id: 1\nevent: item\ndata: {\"id\":\"a\",\"text\":\"Hello\"}\n\n", "MEDIA": "text/event-stream"};

test('integration: an initial421 is rejected after exactly one HTTP attempt', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'retry'});
  try {
    await assert.rejects(fetchReplay(peer.url, 0));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['GET'], bodies: [null]});
  } finally { await peer.stop(); }
});

test('integration: duplicate malformed media fields cannot be folded into a receipt', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'duplicate'});
  try {
    await assert.rejects(fetchReplay(peer.url, 0));
    const stats = await fetch(peer.url + '/stats', {signal: AbortSignal.timeout(3000)});
    const body: unknown = await stats.json();
    assert.deepEqual(body, {calls: 1, methods: ['GET'], bodies: [null]});
  } finally { await peer.stop(); }
});

test('integration: a late encoding field remains visible within the bounded header block', async () => {
  const peer = await startService(peerEntry, {...settings, MODE: 'flood'});
  try {
    await assert.rejects(fetchReplay(peer.url, 0));
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

test('integration: a Last-Event-ID beyond the header count window still resumes at the tail', async () => {
  await lab(async (dir, acquire) => {
    const feed = await acquire('feed.mts', {DB_PATH: join(dir, 'feed.sqlite')});
    const created = await jsonRequest(feed.url + '/events', {id: 'a', text: 'Hello'});
    assert.equal(created.status, 201); await created.arrayBuffer();
    const result = await rawWire(feed.url, 'GET', '/events', [...filler(), 'last-event-id', '1']);
    assert.equal(result.status, 200);
    assert.equal(result.text, '');
  });
});
