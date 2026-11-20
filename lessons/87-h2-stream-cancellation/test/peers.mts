import assert from 'node:assert/strict';
import { deferred } from '../deferred.mts';
import { request } from 'node:http';
import { connect, constants, createServer } from 'node:http2';
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http2';
import { createConnection, createServer as createTcpServer } from 'node:net';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';

const { NGHTTP2_NO_ERROR, NGHTTP2_REFUSED_STREAM, NGHTTP2_FLAG_END_STREAM } = constants;
const fastBody = '{"value":"ok"}';
const jsonHeaders = { ':status': 200, 'content-type': 'application/json; charset=utf-8' };

export function http1(origin: string, path = '/demo', method = 'GET', headers?: string[], body?: string) {
  return new Promise<{ status: number | undefined; allow: string | undefined; body: unknown }>((resolve, reject) => {
    const req = request(origin, {
      path, method, headers, agent: false, maxHeaderSize: 8192, signal: AbortSignal.timeout(3500),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('HTTP/1 response aborted')));
      res.on('end', () => {
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: res.statusCode, allow: res.headers.allow, body: value });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.maxHeadersCount = 0;
    req.end(body);
  });
}

export function h2Client(t: TestContext, origin: string) {
  const session = connect(origin);
  session.on('error', () => {});
  t.after(() => session.destroy());
  return session;
}

export async function startFinDelayingProxy(t: TestContext, workerPort: number) {
  const sockets = new Set<Socket>();
  const workerSockets: Socket[] = [];
  const server = createTcpServer({ allowHalfOpen: true }, (clientSocket) => {
    sockets.add(clientSocket);
    clientSocket.on('error', () => {});
    const workerSocket = createConnection({ host: '127.0.0.1', port: workerPort, allowHalfOpen: true });
    sockets.add(workerSocket);
    workerSockets.push(workerSocket);
    workerSocket.on('error', () => {});
    // Forward all bytes while holding back the client FIN until fixture cleanup.
    clientSocket.pipe(workerSocket, { end: false });
    workerSocket.pipe(clientSocket);
  });
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { origin: `http://127.0.0.1:${address.port}`, workerSockets };
}

export function h2Request(
  session: ClientHttp2Session,
  path: string,
  { endStream = true, waitForTrailers = false, headers = {}, signal }: {
    endStream?: boolean; waitForTrailers?: boolean; headers?: OutgoingHttpHeaders; signal?: AbortSignal;
  } = {},
) {
  const stream = session.request({ ':path': path, ...headers }, { endStream, waitForTrailers, signal });
  let initial: { headers: IncomingHttpHeaders; endStream: boolean } | undefined;
  let ended = false;
  const chunks: Buffer[] = [];
  const first = deferred<typeof initial>();
  const closed = deferred<{ body: Buffer; rstCode: number; ended: boolean }>();
  stream.on('error', () => {});
  stream.once('response', (headers, flags) => {
    initial = { headers, endStream: (flags & NGHTTP2_FLAG_END_STREAM) !== 0 };
    first.resolve(initial);
  });
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  stream.once('end', () => { ended = true; });
  stream.once('close', () => {
    first.resolve(initial);
    closed.resolve({ body: Buffer.concat(chunks), rstCode: stream.rstCode, ended });
  });
  return { stream, first: first.promise, closed: closed.promise, initial: () => initial };
}

export async function assertH2(
  call: ReturnType<typeof h2Request>,
  status: number,
  body: unknown,
  allow?: string,
) {
  const response = await call.first;
  assert.ok(response, 'expected HTTP/2 response HEADERS');
  assert.equal(response.headers[':status'], status);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(response.headers.allow, allow);
  const end = await call.closed;
  assert.equal(end.rstCode, NGHTTP2_NO_ERROR);
  assert.equal(end.ended, true);
  const parsed: unknown = JSON.parse(end.body.toString('utf8'));
  assert.deepEqual(parsed, body);
}

export function smallHeaders(): Record<string, string> {
  return Object.fromEntries(Array.from({ length: 145 }, (_, i) => [`x-${i}`, 'a']));
}

export type Mode =
  | 'success' | 'slow-end' | 'slow-data' | 'slow-trailers' | 'slow-stall' | 'staggered-stall' | 'hold-slow' | 'goaway'
  | 'fast-stall' | 'fast-reset' | 'fast-reset-no-error' | 'fast-421' | 'fast-error' | 'fast-trailers' | 'fast-shape'
  | 'fast-media' | 'fast-utf8' | 'fast-size' | 'fast-json';

