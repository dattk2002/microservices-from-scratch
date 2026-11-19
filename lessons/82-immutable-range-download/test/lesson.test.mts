import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { promisify } from 'node:util';
import { jsonRequest, startService } from '../../../test/support.mts';
import { download, objectOrigin } from '../download.mts';
import { selectRange, validPutBody, validResumeBody } from '../protocol.mts';
import { ObjectStore } from '../store.mts';

const origin = 'http://127.0.0.1:8082';
const abcTag = '"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"';
const staleTag = `"${'0'.repeat(64)}"`;

test('unit: a stale If-Range replaces the old prefix with the complete 200 body', async () => {
  const fetcher: typeof fetch = async () => new Response('abc', {headers: {
    'content-type': 'application/octet-stream', 'content-length': '3', etag: abcTag,
  }});
  const result = await download(origin, {id: 'o0', prefix: 'OLD', etag: staleTag}, fetcher);
  assert.equal(result.text, 'abc');
  assert.equal(result.etag, abcTag);
  assert.equal(result.resumed, false);
});

const upstreamFailure = {status: 502, code: 'upstream_failure', message: 'upstream_failure'};
const empty = {id: 'o0', prefix: '', etag: null};
const partial = {id: 'o0', prefix: 'a', etag: abcTag};
const finished = {id: 'o0', prefix: 'abc', etag: abcTag};

type ResponseBody = NonNullable<ConstructorParameters<typeof Response>[0]>;

function binary(text: ResponseBody, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(text, {status, headers: {
    'content-type': 'application/octet-stream', 'content-length': '3', etag: abcTag, ...headers,
  }});
}

function suffix(text: ResponseBody = 'bc', headers: Record<string, string> = {}): Response {
  return binary(text, 206, {'content-length': '2', 'content-range': 'bytes 1-2/3', ...headers});
}

function errorBody(code: string) {
  return {error: {code, message: code}};
}

function completeResponse(body: unknown = errorBody('range_not_satisfiable'), headers: Record<string, string> = {}) {
  return Response.json(body, {status: 416, headers: {etag: abcTag, 'content-range': 'bytes */3', ...headers}});
}

test('unit: the downloader selects one fixed path and sends Range and If-Range only with a prefix', async () => {
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, origin + '/objects/o0');
    assert.equal(options?.method, 'GET');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    const headers = new Headers(options.headers);
    if (!headers.has('range')) {
      assert.equal(headers.get('if-range'), null);
      return binary('abc');
    }
    assert.equal(headers.get('range'), 'bytes=1-');
    assert.equal(headers.get('if-range'), abcTag);
    return suffix();
  };

  assert.deepEqual(await download(origin, {...empty, etag: staleTag}, fetcher),
    {text: 'abc', etag: abcTag, resumed: false});
  assert.deepEqual(await download(origin, partial, fetcher), {text: 'abc', etag: abcTag, resumed: true});
});

test('unit: a 206 must match the requested suffix and validate the final bytes including the prefix', async () => {
  for (const [label, response] of [
    ['wrong start', suffix('bc', {'content-range': 'bytes 0-1/2'})],
    ['short interval', suffix('bc', {'content-range': 'bytes 1-2/4'})],
    ['oversized total', suffix('bc', {'content-range': 'bytes 1-128/129'})],
    ['noncanonical start', suffix('bc', {'content-range': 'bytes 01-2/3'})],
    ['wrong length', suffix('bc', {'content-length': '3'})],
    ['wrong actual length', suffix('b')],
    ['wrong suffix hash', suffix('bd')],
    ['different validator', suffix('bc', {etag: staleTag})],
  ] satisfies [string, Response][]) {
    await assert.rejects(download(origin, partial, async () => response), upstreamFailure, label);
  }
  await assert.rejects(download(origin, empty, async () => suffix()), upstreamFailure);
  await assert.rejects(download(origin, {...partial, prefix: 'x'}, async () => suffix()), upstreamFailure);
});

