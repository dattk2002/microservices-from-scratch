import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, IncomingMessage } from 'node:http';
import { Duplex } from 'node:stream';
import { createConnection, Socket } from 'node:net';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { startService } from '../../../test/support.mts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Decoder, encodeFrame, type FrameEvent } from '../codec.mts';
import { Heartbeat } from '../heartbeat.mts';
import { validSwitchingResponse } from '../client.mts';
import { createLessonServer, validHost } from '../server.mts';
import { boundedWriter, CloseState, closeWindow } from '../transport.mts';

function masked(firstByte: number, payload: Buffer | string): Buffer {
  const body = Buffer.from(typeof payload === 'string' ? Buffer.from(payload) : payload);
  const key = Buffer.from([6, 9, 12, 15]);
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = firstByte;
  header[1] = body.length < 126 ? 128 + body.length : 254;
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  for (let i = 0; i < body.length; i++) body[i] = body[i]! ^ key[i % 4]!;
  return Buffer.concat([header, key, body]);
}

function decode(...inputs: Buffer[]): FrameEvent[] {
  const decoder = new Decoder();
  const events: FrameEvent[] = [];
  for (const input of inputs) decoder.feed(input, (event) => { events.push(event); });
  return events;
}

test('unit: coalesced frames decode at every split including a multibyte UTF-8 continuation and an interleaved ping', () => {
  const input = Buffer.concat([
    masked(0x01, Buffer.from([0xe2, 0x82])), masked(0x89, 'probe'),
    masked(0x80, Buffer.from([0xac])), masked(0x81, 'x'.repeat(126)),
  ]);
  const expected = [
    { kind: 'ping', payload: Buffer.from('probe') },
    { kind: 'text', text: '€' },
    { kind: 'text', text: 'x'.repeat(126) },
  ];
  for (let i = 0; i <= input.length; i++) {
    assert.deepEqual(decode(input.subarray(0, i), input.subarray(i)), expected);
  }
  assert.deepEqual(decode(...Array.from(input, (byte) => Buffer.from([byte]))), expected);
});

test('unit: invalid frame headers fail before payload and stop decoding', () => {
  for (const hex of [
    '8101', 'c180', '8380', '0980', '89fe', '80ff', '81fe007d',
    '81ff000000000000ffff', '81ff8000000000000000',
  ]) {
    assert.deepEqual(decode(Buffer.from(hex, 'hex'), masked(0x81, 'later')),
      [{ kind: 'error', code: 1002 }], hex);
  }
});

test('unit: exact message limit works across fragments and excess declared length fails early', () => {
  const half = 'a'.repeat(2048);
  assert.deepEqual(decode(masked(0x01, half), masked(0x80, half)),
    [{ kind: 'text', text: half + half }]);
  const text = '\uFEFF' + 'b'.repeat(4093);
  assert.deepEqual(decode(masked(0x81, text)), [{ kind: 'text', text }]);
  for (const inputs of [
    [masked(0x01, half), Buffer.from('80fe0801', 'hex')],
    [Buffer.from('81fe1001', 'hex')],
    [Buffer.from('81ff7fffffffffffffff', 'hex')],
  ]) {
    assert.deepEqual(decode(...inputs), [{ kind: 'error', code: 1009 }]);
  }
});

test('unit: incomplete UTF-8 and invalid close reasons fail with 1007', () => {
  assert.deepEqual(decode(masked(0x81, Buffer.from([0xe2]))), [{ kind: 'error', code: 1007 }]);
  assert.deepEqual(decode(masked(0x88, Buffer.from([3, 232, 255]))), [{ kind: 'error', code: 1007 }]);
});

test('unit: binary and malformed close codes fail with their respective codes', () => {
  assert.deepEqual(decode(masked(0x82, 'bin')), [{ kind: 'error', code: 1003 }]);
  for (const payload of [Buffer.from([3]), Buffer.from([3, 238])]) {
    assert.deepEqual(decode(masked(0x88, payload)), [{ kind: 'error', code: 1002 }]);
  }
  const payload = Buffer.from([3, 232, 65]);
  assert.deepEqual(decode(masked(0x88, payload), masked(0x81, 'late')),
    [{ kind: 'close', payload }]);
});

