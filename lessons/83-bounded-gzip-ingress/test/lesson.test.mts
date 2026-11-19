import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { IncomingMessage, request } from 'node:http';
import type { OutgoingHttpHeaders } from 'node:http';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { jsonRequest, startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { readMessage } from '../body.mts';

import { requestEncoding, validateMessage } from '../protocol.mts';
import { databasePath } from '../sink.mts';
import { relayMessage, sinkOrigin } from '../upstream.mts';
import { badChecksum, boundaryMessage, errorBody, escapedBoundary, gzipAtSize } from './wire.mts';

function expectCode(status: number, code: string) {
  return {status, code, message: code};
}

test('unit: tiny gzip passes at 512 decoded bytes and rejects valid JSON at 513', async () => {
  assert.equal(Buffer.byteLength(escapedBoundary), 512);
  assert.deepEqual(JSON.parse(`${escapedBoundary} `), boundaryMessage);
  const atLimit = gzipSync(escapedBoundary);
  const overLimit = gzipSync(`${escapedBoundary} `);
  assert.ok(overLimit.length < 100);
  assert.deepEqual(await readMessage(Readable.from([atLimit]), 'gzip'), boundaryMessage);
  await assert.rejects(readMessage(Readable.from([overLimit]), 'gzip'), expectCode(413, 'decoded_too_large'));
});

test('unit: a gzip prefix exceeds the decoded limit before the input ends', async () => {
  const wire = gzipSync(escapedBoundary + ' '.repeat(64));
  const source = new PassThrough();
  try {
    const rejected = assert.rejects(readMessage(source, 'gzip'), expectCode(413, 'decoded_too_large'));
    source.write(wire.subarray(0, -8));
    await rejected;
    assert.equal(source.readableEnded, false);
  } finally {
    source.destroy();
  }
});

test('unit: the encoded gzip cap counts split chunks with a valid gzip header at 1024 and 1025', async () => {
  const atLimit = gzipAtSize(escapedBoundary, 1024);
  const overLimit = gzipAtSize(escapedBoundary, 1025);
  assert.equal(atLimit.length, 1024);
  assert.equal(overLimit.length, 1025);
  assert.deepEqual(await readMessage(Readable.from([atLimit.subarray(0, 900), atLimit.subarray(900)]), 'gzip'),
    boundaryMessage);
  await assert.rejects(
    readMessage(Readable.from([overLimit.subarray(0, 1024), overLimit.subarray(1024)]), 'gzip'),
    expectCode(413, 'encoded_too_large'),
  );
});

test('unit: checksum, truncation and unconsumed bytes all invalidate gzip', async () => {
  const valid = gzipSync(escapedBoundary);
  const invalid = [
    ['checksum', badChecksum(valid)],
    ['truncated', valid.subarray(0, -1)],
    ['trailing garbage', Buffer.concat([valid, Buffer.from('junk')])],
    ['garbage after zero', Buffer.concat([valid, Buffer.from([0, 1])])],
  ] as const;
  for (const [label, wire] of invalid) {
    await assert.rejects(readMessage(Readable.from([wire.subarray(0, 13), wire.subarray(13)]), 'gzip'),
      expectCode(400, 'invalid_gzip'), label);
  }
});

test('unit: concatenated gzip members share one decoded cap and validation waits for the final member', async () => {
  const first = gzipSync(escapedBoundary.slice(0, 150));
  const rest = escapedBoundary.slice(150);
  const second = gzipSync(rest);
  assert.deepEqual(await readMessage(Readable.from([first, second]), 'gzip'), boundaryMessage);
  await assert.rejects(readMessage(Readable.from([first, gzipSync(rest + ' ')]), 'gzip'),
    expectCode(413, 'decoded_too_large'));
  await assert.rejects(readMessage(Readable.from([first, badChecksum(second)]), 'gzip'),
    expectCode(400, 'invalid_gzip'));
});

test('unit: identity has the same decoded cap and validates UTF-8 and JSON', async () => {
  const atLimit = Buffer.from(escapedBoundary);
  assert.deepEqual(await readMessage(Readable.from([atLimit]), 'identity'), boundaryMessage);
  await assert.rejects(readMessage(Readable.from([atLimit, Buffer.from(' ')]), 'identity'),
    expectCode(413, 'decoded_too_large'));
  await assert.rejects(readMessage(Readable.from([Buffer.from(escapedBoundary + ' '.repeat(513))]), 'identity'),
    expectCode(413, 'encoded_too_large'));
  for (const wire of [Buffer.from('{'), Buffer.concat([Buffer.from('{"id":"a","text":"'), Buffer.from([0xff]),
    Buffer.from('"}')])]) {
    await assert.rejects(readMessage(Readable.from([wire]), 'identity'), expectCode(400, 'invalid_json'));
  }
});

test('unit: an oversized declared identity body takes precedence over a smaller decoded overflow', async () => {
  const socket = new Socket();
  try {
    const source = new IncomingMessage(socket);
    try {
      source.headers['content-length'] = '1025';
      const rejected = assert.rejects(readMessage(source, 'identity'), expectCode(413, 'encoded_too_large'));
      source.push(Buffer.from(escapedBoundary + ' '));
      await rejected;
    } finally {
      source.destroy();
    }
  } finally {
    socket.destroy();
  }
});

test('unit: body work at exactly 500ms expires even before the timer callback', async () => {
  for (const encoding of ['identity', 'gzip'] as const) {
    const source = new PassThrough();
    try {
      let tick = 100;
      const closed = new Promise<void>(resolve => source.once('close', resolve));
      const result = readMessage(source, encoding, {acceptedAt: tick, now: () => tick});
      const rejected = assert.rejects(result, expectCode(408, 'body_timeout'));
      tick = 600;
      source.end(encoding === 'gzip' ? gzipSync(escapedBoundary) : Buffer.from(escapedBoundary));
      await rejected;
      assert.equal(source.destroyed, true);
      await closed;
      assert.equal(source.listenerCount('data'), 0);
      assert.equal(source.listenerCount('error'), 1, 'only the stateless late-error guard remains');
    } finally {
      source.destroy();
    }
  }
});

test('unit: gzip validation shares the original deadline after encoded bytes arrive', async () => {
  const source = new PassThrough();
  try {
    let tick = 100;
    const rejected = assert.rejects(
      readMessage(source, 'gzip', {acceptedAt: 100, now: () => tick}), expectCode(408, 'body_timeout'),
    );
    source.write(gzipSync(escapedBoundary));
    tick = 599;
    // The reader has handled EOF by the time this listener runs. Gunzip still has to finish.
    source.once('end', () => { tick = 600; });
    source.end();
    await rejected;
  } finally {
    source.destroy();
  }
});

test('unit: timing out destroys an ordinary reader and guards errors during asynchronous teardown', async () => {
  const source = new Readable({
    read() {},
    destroy(_error, callback) {
      setImmediate(() => callback(new Error('pending read failed during teardown')));
    },
  });
  try {
    const closed = new Promise<void>(resolve => source.once('close', resolve));
    let tick = 100;
    const rejected = assert.rejects(
      readMessage(source, 'gzip', {acceptedAt: 100, now: () => tick}), expectCode(408, 'body_timeout'),
    );
    tick = 600;
    source.push(Buffer.from([0x1f, 0x8b]));
    await rejected;
    assert.equal(source.destroyed, true);
    await closed;
    for (const event of ['data', 'end', 'close']) assert.equal(source.listenerCount(event), 0, event);
    assert.equal(source.listenerCount('error'), 1, 'only the stateless late-error guard remains');
  } finally {
    if (!source.destroyed) {
      source.once('error', () => {});
      source.destroy();
    }
  }
});

test('unit: abort detaches body listeners during a stalled read', async () => {
  const source = new PassThrough();
  try {
    const closed = new Promise<void>(resolve => source.once('close', resolve));
    const controller = new AbortController();
    const rejected = assert.rejects(readMessage(source, 'gzip', {signal: controller.signal}),
      expectCode(400, 'request_aborted'));
    controller.abort();
    await rejected;
    assert.equal(source.destroyed, true);
    await closed;
    for (const event of ['data', 'end', 'close']) assert.equal(source.listenerCount(event), 0, event);
    assert.equal(source.listenerCount('error'), 1, 'only the stateless late-error guard remains');
  } finally {
    source.destroy();
  }
});

test('unit: the message schema rejects coercion, extra fields and invalid ASCII or lengths', () => {
  assert.deepEqual(validateMessage({id: 'ab0123456789abcd', text: ' '.repeat(256)}),
    {id: 'ab0123456789abcd', text: ' '.repeat(256)});
  for (const value of [null, [], 10, 'message', {id: 'a'}, {id: 'a', text: 'ok', extra: true},
    {id: {toString: null}, text: 'ok'}, {id: 'a', text: {toString: null}}, {id: '', text: 'ok'},
    {id: 'a'.repeat(17), text: 'ok'}, {id: 'ABC', text: 'ok'}, {id: 'a\n', text: 'ok'},
    {id: 'a', text: ''}, {id: 'a', text: 'A'.repeat(257)}, {id: 'a', text: 'có'},
    {id: 'a', text: 'a\n'}, {id: 'a', text: 'a1'}]) {
    assert.throws(() => validateMessage(value), expectCode(400, 'invalid_message'));
  }
});

test('unit: only JSON and a single well-known content encoding pass the header contract', () => {
  const headers = {'content-type': ['Application/JSON; charset=utf-8']};
  assert.equal(requestEncoding(headers), 'identity');
  assert.equal(requestEncoding({...headers, 'content-encoding': ['Identity']}), 'identity');
  assert.equal(requestEncoding({...headers, 'content-encoding': ['GZip']}), 'gzip');
  for (const encoding of ['', 'br', 'gzip, identity', 'gzip, gzip']) {
    assert.throws(() => requestEncoding({...headers, 'content-encoding': [encoding]}),
      expectCode(415, 'unsupported_encoding'));
  }
  assert.throws(() => requestEncoding({...headers, 'content-encoding': ['gzip', 'identity']}),
    expectCode(415, 'unsupported_encoding'));
  assert.equal(requestEncoding({'content-type': ['application/json; example="x,y"']}), 'identity');
  for (const mediaTypes of [['text/plain'], ['application/json; charset=utf-8, text/plain'],
    ['application/json', 'text/plain'], ['application/json', 'application/json']]) {
    assert.throws(() => requestEncoding({'content-type': mediaTypes}), expectCode(415, 'unsupported_media_type'));
  }
});

test('unit: sink settings constrain the HTTP origin and require a private file-backed database', () => {
  assert.equal(sinkOrigin('HTTP://127.0.0.1:08080/'), 'http://127.0.0.1:8080');
  for (const raw of [undefined, 'http://localhost:80', 'https://127.0.0.1', 'http://127.0.0.1:0',
    'http://127.0.0.1:99999', 'http://127.0.0.1/path', 'http://127.0.0.1?', 'http://127.0.0.1#',
    'http://user@127.0.0.1', 'http://127.0.0.2', 'http://2130706433', 'http://127.0.0.1\n']) {
    assert.throws(() => sinkOrigin(raw), /SINK_ORIGIN/);
  }
  assert.equal(databasePath('data/sink.sqlite'), 'data/sink.sqlite');
  for (const raw of [undefined, '', ' ', ':memory:', 'file::memory:', 'FILE:receipt.sqlite', 'a\0b']) {
    assert.throws(() => databasePath(raw), /DB_PATH/);
  }
});

const message = {id: 'a', text: 'Hello world'};

function response(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
}

test('unit: relay sends only the normalized message to the fixed sink URL and accepts known envelopes', async () => {
  const outcomes = [
    [201, {id: 'a', duplicate: false}], [200, {id: 'a', duplicate: true}],
    [409, errorBody('id_conflict')], [429, errorBody('capacity')],
  ] as const;
  for (const [status, body] of outcomes) {
    const fetcher: typeof fetch = async (input, init) => {
      assert.equal(input, 'http://127.0.0.1:8080/messages');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal(new Headers(init?.headers).get('content-encoding'), null);
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
      assert.equal(init?.body, '{"id":"a","text":"Hello world"}');
      return response(status, body);
    };
    assert.deepEqual(await relayMessage('http://127.0.0.1:8080', message, {fetcher}), {status, body});
  }
});

test('unit: relay rejects mismatched receipts and semantic error envelopes', async () => {
  const faults = [
    [201, {id: 'b', duplicate: false}], [201, {id: 'a', duplicate: true}],
    [200, {id: 'a', duplicate: false}], [200, {id: 'a', duplicate: true, extra: 1}],
    [202, {id: 'a', duplicate: false}], [409, errorBody('internal_error')], [429, errorBody('internal_error')],
    [409, errorBody('capacity')], [429, errorBody('id_conflict')],
    [409, {error: {code: 'id_conflict', message: 'different'}}],
    [429, {error: {code: 'capacity', message: 'capacity', extra: 1}}],
    [429, {...errorBody('capacity'), extra: 1}], [409, null], [429, []], [409, 1], [429, 'capacity'],
  ] as const;
  for (const [status, body] of faults) {
    await assert.rejects(
      relayMessage('http://127.0.0.1:8080', message, {fetcher: async () => response(status, body)}),
      expectCode(502, 'upstream_failure'), JSON.stringify({status, body}),
    );
  }
});

test('unit: relay rejects an otherwise valid receipt with multiple media types', async () => {
  const fetcher: typeof fetch = async () => new Response('{"id":"a","duplicate":false}', {
    status: 201, headers: {'content-type': 'application/json; charset=utf-8, text/plain'},
  });
  await assert.rejects(relayMessage('http://127.0.0.1:8080', message, {fetcher}),
    expectCode(502, 'upstream_failure'));
});

test('unit: relay at exactly 500ms cancels an unread upstream body before forwarding', async () => {
  let tick = 100;
  let cancelled = false;
  const fetcher: typeof fetch = async () => {
    tick = 600;
    const body = new ReadableStream<Uint8Array>({cancel() { cancelled = true; }});
    return new Response(body, {status: 201, headers: {'content-type': 'application/json'}});
  };
  await assert.rejects(relayMessage('http://127.0.0.1:8080', message, {fetcher, now: () => tick}),
    expectCode(502, 'upstream_failure'));
  assert.equal(cancelled, true);
});

const receiptWire = '{"id":"a","duplicate":false}';
const createdReceipt = {status: 201, body: {id: 'a', duplicate: false}};

test('unit: headers at 300ms leave only 200ms to finish the upstream body', async () => {
  for (const finishedAt of [499, 500]) {
    let tick = 0;
    const fetcher: typeof fetch = async () => {
      tick = 300;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from(receiptWire.slice(0, 6)));
        },
        pull(controller) {
          tick = finishedAt;
          controller.enqueue(Buffer.from(receiptWire.slice(6)));
          controller.close();
        },
      }, {highWaterMark: 0});
      return new Response(body, {status: 201, headers: {'content-type': 'application/json'}});
    };
    const reply = relayMessage('http://127.0.0.1:8080', message, {fetcher, now: () => tick});
    if (finishedAt === 499) assert.deepEqual(await reply, createdReceipt);
    else await assert.rejects(reply, expectCode(502, 'upstream_failure'));
  }
});