test('unit: 416 completes only an exact, validated prefix with the expected error envelope', async () => {
  assert.deepEqual(await download(origin, finished, async () => completeResponse()),
    {text: 'abc', etag: abcTag, resumed: true});
  await assert.rejects(download(origin, partial, async () => completeResponse()), upstreamFailure);
  await assert.rejects(download(origin, {...finished, prefix: 'abd'}, async () => completeResponse()), upstreamFailure);
  const invalidMetadata: Record<string, string>[] = [
    {etag: staleTag}, {'content-range': 'bytes */03'}, {'content-range': 'bytes 0-2/3'},
  ];
  for (const headers of invalidMetadata) {
    await assert.rejects(download(origin, finished, async () => completeResponse(undefined, headers)), upstreamFailure);
  }
  for (const body of [null, [], 'range_not_satisfiable', {}, errorBody('internal_error'),
    {error: {code: 'range_not_satisfiable', message: 'unexpected'}},
    {error: {...errorBody('range_not_satisfiable').error, extra: 1}},
  ]) {
    await assert.rejects(download(origin, finished, async () => completeResponse(body)), upstreamFailure);
  }
});

test('unit: 200 rejects malformed binary metadata, unexpected bytes and an unverified strong ETag', async () => {
  const noLength = new Response('abc', {headers: {'content-type': 'application/octet-stream', etag: abcTag}});
  const noTag = new Response('abc', {headers: {'content-type': 'application/octet-stream', 'content-length': '3'}});
  for (const response of [noLength, noTag, binary('abc', 200, {etag: staleTag}),
    binary('abc', 200, {etag: 'W/' + abcTag}), binary('abc', 200, {'content-type': 'application/json'}),
    binary('abc', 200, {'content-length': '4'}), binary('abc', 200, {'content-length': '3, 3'}),
    binary('abc', 200, {'content-encoding': 'gzip'}), binary('abc', 200, {'content-range': 'bytes 0-2/3'}),
    binary('abd'), binary('a\nc'), binary(new Uint8Array([0x61, 0x62, 0xff])),
    binary(''), binary('a'.repeat(129), 200, {'content-length': '129'}),
  ]) {
    await assert.rejects(download(origin, empty, async () => response), upstreamFailure);
  }
  const nonAscii = new Uint8Array([0xe1, 0xe2, 0xe3]);
  const nonAsciiTag = '"' + createHash('sha256').update(nonAscii).digest('hex') + '"';
  await assert.rejects(download(origin, empty, async () => binary(nonAscii, 200, {etag: nonAsciiTag})), upstreamFailure);
});

test('unit: conflicting Content-Type fields reject an otherwise valid binary response', async () => {
  const headers = {'content-type': 'application/octet-stream; x="a b"'};
  assert.deepEqual(await download(origin, empty, async () => binary('abc', 200, headers)),
    {text: 'abc', etag: abcTag, resumed: false});
  const response = binary('abc', 200, {'content-type': 'application/octet-stream; x=y'});
  response.headers.append('content-type', 'text/html');
  await assert.rejects(download(origin, empty, async () => response), upstreamFailure);
});

test('unit: folded Content-Type fields cannot form an acceptable quoted parameter', async () => {
  const response = binary('abc', 200, {'content-type': 'application/octet-stream; x="a'});
  response.headers.append('content-type', 'b"');
  await assert.rejects(download(origin, empty, async () => response), upstreamFailure);
});