test('unit: only a matching timely pong clears the deadline', () => {
  let now = 0;
  let serial = 0;
  const heartbeat = new Heartbeat(() => now, () => Buffer.from([++serial]));
  assert.equal(heartbeat.tick(), undefined);
  assert.equal(heartbeat.delay(), 250);
  now = 250;
  assert.deepEqual(heartbeat.tick(), Buffer.from([1]));
  now = 500;
  heartbeat.pong(Buffer.from([99]));
  assert.equal(heartbeat.delay(), 750);
  assert.equal(heartbeat.tick(), undefined);
  now = 600;
  heartbeat.pong(Buffer.from([1]));
  assert.equal(heartbeat.delay(), 0);
  assert.deepEqual(heartbeat.tick(), Buffer.from([2]));
  now = 1599;
  assert.equal(heartbeat.tick(), undefined);
  now = 1600;
  heartbeat.pong(Buffer.from([2]));
  assert.equal(heartbeat.tick(), 'expired');
});

function handshake(port: number, options: { target?: string; version?: string; method?: string; fields?: string[] } = {}): string {
  return [
    `${options.method ?? 'GET'} ${options.target ?? '/events'} HTTP/${options.version ?? '1.1'}`,
    `Host: 127.0.0.1:${port}`,
    'Connection: keep-alive, Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    ...(options.fields ?? []),
    '', '',
  ].join('\r\n');
}

function wirePeer(sockets: Set<Socket>, port: number, request: string, head: Buffer = Buffer.alloc(0)) {
  const socket = createConnection({ host: '127.0.0.1', port });
  sockets.add(socket);
  const peer = readWire(socket, false, () => { sockets.delete(socket); });
  socket.write(Buffer.concat([Buffer.from(request), head]));
  return peer;
}

function readWire(socket: Duplex, expectMask: boolean, onClose: () => void = () => {}) {
  const deadline = performance.now() + 5000;
  const expiry = setTimeout(() => socket.destroy(new Error('wire deadline')), 5000);
  let pending = Buffer.alloc(0);
  let failure: Error | undefined;
  let ended = false;
  let wake: (() => void) | undefined;
  socket.on('data', (chunk: Buffer) => {
    if (pending.length + chunk.length > 8192) {
      socket.destroy(new Error('wire buffer exceeded'));
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    wake?.();
  });
  socket.on('error', (error) => {
    failure = error;
    wake?.();
  });
  socket.once('close', () => {
    ended = true;
    onClose();
    clearTimeout(expiry);
    wake?.();
  });
  async function until(size: (bytes: Buffer) => number | undefined): Promise<Buffer> {
    try {
      for (;;) {
        if (failure) throw failure;
        if (performance.now() >= deadline) throw new Error('wire deadline');
        const count = size(pending);
        if (count !== undefined && pending.length >= count) {
          const result = pending.subarray(0, count);
          pending = pending.subarray(count);
          return result;
        }
        if (ended) throw new Error('unexpected wire EOF');
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      wake = undefined;
    }
  }

  return {
    destroy() { socket.destroy(); },
    send(frame: Buffer) { socket.write(frame); },
    async headers() {
      return (await until((bytes) => {
        const end = bytes.indexOf('\r\n\r\n');
        if (end >= 0) return end + 4;
      })).toString('ascii');
    },
    async json(length: number): Promise<unknown> {
      return JSON.parse((await until(() => length)).toString('utf8'));
    },
    async eof() {
      await until((bytes) => {
        assert.equal(bytes.length, 0, 'unexpected bytes before EOF');
        if (ended) return 0;
      });
    },
    async hasFrame() {
      await until((bytes) => {
        if (bytes.length || ended) return 0;
      });
      return pending.length > 0;
    },
    async frame() {
      const header = await until(() => 2);
      assert.equal(header.readUInt8(0) & 0xf0, 0x80);
      assert.equal(Boolean(header.readUInt8(1) & 0x80), expectMask, 'wire mask bit');
      const marker = header.readUInt8(1) & 0x7f;
      assert.ok(marker <= 126, 'wire frame must be bounded');
      const length = marker === 126 ? (await until(() => 2)).readUInt16BE(0) : marker;
      assert.ok(length <= 4096);
      const mask = expectMask ? await until(() => 4) : undefined;
      const payload = Buffer.from(await until(() => length));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] = payload.readUInt8(i) ^ mask.readUInt8(i % 4);
      }
      return { opcode: header.readUInt8(0) & 15, payload };
    },
  };
}