type StreamObservation = {
  path: string | undefined;
  method: string | undefined;
  initialEnd: boolean;
  rstCode?: number;
  finished?: boolean;
};
type Observation = { streams: StreamObservation[]; closed: Promise<void> };

export async function startFixture(t: TestContext) {
  const server = createServer({ settings: { maxConcurrentStreams: 2 } });
  const sockets = new Set<Socket>();
  const observations: Observation[] = [];
  const fourSlow = deferred<void>();
  const held: (() => void)[] = [];
  let mode: Mode = 'success';
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('session', (session) => {
    const closed = deferred<void>();
    const observation: Observation = { streams: [], closed: closed.promise };
    observations.push(observation);
    const scenario = mode;
    session.on('error', () => {});
    session.once('close', () => closed.resolve());
    session.on('stream', (stream, headers, flags) => {
      const seen: StreamObservation = {
        path: headers[':path'],
        method: headers[':method'],
        initialEnd: (flags & NGHTTP2_FLAG_END_STREAM) !== 0,
      };
      observation.streams.push(seen);
      stream.on('error', () => {});
      stream.once('close', () => {
        seen.rstCode = stream.rstCode;
        seen.finished = stream.writableFinished;
      });
      if (seen.path === '/slow') {
        if (scenario === 'slow-stall') return;
        if (scenario === 'hold-slow') {
          held.push(() => { if (!stream.closed) stream.respond(jsonHeaders); });
          if (held.length === 4) fourSlow.resolve();
          return;
        }
        if (scenario === 'goaway') {
          session.goaway(NGHTTP2_NO_ERROR);
          return;
        }
        if (scenario === 'staggered-stall') {
          // Spend part of the one demo budget waiting for slow headers.
          const timer = setTimeout(() => {
            if (!stream.destroyed && !stream.closed) stream.respond(jsonHeaders);
          }, 330);
          stream.once('close', () => clearTimeout(timer));
          return;
        }
        stream.respond(jsonHeaders, {
          endStream: scenario === 'slow-end',
          waitForTrailers: scenario !== 'slow-end',
        });
        if (scenario === 'slow-data') stream.write('unexpected');
        if (scenario === 'slow-trailers') {
          stream.once('wantTrailers', () => stream.sendTrailers({ 'x-example': 'unexpected' }));
          stream.end();
        }
        return;
      }
      if (seen.path !== '/fast' || scenario === 'fast-reset') {
        stream.close(NGHTTP2_REFUSED_STREAM);
        return;
      }
      stream.respond({
        ...jsonHeaders,
        ':status': scenario === 'fast-421' ? 421 : scenario === 'fast-error' ? 404 : 200,
        'content-type': scenario === 'fast-media'
          ? 'application/json; charset="utf-8"; note=extra'
          : jsonHeaders['content-type'],
      }, { waitForTrailers: scenario === 'fast-trailers' || scenario === 'fast-reset-no-error' });
      if (scenario === 'fast-trailers') {
        stream.once('wantTrailers', () => stream.sendTrailers({ 'x-example': 'trailer' }));
      }
      if (scenario === 'fast-reset-no-error') {
        // All JSON bytes are written. The response still lacks END_STREAM.
        stream.once('wantTrailers', () => stream.close(NGHTTP2_NO_ERROR));
        stream.end(fastBody);
      } else if (scenario === 'fast-stall' || scenario === 'staggered-stall') {
        stream.write(fastBody);
      } else if (scenario === 'fast-error') {
        stream.end('{"error":{"code":"not_found","message":"not_found"}}');
      } else if (scenario === 'fast-shape') {
        stream.end('{"value":"ok","extra":true}');
      } else if (scenario === 'fast-json') {
        stream.end('{"value":');
      } else if (scenario === 'fast-utf8') {
        stream.end(Buffer.concat([Buffer.from('{"value":"'), Buffer.from([0xc3]), Buffer.from('"}')]));
      } else if (scenario === 'fast-size') {
        stream.end(fastBody + ' '.repeat(8192));
      } else {
        stream.end(fastBody);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    setMode: (next: Mode) => { mode = next; },
    observations,
    fourSlow: fourSlow.promise,
    releaseSlow() { for (const respond of held.splice(0)) respond(); },
  };
}

export function sendOnlyTrailers(stream: ClientHttp2Stream) {
  stream.once('wantTrailers', () => stream.sendTrailers({ 'x-example': 'unexpected' }));
  stream.end();
}