test('unit: 404 forwards only the known error code and message under the JSON contract', async () => {
  const expected = {status: 404, code: 'unknown_object', message: 'unknown_object'};
  const valid = errorBody('unknown_object');
  await assert.rejects(download(origin, empty, async () => Response.json(valid, {status: 404})), expected);
  for (const body of [null, [], 'unknown_object', {}, errorBody('internal_error'),
    {error: {code: 'unknown_object', message: 'wrong'}}, {...valid, extra: true}]) {
    await assert.rejects(download(origin, empty, async () => Response.json(body, {status: 404})), upstreamFailure);
  }
  for (const response of [Response.json(valid, {status: 503}), new Response('{', {
    status: 404, headers: {'content-type': 'application/json'},
  }), Response.json(valid, {status: 404, headers: {'content-encoding': 'gzip'}}),
  Response.json(valid, {status: 404, headers: {'content-length': '1'}})]) {
    await assert.rejects(download(origin, empty, async () => response), upstreamFailure);
  }
});

test('unit: upstream JSON rejects 8193 cumulative bytes before EOF or timer abort', async () => {
  const encoder = new TextEncoder();
  for (const [status, code, input, extraHeaders] of [
    [404, 'unknown_object', empty, {}],
    [416, 'range_not_satisfiable', finished, {etag: abcTag, 'content-range': 'bytes */3'}],
  ] as const) {
    const envelope = JSON.stringify(errorBody(code));
    const padding = ' '.repeat(4096);
    const chunks = [envelope, padding, ' '.repeat(8193 - envelope.length - padding.length)];
    assert.deepEqual(JSON.parse(chunks.join('')), errorBody(code));

    let nextChunk = 0;
    let cancelledBeforeAbort = false;
    const fetcher: typeof fetch = async (_url, options) => {
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          const chunk = chunks[nextChunk];
          if (chunk !== undefined) {
            nextChunk++;
            controller.enqueue(encoder.encode(chunk));
          }
        },
        cancel() {
          cancelledBeforeAbort = options?.signal?.aborted === false;
        },
      }, {highWaterMark: 0});
      return new Response(stream, {status, headers: {'content-type': 'application/json', ...extraHeaders}});
    };

    await assert.rejects(download(origin, input, fetcher), upstreamFailure);
    assert.equal(nextChunk, chunks.length, `${status}: reject after crossing the cumulative limit`);
    assert.equal(cancelledBeforeAbort, true, `${status}: cancel the open stream before the deadline timer aborts`);
  }
});

test('unit: upstream JSON accepts 8192 bytes after EOF', async () => {
  const wire = JSON.stringify(errorBody('unknown_object')).padEnd(8192);
  const fetcher: typeof fetch = async () => new Response(wire, {
    status: 404, headers: {'content-type': 'application/json'},
  });
  await assert.rejects(download(origin, empty, fetcher), {status: 404, code: 'unknown_object'});
});

test('unit: headers at 300 ms leave only until 500 ms to read a valid JSON envelope on an open stream', async t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 0});
  let reads = 0;
  let cancelledOnAbort = false;
  const fetcher: typeof fetch = async (_url, options) => {
    await new Promise<void>(resolve => setTimeout(resolve, 300));
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++reads === 1) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(errorBody('unknown_object'))));
        }
      },
      cancel() {
        cancelledOnAbort = options?.signal?.aborted === true;
      },
    }, {highWaterMark: 0});
    return new Response(stream, {status: 404, headers: {'content-type': 'application/json'}});
  };
  try {
    const operation = download(origin, empty, fetcher, Date.now);
    let settled = false;
    const markSettled = () => { settled = true; };
    void operation.then(markSettled, markSettled);

    t.mock.timers.tick(300);
    await nextTurn();
    assert.equal(reads, 2, 'the downloader has read the envelope and is waiting for EOF');
    t.mock.timers.tick(199);
    await nextTurn();
    assert.equal(settled, false, 'the open response is still pending at 499 ms');
    assert.equal(cancelledOnAbort, false);

    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(settled, true, 'the pending body read must fail at 500 ms from request start');
    assert.equal(cancelledOnAbort, true, 'the deadline abort must cancel the reader');
    await assert.rejects(operation, upstreamFailure);
  } finally {
    t.mock.timers.tick(500);
    await nextTurn();
  }
});