test('unit: upstream accepts a valid receipt padded to exactly 8192 bytes', async () => {
  const fetcher: typeof fetch = async () => new Response(receiptWire.padEnd(8192, ' '), {
    status: 201, headers: {'content-type': 'application/json'},
  });
  assert.deepEqual(await relayMessage('http://127.0.0.1:8080', message, {fetcher}), createdReceipt);
});

test('unit: upstream cancels an open, valid JSON stream at 8193 bytes before the deadline', async () => {
  const parts = [receiptWire, ' '.repeat(4096), ' '.repeat(8193 - receiptWire.length - 4096)];
  assert.deepEqual(JSON.parse(parts.join('')), {id: 'a', duplicate: false});
  let cancelledAfterTimeout: boolean | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const part = parts.shift();
        if (part !== undefined) controller.enqueue(Buffer.from(part));
      },
      cancel() { cancelledAfterTimeout = signal.aborted; },
    }, {highWaterMark: 0});
    return new Response(body, {status: 201, headers: {'content-type': 'application/json'}});
  };
  await assert.rejects(relayMessage('http://127.0.0.1:8080', message, {fetcher}),
    expectCode(502, 'upstream_failure'));
  assert.equal(cancelledAfterTimeout, false);
});

test('unit: a complete receipt without upstream EOF waits for the deadline and is cancelled', async () => {
  let cancelledAtDeadline: boolean | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    const signal = init?.signal;
    assert.ok(signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(Buffer.from(receiptWire)); },
      cancel() { cancelledAtDeadline = signal.aborted; },
    });
    return new Response(body, {status: 201, headers: {'content-type': 'application/json'}});
  };
  await assert.rejects(relayMessage('http://127.0.0.1:8080', message, {fetcher}),
    expectCode(502, 'upstream_failure'));
  assert.equal(cancelledAtDeadline, true);
});

