import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { blobFields, call, chunkedWire, openPeer, waitForRequests } from './wire.mts';
import type { Reply } from './wire.mts';

const producerEntry = new URL('../producer.mts', import.meta.url);
const consumerEntry = new URL('../consumer.mts', import.meta.url);
const binary = Buffer.from('0041ff0d0a7f', 'hex');
const binaryReceipt = {
  bytes: 6, sha256: 'd314dd5147e1c32854a780628dec9bace07700ea979c214dc3a09448d1205c3b',
};
const priorReceipt = {
  bytes: 1, sha256: '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
};
const emptyReceipt = {
  bytes: 0, sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};
const binaryTrailer = 'Content-Digest: sha-256=:0xTdUUfhwyhUp4BijeybrOB3AOqXnCFNw6CUSNEgXDs=:';
const binaryDigest = binaryTrailer.slice('Content-Digest: '.length);
const priorWire = chunkedWire(Buffer.from('x'), [
  'Content-Digest: sha-256=:LXEWQrcmsEQBYnyp+6wy9chTD7GQPMTbAiWHF5IaSIE=:',
]);
const binaryWire = chunkedWire(binary, [binaryTrailer]);
const filler = Array.from({length: 1100}, () => 'x: y');
const paddedBinaryWire = (padding: number) => chunkedWire(binary, [binaryTrailer], {
  fields: [...blobFields, 'X-Padding: ' + 'a'.repeat(padding)],
});

function expectJson(reply: Reply, status: number, value: unknown): void {
  assert.equal(reply.status, status);
  assert.equal(reply.headers['content-type'], 'application/json; charset=utf-8');
  assert.ok(reply.body.length <= 8192);
  const decoded: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(reply.body));
  assert.deepEqual(decoded, value);
}

function expectError(reply: Reply, status: number, code: string): void {
  expectJson(reply, status, {error: {code, message: code}});
}

async function withDb(work: (dbPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'content-digest-'));
  try {
    await work(join(dir, 'receipt.sqlite'));
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
}

async function withConsumer(
  dbPath: string, origin: string, work: (consumer: RunningService) => Promise<void>,
): Promise<void> {
  const consumer = await startService(consumerEntry, {PRODUCER_ORIGIN: origin, DB_PATH: dbPath});
  try {
    await work(consumer);
  } finally {
    await consumer.stop();
  }
}

test('integration: the real producer emits binary content and a trailer, and the consumer persists the receipt', async () => {
  const producer = await startService(producerEntry);
  try {
    const blob = await call(producer.url, 'GET', '/blob');
    assert.equal(blob.status, 200);
    assert.deepEqual(blob.body, binary);
    assert.equal(blob.headers['content-type'], 'application/octet-stream');
    assert.equal(blob.headers['transfer-encoding'], 'chunked');
    assert.equal(blob.headers.trailer, 'Content-Digest');
    assert.equal(blob.headers['content-length'], undefined);
    assert.equal(blob.headers['content-digest'], undefined);
    assert.deepEqual(blob.rawTrailers.map((field, index) => index === 0 ? field.toLowerCase() : field),
      ['content-digest', binaryDigest]);

    await withDb(async dbPath => {
      await withConsumer(dbPath, producer.url, async ({url}) => {
        expectError(await call(url, 'GET', '/receipt'), 404, 'no_receipt');
        expectJson(await call(url, 'POST', '/ingest'), 200, binaryReceipt);
        expectJson(await call(url, 'GET', '/receipt'), 200, binaryReceipt);
      });
      await withConsumer(dbPath, producer.url, async ({url}) => {
        expectJson(await call(url, 'GET', '/receipt'), 200, binaryReceipt);
      });
    });
  } finally {
    await producer.stop();
  }
});