test('unit: the monotonic deadline counts 300 ms for headers and rejects EOF at exactly 500 ms', async () => {
  for (const elapsed of [499, 500]) {
    let now = 1000;
    let bodySent = false;
    // A zero high-water mark defers pull until the downloader reads the body.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!bodySent) {
          bodySent = true;
          controller.enqueue(new TextEncoder().encode('abc'));
          return;
        }
        now = 1000 + elapsed;
        controller.close();
      },
    }, {highWaterMark: 0});
    const result = download(origin, empty, async () => {
      now += 300;
      return binary(stream);
    }, () => now);
    if (elapsed === 499) assert.deepEqual(await result, {text: 'abc', etag: abcTag, resumed: false});
    else await assert.rejects(result, upstreamFailure);
  }
});

test('unit: Range clamps inclusive end offsets and validates syntax before applying If-Range', () => {
  assert.deepEqual(selectRange('bytes=1-1', abcTag, abcTag, 3), {kind: 'partial', start: 1, end: 1});
  assert.deepEqual(selectRange('bytes=1-999', undefined, abcTag, 3), {kind: 'partial', start: 1, end: 2});
  assert.deepEqual(selectRange('bytes=1-', abcTag, abcTag, 3), {kind: 'partial', start: 1, end: 2});
  assert.deepEqual(selectRange('bytes=0-' + '9'.repeat(400), undefined, abcTag, 3), {kind: 'partial', start: 0, end: 2});
  for (const range of ['bytes=3-', 'bytes=999-', 'bytes=2-1', 'bytes=' + '9'.repeat(400) + '-']) {
    assert.deepEqual(selectRange(range, abcTag, abcTag, 3), {kind: 'unsatisfiable'});
    assert.deepEqual(selectRange(range, undefined, abcTag, 3), {kind: 'unsatisfiable'});
    assert.deepEqual(selectRange(range, staleTag, abcTag, 3), {kind: 'full'});
    assert.deepEqual(selectRange(range, 'W/' + abcTag, abcTag, 3), {kind: 'full'});
  }
  for (const range of ['', 'bytes=-1', 'bytes=0-0,2-2', 'bytes=00-1', 'bytes=0-01', 'bytes=+1-2',
    'bytes=1--2', 'bytes=0.0-1', 'bytes= 0-1', 'items=0-1', 'bytes=0-1\n']) {
    assert.throws(() => selectRange(range, staleTag, abcTag, 3), {status: 400, code: 'invalid_range'});
  }
  const date = 'Wed, 21 Oct 2015 07:28:00 GMT';
  assert.deepEqual(selectRange(undefined, date, abcTag, 3), {kind: 'full'});
  assert.throws(() => selectRange('bytes=999-', date, abcTag, 3), {status: 400, code: 'invalid_if_range'});
  assert.throws(() => selectRange('bytes=-1', date, abcTag, 3), {status: 400, code: 'invalid_range'});
});

test('unit: request schemas preserve spaces and require exact fields, printable ASCII and a strong validator', () => {
  assert.ok(validPutBody({text: ' '.repeat(128)}));
  assert.ok(validResumeBody(empty));
  assert.ok(validResumeBody({id: 'o7', prefix: '~'.repeat(128), etag: abcTag}));
  for (const body of [null, [], 1, 'a', {}, {text: 'abc', extra: 1}, {text: ''}, {text: 'a'.repeat(129)},
    {text: 'é'}, {text: '\u007f'}, {text: 'a\n'}, {text: {toString: null}}]) {
    assert.equal(validPutBody(body), false);
  }
  for (const body of [null, [], false, 1, 'a', {}, {...empty, extra: 1}, {id: 'o0', prefix: ''},
    {...empty, id: 'o8'}, {...empty, id: {toString: null}}, {...empty, prefix: {toString: null}},
    {...empty, prefix: 'a'}, {...empty, prefix: 'a'.repeat(129), etag: abcTag},
    {...partial, prefix: 'é'}, {...partial, etag: 'W/' + abcTag},
    {...partial, etag: abcTag.toUpperCase()}, {...empty, etag: false}]) {
    assert.equal(validResumeBody(body), false);
  }
});

