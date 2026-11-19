import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { IncomingMessage, request, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { promisify } from 'node:util';
import test from 'node:test';
import { databasePath, feedOrigin, isEventPayload, parseCursor, replayCursor } from '../contracts.mts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonRequest, startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { encodeEvents, ReplayParser } from '../sse.mts';
import { fetchReplay } from '../reader.mts';
import { FeedStore } from '../store.mts';
import { handleFeedRequest } from '../feed.mts';
import { commitOnReplayHeaders } from './pinned-feed.mts';

test('unit: byte-split UTF-8 and SSE framing resume strictly after sequence 2', () => {
  const wire = ': café\r\nunknown: ignored\r\nid: 3\r\nevent: item\r\n'
    + 'data: {"id":"c",\r\ndata: "text":"Third"}\r\n\r\n'
    + 'id: 4\nevent: item\ndata: {"id":"d","text":"Fourth"}\n\n'
    + 'id: 5\nevent: item\ndata: {"id":"e","text":"Unterminated"}\n';
  const parser = new ReplayParser(2);
  for (const byte of new TextEncoder().encode(wire)) parser.push(Uint8Array.of(byte));

  assert.deepEqual(parser.finish(), {
    events: [
      {sequence: 3, id: 'c', text: 'Third'},
      {sequence: 4, id: 'd', text: 'Fourth'},
    ],
    lastEventId: 4,
  });
});

function parseStream(wire: string | Uint8Array, after: number) {
  const parser = new ReplayParser(after);
  parser.push(typeof wire === 'string' ? new TextEncoder().encode(wire) : wire);
  return parser.finish();
}

test('unit: clean EOF discards a trailing frame even when its final data line ends in LF', () => {
  assert.deepEqual(parseStream('id: bad\nevent: wrong\ndata: broken\n', 7), {
    events: [], lastEventId: 7,
  });
  assert.deepEqual(parseStream('', 16), {events: [], lastEventId: 16});
});

test('unit: SSE accepts a leading BOM, bare CR endings and a data-free id block', () => {
  const wire = '\uFEFF: ignored\rid: 1\r\revent:item\rignored\rdata:{"id":"a","text":"One"}\r\r';
  assert.deepEqual(parseStream(wire, 0), {
    events: [{sequence: 1, id: 'a', text: 'One'}], lastEventId: 1,
  });
});

test('unit: replay rejects a completed malformed frame anywhere in the prefix', () => {
  const first = 'id: 3\nevent: item\ndata: {"id":"c","text":"Third"}\n\n';
  const valid = '{"id":"d","text":"Fourth"}';
  for (const wire of [
    'id: 2\nevent: item\ndata: ' + valid + '\n\n',
    'id: 5\nevent: item\ndata: ' + valid + '\n\n',
    'id: 04\nevent: item\ndata: ' + valid + '\n\n',
    'id: 4\nevent: wrong\ndata: ' + valid + '\n\n',
    'id: 4\ndata: ' + valid + '\n\n',
    'event: item\ndata: ' + valid + '\n\n',
    ...['broken', '', 'null', '[]', 'true', '{"id":"c","text":"Duplicate"}',
      '{"id":"d","text":{"toString":null}}', '{"id":"d","text":"Fourth","extra":0}',
      '{"id":"D","text":"Fourth"}', '{"id":"d","text":"Digit 4"}'].map(
      payload => 'id: 4\nevent: item\ndata: ' + payload + '\n\n',
    ),
  ]) assert.throws(() => parseStream(first + wire, 2), {message: 'Invalid SSE event'}, wire);

  assert.throws(
    () => parseStream('id: 17\nevent: item\ndata: ' + valid + '\n\n', 16),
    {message: 'Invalid SSE event'},
  );
});

test('unit: replay measures bytes including comments and rejects truncated or illegal UTF-8', () => {
  // 1 ASCII colon + 4095 two-byte characters + 1 LF = 8192 bytes.
  assert.deepEqual(parseStream(':' + 'é'.repeat(4095) + '\n', 0), {events: [], lastEventId: 0});
  assert.throws(() => parseStream(':' + 'é'.repeat(4095) + ' \n', 0), /too large/);
  assert.throws(() => parseStream(Uint8Array.of(0x3a, 0xc3), 0), TypeError);
  assert.throws(() => parseStream(Uint8Array.of(0x3a, 0xff, 0x0a), 0), TypeError);
});

test('unit: feed encodes exact finite SSE frames and omits the sequence from data', () => {
  assert.equal(encodeEvents([
    {sequence: 2, id: 'b', text: 'Two'},
    {sequence: 3, id: 'c', text: 'Three'},
  ]), 'id: 2\nevent: item\ndata: {"id":"b","text":"Two"}\n\n'
    + 'id: 3\nevent: item\ndata: {"id":"c","text":"Three"}\n\n');
  assert.equal(encodeEvents([]), '');
});

test('unit: only canonical cursors and the sole literal after query parameter are accepted', () => {
  for (const value of [0, 1, 9, 10, 15, 16]) {
    assert.equal(parseCursor(String(value)), value);
    assert.equal(replayCursor('/replay?after=' + value), value);
  }
  for (const invalid of ['', '-0', '00', '02', '17', '3.0', '1e1', '+2', ' 2', '2 ', '2\n',
    '2, 3', '%32', '２', '2?after=2', '2&', '2&after=2', '2#']) {
    assert.equal(parseCursor(invalid), undefined, invalid);
    assert.equal(replayCursor('/replay?after=' + invalid), undefined, invalid);
  }
  for (const invalid of ['/replay', '/replay?', '/replay?other=2', '/replay?%61fter=2', '/replay/?after=2']) {
    assert.equal(replayCursor(invalid), undefined, invalid);
  }
});

test('unit: event body schema checks exact keys and ASCII before any string conversion', () => {
  assert.equal(isEventPayload({id: '0a', text: 'A z'}), true);
  assert.equal(isEventPayload({id: '9'.repeat(16), text: 'x'.repeat(32)}), true);
  for (const invalid of [null, [], false, 1, 'a', {}, {id: 'a'}, {id: 'a', text: 'A', extra: 0},
    ...['', 'a'.repeat(17), 'A', 'a_', 'a\n', 9, {toString: null}].map(id => ({id, text: 'A'})),
    ...['', 'A'.repeat(33), 'é', 'Z0', 'Z\n', false, {toString: null}].map(text => ({id: 'a', text})),
  ]) assert.equal(isEventPayload(invalid), false, JSON.stringify(invalid));
});

test('unit: the feed origin is fixed normalized loopback HTTP and the database requires a disk path', () => {
  assert.equal(feedOrigin('http://127.0.0.1:080/'), 'http://127.0.0.1');
  assert.equal(feedOrigin('http://127.0.0.1:8081/'), 'http://127.0.0.1:8081');
  for (const bad of [undefined, '', 'http://localhost:80', 'http://127.1', 'https://127.0.0.1',
    'http://example.test', 'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://user@127.0.0.1',
    'http://127.0.0.1/path', 'http://127.0.0.1/?', 'http://127.0.0.1/#']) {
    assert.throws(() => feedOrigin(bad), /FEED_ORIGIN/, bad);
  }
  assert.equal(databasePath('./feed.sqlite'), './feed.sqlite');
  for (const bad of [undefined, '', ':memory:', 'file::memory:', 'FILE:feed.sqlite',
    'file:feed.sqlite?mode=memory&cache=shared']) {
    assert.throws(() => databasePath(bad), /DB_PATH/, bad);
  }
});

const upstreamFailure = {status: 502, code: 'upstream_failure', message: 'upstream_failure'};
const cursorAhead = {status: 409, code: 'cursor_ahead', message: 'cursor_ahead'};
const cursorAheadBody = {error: {code: 'cursor_ahead', message: 'cursor_ahead'}};
const conflictWire = JSON.stringify(cursorAheadBody);
const thirdFrame = 'id: 3\nevent: item\ndata: {"id":"c","text":"Third"}\n\n';
const fourthFrame = 'id: 4\nevent: item\ndata: {"id":"d","text":"Fourth"}\n\n';
const fifthFrame = 'id: 5\nevent: item\ndata: {"id":"e","text":"Fifth"}\n\n';
const afterTwo = {events: [{sequence: 3, id: 'c', text: 'Third'}], lastEventId: 3};
const testOrigin = 'http://127.0.0.1:8081';

test('unit: append reuses the receipt before checking capacity and preserves sequence order', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const store = new FeedStore(db);
    for (let sequence = 1; sequence <= 16; sequence++) {
      assert.deepEqual(store.append({id: 'i' + sequence, text: 'Original'}), {created: true, sequence});
    }
    assert.deepEqual(store.append({id: 'i1', text: 'Original'}), {created: false, sequence: 1});
    assert.throws(() => store.append({id: 'i1', text: 'Changed'}), {status: 409, code: 'id_conflict'});
    assert.throws(() => store.append({id: 'new', text: 'Original'}), {status: 429, code: 'capacity'});
    assert.deepEqual(store.capture(15), [{sequence: 16, id: 'i16', text: 'Original'}]);
    assert.deepEqual(store.capture(16), []);
  } finally {
    db.close();
  }
});