test('integration: public routing and bodyless errors use the exact envelope before any outbound dial', async t => {
  const peer = await openPeer(t, socket => socket.end(priorWire));
  const producer = await startService(producerEntry);
  try {
    await withDb(async dbPath => {
      await withConsumer(dbPath, peer.origin, async ({url}) => {
        for (const [origin, route, method] of [
          [producer.url, '/blob', 'GET'], [url, '/receipt', 'GET'], [url, '/ingest', 'POST'],
        ]) {
          if (!origin || !route || !method) throw new Error('Incomplete endpoint fixture');
          expectError(await call(origin, method, '/unknown'), 404, 'not_found');
          const wrong = await call(origin, 'PUT', route);
          expectError(wrong, 405, 'method_not_allowed');
          assert.equal(wrong.headers.allow, method);
          expectError(await call(origin, method, route + '?limit=0'), 400, 'invalid_query');
          expectError(await call(origin, method, route + '?'), 400, 'invalid_query');
          expectError(await call(origin, method, route + '?x=1', {
            headers: {Expect: 'custom'},
          }), 400, 'invalid_query');
          expectError(await call(origin, method, route, {
            headers: {'content-length': '1'}, body: 'x',
          }), 400, 'invalid_body');

          // A late framing field still matters after more than the native default field count.
          const headers = ['Host', new URL(origin).host, 'Connection', 'close'];
          for (const _ of filler) headers.push('x', 'y');
          headers.push('Transfer-Encoding', 'chunked');
          expectError(await call(origin, method, route, {headers}), 400, 'invalid_body');
        }
        assert.equal(peer.connections, 0);
        assert.equal(peer.requests.length, 0);
      });
    });
  } finally {
    await producer.stop();
  }
});

test('integration: malformed and unexpected peer replies preserve a different committed receipt', async t => {
  const redirect = await openPeer(t, socket => socket.end(binaryWire));
  let reply = (socket: Socket) => { socket.end(priorWire); };
  const peer = await openPeer(t, socket => reply(socket));
  assert.notEqual(redirect.origin, peer.origin);

  await withDb(async dbPath => {
    await withConsumer(dbPath, peer.origin, async ({url}) => {
      expectJson(await call(url, 'POST', '/ingest'), 200, priorReceipt);
      assert.equal(peer.connections, 1);
      assert.equal(peer.requests.length, 1);
      const first = peer.requests[0];
      assert.ok(first);
      assert.match(first.head, /^GET \/blob HTTP\/1\.1\r\n/);
      assert.match(first.head, /\r\nTE: trailers(?:\r\n|$)/i);
      assert.match(first.head, /\r\nConnection: TE, close(?:\r\n|$)/i);
      assert.match(first.head, /\r\nAccept-Encoding: identity(?:\r\n|$)/i);

      const overLimit = Buffer.alloc(1025, 255);
      const oversizedTrailer = 'Content-Digest: sha-256=:' + createHash('sha256').update(overLimit).digest('base64') + ':';
      const cases: [string, Buffer][] = [
        ['missing trailer', chunkedWire(binary, [])],
        ['duplicate trailer lines', chunkedWire(binary, [binaryTrailer, 'content-digest: ' + binaryDigest])],
        ['unadvertised extra trailer', chunkedWire(binary, [binaryTrailer, 'X-Extra: 1'])],
        ['noncanonical digest', chunkedWire(binary, [binaryTrailer.replace('Ds=', 'Dt=')])],
        ['digest only in initial headers', chunkedWire(binary, [], {fields: [...blobFields, binaryTrailer]})],
        ['digest in both sections', chunkedWire(binary, [binaryTrailer], {fields: [...blobFields, binaryTrailer]})],
        ['wrong Trailer advertisement', chunkedWire(binary, [binaryTrailer], {fields: [
          ...blobFields.slice(0, -1), 'Trailer: Other',
        ]})],
        ['missing Trailer advertisement', chunkedWire(binary, [binaryTrailer], {fields: blobFields.slice(0, -1)})],
        ['duplicate Trailer advertisement', chunkedWire(binary, [binaryTrailer], {
          fields: [...blobFields, 'Trailer: Content-Digest'],
        })],
        ['unexpected coding', chunkedWire(binary, [binaryTrailer], {fields: [...blobFields, 'Content-Encoding: gzip']})],
        ['late duplicate media type', chunkedWire(binary, [binaryTrailer], {fields: [
          ...blobFields, ...filler, 'content-type: application/octet-stream',
        ]})],
        ['valid blob with headers above 8192 bytes', paddedBinaryWire(8500)],
        ['valid digest but 421 once', chunkedWire(binary, [binaryTrailer], {status: '421 Misdirected Request'})],
        ['reachable redirect stays untouched', chunkedWire(binary, [binaryTrailer], {
          status: '307 Temporary Redirect', fields: [...blobFields, 'Location: ' + redirect.origin + '/blob'],
        })],
        ['wrong hash', chunkedWire(Buffer.from('0041fe0d0a7f', 'hex'), [binaryTrailer])],
        ['valid wire over content limit', chunkedWire(overLimit, [oversizedTrailer])],
        ['FIN in the middle of chunk data', chunkedWire(binary, []).subarray(0, -11)],
        ['FIN before the last terminating CRLF', binaryWire.subarray(0, -2)],
      ];

      for (const [name, wire] of cases) {
        const beforeConnections: number = peer.connections;
        const before: number = peer.requests.length;
        reply = socket => { socket.end(wire); };
        const rejected = await call(url, 'POST', '/ingest');
        // Allow accepted sockets that never write headers to reach either fixture.
        await pause(25);
        assert.equal(peer.connections, beforeConnections + 1, name);
        assert.equal(peer.requests.length, before + 1, name);
        assert.equal(redirect.connections, 0, name);
        assert.equal(redirect.requests.length, 0, name);
        assert.equal(rejected.status, 502, name);
        expectError(rejected, 502, 'upstream_failure');
        expectJson(await call(url, 'GET', '/receipt'), 200, priorReceipt);
      }

      const before: number = peer.requests.length;
      const beforeConnections: number = peer.connections;
      const headEnd = binaryWire.indexOf('\r\n\r\n') + 4;
      const split = headEnd + Buffer.byteLength('6\r\n') + 3;
      const timers: NodeJS.Timeout[] = [];
      let progressWrites = 0;
      try {
        reply = socket => {
          socket.write(binaryWire.subarray(0, headEnd));
          timers.push(setTimeout(() => {
            if (socket.destroyed || socket.readableEnded) return;
            socket.write(binaryWire.subarray(headEnd, split));
            progressWrites++;
          }, 160));
          timers.push(setTimeout(() => {
            if (socket.destroyed || socket.readableEnded) return;
            // All content and the digest line arrive. Only the final CRLF is withheld.
            socket.write(binaryWire.subarray(split, -2));
            progressWrites++;
          }, 340));
        };
        const started = performance.now();
        expectError(await call(url, 'POST', '/ingest'), 502, 'upstream_failure');
        const stalled = peer.requests[before];
        assert.ok(stalled);
        await expectEarlyDisconnect(stalled.disconnected);
        const elapsed = performance.now() - started;
        assert.equal(progressWrites, 2);
        assert.ok(elapsed >= 450, `the final CRLF was withheld for ${elapsed}ms`);
        assert.ok(elapsed < 740, `one 500ms deadline despite progress, got ${elapsed}ms`);
        assert.equal(peer.connections, beforeConnections + 1);
        assert.equal(peer.requests.length, before + 1);
      } finally {
        for (const timer of timers) clearTimeout(timer);
      }
      expectJson(await call(url, 'GET', '/receipt'), 200, priorReceipt);

      reply = socket => { socket.end(paddedBinaryWire(7800)); };
      expectJson(await call(url, 'POST', '/ingest'), 200, binaryReceipt);
      expectJson(await call(url, 'GET', '/receipt'), 200, binaryReceipt);
      assert.equal(peer.connections, 1 + cases.length + 2);
      assert.equal(redirect.connections, 0);
    });
  });
});

