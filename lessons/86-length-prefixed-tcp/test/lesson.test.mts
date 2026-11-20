import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { duplexPair } from 'node:stream';
import { setImmediate as immediate } from 'node:timers/promises';
import { jsonRequestLength, readJsonRequest } from '../http-body.mts';
import { checkEcho, parseJson, requestText, workerAddress } from '../protocol.mts';
import { exchangeFrame } from '../rpc.mts';
import { encodeFrame, FrameDecoder, SingleFrame } from '../framing.mts';
import { createGateway } from '../gateway.mts';
import { packet } from './socket-fixtures.mts';

test('unit: split header and a coalesced tail yield both frames in order', () => {
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.from([0, 0])), []);
  assert.deepEqual(
    decoder.push(Buffer.from([0, 2, 65, 66, 0, 0, 0, 1, 67])),
    [Buffer.from('AB'), Buffer.from('C')],
  );
});

test('unit: every byte boundary preserves the frame and an empty chunk is inert', () => {
  const frame = Buffer.from([0, 0, 0, 4, 0, 255, 128, 65]);
  for (let split = 0; split <= frame.length; split++) {
    const decoder = new FrameDecoder();
    const first = decoder.push(frame.subarray(0, split));
    assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
    const second = decoder.push(frame.subarray(split));
    decoder.finish();
    assert.deepEqual([...first, ...second], [Buffer.from([0, 255, 128, 65])], `split at ${split}`);
  }
  new FrameDecoder().finish();
});

test('unit: frame length is unsigned big-endian and must be between 1 and 1024', () => {
  const largest = Buffer.alloc(1024, 0x61);
  const expected = Buffer.concat([Buffer.from([0, 0, 4, 0]), largest]);
  assert.deepEqual(encodeFrame(largest), expected);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(expected), [largest]);
  decoder.finish();
  for (const header of [[0, 0, 0, 0], [0, 0, 4, 1], [128, 0, 0, 0], [255, 255, 255, 255]]) {
    const invalid = new FrameDecoder();
    assert.throws(() => invalid.push(Buffer.from(header)), /frame length/);
    assert.throws(() => invalid.push(Buffer.from([0, 0, 0, 1, 65])));
    assert.throws(() => invalid.finish());
  }
  assert.throws(() => encodeFrame(Buffer.alloc(0)), /frame length/);
  assert.throws(() => encodeFrame(Buffer.alloc(1025)), /frame length/);
});

test('unit: EOF rejects a partial header or payload even after a valid frame', () => {
  const frame = Buffer.from([0, 0, 0, 3, 65, 66, 67]);
  for (let size = 1; size < frame.length; size++) {
    const decoder = new FrameDecoder();
    assert.deepEqual(decoder.push(frame), [Buffer.from('ABC')]);
    assert.deepEqual(decoder.push(frame.subarray(0, size)), []);
    assert.throws(() => decoder.finish(), /truncated frame/, `truncated at ${size}`);
    assert.throws(() => decoder.push(frame));
  }
});

test('unit: one RPC rejects an empty stream and a second frame across chunks', () => {
  assert.throws(() => new SingleFrame().finish(), /missing frame/);
  const frame = Buffer.from([0, 0, 0, 1, 65]);
  const valid = new SingleFrame();
  valid.push(frame);
  assert.deepEqual(valid.finish(), Buffer.from('A'));
  const extra = new SingleFrame();
  extra.push(frame);
  assert.throws(() => extra.push(frame), /extra frame/);
  assert.throws(() => extra.finish(), /decoder has ended/);
  const coalesced = new SingleFrame();
  assert.throws(() => coalesced.push(Buffer.concat([frame, frame])), /extra frame/);
  const trailing = new SingleFrame();
  trailing.push(frame);
  trailing.push(Buffer.from([0]));
  assert.throws(() => trailing.finish(), /truncated frame/);
});

