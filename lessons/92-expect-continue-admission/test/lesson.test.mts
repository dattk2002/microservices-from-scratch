import assert from 'node:assert/strict';
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {finalReply, jsonFrame, rawExchange, runUploader, startPeer, startReceiver, stats, uploadHeaders, waitStats} from "./support.mts";
import {test} from 'node:test';
import {admit, createSlot, createUploadState, validateResult} from '../core.mts';

const headers = ['Content-Type', 'application/octet-stream', 'Content-Length', '5'];
const helloDigest = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

test('unit: admission recognizes an optional case-insensitive expectation', () => {
  assert.deepEqual(admit('POST', '/upload', headers), {kind: 'upload', length: 5, expect: false});
  assert.deepEqual(admit('POST', '/upload', [...headers, 'Expect', '100-Continue']),
    {kind: 'upload', length: 5, expect: true});
});

test('unit: admission rejects ambiguous framing and unsupported representations', () => {
  const cases: [string[], string][] = [
    [headers.slice(0, 2), 'length_required'],
    [[...headers.slice(0, 2), 'Content-Length', '05'], 'invalid_headers'],
    [[...headers.slice(0, 2), 'Content-Length', '0'], 'invalid_headers'],
    [[...headers.slice(0, 2), 'Content-Length', '8193'], 'body_too_large'],
    [[...headers, 'content-length', '5'], 'invalid_headers'],
    [[...headers, 'Transfer-Encoding', 'chunked'], 'invalid_headers'],
    [[...headers, 'Content-Encoding', 'identity'], 'invalid_headers'],
    [['Content-Type', 'application/octet-stream; junk', ...headers.slice(2)], 'unsupported_media_type'],
    [[...headers, 'Expect', 'other'], 'expectation_failed'],
    [[...headers, 'Expect', '100-continue', 'expect', '100-continue'], 'invalid_headers'],
  ];
  for (const [raw, code] of cases) assert.deepEqual(admit('POST', '/upload', raw), {kind: 'error', code});
});

test('unit: route checks cover query, method and bodies on stats', () => {
  assert.deepEqual(admit('POST', '/upload?', headers), {kind: 'error', code: 'invalid_headers'});
  assert.deepEqual(admit('GET', '/upload', []), {kind: 'error', code: 'method_not_allowed', allow: 'POST'});
  assert.deepEqual(admit('GET', '/stats', ['Content-Length', '1']), {kind: 'error', code: 'invalid_headers'});
  assert.deepEqual(admit('GET', '/elsewhere', []), {kind: 'error', code: 'not_found'});
});

test('unit: stale release cannot clear another reservation', () => {
  const slot = createSlot();
  const first = slot.reserve();
  assert.ok(first);
  assert.equal(slot.reserve(), undefined);
  first.consume(2);
  first.release();
  const second = slot.reserve();
  assert.ok(second);
  first.release();
  first.consume(100);
  assert.deepEqual(slot.stats(), {accepted: 2, completed: 0, bytes: 2, active: 1});
  second.consume(5);
  second.complete();
  second.complete();
  second.release();
  assert.deepEqual(slot.stats(), {accepted: 2, completed: 1, bytes: 7, active: 0});
});

test('unit: only the first 100 permits a body send', () => {
  const state = createUploadState();
  assert.equal(state.sent(), false);
  assert.equal(state.information(100), true);
  assert.equal(state.sent(), true);
  assert.equal(state.information(100), false);
  const rejected = createUploadState();
  rejected.final();
  assert.equal(rejected.information(100), false);
  const unexpected = createUploadState();
  assert.equal(unexpected.information(103), false);
  assert.equal(unexpected.sent(), false);
});