test('unit: OBJECT_ORIGIN normalizes a bare loopback HTTP origin and rejects path, auth and other hosts', () => {
  assert.equal(objectOrigin('http://127.0.0.1:080/'), 'http://127.0.0.1');
  assert.equal(objectOrigin('http://127.0.0.1:8082/'), origin);
  for (const bad of [undefined, 'http://localhost:8082', 'https://127.0.0.1:8082', 'http://127.0.0.1:0',
    'http://127.0.0.1:65536', 'http://user@127.0.0.1', 'http://127.0.0.1/path',
    'http://127.0.0.1/?', 'http://127.0.0.1/#', 'http://127.0.0.2', 'http://127.0.0.1\n']) {
    assert.throws(() => objectOrigin(bad));
  }
});

test('unit: a failed SQLite insert commits no object and preserves the existing immutable bytes', async () => {
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    const store = new ObjectStore(db);
    assert.deepEqual(store.put('o0', 'abc'), {created: true, etag: abcTag, size: 3});
    assert.deepEqual(store.put('o0', 'abc'), {created: false, etag: abcTag, size: 3});
    assert.throws(() => store.put('o0', 'abd'), {status: 409, code: 'immutable_conflict'});
    db.exec(`CREATE TRIGGER fail_insert AFTER INSERT ON objects
      BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END;`);
    assert.throws(() => store.put('o1', 'abc'), {message: 'injected insert failure'});
    assert.equal(store.get('o1'), undefined);
    assert.deepEqual(store.get('o0'), {bytes: Buffer.from('abc'), etag: abcTag});
    db.exec('DROP TRIGGER fail_insert');
    assert.deepEqual(store.put('o1', 'abc'), {created: true, etag: abcTag, size: 3});
  } finally {
    db.close();
  }
});

const objectEntry = new URL('../object.mts', import.meta.url);
const downloaderEntry = new URL('../downloader.mts', import.meta.url);
const upstreamEntry = new URL('./upstream.mts', import.meta.url);

test('unit: both entrypoints import silently with invalid configuration', async () => {
  const script = [objectEntry, downloaderEntry].map(url => `await import(${JSON.stringify(url.href)})`).join('\n');
  const {stdout, stderr} = await promisify(execFile)(
    process.execPath, ['--v8-pool-size=1', '--input-type=module', '--eval', script], {
      timeout: 5000, killSignal: 'SIGKILL',
      env: {PATH: process.env.PATH ?? '', UV_THREADPOOL_SIZE: '1', PORT: '-1',
        DB_PATH: ':memory:', OBJECT_ORIGIN: 'not-an-origin'},
    },
  );
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

async function withDatabaseFile(run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'immutable-range-'));
  try {
    await run(join(dir, 'objects.sqlite'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

async function withService(entry: URL, env: Record<string, string>, run: (url: string) => Promise<void>): Promise<void> {
  const service = await startService(entry, env);
  try {
    await run(service.url);
  } finally {
    await service.stop();
  }
}

function get(url: string, headers?: RequestInit['headers']): Promise<Response> {
  return fetch(url, {headers, signal: AbortSignal.timeout(5000)});
}

function putWire(url: string, wire: string, mediaType = 'application/json'): Promise<Response> {
  return fetch(url, {method: 'PUT', headers: {'content-type': mediaType}, body: wire, signal: AbortSignal.timeout(5000)});
}

async function expectJson(response: Response, status: number, expected: unknown): Promise<void> {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/);
  const body: unknown = await response.json();
  assert.deepEqual(body, expected);
}

async function expectBinary(
  response: Response, status: number, text: string, etag: string, contentRange: string | null = null,
): Promise<void> {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(response.headers.get('accept-ranges'), 'bytes');
  assert.equal(response.headers.get('etag'), etag);
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(text)));
  assert.equal(response.headers.get('content-range'), contentRange);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(text));
}