test('unit: worker origin permits only a canonical literal IPv4 loopback host and port', () => {
  assert.deepEqual(workerAddress(undefined), {host: '127.0.0.1', port: 3086});
  for (const port of [1, 3086, 65535]) {
    assert.deepEqual(workerAddress(`tcp://127.0.0.1:${port}`), {host: '127.0.0.1', port});
  }
  for (const origin of [
    '', 'tcp://127.0.0.1', 'tcp://127.0.0.1:0', 'tcp://127.0.0.1:0001', 'tcp://127.0.0.1:65536',
    'tcp://127.0.0.1:1/', 'tcp://127.0.0.1:1?', 'tcp://127.0.0.1:1#', 'tcp://user@127.0.0.1:1',
    ' tcp://127.0.0.1:1', 'tcp://127.0.0.1:1\n', 'tcp://127.1:1', 'tcp://2130706433:1',
    'tcp://localhost:1', 'TCP://127.0.0.1:1', 'http://127.0.0.1:1', 'tcp://0.0.0.0:1',
  ]) {
    assert.throws(() => workerAddress(origin), /WORKER_ORIGIN/, JSON.stringify(origin));
  }
});

test('unit: request text requires exact keys and bounded ASCII before any coercion', () => {
  for (const text of [' ', 'AZaz09 19', 'x'.repeat(64)]) assert.equal(requestText({text}), text);
  for (const value of [
    null, false, 12, 'abc', [], {}, {text: '', extra: true}, {text: 'hi', extra: true},
    {text: {toString: null}}, {text: ['abc']}, {text: null}, {text: 12}, {text: ''},
    {text: 'x'.repeat(65)}, {text: 'cà phê'}, {text: 'x\n'}, {text: 'a-b'},
  ]) {
    assert.throws(() => requestText(value), /invalid text request/, JSON.stringify(value));
  }
});

test('unit: echo must carry the expected text in an exact object', () => {
  assert.doesNotThrow(() => checkEcho({echo: 'Hi 42'}, 'Hi 42'));
  for (const value of [null, [], true, 'Hi 42', {echo: 'Hi'}, {echo: 42}, {echo: 'Hi 42', extra: true}]) {
    assert.throws(() => checkEcho(value, 'Hi 42'), /invalid echo response/);
  }
});

test('unit: JSON decoding rejects invalid UTF-8 even inside a quoted string', () => {
  assert.deepEqual(parseJson(Buffer.from('{"text":"abc"}')), {text: 'abc'});
  assert.throws(() => parseJson(Buffer.from([0x22, 0xc3, 0x28, 0x22])));
  assert.throws(() => parseJson(Buffer.from('{"text":"abc"')));
});

test('unit: HTTP request representation accepts only JSON with an optional single UTF-8 charset', () => {
  assert.equal(jsonRequestLength(['Content-Type', 'application/json']), undefined);
  assert.equal(jsonRequestLength([
    'content-TYPE', ' Application/JSON \t;\tCHARSET="Utf-8"\t',
    'Content-Encoding', ' IDENTITY ', 'Content-Length', '8192',
  ]), 8192);
  assert.equal(jsonRequestLength(['Content-Type', 'application/json', 'Transfer-Encoding', 'chunked']), undefined);
  for (const mime of [
    'text/plain', 'application/json, application/json', 'application/json;', 'application/json; charset=',
    'application/json; charset=latin1', 'application/json; foo=bar', 'application/json; charset="utf-8',
    'application/json; charset=utf-8; charset=utf-8', 'application/json; charset="utf-8"; x=1',
    'application/json; charset="utf-8,utf-8"', 'application/json; charset=utf-8 trailing',
  ]) {
    assert.throws(() => jsonRequestLength(['Content-Type', mime]), {status: 415, code: 'unsupported_media_type'}, mime);
  }
});

test('unit: raw field occurrences reject duplicate media, coding and ambiguous HTTP framing', () => {
  const json = ['Content-Type', 'application/json'];
  for (const headers of [
    [], [...json, 'CONTENT-TYPE', 'application/json'],
    [...json, 'Content-Encoding', 'identity', 'content-encoding', 'identity'],
    [...json, 'Content-Encoding', 'identity, identity'], [...json, 'Content-Encoding', 'gzip'],
  ]) {
    assert.throws(() => jsonRequestLength(headers), {status: 415, code: 'unsupported_media_type'});
  }
  for (const fields of [
    ['Content-Length', '2', 'Content-Length', '2'],
    ['Content-Length', '2', 'Transfer-Encoding', 'chunked'],
    ['Transfer-Encoding', 'gzip, chunked'], ['Content-Length', '2, 2'],
  ]) {
    assert.throws(() => jsonRequestLength([...json, ...fields]), {status: 400, code: 'invalid_body'});
  }
});

