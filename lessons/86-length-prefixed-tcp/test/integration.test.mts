import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { setImmediate as immediate, setTimeout as delay } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import { callHttp, openRaw, packet, portOf, startPeer } from './socket-fixtures.mts';

const workerEntry = new URL('../worker.mts', import.meta.url);
const gatewayEntry = new URL('../gateway.mts', import.meta.url);
const requestJson = '{"text":"Hello 86"}';
const requestFrame = packet(requestJson);
const replyJson = '{"echo":"Hello 86"}';
const replyFrame = packet(replyJson);
const envelope = (code: string) => ({error: {code, message: code}});

test('integration: the worker reads bytewise writes through FIN and flushes its reply', async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  const client = openRaw(t, portOf(worker.url));
  assert.equal(await client.opened, true);
  for (const byte of requestFrame) {
    client.socket.write(Buffer.from([byte]));
    await immediate();
  }
  assert.deepEqual(client.chunks, []);
  client.socket.end();
  const result = await client.closed;
  assert.equal(result.timedOut, false);
  assert.equal(result.error, undefined);
  assert.equal(result.ended, true);
  assert.deepEqual(result.bytes, replyFrame);
});

test('integration: the worker closes malformed or non-singleton requests without replying', async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  for (const [name, wire] of [
    ['empty', Buffer.alloc(0)],
    ['zero', Buffer.from([0, 0, 0, 0])],
    ['oversized declaration', Buffer.from([0, 0, 4, 1])],
    ['oversized valid JSON', packet(requestJson.padEnd(1025, ' '))],
    ['unsigned high bit', Buffer.from([128, 0, 0, 0])],
    ['short payload', requestFrame.subarray(0, -1)],
    ['extra frame', Buffer.concat([requestFrame, requestFrame])],
    ['broken trailing prefix', Buffer.concat([requestFrame, Buffer.from([0, 0])])],
    ['invalid JSON', packet('{')],
    ['invalid UTF-8', packet(Buffer.from([0x22, 0xff, 0x22]))],
    ['extra field', packet('{"text":"Hello 86","other":true}')],
    ['non-coercible text', packet('{"text":{"toString":null}}')],
  ] satisfies Array<[string, Buffer]>) {
    const client = openRaw(t, portOf(worker.url));
    assert.equal(await client.opened, true, name);
    client.socket.end(wire);
    const result = await client.closed;
    assert.equal(result.timedOut, false, name);
    assert.equal(result.bytes.length, 0, name);
  }
});

test('integration: the worker expires idle and unfinished requests, sheds excess sockets and admits again', async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  const port = portOf(worker.url);
  const held = Array.from({length: 8}, () => openRaw(t, port));
  assert.deepEqual(await Promise.all(held.map((client) => client.opened)), Array(8).fill(true));
  assert.ok(held[0]);
  held[0].socket.write(requestFrame); // A valid frame without FIN must still expire.

  const excess = openRaw(t, port);
  assert.equal(await excess.opened, true);
  excess.socket.end(requestFrame);
  const rejected = await excess.closed;
  assert.equal(rejected.timedOut, false);
  assert.equal(rejected.bytes.length, 0);

  // Exercise abrupt disconnect as well as the no-first-byte deadline.
  assert.ok(held[1]);
  held[1].socket.resetAndDestroy();
  for (const result of await Promise.all(held.map((client) => client.closed))) {
    assert.equal(result.timedOut, false);
    assert.equal(result.bytes.length, 0);
  }

  const next = openRaw(t, port);
  assert.equal(await next.opened, true);
  next.socket.end(requestFrame);
  assert.deepEqual((await next.closed).bytes, replyFrame);
});