test('unit: failure inserting a receipt rolls back its event and leaves the sequence reusable', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const store = new FeedStore(db);
    assert.deepEqual(store.append({id: 'a', text: 'First'}), {created: true, sequence: 1});
    for (const action of ['ABORT', 'ROLLBACK']) {
      db.exec(`CREATE TRIGGER reject_receipt AFTER INSERT ON receipts
        BEGIN SELECT RAISE(${action}, 'injected failure'); END`);
      assert.throws(() => store.append({id: 'b', text: 'Second'}), {message: 'injected failure'});
      assert.deepEqual(store.capture(0), [{sequence: 1, id: 'a', text: 'First'}]);
      assert.throws(() => store.capture(2), cursorAhead);
      db.exec('DROP TRIGGER reject_receipt');
    }
    assert.deepEqual(store.append({id: 'b', text: 'Second'}), {created: true, sequence: 2});
    assert.deepEqual(store.capture(1), [{sequence: 2, id: 'b', text: 'Second'}]);
  } finally {
    db.close();
  }
});

const firstFour = [
  {id: 'a', text: 'First'}, {id: 'b', text: 'Second'},
  {id: 'c', text: 'Third'}, {id: 'd', text: 'Fourth'},
];

test('unit: feed sends only the committed prefix when an append lands at the first HTTP write', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const store = new FeedStore(db);
    for (const event of firstFour) store.append(event);
    const socket = new Socket();
    try {
      const chunks: string[] = [];
      const record = (chunk: unknown) => {
        assert.ok(typeof chunk === 'string' || Buffer.isBuffer(chunk));
        chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      };
      socket._write = (chunk: unknown, _encoding, done) => {
        record(chunk);
        done();
      };
      socket._writev = (batch: readonly {chunk: unknown}[], done) => {
        for (const {chunk} of batch) record(chunk);
        done();
      };
      const req = new IncomingMessage(socket);
      req.httpVersionMajor = 1;
      req.httpVersionMinor = 0;
      req.method = 'GET';
      req.url = '/events';
      req.headers = {'last-event-id': '2'};
      const res = new ServerResponse(req);
      res.assignSocket(socket);
      commitOnReplayHeaders(res, store);

      await handleFeedRequest(store, req, res);

      const wire = chunks.join('');
      assert.match(wire, /^HTTP\/1\.1 200 /);
      assert.equal(wire.split('\r\n\r\n')[1], thirdFrame + fourthFrame);
      assert.deepEqual(store.capture(4), [{sequence: 5, id: 'e', text: 'Fifth'}]);
    } finally {
      socket.destroy();
    }
  } finally {
    db.close();
  }
});