test('integration: independent services upload, resume a strict suffix, finish a prefix and restart a stale download', async () => {
  const text = ' A !z ';
  const etag = '"264d70584f98e8be7ca8f12df5abbf7a346c0185bb0eeb9a0c821e81ac352e7a"';
  await withDatabaseFile(async path => withService(objectEntry, {DB_PATH: path}, async source => {
    await withService(downloaderEntry, {OBJECT_ORIGIN: source + '/'}, async downloader => {
      const object = source + '/objects/o0';
      await expectJson(await putWire(object, JSON.stringify({text})), 201, {etag, size: 6});
      await expectJson(await putWire(object, JSON.stringify({text})), 200, {etag, size: 6});
      await expectJson(await putWire(object, JSON.stringify({text: text.trim()})), 409, errorBody('immutable_conflict'));
      await expectBinary(await get(object), 200, text, etag);

      for (const [range, bytes, contentRange] of [
        ['bytes=0-0', ' ', 'bytes 0-0/6'],
        ['bytes=1-3', 'A !', 'bytes 1-3/6'],
        ['bytes=4-999', 'z ', 'bytes 4-5/6'],
        ['bytes=2-', ' !z ', 'bytes 2-5/6'],
      ] satisfies [string, string, string][]) {
        await expectBinary(await get(object, {range, 'if-range': etag}), 206, bytes, etag, contentRange);
      }

      const resume = (prefix: string, tag: string | null) =>
        jsonRequest(downloader + '/resume', {id: 'o0', prefix, etag: tag});
      await expectJson(await resume('', null), 200, {text, etag, resumed: false});
      await expectJson(await resume(' A ', etag), 200, {text, etag, resumed: true});
      await expectJson(await resume(text, etag), 200, {text, etag, resumed: true});
      await expectJson(await resume('old bytes', staleTag), 200, {text, etag, resumed: false});
      await expectJson(await resume(' x ', etag), 502, errorBody('upstream_failure'));
      await expectJson(await resume(' A !x ', etag), 502, errorBody('upstream_failure'));
      await expectJson(await jsonRequest(downloader + '/resume', {...empty, id: 'o7'}), 404, errorBody('unknown_object'));
    });
  }));
});

test('integration: Range rejects invalid syntax and distinguishes 416 from a stale or weak If-Range', async () => {
  await withDatabaseFile(async path => withService(objectEntry, {DB_PATH: path}, async source => {
    const object = source + '/objects/o0';
    await expectJson(await putWire(object, '{"text":"abc"}'), 201, {etag: abcTag, size: 3});
    for (const value of [undefined, abcTag]) {
      const headers = new Headers({range: 'bytes=999-'});
      if (value) headers.set('if-range', value);
      const response = await get(object, headers);
      assert.equal(response.headers.get('etag'), abcTag);
      assert.equal(response.headers.get('content-range'), 'bytes */3');
      await expectJson(response, 416, errorBody('range_not_satisfiable'));
    }
    for (const ifRange of [staleTag, 'W/' + abcTag]) {
      await expectBinary(await get(object, {range: 'bytes=999-', 'if-range': ifRange}), 200, 'abc', abcTag);
    }
    await expectJson(await get(object, {range: 'bytes=2-1'}), 416, errorBody('range_not_satisfiable'));
    await expectBinary(await get(object, {'if-range': 'invalid'}), 200, 'abc', abcTag);
    for (const range of ['bytes=-1', 'bytes=00-1', 'bytes=0-0,2-2', 'bytes=1', 'bytes=-']) {
      await expectJson(await get(object, {range, 'if-range': staleTag}), 400, errorBody('invalid_range'));
    }
    for (const ifRange of ['Wed, 21 Oct 2015 07:28:00 GMT', 'W/"bad"', '*', abcTag + ', ' + abcTag]) {
      await expectJson(await get(object, {range: 'bytes=999-', 'if-range': ifRange}),
        400, errorBody('invalid_if_range'));
    }
  }));
});