test('unit: exchange accepts a full frame only at readable EOF', async (t) => {
  const [socket, peer] = duplexPair();
  t.after(() => { socket.destroy(); peer.destroy(); });
  let accepted: string | undefined;
  const bytes: Buffer[] = [];
  peer.on('data', (chunk: Buffer) => bytes.push(chunk));
  const result = exchangeFrame(socket, 0, (payload) => {
    accepted = payload.toString();
    return Buffer.from([0, 0, 0, 1, 66]);
  }, {now: () => 0});
  peer.write(Buffer.from([0, 0, 0, 1, 65]));
  await immediate();
  assert.equal(accepted, undefined);
  peer.end();
  await result;
  assert.equal(accepted, 'A');
  assert.deepEqual(Buffer.concat(bytes), Buffer.from([0, 0, 0, 1, 66]));
});

test('unit: a matching echo reaches validation only within the 1024-byte frame limit', async (t) => {
  for (const size of [1024, 1025]) {
    const [socket, peer] = duplexPair();
    t.after(() => { socket.destroy(); peer.destroy(); });
    peer.resume();
    const result = exchangeFrame(socket, 0, (payload) => checkEcho(parseJson(payload), 'Hello 86'), {
      send: packet('{"text":"Hello 86"}'), now: () => 0,
    });
    const checked = size === 1024 ? result : assert.rejects(result, /invalid frame length/);
    peer.end(packet('{"echo":"Hello 86"}'.padEnd(size, ' ')));
    await checked;
  }
});

test('unit: a missing FIN destroys the exchange at 500ms from dial initiation', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const [socket, peer] = duplexPair();
  t.after(() => { socket.destroy(); peer.destroy(); });
  peer.resume();
  let time = 140;
  const result = exchangeFrame(socket, 100, () => assert.fail('accepted without FIN'), {
    send: packet('{"text":"Hello 86"}'), now: () => time,
  });
  const rejected = assert.rejects(result, /RPC deadline/);
  void rejected.catch(() => {});
  peer.write(packet('{"echo":"Hello 86"}'));
  await immediate();
  time = 599;
  t.mock.timers.tick(459);
  assert.equal(socket.destroyed, false, 'still open at 499ms');
  time = 600;
  t.mock.timers.tick(1);
  assert.equal(socket.destroyed, true, 'destroyed at 500ms without a peer FIN');
  await rejected;
});

test('unit: readable EOF exactly at the deadline fails even before the timer runs', async (t) => {
  const [socket, peer] = duplexPair();
  t.after(() => { socket.destroy(); peer.destroy(); });
  let time = 100;
  const result = exchangeFrame(socket, 100, () => assert.fail('accepted expired frame'), {now: () => time});
  const rejected = assert.rejects(result, /RPC deadline/);
  peer.write(Buffer.from([0, 0, 0, 1, 65]));
  await immediate();
  time = 600;
  peer.end();
  await rejected;
  assert.equal(socket.destroyed, true);
});

test('unit: a reply cannot start after validation uses the remaining deadline', async (t) => {
  const [socket, peer] = duplexPair();
  t.after(() => { socket.destroy(); peer.destroy(); });
  let time = 100;
  const bytes: Buffer[] = [];
  peer.on('data', (chunk: Buffer) => bytes.push(chunk));
  const result = exchangeFrame(socket, 100, () => {
    time = 600;
    return Buffer.from([0, 0, 0, 1, 66]);
  }, {now: () => time});
  const rejected = assert.rejects(result, /RPC deadline/);
  peer.end(Buffer.from([0, 0, 0, 1, 65]));
  await Promise.all([rejected, immediate().then(() => assert.equal(socket.destroyed, true))]);
  assert.deepEqual(bytes, []);
});