function eventResponse(wire: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Response(wire, {headers: {'content-type': 'text/event-stream; charset=utf-8', ...headers}});
}

function conflictResponse(wire: string | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
  return new Response(wire, {status: 409, headers: {'content-type': 'application/json', ...headers}});
}

test('unit: reader sends the cursor to the fixed events URL using a no-redirect request', async () => {
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, testOrigin + '/events');
    assert.equal(options?.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('last-event-id'), '2');
    return eventResponse(thirdFrame);
  };
  assert.deepEqual(await fetchReplay(testOrigin, 2, fetcher), afterTwo);
});

test('unit: only the exact identity JSON cursor_ahead response preserves an upstream 409', async () => {
  const wire = conflictWire;
  const atLimit = wire.padEnd(8192);
  const overLimit = wire.padEnd(8193);
  assert.deepEqual(JSON.parse(atLimit), cursorAheadBody);
  assert.deepEqual(JSON.parse(overLimit), cursorAheadBody);
  await assert.rejects(fetchReplay(testOrigin, 2, async () => conflictResponse(atLimit)), cursorAhead);
  for (const response of [
    conflictResponse(overLimit),
    conflictResponse(wire, {'content-encoding': 'gzip'}),
    conflictResponse(wire, {'content-type': 'text/plain'}),
    conflictResponse(wire, {'content-length': '8193'}),
    ...['null', '[]', '4', 'bad', '{"error":[]}', '{"error":{"code":"cursor_ahead","message":"wrong"}}',
      '{"error":{"code":"internal_error","message":"internal_error"}}',
      '{"error":{"code":"cursor_ahead","message":"cursor_ahead","extra":0}}',
      '{"error":{"code":"cursor_ahead","message":"cursor_ahead"},"extra":0}'].map(
      value => conflictResponse(value),
    ),
  ]) await assert.rejects(fetchReplay(testOrigin, 2, async () => response), upstreamFailure);
});