test('integration: both routes reject invalid schemas and otherwise-valid oversized JSON without writing anything', async () => {
  await withDatabaseFile(async path => withService(objectEntry, {DB_PATH: path}, async source => {
    await withService(downloaderEntry, {OBJECT_ORIGIN: source}, async downloader => {
      const object = source + '/objects/o0';
      for (const body of [null, [], true, 1, 'abc', {}, {text: null}, {text: []}, {text: {toString: null}},
        {text: ''}, {text: 'a'.repeat(129)}, {text: 'é'}, {text: 'a', extra: true}]) {
        await expectJson(await putWire(object, JSON.stringify(body)), 400, errorBody('invalid_request'));
      }
      const overPut = JSON.stringify({text: 'abc'}).padEnd(8193);
      assert.deepEqual(JSON.parse(overPut), {text: 'abc'});
      await expectJson(await putWire(object, overPut), 413, errorBody('body_too_large'));
      await expectJson(await putWire(object, '{"text":"abc"}', 'text/plain'), 415, errorBody('unsupported_media_type'));
      await expectJson(await putWire(object, '{'), 400, errorBody('invalid_json'));
      await expectJson(await putWire(object + '?unexpected=1', '{"text":"abc"}'), 400, errorBody('invalid_request'));
      await expectJson(await putWire(source + '/objects/o8', '{"text":"abc"}'), 400, errorBody('invalid_request'));
      await expectJson(await get(object), 404, errorBody('unknown_object'));
      await expectJson(await putWire(object, '{"text":"abc"}'), 201, {etag: abcTag, size: 3});

      const resume = downloader + '/resume';
      for (const body of [null, [], false, 0, 'abc', {}, {...empty, id: {toString: null}}, {...empty, id: 'o8'},
        {...empty, prefix: {toString: null}}, {...empty, prefix: 'a'}, {...partial, etag: 'W/' + abcTag},
        {...empty, extra: true}]) {
        await expectJson(await jsonRequest(resume, body), 400, errorBody('invalid_request'));
      }
      const overResume = JSON.stringify(empty).padEnd(8193);
      assert.deepEqual(JSON.parse(overResume), empty);
      await expectJson(await fetch(resume, {method: 'POST', headers: {'content-type': 'application/json'},
        body: overResume, signal: AbortSignal.timeout(5000)}), 413, errorBody('body_too_large'));
      await expectJson(await jsonRequest(resume + '?unexpected=1', empty), 400, errorBody('invalid_request'));
      await expectJson(await jsonRequest(resume, empty), 200, {text: 'abc', etag: abcTag, resumed: false});
    });
  }));
});