const ingressEntry = new URL('../ingress.mts', import.meta.url);
const sinkEntry = new URL('../sink.mts', import.meta.url);
const fixtureEntry = new URL('./fixture.mts', import.meta.url);

test('unit: entrypoints import silently with invalid environment settings', async () => {
  const script = [ingressEntry, sinkEntry].map(url => `await import(${JSON.stringify(url.href)})`).join('\n');
  const {stdout, stderr} = await promisify(execFile)(process.execPath, [
    '--v8-pool-size=1', '--input-type=module', '--eval', script,
  ], {
    env: {PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1', SINK_ORIGIN: 'invalid', DB_PATH: ':memory:',
      PORT: '-1', HOST: 'invalid'},
    timeout: 5000,
    killSignal: 'SIGKILL',
  });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

async function get(origin: string, path: string): Promise<Response> {
  return fetch(origin + path, {signal: AbortSignal.timeout(3000)});
}

async function expectHttp(response: Response, status: number, body: unknown): Promise<void> {
  const value: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(value));
  assert.deepEqual(value, body);
}

async function postGzip(origin: string, wire: Buffer): Promise<Response> {
  return fetch(origin + '/messages', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'content-encoding': 'gzip'},
    body: new Uint8Array(wire),
    signal: AbortSignal.timeout(3000),
  });
}