test('unit: conflicting Content-Type values cannot produce a checkpoint or preserve a 409', async () => {
  for (const response of [
    eventResponse(thirdFrame, {'content-type': 'text/event-stream; charset=utf-8, application/json'}),
    conflictResponse(conflictWire, {'content-type': 'application/json; charset=utf-8, text/event-stream'}),
    new Response(thirdFrame, {headers: [['content-type', 'text/event-stream; note="a'], ['content-type', 'b"']]}),
  ]) await assert.rejects(fetchReplay(testOrigin, 2, async () => response), upstreamFailure);

  assert.deepEqual(await fetchReplay(testOrigin, 2, async () =>
    eventResponse(thirdFrame, {'content-type': 'Text/Event-Stream; note="a b"; charset=utf-8'})), afterTwo);
});

test('unit: reader rejects the wrong status, media, encoding and oversized SSE before returning a checkpoint', async () => {
  for (const response of [
    new Response(thirdFrame, {status: 201, headers: {'content-type': 'text/event-stream'}}),
    new Response(null, {headers: {'content-type': 'text/event-stream'}}),
    eventResponse(thirdFrame, {'content-type': 'text/plain'}),
    eventResponse(thirdFrame, {'content-encoding': 'identity, gzip'}),
    eventResponse(thirdFrame, {'content-encoding': ''}),
    eventResponse(thirdFrame, {'content-length': '8193'}),
    eventResponse(thirdFrame + ':' + ' '.repeat(8193 - thirdFrame.length - 2) + '\n'),
  ]) await assert.rejects(fetchReplay(testOrigin, 2, async () => response), upstreamFailure);

  const exactCap = thirdFrame + ':' + ' '.repeat(8192 - thirdFrame.length - 2) + '\n';
  assert.deepEqual(await fetchReplay(testOrigin, 2, async () =>
    eventResponse(exactCap, {'content-encoding': 'IdEnTiTy'})), afterTwo);
});

function openBody(chunks: readonly string[]) {
  let producer: ReadableStreamDefaultController<Uint8Array> | undefined;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      producer = controller;
    },
    cancel() { cancelled = true; },
  });
  return {
    body,
    wasCancelled: () => cancelled,
    close() {
      if (!cancelled && producer) {
        producer.close();
        producer = undefined;
      }
    },
  };
}

function trackReplay(pending: ReturnType<typeof fetchReplay>) {
  let finished = false;
  const markFinished = () => { finished = true; };
  const settled = pending.then(markFinished, markFinished);
  return {settled, hasFinished: () => finished};
}

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

test('unit: headers at 300 ms leave only the remaining time for clean EOF', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const elapsed of [499, 500]) {
    let now = 1000;
    const stream = openBody([thirdFrame]);
    let settled: Promise<unknown> | undefined;
    try {
      const result = fetchReplay(testOrigin, 2, async () => {
        await nextTurn();
        now = 1300;
        return eventResponse(stream.body);
      }, () => now);
      const checked = elapsed === 499 ? result.then(value => assert.deepEqual(value, afterTwo))
        : assert.rejects(result, upstreamFailure);
      settled = Promise.allSettled([checked]);
      await nextTurn();
      now = 1000 + elapsed;
      stream.close();
      await checked;
    } finally {
      stream.close();
      await settled;
    }
  }
});

