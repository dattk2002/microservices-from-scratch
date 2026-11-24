import { createServer as createTcpServer } from 'node:net';
import { frame } from './wire.mts';
import assert from 'node:assert/strict';
import { constants, createServer } from 'node:http2';
import type { Http2Session, ServerHttp2Stream } from 'node:http2';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { latch, within } from './support.mts';

const { NGHTTP2_NO_ERROR, NGHTTP2_REFUSED_STREAM, NGHTTP2_INTERNAL_ERROR } = constants;
const body = '{"result":"done"}';
const headers = { ':status': 200, 'content-type': 'application/json; charset=utf-8' };

type Observation = {
  session: number;
  closed: Promise<void>;
  getReset: () => number;
};

type Handler = (stream: ServerHttp2Stream, session: Http2Session) => void;

export async function fixture(t: TestContext, maxConcurrentStreams = 8) {
  const server = createServer({ settings: { maxConcurrentStreams } });
  const sockets = new Set<Socket>();
  const sessions = new Map<Http2Session, number>();
  const seen: Observation[] = [];
  let connections = 0;
  let next = latch();
  let handled: Handler = (stream) => { stream.respond(headers); stream.end(body); };

  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const session of sessions.keys()) session.destroy();
    for (const socket of sockets) socket.destroy();
    await within(closed, 'fixture cleanup');
  });
  server.prependListener('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.setTimeout(3000, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('session', (session: Http2Session) => {
    sessions.set(session, ++connections);
    session.on('error', () => session.destroy());
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, received) => {
    stream.on('error', () => {});
    const session = stream.session;
    assert.ok(session);
    const number = sessions.get(session);
    assert.ok(number);
    assert.equal(received[':method'], 'GET');
    assert.equal(received[':path'], '/work');
    const closed = latch();
    stream.once('close', closed.open);
    seen.push({ session: number, closed: closed.promise, getReset: () => stream.rstCode });
    handled(stream, session);
    next.open();
    next = latch();
  });
  await within(new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }), 'fixture readiness');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  return {
    port: address.port,
    seen,
    connections: () => connections,
    change(handler: Handler) { handled = handler; },
    async until(count: number) {
      while (seen.length < count) await within(next.promise, `stream ${count}`);
      const stream = seen[count - 1];
      assert.ok(stream);
      return stream;
    },
  };
}

export function retire(
  stream: ServerHttp2Stream,
  session: Http2Session,
  observed: ReturnType<typeof latch>,
) {
  // Node automatically answers NO_ERROR GOAWAY with a graceful GOAWAY.
  // The return frame is a barrier that proves the gateway already retired it.
  session.once('goaway', observed.open);
  stream.respond(headers);
  stream.write('{"result":');
  session.goaway(NGHTTP2_NO_ERROR, stream.id);
  return () => { if (!stream.closed) stream.end('"done"}'); };
}

function resetAfterData(stream: ServerHttp2Stream, code: number) {
  // Hold END_STREAM for trailers, then reset instead of sending the trailers.
  stream.respond(headers, { waitForTrailers: true });
  stream.once('wantTrailers', () => stream.close(code));
  stream.end(body);
}

export const modes = {
  success(stream: ServerHttp2Stream) { stream.respond(headers); stream.end(body); },
  refused(stream: ServerHttp2Stream) { stream.close(NGHTTP2_REFUSED_STREAM); },
  misdirected(stream: ServerHttp2Stream) { stream.respond({ ...headers, ':status': 421 }); stream.end(body); },
  redirect(stream: ServerHttp2Stream, destination: string) {
    stream.respond({ ...headers, ':status': 307, location: destination });
    stream.end(body);
  },
  nonzeroReset(stream: ServerHttp2Stream) {
    resetAfterData(stream, NGHTTP2_INTERNAL_ERROR);
  },
  zeroReset(stream: ServerHttp2Stream) {
    resetAfterData(stream, NGHTTP2_NO_ERROR);
  },
  truncated(stream: ServerHttp2Stream) { stream.respond(headers); stream.end('{"result":'); },
  extraKey(stream: ServerHttp2Stream) { stream.respond(headers); stream.end('{"result":"done","extra":true}'); },
  invalidType(stream: ServerHttp2Stream) { stream.respond(headers); stream.end('{"result":["done"]}'); },
  large(stream: ServerHttp2Stream) { stream.respond(headers); stream.end(body + ' '.repeat(8192)); },
  invalidUtf8(stream: ServerHttp2Stream) {
    stream.respond(headers);
    stream.end(Buffer.concat([Buffer.from(body), Buffer.from([0xff])]));
  },
  invalidMedia(stream: ServerHttp2Stream) {
    stream.respond({ ...headers, 'content-type': 'application/json; charset=utf-8; broken' });
    stream.end(body);
  },
  encoded(stream: ServerHttp2Stream) {
    stream.respond({ ...headers, 'content-encoding': 'gzip' });
    stream.end(body);
  },
  slowEof(stream: ServerHttp2Stream) { stream.respond(headers); stream.write(body); },
};

export function lateEof() {
  let sentEnd = false;
  return {
    sentEnd: () => sentEnd,
    handle(stream: ServerHttp2Stream) {
      stream.respond(headers);
      stream.write(body);
      // Legal JSON whitespace keeps the transport active without ending it.
      const keepSending = setInterval(() => stream.write(' '), 100);
      const ending = setTimeout(() => {
        sentEnd = true;
        stream.end();
      }, 700);
      stream.once('close', () => {
        clearInterval(keepSending);
        clearTimeout(ending);
      });
    },
  };
}


// The peer speaks the h2 preface but deliberately keeps its writable TCP half
// open after the gateway sends FIN. This outlives ordinary stream cancellation.
export async function halfOpenPeer(t: TestContext) {
  const sockets = new Set<Socket>();
  const started = latch();
  let resets = 0;
  const server = createTcpServer({allowHalfOpen: true}, socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    socket.write(frame(4, 0, 0, Buffer.alloc(0)));
    let pending = Buffer.alloc(0);
    let total = 0;
    let preface = false;
    socket.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 8192) return socket.destroy(new Error('Gateway peer wire budget exceeded'));
      pending = Buffer.concat([pending, chunk]);
      if (!preface) {
        if (pending.length < 24) return;
        assert.equal(pending.subarray(0, 24).toString(), 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n');
        pending = pending.subarray(24);
        preface = true;
      }
      while (pending.length >= 9) {
        const length = pending.readUIntBE(0, 3);
        if (pending.length < 9 + length) return;
        const type = pending[3];
        const flags = pending[4];
        if (type === 4 && flags === 0) socket.write(frame(4, 1, 0, Buffer.alloc(0)));
        if (type === 1) started.open();
        if (type === 3) resets++;
        pending = pending.subarray(9 + length);
      }
    });
    // No 'end' handler closes the writable half: force cleanup owns this case.
  });
  t.after(async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await within(closed, 'half-open peer cleanup');
  });
  await within(new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  }), 'half-open peer readiness');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {port: address.port, started: started.promise, resets: () => resets};
}