test('integration: a SQLite writer lock rejects a verified write and preserves the previous receipt', async t => {
  let wire = priorWire;
  const peer = await openPeer(t, socket => socket.end(wire));
  await withDb(async dbPath => {
    await withConsumer(dbPath, peer.origin, async ({url}) => {
      expectJson(await call(url, 'POST', '/ingest'), 200, priorReceipt);
      const { DatabaseSync } = await import('node:sqlite');
      const locker = new DatabaseSync(dbPath, {timeout: 0});
      try {
        locker.exec('BEGIN IMMEDIATE');
        try {
          wire = binaryWire;
          expectError(await call(url, 'POST', '/ingest'), 500, 'internal_error');
          expectJson(await call(url, 'GET', '/receipt'), 200, priorReceipt);
        } finally {
          locker.exec('ROLLBACK');
        }
      } finally {
        locker.close();
      }
      expectJson(await call(url, 'GET', '/receipt'), 200, priorReceipt);
      expectJson(await call(url, 'POST', '/ingest'), 200, binaryReceipt);
    });
  });
});

test('integration: a full trailer block is sufficient while the peer withholds TCP FIN', async t => {
  const barrier = new AbortController();
  try {
    const peer = await openPeer(t, socket => {
      socket.write(chunkedWire(Buffer.alloc(0), [
        'cOnTeNt-DiGeSt: sha-256=:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=:',
      ], {fields: [...blobFields, 'Content-Encoding: IDENTITY']}));
      barrier.signal.addEventListener('abort', () => socket.end(), {once: true});
    });
    await withDb(async dbPath => {
      await withConsumer(dbPath, peer.origin, async ({url}) => {
        expectJson(await call(url, 'POST', '/ingest'), 200, emptyReceipt);
        const request = peer.requests[0];
        assert.ok(request);
        assert.equal(request.socket.writableEnded, false);
        assert.equal(peer.requests.length, 1);
        expectJson(await call(url, 'GET', '/receipt'), 200, emptyReceipt);
      });
    });
  } finally {
    barrier.abort();
  }
});