for (const headerDelay of [0, 300]) {
  for (const [label, frame, responseFor] of [
    ['SSE', thirdFrame, eventResponse],
    ['409 JSON', conflictWire, conflictResponse],
  ] as const) {
    test(`unit: a complete ${label} body held open with headers at ${headerDelay} ms is cancelled at 500 ms`, async (t) => {
      t.mock.timers.enable({apis: ['setTimeout']});
      const stream = openBody([frame]);
      let settled: Promise<void> | undefined;
      try {
        const result = fetchReplay(testOrigin, 2, async () => {
          if (headerDelay > 0) await new Promise<void>(resolve => setTimeout(resolve, headerDelay));
          return responseFor(stream.body);
        }, () => 1000);
        const replay = trackReplay(result);
        settled = replay.settled;
        if (headerDelay > 0) t.mock.timers.tick(headerDelay);
        await nextTurn();
        t.mock.timers.tick(499 - headerDelay);
        await nextTurn();
        assert.equal(replay.hasFinished(), false, 'body still open at 499 ms');
        assert.equal(stream.wasCancelled(), false);

        t.mock.timers.tick(1);
        await nextTurn();
        assert.ok(replay.hasFinished(), 'replay must settle at 500 ms including header latency');
        await assert.rejects(result, upstreamFailure);
        assert.equal(stream.wasCancelled(), true);
      } finally {
        stream.close();
        await settled;
      }
    });
  }
}

test('unit: streamed 409 JSON exceeding the cumulative cap is cancelled while still open', async (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const chunks = [conflictWire, ' '.repeat(4096), ' '.repeat(8193 - conflictWire.length - 4096)];
  assert.deepEqual(JSON.parse(chunks.join('')), cursorAheadBody);
  const stream = openBody(chunks);
  let settled: Promise<void> | undefined;
  try {
    const result = fetchReplay(testOrigin, 2, async () => conflictResponse(stream.body));
    const replay = trackReplay(result);
    settled = replay.settled;
    await nextTurn();
    assert.ok(replay.hasFinished(), 'replay must settle without EOF or a timer tick');
    await assert.rejects(result, upstreamFailure);
    assert.equal(stream.wasCancelled(), true);
  } finally {
    stream.close();
    await settled;
  }
});

const feedEntry = new URL('../feed.mts', import.meta.url);
const readerEntry = new URL('../reader.mts', import.meta.url);
const runNode = promisify(execFile);

test('unit: entrypoint imports are silent under invalid runtime configuration', async () => {
  const script = [feedEntry, readerEntry].map(url => `await import(${JSON.stringify(url.href)})`).join('\n');
  const {stdout, stderr} = await runNode(process.execPath,
    ['--v8-pool-size=1', '--input-type=module', '--eval', script], {
      timeout: 5000,
      killSignal: 'SIGKILL',
      env: {PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1', PORT: '-1',
        DB_PATH: ':memory:', FEED_ORIGIN: 'invalid'},
    });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {headers, signal: AbortSignal.timeout(5000)});
}

async function expectJson(response: Response, status: number, body: unknown): Promise<void> {
  assert.equal(response.status, status);
  const value: unknown = await response.json();
  assert.deepEqual(value, body);
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  await expectJson(response, status, {error: {code, message: code}});
}