test('integration: concurrent conflicting creates leave one durable representation across restart', async () => {
  await withDatabaseFile(async path => {
    let text = '';
    let etag = '';
    await withService(objectEntry, {DB_PATH: path}, async source => {
      const object = source + '/objects/o0';
      const [first, second] = await Promise.all([
        putWire(object, '{"text":"abc"}'),
        putWire(object, '{"text":"a bc"}'),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [201, 409]);
      text = first.status === 201 ? 'abc' : 'a bc';
      etag = '"' + createHash('sha256').update(text, 'utf8').digest('hex') + '"';
      await expectJson(first.status === 201 ? first : second, 201, {etag, size: Buffer.byteLength(text)});
      await expectJson(first.status === 409 ? first : second, 409, errorBody('immutable_conflict'));
      await expectBinary(await get(object), 200, text, etag);
    });
    await withService(objectEntry, {DB_PATH: path}, async source => {
      const object = source + '/objects/o0';
      await expectBinary(await get(object), 200, text, etag);
      await expectJson(await putWire(object, JSON.stringify({text})), 200, {etag, size: Buffer.byteLength(text)});
      await expectJson(await putWire(object, '{"text":"different"}'), 409, errorBody('immutable_conflict'));
      await expectBinary(await get(object), 200, text, etag);
    });
  });
});

test('integration: the downloader rejects adversarial HTTP bodies, statuses, redirects and stalls', async () => {
  await withService(upstreamEntry, {}, async destination => {
    await withService(upstreamEntry, {REDIRECT_ORIGIN: destination}, async source => {
      assert.notEqual(source, destination);
      await withService(downloaderEntry, {OBJECT_ORIGIN: source}, async downloader => {
        const resume = downloader + '/resume';
        const setMode = async (mode: string) => expectJson(await jsonRequest(source + '/mode', {mode}), 200, {ok: true});
        await expectJson(await jsonRequest(source + '/mode', {mode: {toString: null}}), 400, errorBody('invalid_request'));
        await expectJson(await get(destination + '/requests'), 200, {requests: 0});
        await setMode('redirect');
        await expectJson(await jsonRequest(resume, partial), 502, errorBody('upstream_failure'));
        await expectJson(await get(destination + '/requests'), 200, {requests: 0});
        await expectJson(await get(source + '/requests'), 200, {requests: 1});

        await setMode('valid-404-at-limit');
        await expectJson(await jsonRequest(resume, empty), 404, errorBody('unknown_object'));
        await setMode('large-404');
        const overflowStart = performance.now();
        await expectJson(await jsonRequest(resume, empty), 502, errorBody('upstream_failure'));
        const overflowElapsed = performance.now() - overflowStart;
        assert.ok(overflowElapsed < 450, `expected rejection on overflow before the deadline, observed ${overflowElapsed} ms`);

        for (const mode of ['wrong-404-code', 'wrong-404-schema', 'bad-404-json', 'wrong-status',
          'bad-media', 'conflicting-media', 'folded-media', 'bad-etag', 'bad-hash', 'short-body', 'large-object', 'gzip-object']) {
          await setMode(mode);
          await expectJson(await jsonRequest(resume, empty), 502, errorBody('upstream_failure'));
        }
        for (const mode of ['bad-206-start', 'bad-206-total']) {
          await setMode(mode);
          await expectJson(await jsonRequest(resume, partial), 502, errorBody('upstream_failure'));
        }
        for (const mode of ['wrong-416-code', 'bad-416-range']) {
          await setMode(mode);
          await expectJson(await jsonRequest(resume, finished), 502, errorBody('upstream_failure'));
        }
        for (const mode of ['header-stall', 'body-stall', 'json-stall', 'json-envelope-stall', 'header-and-body-delay']) {
          await setMode(mode);
          const start = performance.now();
          await expectJson(await jsonRequest(resume, empty), 502, errorBody('upstream_failure'));
          const elapsed = performance.now() - start;
          assert.ok(elapsed >= 450 && elapsed < 1200, `${mode}: expected a 500 ms deadline, observed ${elapsed} ms`);
        }
        await setMode('delayed-json-envelope-stall');
        const stalledStart = performance.now();
        await expectJson(await jsonRequest(resume, empty), 502, errorBody('upstream_failure'));
        const stalledElapsed = performance.now() - stalledStart;
        assert.ok(stalledElapsed >= 450 && stalledElapsed < 750,
          `expected the deadline to include delayed headers, observed ${stalledElapsed} ms`);

        await setMode('full');
        await expectJson(await jsonRequest(resume, empty), 200, {text: 'abc', etag: abcTag, resumed: false});
      });
    });
  });
});