test('integration: HTTP route and JSON contract with a separate TCP worker', async (t) => {
  const worker = await startService(workerEntry);
  t.after(worker.stop);
  const gateway = await startService(gatewayEntry, {WORKER_ORIGIN: `tcp://127.0.0.1:${portOf(worker.url)}`});
  t.after(gateway.stop);

  const {url} = gateway;
  const ok = await callHttp(t, url, {
    headers: {'content-type': 'Application/JSON ; CHARSET="UTF-8"', 'content-encoding': 'Identity'},
    body: requestJson.padEnd(8192, ' '),
  }).response;
  assert.deepEqual(ok, {status: 200, allow: undefined, body: {echo: 'Hello 86'}});

  for (const [input, status, code] of [
    [{path: '/missing'}, 404, 'not_found'],
    [{method: 'GET', body: ''}, 405, 'method_not_allowed'],
    [{method: 'GET', headers: {expect: 'extension'}, body: ''}, 405, 'method_not_allowed'],
    [{path: '/echo?text=x'}, 400, 'invalid_query'],
    [{path: '/echo?'}, 400, 'invalid_query'],
    [{headers: {}}, 415, 'unsupported_media_type'],
    [{headers: {'content-type': 'application/json; charset=utf-8; charset=utf-8'}}, 415, 'unsupported_media_type'],
    [{headers: {'content-type': 'application/json', 'content-encoding': 'gzip'}}, 415, 'unsupported_media_type'],
    [{body: '{'}, 400, 'invalid_json'],
    [{body: Buffer.from([0x22, 0xff, 0x22])}, 400, 'invalid_json'],
    [{body: '{"text":{"toString":null}}'}, 400, 'invalid_body'],
    [{body: '{"text":"Hello 86","more":true}'}, 400, 'invalid_body'],
    [{body: '["Hello 86"]'}, 400, 'invalid_body'],
    [{body: 'null'}, 400, 'invalid_body'],
    [{body: requestJson.padEnd(8193, ' ')}, 413, 'body_too_large'],
    [{headers: {'content-type': 'application/json', 'transfer-encoding': 'chunked'},
      body: requestJson.padEnd(8193, ' ')}, 413, 'body_too_large'],
  ] satisfies Array<[Parameters<typeof callHttp>[2], number, string]>) {
    const result = await callHttp(t, url, input).response;
    assert.deepEqual(result, {
      status, allow: status === 405 ? 'POST' : undefined, body: envelope(code),
    }, JSON.stringify(input));
  }
});

function checkRawHttp(wire: Buffer, status: number, code: string) {
  const raw = wire.toString('utf8');
  const separator = raw.indexOf('\r\n\r\n');
  assert.notEqual(separator, -1);
  const headers = raw.slice(0, separator);
  assert.equal(headers.split(' ')[1], String(status));
  // Connection-close errors use a single small JSON response, with chunked encoding permitted.
  const body = raw.slice(separator + 4);
  if (/^transfer-encoding: chunked\r?$/im.test(headers)) {
    const firstLine = body.indexOf('\r\n');
    assert.ok(firstLine > 0);
    const length = Number.parseInt(body.slice(0, firstLine), 16);
    const json = body.slice(firstLine + 2, firstLine + 2 + length);
    assert.deepEqual(JSON.parse(json), envelope(code));
  } else {
    assert.deepEqual(JSON.parse(body), envelope(code));
  }
}

test('integration: the gateway rejects late duplicate raw fields and bounds an incomplete HTTP body', async (t) => {
  const peer = await startPeer(t, (socket) => socket.end(replyFrame));
  const gateway = await startService(gatewayEntry, {WORKER_ORIGIN: peer.origin});
  t.after(gateway.stop);
  const port = portOf(gateway.url);

  // Each short field consumes four bytes, so the relevant duplicate follows the
  // default HTTP field-count limit while the complete header still fits 8192 bytes.
  const first = 'POST /echo HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\n';
  const length = `Content-Length: ${Buffer.byteLength(requestJson)}\r\n`;
  for (const [earlier, late] of [
    ['', 'Content-Type: application/json\r\n'],
    ['Content-Encoding: identity\r\n', 'Content-Encoding: identity\r\n'],
  ]) {
    const header = first + length + earlier + 'X:\r\n'.repeat(2000) + late + '\r\n';
    assert.ok(Buffer.byteLength(header) < 8192);
    const client = openRaw(t, port);
    client.socket.write(header + requestJson);
    const result = await client.closed;
    assert.equal(result.timedOut, false);
    checkRawHttp(result.bytes, 415, 'unsupported_media_type');
  }

  const stalled = openRaw(t, port);
  stalled.socket.write(first + length + '\r\n{');
  const result = await stalled.closed;
  assert.equal(result.timedOut, false);
  checkRawHttp(result.bytes, 408, 'body_timeout');
  assert.equal(peer.attempts.length, 0);
});

