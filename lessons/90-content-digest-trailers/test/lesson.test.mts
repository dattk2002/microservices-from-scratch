import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { IncomingMessage, Server, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { BlobVerification, ingestBlob } from '../digest.mts';
import type { Receipt } from '../digest.mts';
import { requireBodyless, serve } from '../http.mts';
import { normalizeProducerOrigin, validateBlobHeaders } from '../upstream.mts';

const binary = Buffer.from('0041ff0d0a7f', 'hex');
const binaryReceipt = {
  bytes: 6, sha256: 'd314dd5147e1c32854a780628dec9bace07700ea979c214dc3a09448d1205c3b',
};
const binaryDigest = 'sha-256=:0xTdUUfhwyhUp4BijeybrOB3AOqXnCFNw6CUSNEgXDs=:';
const binaryTrailers = ['Content-Digest', binaryDigest];
const priorReceipt = {
  bytes: 1, sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
};
const activeSignal = () => new AbortController().signal;
const upstreamFailure = {message: 'upstream_failure'};

test('unit: split binary chunks produce a verified receipt and then commit it', async () => {
  const commits: Receipt[] = [];
  const receipt = await ingestBlob(async verification => {
    verification.add(binary.subarray(0, 3));
    verification.add(binary.subarray(3));
    assert.deepEqual(commits, []);
    return verification.finish(true, binaryTrailers);
  }, value => commits.push(value), activeSignal(), () => 0);

  assert.deepEqual(receipt, binaryReceipt);
  assert.deepEqual(commits, [binaryReceipt]);
});

test('unit: flipping one content byte rejects before replacing the previous receipt', async () => {
  let stored = priorReceipt;
  await assert.rejects(ingestBlob(async verification => {
    verification.add(Buffer.from('0041fe', 'hex'));
    verification.add(binary.subarray(3));
    return verification.finish(true, binaryTrailers);
  }, value => { stored = value; }, activeSignal(), () => 0), upstreamFailure);
  assert.deepEqual(stored, priorReceipt);
});

test('unit: verification accepts empty content and exactly 1024 arbitrary octets', () => {
  const empty = new BlobVerification(() => 0);
  assert.deepEqual(empty.finish(true, [
    'CONTENT-DIGEST', ' \tsha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:\t ',
  ]), {bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'});

  const full = new BlobVerification(() => 0);
  full.add(Buffer.alloc(1023, 255));
  full.add(Buffer.of(255));
  assert.deepEqual(full.finish(true, [
    'content-digest', 'sha-256=:X07Nt7ccPkA5g/5AXN3NwvJXa2Vf2z6A2UpvfDLli8I=:',
  ]), {bytes: 1024, sha256: '5f4ecdb7b71c3e403983fe405cddcdc2f2576b655fdb3e80d94a6f7c32e58bc2'});
});

test('unit: the 1025th content octet is rejected as soon as it arrives', () => {
  const verification = new BlobVerification(() => 0);
  verification.add(Buffer.alloc(1024, 255));
  assert.throws(() => verification.add(Buffer.of(255)), upstreamFailure);
});

test('unit: only one canonical SHA-256 member in the sole expected trailer is valid', () => {
  const invalid = [
    [],
    [...binaryTrailers, 'content-digest', binaryDigest],
    [...binaryTrailers, 'X-Other', '1'],
    ['X-Other', binaryDigest],
    ['Content-Digest', binaryDigest.replace('Ds=', 'Dt=')], // Same decoded bytes, nonzero padding bits.
    ['Content-Digest', binaryDigest.replace('=:', ':')],
    ['Content-Digest', binaryDigest.replace('TdUU', 'Td UU')],
    ['Content-Digest', binaryDigest.replace('sha-256', 'SHA-256')],
    ['Content-Digest', 'sha-256=:AA==:'],
    ['Content-Digest', binaryDigest + ';key=1'],
    ['Content-Digest', binaryDigest + ', ' + binaryDigest],
  ];
  for (const fields of invalid) {
    const verification = new BlobVerification(() => 0);
    verification.add(binary);
    assert.throws(() => verification.finish(true, fields), upstreamFailure, JSON.stringify(fields));
  }
});

test('unit: intact content and digest require a complete HTTP message', () => {
  const verification = new BlobVerification(() => 0);
  verification.add(binary);
  assert.throws(() => verification.finish(false, binaryTrailers), upstreamFailure);
});

test('unit: a digest at the 500ms boundary is too late', () => {
  let now = 10;
  const verification = new BlobVerification(() => now);
  now = 509;
  verification.add(binary);
  now = 510;
  assert.throws(() => verification.finish(true, binaryTrailers), upstreamFailure);
});

test('unit: deadline is rechecked at commit even after timely verification', async () => {
  let now = 0;
  let stored = priorReceipt;
  let verified: Receipt | undefined;
  await assert.rejects(ingestBlob(async verification => {
    verification.add(binary);
    now = 499;
    verified = verification.finish(true, binaryTrailers);
    now = 500;
    return verified;
  }, value => { stored = value; }, activeSignal(), () => now), upstreamFailure);
  assert.deepEqual(verified, binaryReceipt);
  assert.deepEqual(stored, priorReceipt);
});

test('unit: caller cancellation after verification prevents a commit', async () => {
  const caller = new AbortController();
  let stored = priorReceipt;
  await assert.rejects(ingestBlob(async verification => {
    verification.add(binary);
    const receipt = verification.finish(true, binaryTrailers);
    caller.abort();
    return receipt;
  }, value => { stored = value; }, caller.signal, () => 0), upstreamFailure);
  assert.equal(caller.signal.aborted, true);
  assert.deepEqual(stored, priorReceipt);
});

const blobHeaders = [
  'Content-Type', 'application/octet-stream', 'Transfer-Encoding', 'chunked', 'Trailer', 'Content-Digest',
];

test('unit: a blob accepts case-insensitive token fields and optional identity coding', () => {
  assert.doesNotThrow(() => validateBlobHeaders(200, blobHeaders));
  assert.doesNotThrow(() => validateBlobHeaders(200, [
    'content-type', ' Application/Octet-Stream\t', 'Transfer-Encoding', 'CHUNKED',
    'Trailer', 'content-digest', 'Content-Encoding', 'IDENTITY',
  ]));
});

test('unit: status, raw field counts and entire representation fields must match', () => {
  const invalid = [
    {status: 421, fields: blobHeaders},
    {status: 200, fields: blobHeaders.slice(0, -2)},
    {status: 200, fields: [...blobHeaders.slice(0, -1), 'Content-Digest, Other']},
    {status: 200, fields: [...blobHeaders.slice(0, -2), 'Content-Digest', binaryDigest]},
    {status: 200, fields: [...blobHeaders, 'Content-Digest', binaryDigest]},
    {status: 200, fields: [...blobHeaders, 'content-type', 'application/octet-stream']},
    {status: 200, fields: [...blobHeaders, 'Trailer', 'Content-Digest']},
    {status: 200, fields: [...blobHeaders, 'transfer-encoding', 'chunked']},
    {status: 200, fields: [...blobHeaders, 'Content-Length', '6']},
    {status: 200, fields: [...blobHeaders, 'Content-Encoding', 'gzip']},
    {status: 200, fields: [...blobHeaders, 'Content-Encoding', 'identity', 'content-encoding', 'identity']},
    {status: 200, fields: ['Content-Type', 'application/octet-stream; charset=utf-8', ...blobHeaders.slice(2)]},
    {status: 200, fields: ['Content-Type', 'application/octet-stream, image/png', ...blobHeaders.slice(2)]},
    {status: 200, fields: [...blobHeaders.slice(0, 3), 'gzip, chunked', ...blobHeaders.slice(4)]},
  ];
  for (const {status, fields} of invalid) {
    assert.throws(() => validateBlobHeaders(status, fields), upstreamFailure, JSON.stringify({status, fields}));
  }
});

test('unit: producer origin accepts only the configured loopback HTTP authority', () => {
  assert.equal(normalizeProducerOrigin('http://127.0.0.1/'), 'http://127.0.0.1');
  assert.equal(normalizeProducerOrigin('http://127.0.0.1:3090/'), 'http://127.0.0.1:3090');
  assert.equal(normalizeProducerOrigin('http://127.0.0.1:80'), 'http://127.0.0.1');
  for (const value of [
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1/blob',
    'http://127.0.0.1?', 'http://127.0.0.1/#', 'http://user@127.0.0.1',
    'http://localhost:3090', 'http://127.1', 'https://127.0.0.1', 'http://127.0.0.1\n',
  ]) {
    assert.throws(() => normalizeProducerOrigin(value), /Invalid PRODUCER_ORIGIN/);
  }
});

test('unit: a storage error rejects even after a correct digest', async () => {
  const failure = new Error('database write failed');
  await assert.rejects(ingestBlob(async verification => {
    verification.add(binary);
    return verification.finish(true, binaryTrailers);
  }, () => { throw failure; }, activeSignal(), () => 0), error => error === failure);
});

function startWithoutNetwork(t: TestContext, handler: Parameters<typeof serve>[2]) {
  let owner: Server | undefined;
  t.mock.method(Server.prototype, 'listen', function (this: Server) {
    owner = this;
    return this;
  });
  const readiness = t.mock.method(console, 'log', () => {});
  const signalListeners = new Set(process.listeners('SIGTERM'));
  const running = serve('test', 0, handler);
  const settled = Promise.allSettled([running]);
  assert.ok(owner);
  const server = owner;
  const stop = process.listeners('SIGTERM').find(listener => !signalListeners.has(listener));
  t.after(async () => {
    stop?.('SIGTERM');
    if (server.listenerCount('listening') !== 0 && server.listenerCount('error') !== 0) {
      server.emit('error', new Error('fixture stopped before readiness'));
    }
    await settled;
  });
  return {server, running, readiness};
}

function bodylessRequest(t: TestContext) {
  const socket = new Socket();
  t.after(() => { socket.destroy(); });
  const req = new IncomingMessage(socket);
  req.method = 'GET';
  req.url = '/blob?x=1';
  return {req, res: new ServerResponse(req)};
}

test('unit: an extension expectation still goes through bodyless query validation', t => {
  const {server} = startWithoutNetwork(t, (req, res) => requireBodyless(req, res, 'GET'));
  const {req, res} = bodylessRequest(t);
  req.headers.expect = 'custom';
  server.emit('checkExpectation', req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.getHeader('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.writableEnded, true);
});

test('unit: a late accept error aborts active work before listener and owner cleanup', async t => {
  const events: string[] = [];
  const {server, running} = startWithoutNetwork(t, (_req, _res, shutdown) => {
    shutdown.addEventListener('abort', () => events.push('abort'), {once: true});
  });
  t.mock.method(server, 'address', () => ({address: '127.0.0.1', family: 'IPv4', port: 4090}));
  Object.defineProperty(server, 'listening', {value: true, configurable: true});
  t.mock.method(server, 'close', (done?: () => void) => {
    events.push('close');
    queueMicrotask(() => {
      events.push('closed');
      done?.();
    });
    return server;
  });
  const owner = running.finally(() => events.push('owner cleanup'));
  const settled = Promise.allSettled([owner]);
  const {req, res} = bodylessRequest(t);
  server.emit('listening');
  await setImmediate();
  server.emit('request', req, res);

  const failure = new Error('accept EMFILE');
  assert.doesNotThrow(() => server.emit('error', failure));
  assert.deepEqual(await settled, [{status: 'rejected', reason: failure}]);
  assert.deepEqual(events, ['abort', 'close', 'closed', 'owner cleanup']);
});

test('unit: a listen failure rejects the server owner before readiness', async t => {
  const {server, running, readiness} = startWithoutNetwork(t, () => assert.fail('no request expected'));
  const failure = new Error('listen EADDRINUSE');
  server.emit('error', failure);
  await assert.rejects(running, error => error === failure);
  assert.equal(readiness.mock.callCount(), 0);
});

test('unit: both entrypoints import silently with invalid startup settings', async () => {
  const run = promisify(execFile);
  const producer = new URL('../producer.mts', import.meta.url);
  const consumer = new URL('../consumer.mts', import.meta.url);
  const {stdout, stderr} = await run(process.execPath, [
    '--v8-pool-size=1', '--input-type=module', '--eval',
    `await import(${JSON.stringify(producer.href)}); await import(${JSON.stringify(consumer.href)});`,
  ], {
    env: {
      PATH: process.env.PATH ?? '', PORT: 'bad', PRODUCER_ORIGIN: 'invalid',
      DB_PATH: '', UV_THREADPOOL_SIZE: '1',
    },
    timeout: 5000,
  });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});