async function readRawResponse(response: IncomingMessage): Promise<{status: number | undefined; body: unknown}> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Expected bytes');
    size += chunk.byteLength;
    if (size > 8192) throw new Error('Unexpectedly large response');
    chunks.push(chunk);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  return {status: response.statusCode, body};
}

async function postOpenBody(
  origin: string, parts: Buffer[], headers: OutgoingHttpHeaders | string[] = {},
): Promise<{status: number | undefined; body: unknown}> {
  const requestBody = request(origin + '/messages', {
    method: 'POST',
    agent: false,
    signal: AbortSignal.timeout(3000),
    headers: Array.isArray(headers) ? headers : {
      'content-type': 'application/json', 'content-encoding': 'gzip',
      ...(headers['content-length'] === undefined ? {'transfer-encoding': 'chunked'} : {}), ...headers,
    },
  });
  try {
    return await new Promise((resolve, reject) => {
      requestBody.once('error', reject);
      requestBody.once('response', (response: IncomingMessage) => {
        void readRawResponse(response).then(resolve, reject);
      });
      // Intentionally keep the request open after sending these chunks.
      for (const part of parts) requestBody.write(part);
    });
  } finally {
    requestBody.destroy();
  }
}

async function withPrivateDb(run: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'lesson83-'));
  try {
    await run(join(directory, 'sink.sqlite'));
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

async function withPair(
  path: string, run: (sink: RunningService, ingress: RunningService) => Promise<void>,
): Promise<void> {
  const sink = await startService(sinkEntry, {DB_PATH: path});
  try {
    const ingress = await startService(ingressEntry, {SINK_ORIGIN: sink.url});
    try {
      await run(sink, ingress);
    } finally {
      await ingress.stop();
    }
  } finally {
    await sink.stop();
  }
}

test('integration: gzip creates one durable receipt per id and a full sink still accepts exact replays', async () => {
  await withPrivateDb(async path => {
    await withPair(path, async (sink, ingress) => {
      const route = ingress.url + '/messages';
      const wire = gzipSync(escapedBoundary);
      await expectHttp(await postGzip(ingress.url, wire), 201, {id: 'a', duplicate: false});
      await expectHttp(await postGzip(ingress.url, wire), 200, {id: 'a', duplicate: true});
      await expectHttp(await jsonRequest(route, {id: 'a', text: 'Different'}), 409, errorBody('id_conflict'));

      const sameId = {id: 'b', text: 'Same'};
      const insertions = await Promise.all([jsonRequest(route, sameId), jsonRequest(route, sameId)]);
      insertions.sort((a, b) => a.status - b.status);
      const [replay, created] = insertions;
      assert.ok(replay && created);
      await expectHttp(replay, 200, {id: 'b', duplicate: true});
      await expectHttp(created, 201, {id: 'b', duplicate: false});

      for (let i = 1; i <= 14; i++) {
        const id = String(i);
        await expectHttp(await jsonRequest(route, {id, text: 'Receipt'}), 201, {id, duplicate: false});
      }
      await expectHttp(await jsonRequest(route, {id: 'overflow', text: 'Receipt'}), 429, errorBody('capacity'));
      await expectHttp(await postGzip(ingress.url, wire), 200, {id: 'a', duplicate: true});
      await expectHttp(await jsonRequest(sink.url + '/messages', {id: 'bad'}), 400, errorBody('invalid_message'));
      await expectHttp(await jsonRequest(sink.url + '/messages?x=1', {id: 'a', text: 'Receipt'}),
        400, errorBody('invalid_request'));
      await expectHttp(await get(sink.url, '/messages/a'), 200, boundaryMessage);
      await expectHttp(await get(sink.url, '/messages/overflow'), 404, errorBody('not_found'));
      await expectHttp(await get(sink.url, '/stats'), 200, {count: 16, requests: 23});
    });

    await withPair(path, async (sink, ingress) => {
      await expectHttp(await get(sink.url, '/stats'), 200, {count: 16, requests: 0});
      await expectHttp(await get(sink.url, '/messages/a'), 200, boundaryMessage);
      await expectHttp(await postGzip(ingress.url, gzipSync(escapedBoundary)), 200, {id: 'a', duplicate: true});
      await expectHttp(await jsonRequest(ingress.url + '/messages', {id: 'new', text: 'Still full'}),
        429, errorBody('capacity'));
      await expectHttp(await get(sink.url, '/stats'), 200, {count: 16, requests: 2});
    });
  });
});

test('integration: rejected compressed or identity bodies leave both sink counters unchanged', async () => {
  await withPrivateDb(path => withPair(path, async (sink, ingress) => {
    await expectHttp(await postGzip(ingress.url, gzipAtSize(escapedBoundary, 1024)), 201, {id: 'a', duplicate: false});
    const valid = gzipSync(escapedBoundary);
    const oversized = gzipSync(escapedBoundary + ' ');
    for (let i = 0; i < 6; i++) {
      await expectHttp(await postGzip(ingress.url, oversized), 413, errorBody('decoded_too_large'));
    }

    for (const wire of [badChecksum(valid), valid.subarray(0, -2), Buffer.concat([valid, Buffer.from([0, 1])])]) {
      await expectHttp(await postGzip(ingress.url, wire), 400, errorBody('invalid_gzip'));
    }
    await expectHttp(await postGzip(ingress.url, gzipSync('{')), 400, errorBody('invalid_json'));
    for (const value of [null, [], true, 3, 'message', {id: 'a', text: 'ok', extra: true},
      {id: 'a', text: {toString: null}}]) {
      await expectHttp(await postGzip(ingress.url, gzipSync(JSON.stringify(value))), 400, errorBody('invalid_message'));
    }

    const route = ingress.url + '/messages';
    await expectHttp(await jsonRequest(route, message, {'content-encoding': 'br'}), 415, errorBody('unsupported_encoding'));
    await expectHttp(await jsonRequest(route, message, {'content-encoding': 'gzip, identity'}),
      415, errorBody('unsupported_encoding'));
    await expectHttp(await jsonRequest(route, message, {'content-type': 'text/plain'}),
      415, errorBody('unsupported_media_type'));
    await expectHttp(await jsonRequest(route + '?extra=1', message), 400, errorBody('invalid_request'));

    const encodedOver = gzipAtSize(escapedBoundary, 1025);
    assert.deepEqual(await postOpenBody(ingress.url, [encodedOver.subarray(0, 900), encodedOver.subarray(900)]),
      {status: 413, body: errorBody('encoded_too_large')});
    const overflowingPrefix = gzipSync(escapedBoundary + ' '.repeat(64)).subarray(0, -8);
    assert.deepEqual(await postOpenBody(ingress.url, [overflowingPrefix]),
      {status: 413, body: errorBody('decoded_too_large')});
    assert.deepEqual(await postOpenBody(ingress.url, [Buffer.from(escapedBoundary), Buffer.from(' ')], {
      'content-encoding': 'identity',
    }), {status: 413, body: errorBody('decoded_too_large')});
    assert.deepEqual(await postOpenBody(ingress.url, [Buffer.from(escapedBoundary + ' ')], {
      'content-encoding': 'identity', 'content-length': '1025',
    }), {status: 413, body: errorBody('encoded_too_large')});
    const duplicateTypeBody = Buffer.from(JSON.stringify(message));
    assert.deepEqual(await postOpenBody(ingress.url, [duplicateTypeBody], [
      'Host', new URL(ingress.url).host,
      'Content-Type', 'application/json', 'Content-Type', 'text/plain',
      'Content-Length', String(duplicateTypeBody.length),
    ]), {status: 415, body: errorBody('unsupported_media_type')});
    const started = performance.now();
    // All gzip bytes arrived, but the HTTP body still has no terminating chunk.
    assert.deepEqual(await postOpenBody(ingress.url, [valid]),
      {status: 408, body: errorBody('body_timeout')});
    assert.ok(performance.now() - started < 1500, 'ingress deadline must close an unfinished body');

    await expectHttp(await get(sink.url, '/stats'), 200, {count: 1, requests: 1});
    await expectHttp(await jsonRequest(route, {id: 'healthy', text: 'Works'}), 201, {id: 'healthy', duplicate: false});
    await expectHttp(await get(sink.url, '/stats'), 200, {count: 2, requests: 2});
  }));
});

async function setMode(fixture: RunningService, mode: string): Promise<void> {
  await expectHttp(await jsonRequest(fixture.url + '/mode', {mode}), 200, {mode});
}

test('integration: upstream failures stay contained and the entire reply shares one deadline', async () => {
  const destination = await startService(fixtureEntry);
  try {
    const fixture = await startService(fixtureEntry, {REDIRECT_TO: destination.url});
    try {
      const ingress = await startService(ingressEntry, {SINK_ORIGIN: fixture.url});
      try {
        const route = ingress.url + '/messages';
        assert.notEqual(fixture.url, destination.url);
        await setMode(fixture, 'redirect');
        await expectHttp(await jsonRequest(route, message), 502, errorBody('upstream_failure'));
        await expectHttp(await get(destination.url, '/hits'), 200, {hits: 0});

        await expectHttp(await jsonRequest(fixture.url + '/mode', {mode: {toString: null}}),
          400, errorBody('invalid_request'));
        for (const mode of ['wrong-conflict', 'wrong-capacity', 'wrong-id', 'compressed',
          'malformed', 'wrong-media', 'ambiguous-media', 'unexpected-status']) {
          await setMode(fixture, mode);
          await expectHttp(await jsonRequest(route, message), 502, errorBody('upstream_failure'));
        }

        await setMode(fixture, 'at-limit');
        await expectHttp(await jsonRequest(route, message), 201, {id: 'a', duplicate: false});

        await setMode(fixture, 'oversize');
        const overflowStarted = performance.now();
        await expectHttp(await jsonRequest(route, message), 502, errorBody('upstream_failure'));
        assert.ok(performance.now() - overflowStarted < 500, 'oversize must be rejected before the upstream deadline');
        await expectHttp(await get(fixture.url, '/stall-closed'), 200, {cancelled: true});

        for (const mode of ['slow-body', 'split-deadline']) {
          await setMode(fixture, mode);
          const started = performance.now();
          await expectHttp(await jsonRequest(route, message), 502, errorBody('upstream_failure'));
          assert.ok(performance.now() - started < 1500, mode + ' must share the upstream deadline');
          await expectHttp(await get(fixture.url, '/stall-closed'), 200, {cancelled: true});
        }

        await setMode(fixture, 'ok');
        await expectHttp(await jsonRequest(route, message), 201, {id: 'a', duplicate: false});
      } finally {
        await ingress.stop();
      }
    } finally {
      await fixture.stop();
    }
  } finally {
    await destination.stop();
  }
});


test('unit: valid identity EOF keeps a stateless guard for an asynchronous destroy error', async () => {
  let destroyed: () => void = () => {};
  const completed = new Promise<void>(resolve => { destroyed = resolve; });
  const source = new Readable({
    read() { this.push(Buffer.from(JSON.stringify(boundaryMessage))); this.push(null); },
    destroy(_error, callback) {
      setImmediate(() => { callback(new Error('late destroy failure')); destroyed(); });
    },
  });
  try {
    assert.deepEqual(await readMessage(source, 'identity'), boundaryMessage);
    await completed;
    await new Promise<void>(resolve => setImmediate(resolve));
    for (const event of ['data', 'end', 'close']) assert.equal(source.listenerCount(event), 0, event);
    assert.equal(source.listenerCount('error'), 1, 'one stateless late-error guard');
    source.emit('error', new Error('another post-destroy error'));
    assert.equal(source.listenerCount('error'), 1, 'the guard is bounded and survives repeated late errors');
  } finally { source.destroy(); }
});

test('unit: emitClose false teardown releases operation listeners without waiting for close', async () => {
  let destroyed: () => void = () => {};
  const completed = new Promise<void>(resolve => { destroyed = resolve; });
  const source = new Readable({
    emitClose: false,
    read() {},
    destroy(_error, callback) { setImmediate(() => { callback(null); destroyed(); }); },
  });
  try {
    let now = 0;
    const rejected = assert.rejects(readMessage(source, 'gzip', {acceptedAt: 0, now: () => now}),
      expectCode(408, 'body_timeout'));
    now = 500;
    source.push(Buffer.from([0x1f, 0x8b]));
    await rejected;
    await completed;
    assert.equal(source.closed, true);
    for (const event of ['data', 'end', 'close']) assert.equal(source.listenerCount(event), 0, event);
    assert.equal(source.listenerCount('error'), 1, 'only the stateless late-error guard remains');
    source.emit('error', new Error('late failure without a close event'));
  } finally { source.destroy(); }
});


test('unit: successful gzip EOF guards late source errors while the decoder finalizes', async () => {
  const source = Readable.from([gzipSync(escapedBoundary)]);
  try {
    const result = readMessage(source, 'gzip');
    let guardsAtClose = -1;
    const closed = new Promise<void>(resolve => source.once('close', () => {
      guardsAtClose = source.listenerCount('error');
      try { source.emit('error', new Error('post-EOF source error during gunzip finalization')); }
      finally { resolve(); }
    }));
    assert.deepEqual(await result, boundaryMessage);
    await closed;
    assert.equal(guardsAtClose, 1, 'input EOF already installed the stateless guard');
    for (const event of ['data', 'end', 'close']) assert.equal(source.listenerCount(event), 0, event);
    assert.equal(source.listenerCount('error'), 1);
  } finally { source.destroy(); }
});