test('integration: the gateway requires exactly one matching reply through FIN and makes one attempt', async (t) => {
  const peer = await startPeer(t, (socket) => {
    socket.write(replyFrame.subarray(0, 2));
    void immediate().then(() => {
      if (socket.destroyed) return;
      socket.write(replyFrame.subarray(2, 9));
      return immediate().then(() => {
        if (!socket.destroyed) socket.end(replyFrame.subarray(9));
      });
    });
  });
  const gateway = await startService(gatewayEntry, {WORKER_ORIGIN: peer.origin});
  t.after(gateway.stop);
  const success = await callHttp(t, gateway.url).response;
  assert.deepEqual(success, {status: 200, allow: undefined, body: {echo: 'Hello 86'}});
  assert.equal(peer.attempts.length, 1);
  assert.deepEqual(peer.attempts[0]?.wire, requestFrame);

  peer.setReply((socket) => socket.end(packet(replyJson.padEnd(1024, ' '))));
  assert.deepEqual(await callHttp(t, gateway.url).response, {
    status: 200, allow: undefined, body: {echo: 'Hello 86'},
  });
  assert.equal(peer.attempts.length, 2);
  assert.deepEqual(peer.attempts[1]?.wire, requestFrame);

  const invalid = [
    ['mismatch', packet('{"echo":"Hello 87"}')],
    ['wrong fields', packet('{"echo":"Hello 86","extra":1}')],
    ['wrong type', packet('{"echo":{"toString":null}}')],
    ['wrong root', packet('["Hello 86"]')],
    ['bad UTF-8', packet(Buffer.from([0x22, 0xff, 0x22]))],
    ['bad JSON', packet('{')],
    ['missing', Buffer.alloc(0)],
    ['zero', Buffer.from([0, 0, 0, 0])],
    ['oversized declaration', Buffer.from([0, 0, 4, 1])],
    ['oversized complete matching echo', packet(replyJson.padEnd(1025, ' '))],
    ['truncated', replyFrame.subarray(0, -1)],
    ['extra frame', Buffer.concat([replyFrame, replyFrame])],
    ['broken trailing prefix', Buffer.concat([replyFrame, Buffer.from([0, 0, 0])])],
  ] satisfies Array<[string, Buffer]>;
  for (const [name, wire] of invalid) {
    const before: number = peer.attempts.length;
    peer.setReply((socket) => socket.end(wire));
    const result = await callHttp(t, gateway.url).response;
    assert.deepEqual(result, {status: 502, allow: undefined, body: envelope('upstream_failure')}, name);
    assert.equal(peer.attempts.length, before + 1, name);
    assert.deepEqual(peer.attempts[before]?.wire, requestFrame, name);
  }

  const before: number = peer.attempts.length;
  peer.setReply((socket) => socket.resetAndDestroy());
  assert.deepEqual(await callHttp(t, gateway.url).response, {
    status: 502, allow: undefined, body: envelope('upstream_failure'),
  });
  assert.equal(peer.attempts.length, before + 1);
  assert.deepEqual(peer.attempts[before]?.wire, requestFrame);
});

test('integration: eight missing FINs fill the gateway budget and release it after timeout', async (t) => {
  const peer = await startPeer(t, (socket) => { socket.write(replyFrame); });
  const gateway = await startService(gatewayEntry, {WORKER_ORIGIN: peer.origin});
  t.after(gateway.stop);
  const pending = Promise.all(Array.from({length: 8}, async () => {
    const startedAt = performance.now();
    const reply = await callHttp(t, gateway.url).response;
    const elapsed = performance.now() - startedAt;
    assert.ok(elapsed < 850, `500ms RPC with HTTP scheduling allowance took ${elapsed.toFixed(1)}ms`);
    return reply;
  }));
  // Attach a rejection observer before awaiting separate fixture activity.
  void pending.catch(() => {});
  await peer.waitForRequests(8);
  const busy = await callHttp(t, gateway.url).response;
  assert.deepEqual(busy, {status: 503, allow: undefined, body: envelope('busy')});
  assert.equal(peer.attempts.length, 8);

  for (const reply of await pending) {
    assert.deepEqual(reply, {status: 502, allow: undefined, body: envelope('upstream_failure')});
  }
  assert.equal(peer.attempts.length, 8);
  await Promise.all(peer.attempts.map(async (attempt) => {
    assert.deepEqual(attempt.wire, requestFrame);
    // The gateway already sent FIN. A write can expose its later reset without
    // ending the fixture's write half. At most three bytes leave a partial header.
    for (let probe = 0; probe < 3 && !attempt.socket.destroyed; probe++) {
      attempt.socket.write(Buffer.from([0]));
      await delay(75);
    }
    assert.ok(attempt.socket.destroyed, 'the peer observed closure without sending FIN');
    await attempt.closed;
  }));

  // Hold every new reply until all eight exchanges have been admitted together.
  peer.setReply(() => {});
  const recovered = Array.from({length: 8}, () => callHttp(t, gateway.url).response);
  const replies = Promise.all(recovered);
  void replies.catch(() => {});
  const earlyReply = await Promise.race([peer.waitForRequests(16), Promise.race(recovered)]);
  assert.equal(earlyReply, undefined, 'all eight permits must be reusable before any peer replies');
  assert.equal(peer.attempts.length, 16);
  for (const attempt of peer.attempts.slice(8)) {
    assert.deepEqual(attempt.wire, requestFrame);
    attempt.socket.end(replyFrame);
  }
  for (const reply of await replies) {
    assert.deepEqual(reply, {status: 200, allow: undefined, body: {echo: 'Hello 86'}});
  }
  assert.equal(peer.attempts.length, 16);
});