test('integration: eight held calls reject a ninth without dialing and leave local reads available', async t => {
  let hold = false;
  const peer = await openPeer(t, socket => {
    if (!hold) socket.end(priorWire);
  });
  await withDb(async dbPath => {
    await withConsumer(dbPath, peer.origin, async ({url}) => {
      expectJson(await call(url, 'POST', '/ingest'), 200, priorReceipt);
      hold = true;
      const controllers = Array.from({length: 8}, () => new AbortController());
      const replies = controllers.map(({signal}) => call(url, 'POST', '/ingest', {signal}));
      const settled = Promise.allSettled(replies);
      try {
        await waitForRequests(peer.requests, 9);
        expectError(await call(url, 'POST', '/ingest'), 503, 'busy');
        await pause(25);
        assert.equal(peer.connections, 9);
        assert.equal(peer.requests.length, 9);
        expectJson(await call(url, 'GET', '/receipt'), 200, priorReceipt);
        assert.equal(peer.connections, 9);
        assert.equal(peer.requests.length, 9);

        const released = peer.requests[1];
        assert.ok(released);
        released.socket.end(binaryWire);
        expectJson(await Promise.race(replies), 200, binaryReceipt);
        expectJson(await call(url, 'GET', '/receipt'), 200, binaryReceipt);
        hold = false;
        expectJson(await call(url, 'POST', '/ingest'), 200, priorReceipt);
        assert.equal(peer.connections, 10);
        assert.equal(peer.requests.length, 10);
      } finally {
        for (const controller of controllers) controller.abort();
        await settled;
      }
    });
  });
});

test('integration: caller disconnect and process shutdown cancel an unfinished peer exchange', async t => {
  const peer = await openPeer(t, socket => { socket.write(binaryWire.subarray(0, -2)); });
  await withDb(async dbPath => {
    await withConsumer(dbPath, peer.origin, async consumer => {
      const caller = new AbortController();
      const callerGone = assert.rejects(call(consumer.url, 'POST', '/ingest', {signal: caller.signal}),
        {code: 'ABORT_ERR'});
      const callerSettled = Promise.allSettled([callerGone]);
      try {
        await waitForRequests(peer.requests, 1);
        const first = peer.requests[0];
        assert.ok(first);
        caller.abort();
        await callerGone;
        await expectEarlyDisconnect(first.disconnected);
      } finally {
        caller.abort();
        await callerSettled;
      }
      expectError(await call(consumer.url, 'GET', '/receipt'), 404, 'no_receipt');

      const interrupted = call(consumer.url, 'POST', '/ingest').then(
        reply => expectError(reply, 502, 'upstream_failure'),
        () => { /* Shutdown may close the caller socket before the response is sent. */ },
      );
      const shutdownSettled = Promise.allSettled([interrupted]);
      try {
        await waitForRequests(peer.requests, 2);
        const second = peer.requests[1];
        assert.ok(second);
        await Promise.all([consumer.stop(), expectEarlyDisconnect(second.disconnected)]);
        await interrupted;
      } finally {
        await shutdownSettled;
      }
    });
  });
});

async function expectEarlyDisconnect(disconnected: Promise<void>): Promise<void> {
  const timer = new AbortController();
  try {
    assert.equal(await Promise.race([
      disconnected, pause(300, 'peer still open', {signal: timer.signal, ref: false}),
    ]), undefined);
  } finally {
    timer.abort();
  }
}