type WirePeer = ReturnType<typeof wirePeer>;

async function withServer(run: (fixture: {
  port: number;
  peer: (request?: string, head?: Buffer) => WirePeer;
  stop: () => Promise<void>;
}) => Promise<void>): Promise<void> {
  const sockets = new Set<Socket>();
  const service = await startService(new URL('../server.mts', import.meta.url));
  try {
    const port = Number(new URL(service.url).port);
    await run({
      port,
      peer(request = handshake(port), head) {
        return wirePeer(sockets, port, request, head);
      },
      async stop() {
        await service.stop();
        assert.equal(service.child.exitCode, 0);
      },
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await service.stop();
  }
}

async function accepted(peer: WirePeer): Promise<void> {
  const headers = await peer.headers();
  assert.match(headers, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(headers, /\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=\r\n/i);
  assert.doesNotMatch(headers, /\r\nSec-WebSocket-Extensions:/i);
}

async function expectClose(peer: WirePeer, code: number): Promise<void> {
  // A heartbeat can already be on the wire when the close is produced.
  let frame = await peer.frame();
  if (frame.opcode === 9) frame = await peer.frame();
  assert.equal(frame.opcode, 8);
  assert.equal(frame.payload.readUInt16BE(0), code);
}

async function expectHttp(peer: WirePeer, status: number, body: unknown): Promise<string> {
  const headers = await peer.headers();
  assert.ok(headers.startsWith(`HTTP/1.1 ${status} `), headers);
  assert.match(headers, /\r\nContent-Type: application\/json;charset=utf-8\r\n/i);
  const length = Number(/\r\nContent-Length: (\d+)\r\n/i.exec(headers)?.[1]);
  assert.ok(Number.isInteger(length) && length > 0 && length <= 8192);
  assert.deepEqual(await peer.json(length), body);
  return headers;
}

test('unit: CONNECT dispatch sends a terminal JSON rejection using the shared route rules', () => {
  const { server, shutdown } = createLessonServer();
  try {
    for (const [target, status, code, allow] of [
      ['127.0.0.1:8099', '404 Not Found', 'not_found', ''],
      ['/health', '405 Method Not Allowed', 'method_not_allowed', 'Allow: GET\r\n'],
    ]) {
      const writes: string[] = [];
      const socket = new Socket();
      try {
        const response = new Duplex({
          read() {},
          write(chunk: Buffer, _encoding, done) {
            writes.push(chunk.toString());
            done();
          },
        });
        try {
          const request = new IncomingMessage(socket);
          request.method = 'CONNECT';
          request.url = target;
          request.httpVersion = '1.1';
          request.rawHeaders = ['Host', '127.0.0.1:8099'];
          server.emit('connect', request, response, Buffer.alloc(0));
          const body = JSON.stringify({ error: { code, message: code } });
          assert.equal(writes.join(''), `HTTP/1.1 ${status}\r\nConnection: close\r\n`
            + 'Content-Type: application/json;charset=utf-8\r\n'
            + `Content-Length: ${Buffer.byteLength(body)}\r\n${allow}\r\n${body}`);
          assert.equal(response.writableEnded, true);
        } finally {
          response.destroy();
        }
      } finally {
        socket.destroy();
      }
    }
  } finally {
    shutdown();
  }
});

test('integration: raw CONNECT gets a JSON 404 and health remains available', async () => {
  await withServer(async ({ port, peer }) => {
    const authority = `127.0.0.1:${port}`;
    const raw = peer(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    assert.match(await expectHttp(raw, 404, { error: { code: 'not_found', message: 'not_found' } }),
      /\r\nConnection: close\r\n/i);
    await raw.eof();
    await expectHttp(peer(`GET /health HTTP/1.1\r\nHost: ${authority}\r\n\r\n`), 200, { ok: true });
  });
});

test('integration: child client exchanges one text message and closes, and health works over HTTP', async () => {
  await withServer(async ({ port, peer }) => {
    await expectHttp(peer(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), 200, { ok: true });
    const result = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../client.mts', import.meta.url))], {
        env: { PORT: String(port), UV_THREADPOOL_SIZE: '1' },
        encoding: 'utf8', timeout: 4500, killSignal: 'SIGKILL', maxBuffer: 8192,
      });
    const output: unknown = JSON.parse(result.stdout);
    assert.deepEqual(output, { echo: 'Xin chào WebSocket', closeCode: 1000 });
    assert.equal(result.stderr, '');
  });
});

test('integration: upgrade head is echoed immediately, fragmented text and ping retain order, close echoes its payload', async () => {
  await withServer(async ({ port, peer }) => {
    const raw = peer(handshake(port, { fields: ['Sec-WebSocket-Extensions: permessage-deflate'] }),
      masked(0x81, 'in the head'));
    await accepted(raw);
    assert.deepEqual(await raw.frame(), { opcode: 1, payload: Buffer.from('in the head') });
    raw.send(Buffer.concat([masked(0x01, 'xin '), masked(0x89, 'peer ping'), masked(0x80, 'chào')]));
    assert.deepEqual(await raw.frame(), { opcode: 10, payload: Buffer.from('peer ping') });
    assert.deepEqual(await raw.frame(), { opcode: 1, payload: Buffer.from('xin chào') });
    const payload = Buffer.from([3, 232, 65]);
    raw.send(masked(0x88, payload));
    assert.deepEqual(await raw.frame(), { opcode: 8, payload });
    await raw.eof();
  });
});

test('integration: malformed upgrade fields, a query, a body and late duplicate keys are rejected before 101', async () => {
  await withServer(async ({ port, peer }) => {
    const regular = handshake(port);
    const malformed = [
      handshake(port, { target: '/events?cursor=1' }),
      handshake(port, { version: '1.0' }),
      handshake(port, { fields: ['Sec-WebSocket-Protocol: demo'] }),
      handshake(port, { fields: ['Content-Length: 1'] }) + 'x',
      regular.replace('ZQ==', 'ZR=='),
      ...['127.0.0.1/path', 'user@localhost', 'localhost:00', 'localhost:65536'].map(
        (host) => regular.replace(`Host: 127.0.0.1:${port}`, `Host: ${host}`)),
      handshake(port, { fields: [
        ...Array.from({ length: 1250 }, () => 'X:a'),
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ] }),
      handshake(port, { fields: ['Sec-WebSocket-Version: 13'] }),
    ];
    for (const request of malformed) {
      const raw = peer(request);
      try {
        await expectHttp(raw, 400, { error: { code: 'bad_request', message: 'bad_request' } });
      } finally {
        raw.destroy();
      }
    }
    const wrongMethod = peer(handshake(port, { method: 'POST' }));
    assert.match(await expectHttp(wrongMethod, 405,
      { error: { code: 'method_not_allowed', message: 'method_not_allowed' } }), /\r\nAllow: GET\r\n/i);
    await expectHttp(peer(handshake(port, { target: '/missing' })), 404,
      { error: { code: 'not_found', message: 'not_found' } });
  });
});

test('integration: RSV1 and declared excess length close before any payload arrives', async () => {
  await withServer(async ({ port, peer }) => {
    for (const [header, code] of [['c180', 1002], ['81ff0000000000010000', 1009]] as const) {
      const raw = peer(handshake(port, { fields: ['Sec-WebSocket-Extensions: permessage-deflate'] }));
      await accepted(raw);
      raw.send(Buffer.from(header, 'hex'));
      await expectClose(raw, code);
      raw.destroy();
    }
  });
});

test('integration: a matching pong allows a fresh ping, then silence closes despite a wrong pong and text', async () => {
  await withServer(async ({ peer }) => {
    const raw = peer();
    await accepted(raw);
    const first = await raw.frame();
    assert.equal(first.opcode, 9);
    assert.equal(first.payload.length, 8);
    raw.send(masked(0x8a, first.payload));
    const second = await raw.frame();
    const pingReceived = performance.now();
    assert.equal(second.opcode, 9);
    assert.notDeepEqual(second.payload, first.payload);
    await wait(500);
    raw.send(Buffer.concat([masked(0x8a, first.payload), masked(0x81, 'still here')]));
    assert.deepEqual(await raw.frame(), { opcode: 1, payload: Buffer.from('still here') });
    const close = await raw.frame();
    assert.ok(performance.now() - pingReceived < 1400, 'traffic must not restart the pong deadline');
    assert.equal(close.opcode, 8);
    assert.equal(close.payload.readUInt16BE(0), 1001);
  });
});

test('integration: the ninth upgrade gets 503 and shutdown closes all eight peers with 1001', async () => {
  await withServer(async ({ port, peer, stop }) => {
    const connected: WirePeer[] = [];
    for (let i = 0; i < 8; i++) {
      const raw = peer();
      await accepted(raw);
      connected.push(raw);
    }
    await expectHttp(peer(), 503, { error: { code: 'busy', message: 'busy' } });
    await expectHttp(peer(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), 200, { ok: true });

    await Promise.all([stop(), ...connected.map(async (raw) => {
      await expectClose(raw, 1001);
      const started = performance.now();
      await raw.eof();
      assert.ok(performance.now() - started < 750, 'shutdown must not retain a silent peer for one second');
    })]);
  });
});

test('unit: server-direction frames enforce aggregate bounds before continuation payload arrives', () => {
  const decoder = new Decoder(false);
  const events: FrameEvent[] = [];
  const emit = (event: FrameEvent) => { events.push(event); };
  decoder.feed(Buffer.from('810178', 'hex'), emit);
  decoder.feed(Buffer.concat([Buffer.from('017d', 'hex'), Buffer.alloc(125, 97)]), emit);
  decoder.feed(Buffer.from('807e0f84', 'hex'), emit);
  assert.deepEqual(events, [{ kind: 'text', text: 'x' }, { kind: 'error', code: 1009 }]);
});

test('unit: Host must be a loopback authority with a canonical port', () => {
  for (const host of ['127.0.0.1', 'LOCALHOST:65535', 'localhost:1']) assert.ok(validHost(host), host);
  for (const host of ['127.0.0.1/path', 'x@localhost', 'localhost:0', 'localhost:01',
    'localhost:65536', 'localhost:bad', ' localhost', 'localhost,localhost', 'example.com']) {
    assert.equal(validHost(host), false, host);
  }
});

test('unit: client encoding masks text, pong and close for the server decoder', () => {
  const inputs = [
    encodeFrame(1, Buffer.from('echo'), true),
    encodeFrame(10, Buffer.from('probe'), true),
    encodeFrame(8, Buffer.from([3, 232]), true),
  ];
  assert.ok(inputs.every((frame) => frame.readUInt8(1) >= 128));
  assert.deepEqual(decode(...inputs), [
    { kind: 'text', text: 'echo' },
    { kind: 'pong', payload: Buffer.from('probe') },
    { kind: 'close', payload: Buffer.from([3, 232]) },
  ]);
  const events: FrameEvent[] = [];
  new Decoder(false).feed(inputs[0]!, (event) => { events.push(event); });
  assert.deepEqual(events, [{ kind: 'error', code: 1002 }]);
});

test('unit: close window expires at 250ms and cancellation clears the scheduled destroy', () => {
  let now = 300;
  let due = Infinity;
  let pending: (() => void) | undefined;
  let destroys = 0;
  function schedule(callback: () => void, delay: number) {
    pending = callback;
    due = now + delay;
    return () => { pending = undefined; };
  }
  function advance(time: number): void {
    now = time;
    if (now >= due) {
      const callback = pending;
      pending = undefined;
      callback?.();
    }
  }
  const window = closeWindow(() => { destroys++; }, () => now, schedule);
  advance(549);
  assert.equal(window.expired(), false);
  assert.equal(destroys, 0);
  advance(550);
  assert.equal(window.expired(), true);
  assert.equal(destroys, 1);
  const cancelled = closeWindow(() => { destroys++; }, () => now, schedule);
  cancelled.cancel();
  advance(800);
  assert.equal(destroys, 1);
});

function controlledWritable() {
  const writes: number[] = [];
  let complete: (() => void) | undefined;
  const stream = new Duplex({
    highWaterMark: 4096,
    read() {},
    write(chunk: Buffer, _encoding, done) {
      writes.push(chunk.length);
      complete = done;
    },
  });
  return {
    stream, writes,
    release() {
      const callback = complete;
      assert.ok(callback);
      complete = undefined;
      callback();
    },
  };
}

test('unit: writer stops at backpressure and resumes on drain in FIFO order', async () => {
  const { stream, writes, release } = controlledWritable();
  const writer = boundedWriter(stream, () => {});
  try {
    assert.equal(writer.send(Buffer.alloc(4096)), true);
    assert.equal(writer.send(Buffer.alloc(1500)), true);
    assert.equal(writer.send(Buffer.alloc(1000)), true);
    assert.deepEqual(writes, [4096]);
    assert.equal(stream.writableLength, 4096, 'application queue stays out of the stream before drain');
    const drained = once(stream, 'drain');
    release();
    await drained;
    assert.deepEqual(writes, [4096, 1500]);
    release();
    assert.deepEqual(writes, [4096, 1500, 1000]);
    release();
  } finally {
    writer.cancel();
    stream.destroy();
  }
});

test('unit: writer terminates at one byte above combined pending and queued budget', async () => {
  const { stream, writes, release } = controlledWritable();
  const writer = boundedWriter(stream, () => {});
  try {
    assert.equal(writer.send(Buffer.alloc(4096)), true);
    assert.equal(writer.send(Buffer.alloc(4096)), true);
    const closed = once(stream, 'close');
    assert.equal(writer.send(Buffer.alloc(1)), false);
    assert.equal(stream.destroyed, true);
    release();
    await closed;
    assert.deepEqual(writes, [4096]);
    assert.equal(stream.listenerCount('drain'), 0);
  } finally {
    writer.cancel();
    stream.destroy();
  }
});

test('unit: writer cancellation detaches listeners and discards queued writes', () => {
  const { stream, writes, release } = controlledWritable();
  const writer = boundedWriter(stream, () => assert.fail('cancelled writer flushed'));
  try {
    writer.send(Buffer.alloc(4096));
    writer.send(Buffer.alloc(1));
    writer.cancel();
    assert.equal(stream.listenerCount('drain'), 0);
    assert.equal(stream.listenerCount('close'), 0);
    assert.equal(writer.send(Buffer.alloc(1)), false);
    release();
    assert.deepEqual(writes, [4096]);
  } finally {
    stream.destroy();
  }
});

for (const { name, head, headers, error, limit } of [
  { name: 'oversized declared frame', head: Buffer.from('817f0000000000010000', 'hex'), error: 'frame_1009', limit: 1800 },
  {
    name: 'oversized fragmented message',
    head: Buffer.concat([Buffer.from('017e1000', 'hex'), Buffer.alloc(4096, 97), Buffer.from('8001', 'hex')]),
    error: 'frame_1009', limit: 1800,
  },
  { name: 'stalled in-budget fragment', head: Buffer.from('010161', 'hex'), error: 'timeout', limit: 4200 },
  {
    name: 'duplicate accept field', head: Buffer.alloc(0),
    headers: (accept: string) => `Sec-WebSocket-Accept: ${accept}\r\n`,
    error: 'invalid_upgrade', limit: 1800,
  },
  {
    name: 'negotiated extension', head: Buffer.alloc(0),
    headers: () => 'Sec-WebSocket-Extensions: permessage-deflate\r\n',
    error: 'invalid_upgrade', limit: 1800,
  },
]) {
  test(`integration: bounded CLI cancels a server with a ${name}`, async () => {
    const sockets = new Set<Duplex>();
    const cancelChild = new AbortController();
    let requests = 0;
    let clientDone: Promise<void> | undefined;
    let childClosed: Promise<void> | undefined;
    const server = createServer();
    try {
      server.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      const ready = once(server, 'listening', { signal: AbortSignal.timeout(1000) });
      server.listen(0, '127.0.0.1');
      await ready;
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const upgraded = new Promise<{ incoming: IncomingMessage; socket: Duplex }>((resolve) => {
        server.on('upgrade', (incoming, socket) => {
          requests++;
          socket.on('error', () => socket.destroy());
          socket.once('end', () => socket.end());
          resolve({ incoming, socket });
        });
      });
      const started = performance.now();
      const child = promisify(execFile)(process.execPath,
        [fileURLToPath(new URL('../client.mts', import.meta.url))], {
          env: { PORT: String(address.port), UV_THREADPOOL_SIZE: '1' },
          encoding: 'utf8', timeout: 4500, killSignal: 'SIGKILL', maxBuffer: 8192,
          signal: cancelChild.signal,
        });
      childClosed = new Promise<void>((resolve) => child.child.once('close', () => resolve()));
      clientDone = assert.rejects(child, {
        code: 1, stdout: '', stderr: JSON.stringify({ error: { code: error, message: error } }) + '\n',
      }).then(() => {
        assert.ok(performance.now() - started < limit, name);
        assert.equal(requests, 1);
      });
      const responded = upgraded.then(({ incoming, socket }) => {
        const key = incoming.headers['sec-websocket-key'];
        assert.equal(typeof key, 'string');
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(Buffer.concat([
          Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
            + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n`
            + (headers?.(accept) ?? '') + '\r\n'),
          head,
        ]));
        socket.resume();
      });
      await Promise.all([responded, clientDone]);
      await Promise.all([...sockets].map((socket) =>
        once(socket, 'close', { signal: AbortSignal.timeout(500) })));
    } finally {
      cancelChild.abort();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await clientDone?.catch(() => {});
      await childClosed;
    }
  });
}


test('unit: a correct accept cannot authorize a switching response with framing or coding fields', () => {
  const socket = new Socket();
  try {
    const response = new IncomingMessage(socket);
    response.httpVersion = '1.1';
    response.statusCode = 101;
    const accept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
    const base = ['Connection', 'Upgrade', 'Upgrade', 'websocket', 'Sec-WebSocket-Accept', accept];
    response.rawHeaders = base;
    assert.equal(validSwitchingResponse(response, accept), true);
    for (const fields of [
      ['Content-Length', '0'], ['Transfer-Encoding', 'chunked'], ['Trailer', 'X-Later'],
      ['cOnTeNt-EnCoDiNg', 'gzip', 'Content-Encoding', 'identity'],
    ]) {
      response.rawHeaders = [...base, ...fields];
      assert.equal(validSwitchingResponse(response, accept), false, fields.join(' '));
    }
  } finally {
    socket.destroy();
  }
});

test('unit: locally initiated close allows ping until peer close and sends close only once', () => {
  const state = new CloseState();
  assert.equal(state.begin(), true);
  assert.equal(state.acceptsPing, true);
  assert.equal(state.begin(), false);
  state.receive();
  assert.equal(state.acceptsPing, false);
});

test('unit: peer-initiated close disables ping and permits one close reply', () => {
  const state = new CloseState();
  state.receive();
  assert.equal(state.acceptsPing, false);
  assert.equal(state.begin(), true);
  assert.equal(state.begin(), false);
});


async function withCliPeer(
  exchange: (peer: WirePeer) => Promise<void>,
  expectedError?: string,
  extraHeader = '',
): Promise<void> {
  const sockets = new Set<Duplex>();
  const server = createServer();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let clientDone: Promise<void> | undefined;
  try {
    const ready = once(server, 'listening', { signal: AbortSignal.timeout(1000) });
    server.listen(0, '127.0.0.1');
    await ready;
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const observationDeadline = AbortSignal.timeout(5000);
    const observed = new Promise<void>((resolve, reject) => {
      const onTimeout = () => reject(new Error('CLI peer observation deadline'));
      observationDeadline.addEventListener('abort', onTimeout, { once: true });
      server.once('upgrade', (request, socket, head) => {
        void (async () => {
          socket.once('end', () => socket.end());
          const peer = readWire(socket, true);
          assert.equal(head.length, 0, 'client sent bytes before the switching response');
          const key = request.headers['sec-websocket-key'];
          assert.equal(typeof key, 'string');
          const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
          peer.send(Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
            + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${extraHeader}\r\n`));
          await exchange(peer);
        })().then(resolve, reject).finally(() => observationDeadline.removeEventListener('abort', onTimeout));
      });
    });
    const child = promisify(execFile)(process.execPath,
      [fileURLToPath(new URL('../client.mts', import.meta.url))], {
        env: { PORT: String(address.port), UV_THREADPOOL_SIZE: '1' },
        encoding: 'utf8', timeout: 4500, killSignal: 'SIGKILL', maxBuffer: 8192,
      });
    clientDone = expectedError
      ? assert.rejects(child, {
        code: 1, stdout: '', stderr: JSON.stringify({ error: { code: expectedError, message: expectedError } }) + '\n',
      })
      : child.then(({ stdout, stderr }) => {
        assert.deepEqual(JSON.parse(stdout), { echo: 'Xin chào WebSocket', closeCode: 1000 });
        assert.equal(stderr, '');
      });
    await Promise.all([observed, clientDone]);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await clientDone?.catch(() => {});
  }
}

test('integration: CLI returns masked Pongs between echo fragments and after sending Close', async () => {
  await withCliPeer(async (peer) => {
    assert.deepEqual(await peer.frame(), { opcode: 1, payload: Buffer.from('Xin chào WebSocket') });
    const firstPing = Buffer.from([0xff, 0, 9]);
    peer.send(Buffer.concat([Buffer.from('010458696e20', 'hex'), encodeFrame(9, firstPing)]));
    assert.deepEqual(await peer.frame(), { opcode: 10, payload: firstPing });
    const suffix = Buffer.from('chào WebSocket');
    peer.send(Buffer.concat([Buffer.from([0x80, suffix.length]), suffix]));
    const close = Buffer.from([3, 232]);
    assert.deepEqual(await peer.frame(), { opcode: 8, payload: close });

    const closingPing = Buffer.from('while closing');
    peer.send(Buffer.concat([encodeFrame(1, Buffer.from('discard me')), encodeFrame(9, closingPing)]));
    assert.deepEqual(await peer.frame(), { opcode: 10, payload: closingPing });
    peer.send(encodeFrame(8, close));
    await peer.eof();
  });
});

test('integration: CLI replies with one masked Close before reporting an unsuccessful echo', async () => {
  await withCliPeer(async (peer) => {
    assert.deepEqual(await peer.frame(), { opcode: 1, payload: Buffer.from('Xin chào WebSocket') });
    const close = Buffer.from([3, 232, 98, 121, 101]);
    peer.send(encodeFrame(8, close));
    assert.deepEqual(await peer.frame(), { opcode: 8, payload: close });
    await peer.eof();
  }, 'unexpected_close');
});

test('integration: CLI sends no application frame to a correct-accept peer that adds Content-Length zero', async () => {
  await withCliPeer(async (peer) => {
    const sentApplication = await peer.hasFrame();
    if (sentApplication) {
      const message = await peer.frame();
      assert.equal(message.opcode, 1);
      peer.send(encodeFrame(1, message.payload));
      const close = await peer.frame();
      assert.equal(close.opcode, 8);
      peer.send(encodeFrame(8, close.payload));
    }
    await peer.eof();
    assert.equal(sentApplication, false, 'client transmitted an application frame after an invalid 101');
  }, 'invalid_upgrade', 'Content-Length: 0\r\n');
});

test('integration: server answers Ping after shutdown Close and discards text until peer Close', async () => {
  await withServer(async ({ peer, stop }) => {
    const raw = peer();
    await accepted(raw);
    await Promise.all([stop(), (async () => {
      await expectClose(raw, 1001);
      const probe = Buffer.from([0, 128, 255]);
      raw.send(Buffer.concat([masked(0x81, 'discard me'), masked(0x89, probe)]));
      assert.deepEqual(await raw.frame(), { opcode: 10, payload: probe });
      raw.send(masked(0x88, Buffer.from([3, 233])));
      await raw.eof();
    })()]);
  });
});


test('integration: Node built-in WebSocket can exchange text with the bounded server', async () => {
  await withServer(async ({ port }) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/events`);
    try {
      const deadline = AbortSignal.timeout(2000);
      await once(socket, 'open', { signal: deadline });
      assert.equal(socket.extensions, '');
      const echoed = once(socket, 'message', { signal: deadline });
      socket.send('xin chào');
      const [message]: unknown[] = await echoed;
      assert.ok(message instanceof MessageEvent);
      assert.equal(message.data, 'xin chào');
      const closed = once(socket, 'close', { signal: deadline });
      socket.close(1000);
      const [event]: unknown[] = await closed;
      assert.ok(event instanceof CloseEvent);
      assert.equal(event.code, 1000);
    } finally {
      if (socket.readyState < WebSocket.CLOSING) socket.close();
    }
  });
});