test('unit: final success pins exact keys, bytes, digest and prior send', () => {
  const valid = {bytes: 5, sha256: helloDigest};
  assert.deepEqual(validateResult(201, valid, 5, helloDigest, true), {ok: true, ...valid});
  for (const body of [null, [valid], {...valid, extra: 1}, {...valid, bytes: '5'},
    {...valid, bytes: 4}, {...valid, sha256: '0'.repeat(64)}, {...valid, sha256: helloDigest.toUpperCase()}]) {
    assert.equal(validateResult(201, body, 5, helloDigest, true), undefined);
  }
  assert.equal(validateResult(201, valid, 5, helloDigest, false), undefined);
});

test('unit: a business rejection requires a matching status, code and message', () => {
  const valid = {error: {code: 'body_too_large', message: 'body_too_large'}};
  assert.deepEqual(validateResult(413, valid, 5, helloDigest, false), {ok: false, status: 413, ...valid});
  for (const body of [true, [], {...valid, extra: 1}, {error: {...valid.error, extra: 1}},
    {error: {code: 'internal_error', message: 'internal_error'}}, {error: {...valid.error, message: 'other'}}]) {
    assert.equal(validateResult(413, body, 5, helloDigest, false), undefined);
  }
  assert.equal(validateResult(503, valid, 5, helloDigest, false), undefined);
});

const continuation = 'HTTP/1.1 100 Continue\r\n\r\n';
const successJson = JSON.stringify({bytes: 5, sha256: helloDigest});
const chunkedSuccessHeaders = 'HTTP/1.1 201 Created\r\nContent-Type: application/json; charset=utf-8\r\n'
  + 'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n';
const chunkedEnd = '0\r\n\r\n';

function chunkFrame(body: string) {
  return `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`;
}

test('integration: CLI uploads to an independent receiver and raw peers see exactly one 100', async t => {
  const port = await startReceiver(t);
  assert.deepEqual(await runUploader(port), {code: 0, body: {ok: true, bytes: 5, sha256: helloDigest}});
  const response = await rawExchange(t, port, uploadHeaders(5, '100-Continue'), socket => socket.write('hello')).closed;
  assert.equal(response.continues, 1);
  assert.deepEqual(finalReply(response.wire).body, {bytes: 5, sha256: helloDigest});
  assert.deepEqual(await stats(t, port), {accepted: 2, completed: 2, bytes: 10, active: 0});
});

test('integration: header rejections and busy are final before any 100 or cooperative payload', async t => {
  const port = await startReceiver(t);
  let payloadSent = 0;
  const send = (socket: import('node:net').Socket) => { payloadSent += 5; socket.write('hello'); };
  async function rejected(raw: string, status: number, code: string) {
    const response = await rawExchange(t, port, raw, send).closed;
    assert.equal(response.continues, 0);
    const result = finalReply(response.wire);
    assert.equal(result.status, status);
    assert.match(result.headers, /\r\nconnection: close\r?$/m);
    assert.deepEqual(result.body, {error: {code, message: code}});
  }

  await rejected(uploadHeaders(8193), 413, 'body_too_large');
  await rejected(uploadHeaders(5, 'unknown'), 417, 'expectation_failed');
  assert.deepEqual(await stats(t, port), {accepted: 0, completed: 0, bytes: 0, active: 0});
  const held = rawExchange(t, port, uploadHeaders(5));
  try {
    await held.waitContinue();
    await rejected(uploadHeaders(5), 503, 'busy');
    assert.equal(payloadSent, 0);
  } finally {
    held.socket.destroy();
  }
});