async function stopServices(services: RunningService[]): Promise<void> {
  const results = await Promise.allSettled(services.map(service => service.stop()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
}

test('integration: feed persists receipts and finite replay across process restart', async () => {
  const services: RunningService[] = [];
  const dir = await mkdtemp(join(tmpdir(), 'durable-sse-'));
  try {
    const DB_PATH = join(dir, 'feed.sqlite');
    const feed = await startService(feedEntry, {DB_PATH});
    services.push(feed);
    const reader = await startService(readerEntry, {FEED_ORIGIN: feed.url});
    services.push(reader);
    const events = feed.url + '/events';
    const replay = reader.url + '/replay';

    await expectJson(await get(replay + '?after=0'), 200, {events: [], lastEventId: 0});
    await expectError(await get(replay + '?after=1'), 409, 'cursor_ahead');

    await expectJson(await jsonRequest(events, {id: 'a', text: 'First'}), 201, {sequence: 1});
    const duplicates = await Promise.all([
      jsonRequest(events, {id: 'b', text: 'Second'}),
      jsonRequest(events, {id: 'b', text: 'Second'}),
    ]);
    const statuses = duplicates.map(response => response.status);
    assert.deepEqual(statuses.toSorted(), [200, 201]);
    for (const response of duplicates) {
      const value: unknown = await response.json();
      assert.deepEqual(value, {sequence: 2});
    }
    await expectJson(await jsonRequest(events, {id: 'c', text: 'Third'}), 201, {sequence: 3});

    const all = await get(events);
    assert.equal(all.status, 200);
    assert.match(all.headers.get('content-type') ?? '', /^text\/event-stream(?:;|$)/);
    assert.equal(await all.text(), 'id: 1\nevent: item\ndata: {"id":"a","text":"First"}\n\n'
      + 'id: 2\nevent: item\ndata: {"id":"b","text":"Second"}\n\n' + thirdFrame);
    await expectJson(await get(replay + '?after=2'), 200, afterTwo);
    await expectJson(await get(replay + '?after=2'), 200, afterTwo);
    await expectJson(await get(replay + '?after=3'), 200, {events: [], lastEventId: 3});
    await expectError(await get(replay + '?after=4'), 409, 'cursor_ahead');

    await feed.stop();
    const restarted = await startService(feedEntry, {DB_PATH, PORT: new URL(feed.url).port});
    services.push(restarted);
    assert.equal(restarted.url, feed.url);
    await expectJson(await get(replay + '?after=2'), 200, afterTwo);
    await expectJson(await jsonRequest(events, {id: 'b', text: 'Second'}), 200, {sequence: 2});
    await expectError(await jsonRequest(events, {id: 'b', text: 'Changed'}), 409, 'id_conflict');

    await expectJson(await jsonRequest(events, {id: 'd', text: 'Fourth'}), 201, {sequence: 4});
    await expectJson(await jsonRequest(events, {id: 'e', text: 'Fifth'}), 201, {sequence: 5});
    await expectJson(await get(replay + '?after=4'), 200, {
      events: [{sequence: 5, id: 'e', text: 'Fifth'}], lastEventId: 5,
    });

    for (const body of [null, [], true, 1, {id: 'bad', text: 'A', extra: 0},
      {id: {toString: null}, text: 'A'}, {id: 'bad', text: {toString: null}}]) {
      await expectError(await jsonRequest(events, body), 400, 'invalid_request');
    }
    await expectError(await jsonRequest(events + '?extra=1', {id: 'bad', text: 'A'}), 400, 'invalid_request');
    // Node24.12 fetch strips a bare question mark, so send this literal request target.
    const emptyQuery = await new Promise<IncomingMessage>((resolve, reject) => {
      const call = request(events, {path: '/events?', signal: AbortSignal.timeout(5000)}, resolve);
      call.once('error', reject);
      call.end();
    });
    try {
      assert.equal(emptyQuery.statusCode, 400);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of emptyQuery) {
        assert.ok(Buffer.isBuffer(chunk));
        bytes += chunk.byteLength;
        assert.ok(bytes <= 8192);
        chunks.push(chunk);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.deepEqual(body, {error: {code: 'invalid_request', message: 'invalid_request'}});
    } finally { emptyQuery.destroy(); }
    await expectError(await get(events, {'last-event-id': '02'}), 400, 'invalid_request');
    await expectError(await get(events, {'last-event-id': '2, 3'}), 400, 'invalid_request');
    for (const query of ['', '?after=01', '?after=%32', '?after=2&after=2', '?after=2?ignored', '?upstream=other']) {
      await expectError(await get(replay + query), 400, 'invalid_request');
    }
    await expectError(await jsonRequest(replay + '?after=2', {}), 405, 'method_not_allowed');
    await expectError(await get(feed.url + '/unknown'), 404, 'not_found');

    for (let sequence = 6; sequence <= 16; sequence++) {
      await expectJson(await jsonRequest(events, {id: 'i' + sequence, text: 'More'}), 201, {sequence});
    }
    await expectError(await jsonRequest(events, {id: 'new', text: 'Full'}), 429, 'capacity');
    await expectJson(await jsonRequest(events, {id: 'a', text: 'First'}), 200, {sequence: 1});
    await expectJson(await get(replay + '?after=16'), 200, {events: [], lastEventId: 16});
  } finally {
    try { await stopServices(services); }
    finally { await rm(dir, {recursive: true, force: true}); }
  }
});

test('integration: an append at the start of a nonempty SSE response only appears in the next replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pinned-sse-'));
  try {
    const feed = await startService(new URL('./pinned-feed.mts', import.meta.url), {
      DB_PATH: join(dir, 'feed.sqlite'),
    });
    try {
      const events = feed.url + '/events';
      for (const [index, event] of firstFour.entries()) {
        await expectJson(await jsonRequest(events, event), 201, {sequence: index + 1});
      }
      const pinned = await get(events, {'last-event-id': '2'});
      assert.equal(pinned.status, 200);
      assert.equal(await pinned.text(), thirdFrame + fourthFrame);

      const next = await get(events, {'last-event-id': '4'});
      assert.equal(next.status, 200);
      assert.equal(await next.text(), fifthFrame);
    } finally {
      await feed.stop();
    }
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('integration: reader rejects incomplete transport, invalid frames, oversized bodies and redirects', async () => {
  const services: RunningService[] = [];
  const fixture = new URL('./upstream.mts', import.meta.url);
  try {
    const destination = await startService(fixture);
    services.push(destination);
    const upstream = await startService(fixture, {REDIRECT_TO: destination.url + '/redirect-target'});
    services.push(upstream);
    assert.notEqual(upstream.url, destination.url);
    const reader = await startService(readerEntry, {FEED_ORIGIN: upstream.url + '/'});
    services.push(reader);

    const replay = reader.url + '/replay?after=2';
    const setMode = async (mode: string) => {
      await expectJson(await jsonRequest(upstream.url + '/mode', {mode}), 200, {mode});
    };
    await expectError(await jsonRequest(upstream.url + '/mode', {mode: {toString: null}}), 400, 'invalid_request');
    await expectJson(await get(replay), 200, afterTwo);
    await setMode('split');
    await expectJson(await get(replay), 200, afterTwo);
    await setMode('redirect');
    await expectError(await get(replay), 502, 'upstream_failure');
    await expectJson(await get(destination.url + '/hits'), 200, {hits: 0});

    for (const mode of ['wrong-type', 'conflicting-type', 'folded-malformed-type', 'gzip', 'bad-utf8', 'malformed', 'gap', 'duplicate-id',
      'oversize-sse', 'cut', '409-null', '409-array', '409-primitive', '409-extra', '409-unexpected',
      '409-wrong-message', '409-conflicting-type', '409-gzip']) {
      await setMode(mode);
      await expectError(await get(replay), 502, 'upstream_failure');
    }
    await setMode('409-oversize');
    const oversizedStarted = performance.now();
    await expectError(await get(replay), 502, 'upstream_failure');
    const oversizedElapsed = performance.now() - oversizedStarted;
    assert.ok(oversizedElapsed < 450, `open oversized body returned after ${oversizedElapsed.toFixed(1)} ms`);

    for (const mode of ['stall', '409-stall']) {
      await setMode(mode);
      const started = performance.now();
      await expectError(await get(replay), 502, 'upstream_failure');
      const elapsed = performance.now() - started;
      // Allow scheduling and loopback overhead while rejecting a multi-second body timer.
      assert.ok(elapsed >= 450 && elapsed < 1500, `${mode} returned after ${elapsed.toFixed(1)} ms`);
    }
    await setMode('409-exact-cap');
    await expectError(await get(replay), 409, 'cursor_ahead');
    await setMode('exact-cap-sse');
    await expectJson(await get(replay), 200, afterTwo);
    await upstream.stop();
    await expectError(await get(replay), 502, 'upstream_failure');
  } finally {
    await stopServices(services);
  }
});
