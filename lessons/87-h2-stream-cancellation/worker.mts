import { constants, createServer } from 'node:http2';
import type { Http2Session, ServerHttp2Stream } from 'node:http2';
import type { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { HttpError, numberSetting } from '../../lib/http.mts';
import {
  DEADLINE_MS, MAX_SESSIONS, MAX_STREAMS, SLOW_LIFETIME_MS, errorBody, fault, h2Options,
  readRequest, requireBodyless, requireGet, sendHeaders,
} from './protocol.mts';
import { listenLoopback } from './startup.mts';

const { NGHTTP2_CANCEL, NGHTTP2_FLAG_END_STREAM, NGHTTP2_NO_ERROR, NGHTTP2_REFUSED_STREAM } = constants;

function handle(stream: ServerHttp2Stream, flags: number, raw: readonly string[]) {
  const start = performance.now();
  const initialEnd = (flags & NGHTTP2_FLAG_END_STREAM) !== 0;
  let requestEnded = initialEnd;
  let decided = false;
  let timer: NodeJS.Timeout | undefined;
  let finishRequest: NodeJS.Immediate | undefined;

  function clearPending() {
    clearTimeout(timer);
    if (finishRequest !== undefined) clearImmediate(finishRequest);
  }

  function respond(status: number, value?: unknown, allow?: string) {
    if (stream.closed || stream.destroyed) return;
    const body = value === undefined ? undefined : JSON.stringify(value);
    const headers = {
      ':status': String(status),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      date: new Date().toUTCString(),
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
      ...(allow === undefined ? {} : { allow }),
    };
    try {
      // Node has already ended the writable side if the method is HEAD.
      const head = stream.writableEnded;
      stream.respond(sendHeaders(headers, 'response'), {
        endStream: head,
        // Hold END_STREAM on /slow when close(CANCEL) ends the writable side.
        // No trailers are sent, so the peer sees the reset instead of a clean EOF.
        waitForTrailers: body === undefined,
      });
      if (body !== undefined && !head) stream.end(body);
      if (!requestEnded) {
        // Send the final response, then stop an upload that has not ended.
        stream.close(NGHTTP2_NO_ERROR);
      }
    } catch {
      stream.destroy();
    }
  }

  function reject(error: HttpError) {
    if (decided) return;
    decided = true;
    clearPending();
    respond(error.status, errorBody(error.code), error.status === 405 ? 'GET' : undefined);
  }

  stream.once('close', clearPending);

  let route: '/slow' | '/fast';
  try {
    const { path, method, fields } = readRequest(raw);
    route = requireGet(path, method, ['/slow', '/fast']);
    requireBodyless(fields);
  } catch (error) {
    reject(error instanceof HttpError ? error : fault(500, 'internal_error'));
    return;
  }

  function complete() {
    if (decided || stream.closed || stream.destroyed) return;
    if (performance.now() - start >= DEADLINE_MS) return reject(fault(408, 'body_timeout'));
    decided = true;
    clearPending();
    if (route === '/fast') {
      respond(200, { value: 'ok' });
    } else {
      timer = setTimeout(() => stream.close(NGHTTP2_CANCEL),
        Math.max(0, SLOW_LIFETIME_MS - (performance.now() - start)));
      respond(200);
    }
  }

  if (initialEnd) {
    complete();
    return;
  }

  timer = setTimeout(() => reject(fault(408, 'body_timeout')),
    Math.max(0, DEADLINE_MS - (performance.now() - start)));
  const invalidBody = () => reject(fault(400, 'invalid_body'));
  stream.on('data', (chunk: Buffer) => { if (chunk.length !== 0) invalidBody(); });
  stream.on('headers', invalidBody);
  stream.on('trailers', invalidBody);
  stream.once('end', () => {
    requestEnded = true;
    if (!decided) finishRequest = setImmediate(complete);
  });
}

// A graceful HTTP/2 shutdown can outlive the session's own timeout.
export function boundSessionDrain(session: EventEmitter, socket: Socket) {
  session.once('goaway', () => {
    const timer = setTimeout(() => socket.destroy(), SLOW_LIFETIME_MS);
    socket.once('close', () => clearTimeout(timer));
  });
}

async function main() {
  const port = numberSetting('PORT', 3087, 0, 65535);
  const server = createServer(h2Options);
  // Leave room to reject one excess session without accumulating closing sockets.
  server.maxConnections = MAX_SESSIONS + 1;
  const sessions = new Map<Http2Session, number>();
  const sockets = new Map<number, Socket>();

  server.prependListener('connection', (socket: Socket) => {
    const port = socket.remotePort;
    if (port === undefined) return socket.destroy();
    sockets.set(port, socket);
    socket.once('close', () => sockets.delete(port));
  });
  server.on('session', (session) => {
    session.on('error', () => session.destroy());
    const port = session.socket.remotePort;
    const socket = port === undefined ? undefined : sockets.get(port);
    if (!socket || sessions.size >= MAX_SESSIONS) {
      session.destroy();
      return;
    }
    boundSessionDrain(session, socket);
    sessions.set(session, 0);
    session.once('close', () => sessions.delete(session));
    session.setTimeout(5000, () => session.destroy());
  });
  server.on('stream', (stream, _headers, flags, raw) => {
    stream.on('error', () => stream.destroy());
    const session = stream.session;
    if (!session) return;
    const count = sessions.get(session);
    if (count === undefined || count >= MAX_STREAMS) {
      stream.close(NGHTTP2_REFUSED_STREAM);
      return;
    }
    sessions.set(session, count + 1);
    stream.once('close', () => {
      const active = sessions.get(session);
      if (active !== undefined) sessions.set(session, active - 1);
    });
    handle(stream, flags, raw);
  });

  await listenLoopback(server, 'worker', port, () => {
    for (const session of sessions.keys()) session.destroy();
    for (const socket of sockets.values()) socket.destroy();
  });
}

if (import.meta.main) await main();