test('integration: truncated upload and absolute timeout release the slot', async t => {
  const port = await startReceiver(t);
  const aborted = rawExchange(t, port, uploadHeaders(5), socket => socket.write('he'));
  try {
    assert.deepEqual(await waitStats(t, port, value => value.bytes === 2),
      {accepted: 1, completed: 0, bytes: 2, active: 1});
  } finally {
    aborted.socket.destroy();
  }
  assert.deepEqual(await waitStats(t, port, value => value.active === 0),
    {accepted: 1, completed: 0, bytes: 2, active: 0});

  const stalled = await rawExchange(t, port, uploadHeaders(5), socket => socket.write('h')).closed;
  assert.equal(stalled.continues, 1);
  const timeout = finalReply(stalled.wire);
  assert.equal(timeout.status, 408);
  assert.deepEqual(timeout.body, {error: {code: 'body_timeout', message: 'body_timeout'}});
  assert.deepEqual(await stats(t, port), {accepted: 2, completed: 0, bytes: 3, active: 0});

  const payload = Buffer.alloc(8192, 0xa5);
  const noExpect = await rawExchange(t, port, uploadHeaders(payload.length, '') + payload.toString('latin1')).closed;
  assert.equal(noExpect.continues, 0);
  assert.equal(finalReply(noExpect.wire).status, 201);
  assert.deepEqual(finalReply(noExpect.wire).body, {
    bytes: 8192, sha256: createHash('sha256').update(payload).digest('hex'),
  });
  assert.deepEqual(await stats(t, port), {accepted: 3, completed: 1, bytes: 8195, active: 0});
});

test('integration: uploader sends zero bytes on silence, rejection or redirect', async t => {
  const peer = await startPeer(t);
  const destination = await startPeer(t);
  assert.notEqual(peer.port, destination.port);

  const rejectBody = {error: {code: 'body_too_large', message: 'body_too_large'}};
  const cases = [
    [{}, {ok: false, local: 'timeout'}],
    [{initial: jsonFrame(413, JSON.stringify(rejectBody))}, {ok: false, status: 413, ...rejectBody}],
    [{initial: jsonFrame(307, '{}', `Location: http://127.0.0.1:${destination.port}/upload\r\n`)},
      {ok: false, local: 'upstream_failure'}],
    [{initial: jsonFrame(421, '{}')}, {ok: false, local: 'upstream_failure'}],
    [{initial: jsonFrame(413, '{"error":{"code":"internal_error","message":"internal_error"}}')},
      {ok: false, local: 'upstream_failure'}],
    [{initial: 'HTTP/1.1 103 Early Hints\r\n\r\n'}, {ok: false, local: 'upstream_failure'}],
  ] as const;
  let attempts = 0;
  for (const [mode, expected] of cases) {
    peer.mode(mode);
    assert.deepEqual(await runUploader(peer.port), {code: 1, body: expected});
    await peer.closed();
    attempts++;
    assert.deepEqual(peer.counts(), {requests: attempts, connections: attempts, payloadBytes: 0});
    assert.deepEqual(destination.counts(), {requests: 0, connections: 0, payloadBytes: 0});
  }
});

test('integration: incoming upload progress cannot extend the receiver deadline', async t => {
  const port = await startReceiver(t);
  const payload = 'abcdefgh';
  const response = await rawExchange(t, port, uploadHeaders(payload.length), socket => {
    let sent = 1;
    socket.write(payload.slice(0, sent));
    const timer = setInterval(() => {
      socket.write(payload.slice(sent, sent + 1));
      sent++;
      if (sent === payload.length) clearInterval(timer);
    }, 100);
    socket.once('close', () => clearInterval(timer));
  }).closed;

  assert.equal(response.continues, 1);
  const reply = finalReply(response.wire);
  assert.equal(reply.status, 408);
  assert.deepEqual(reply.body, {error: {code: 'body_timeout', message: 'body_timeout'}});
  assert.doesNotMatch(response.wire, /HTTP\/1\.1 201 /);
  const after = await stats(t, port);
  assert.equal(after.accepted, 1);
  assert.equal(after.active, 0);
  assert.equal(after.completed, 0);
  assert.ok(typeof after.bytes === 'number' && after.bytes > 1 && after.bytes < payload.length);
});