test('unit: a transport close or error cannot substitute for readable EOF', async (t) => {
  const [socket, peer] = duplexPair();
  t.after(() => { socket.destroy(); peer.destroy(); });
  const result = exchangeFrame(socket, 0, () => assert.fail('accepted without EOF'), {now: () => 0});
  const rejected = assert.rejects(result, /connection closed/);
  socket.destroy();
  await rejected;

  const [broken, other] = duplexPair();
  t.after(() => { broken.destroy(); other.destroy(); });
  const failed = exchangeFrame(broken, 0, () => assert.fail('accepted after error'), {now: () => 0});
  const reset = assert.rejects(failed, /peer reset/);
  broken.destroy(new Error('peer reset'));
  await reset;
});

test('unit: cancelling an RPC destroys its stream before release', async (t) => {
  const [socket, peer] = duplexPair();
  t.after(() => { socket.destroy(); peer.destroy(); });
  const controller = new AbortController();
  const result = exchangeFrame(socket, 0, () => assert.fail('accepted after cancellation'), {
    now: () => 0, signal: controller.signal,
  });
  const rejected = assert.rejects(result, /RPC cancelled/);
  controller.abort();
  await rejected;
  assert.equal(socket.destroyed, true);
});

function incomingJson(t: TestContext) {
  const socket = new Socket();
  t.after(() => { socket.destroy(); });
  const req = new IncomingMessage(socket);
  t.after(() => { req.destroy(); });
  req.rawHeaders = ['Content-Type', 'application/json'];
  return req;
}

test('unit: an extension Expect request reaches the same method validation as an ordinary request', (t) => {
  const server = createGateway(undefined);
  const req = incomingJson(t);
  req.method = 'GET';
  req.url = '/echo';
  req.headers.expect = 'extension';
  const res = new ServerResponse(req);
  t.after(() => { res.destroy(); });

  server.emit('checkExpectation', req, res);
  assert.deepEqual(
    {status: res.statusCode, allow: res.getHeader('allow'), ended: res.writableEnded},
    {status: 405, allow: 'POST', ended: true},
  );
});

test('unit: HTTP JSON is bounded by body bytes before parsing', async (t) => {
  const compact = '{"text":"Hello 86"}';
  for (const size of [8192, 8193]) {
    const req = incomingJson(t);
    const result = readJsonRequest(req, 0, () => 0);
    const checked = size === 8192
      ? result.then((value) => assert.deepEqual(value, {text: 'Hello 86'}))
      : assert.rejects(result, {status: 413, code: 'body_too_large'});
    req.push(Buffer.from(compact.padEnd(size, ' ')));
    req.complete = true;
    req.push(null);
    await checked;
  }
});

test('unit: HTTP EOF at 500ms fails even when all JSON bytes have arrived', async (t) => {
  const req = incomingJson(t);
  let time = 100;
  const result = readJsonRequest(req, 100, () => time);
  const rejected = assert.rejects(result, {status: 408, code: 'body_timeout'});
  req.push(Buffer.from('{"text":"abc"}'));
  await immediate();
  time = 600;
  req.complete = true;
  req.push(null);
  await rejected;
});

test('unit: HTTP media trailers cannot override the original representation', async (t) => {
  const req = incomingJson(t);
  const result = readJsonRequest(req, 0, () => 0);
  const rejected = assert.rejects(result, {status: 415, code: 'unsupported_media_type'});
  req.push(Buffer.from('{"text":"abc"}'));
  req.rawTrailers = ['Content-Encoding', 'gzip'];
  req.complete = true;
  req.push(null);
  await rejected;
});

test('unit: both entrypoints import silently even with invalid runtime configuration', async () => {
  const moduleUrls = ['worker', 'gateway'].map((name) => new URL(`../${name}.mts`, import.meta.url).href);
  const program = moduleUrls.map((url) => `await import(${JSON.stringify(url)});`).join('');
  const result = await promisify(execFile)(
    process.execPath, ['--v8-pool-size=1', '--input-type=module', '--eval', program], {
      env: {PATH: process.env.PATH ?? '', PORT: 'bad', HOST: 'bad', WORKER_ORIGIN: 'bad'},
      timeout: 2500,
    },
  );
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