test('integration: uploader bounds decoded chunked JSON at 8192 bytes', async t => {
  const peer = await startPeer(t);
  const cases = [
    {size: 8192, result: {code: 0, body: {ok: true, bytes: 5, sha256: helloDigest}}},
    {size: 8193, result: {code: 1, body: {ok: false, local: 'upstream_failure'}}},
  ];
  let attempts = 0;
  for (const {size, result} of cases) {
    const whitespace = ' '.repeat(size - Buffer.byteLength(successJson));
    peer.mode({initial: continuation, afterBody:
      chunkedSuccessHeaders + chunkFrame(successJson) + chunkFrame(whitespace) + chunkedEnd});
    assert.deepEqual(await runUploader(peer.port), result);
    await peer.closed();
    attempts++;
    assert.deepEqual(peer.counts(), {requests: attempts, connections: attempts, payloadBytes: 5 * attempts});
  }
});

test('integration: uploader closes before delayed chunked EOF despite response progress', async t => {
  const peer = await startPeer(t);
  let eofSent = false;
  peer.mode({
    initial: continuation,
    afterBody(socket) {
      // Keep an idle timer alive beyond the total budget, with no data event at the deadline.
      const timers: NodeJS.Timeout[] = [];
      socket.once('close', () => {
        for (const timer of timers) clearTimeout(timer);
      });
      socket.write(chunkedSuccessHeaders + chunkFrame(successJson));
      for (const delay of [100, 200, 300]) {
        timers.push(setTimeout(() => socket.write(chunkFrame(' ')), delay));
      }
      timers.push(setTimeout(() => {
        eofSent = true;
        socket.end(chunkedEnd);
      }, 700));
    },
  });

  assert.deepEqual(await runUploader(peer.port), {code: 1, body: {ok: false, local: 'timeout'}});
  await peer.closed();
  assert.equal(eofSent, false);
  assert.deepEqual(peer.counts(), {requests: 1, connections: 1, payloadBytes: 5});
});

test('integration: uploader validates the complete 201 and sends the body once', async t => {
  const peer = await startPeer(t);
  peer.mode({initial: continuation, afterBody: jsonFrame(201, successJson)});
  assert.deepEqual(await runUploader(peer.port), {code: 0, body: {ok: true, bytes: 5, sha256: helloDigest}});
  await peer.closed();

  const invalidFrames = [
    jsonFrame(201, JSON.stringify({bytes: 5, sha256: '0'.repeat(64)})),
    jsonFrame(201, '{invalid'),
    jsonFrame(201, successJson, 'Content-Type: application/json\r\n'),
    jsonFrame(201, successJson, 'Content-Encoding: gzip\r\n'),
    continuation + jsonFrame(201, successJson),
  ];
  let attempts = 1;
  for (const afterBody of invalidFrames) {
    peer.mode({initial: continuation, afterBody});
    assert.deepEqual(await runUploader(peer.port), {code: 1, body: {ok: false, local: 'upstream_failure'}});
    await peer.closed();
    attempts++;
    assert.deepEqual(peer.counts(), {requests: attempts, connections: attempts, payloadBytes: 5 * attempts});
  }
});

test('unit: importing both entrypoints produces no CLI output and exits on its own', async () => {
  const receiverUrl = new URL('../receiver.mts', import.meta.url).href;
  const uploaderUrl = new URL('../uploader.mts', import.meta.url).href;
  await new Promise<void>((resolve, reject) => {
    const code = `await import(${JSON.stringify(receiverUrl)}); await import(${JSON.stringify(uploaderUrl)});`;
    execFile(process.execPath, ['--v8-pool-size=1', '--input-type=module', '-e', code],
      {timeout: 3000, killSignal: 'SIGKILL', maxBuffer: 8192}, (error, stdout, stderr) => {
        if (error) return reject(error);
        try {
          assert.equal(stdout, '');
          assert.equal(stderr, '');
          resolve();
        } catch (failure) {
          reject(failure);
        }
      });
  });
});


test('unit: multiple Host fields take precedence over all endpoint routing', () => {
  const raw = ['Host', 'first.invalid', 'Host', 'second.invalid'];
  for (const [method, path] of [['GET', '/health'], ['GET', '/elsewhere'], ['GET', '/upload']]) {
    assert.deepEqual(admit(method, path, raw), {kind: 'error', code: 'invalid_headers'});
  }
});
