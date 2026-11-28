import { once } from 'node:events';
import { constants, createServer } from 'node:http2';
import type { ServerHttp2Stream, Http2Session } from 'node:http2';
import { pump } from './pump.mts';
import {
  BINARY, BLOB_BYTES, CAPACITY, CHUNK_BYTES, JSON_BYTES, JSON_MEDIA, JSON_MS, MARKER,
  STREAM_WINDOW, TRANSFER_MS, bodyless, deadline, encodeJson, errorBody, port, rejectRoute,
} from './protocol.mts';

function* blob(): Iterable<Buffer> {
  for (let offset = 0; offset < BLOB_BYTES; offset += CHUNK_BYTES) {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    for (let index = 0; index < chunk.length; index++) {
      const position = offset + index;
      chunk[index] = (position ^ (position >>> 8)) & 255;
    }
    yield chunk;
  }
}

function reply(stream: ServerHttp2Stream, status: number, value: object) {
  const body = encodeJson(value);
  const timer = setTimeout(() => stream.close(constants.NGHTTP2_CANCEL), JSON_MS);
  stream.once('close', () => clearTimeout(timer));
  stream.respond({
    ':status': status, 'content-type': JSON_MEDIA, 'content-length': body.length,
    ...(status === 405 ? { allow: 'GET' } : {}),
  });
  stream.end(body);
}

type SessionState = { active: number; idle?: NodeJS.Timeout };

export function createProvider() {
  const server = createServer({
    settings: { initialWindowSize: STREAM_WINDOW, maxHeaderListSize: JSON_BYTES, maxConcurrentStreams: 32 },
    maxHeaderListPairs: 64,
    maxSessionMemory: 2,
  });
  const sessions = new Map<Http2Session, SessionState>();
  let active = 0;
  let generatedBytes = 0;
  let backpressureWaits = 0;
  let blocked = 0;
  const idle = (session: Http2Session, state: SessionState) => {
    clearTimeout(state.idle);
    state.idle = setTimeout(() => session.destroy(), JSON_MS);
  };

  server.on('session', (session) => {
    session.on('error', () => {});
    if (sessions.size >= CAPACITY) {
      session.destroy();
      return;
    }
    const state: SessionState = { active: 0 };
    sessions.set(session, state);
    idle(session, state);
    session.once('close', () => {
      const current = sessions.get(session);
      clearTimeout(current?.idle);
      sessions.delete(session);
    });
  });

  async function sendBlob(stream: ServerHttp2Stream, session: Http2Session, state: SessionState) {
    const operation = deadline(TRANSFER_MS);
    const { signal, controller } = operation;
    const stop = () => controller.abort(new Error('stream closed'));
    const cancel = () => {
      if (!stream.closed && !stream.destroyed) stream.close(constants.NGHTTP2_CANCEL);
    };
    stream.once('close', stop);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const completed = once(stream, 'wantTrailers', { signal });
      // The event can reject while the producer is still awaiting drain.
      void completed.catch(() => {});
      stream.respond({
        ':status': 200, 'content-type': BINARY, 'content-length': BLOB_BYTES,
      }, { waitForTrailers: true });
      const count = await pump(blob(), (chunk) => {
        operation.check();
        generatedBytes = Math.min(Number.MAX_SAFE_INTEGER, generatedBytes + chunk.length);
        return stream.write(chunk);
      }, async () => {
        blocked++;
        backpressureWaits = Math.min(Number.MAX_SAFE_INTEGER, backpressureWaits + 1);
        try { await once(stream, 'drain', { signal }); }
        finally { blocked--; }
      }, BLOB_BYTES, signal);
      if (count !== BLOB_BYTES) throw new Error('short source');
      stream.end();
      await completed;
      operation.check();
      stream.sendTrailers({ [MARKER]: '1' });
      // Retain capacity until the stream closes, including trailer flush.
      if (!stream.closed && !stream.destroyed) await once(stream, 'close');
    } catch (error) {
      controller.abort(error);
    } finally {
      operation.dispose();
      signal.removeEventListener('abort', cancel);
      stream.off('close', stop);
      state.active--;
      active--;
      if (state.active === 0 && !session.destroyed) idle(session, state);
    }
  }

  server.on('stream', (stream, headers, flags, raw) => {
    stream.on('error', () => {});
    if (stream.closed || stream.destroyed) return;
    const session = stream.session;
    const state = session && sessions.get(session);
    if (!session || !state) {
      stream.close(constants.NGHTTP2_REFUSED_STREAM);
      return;
    }
    const hasEnd = (flags & constants.NGHTTP2_FLAG_END_STREAM) !== 0;
    const rejection = rejectRoute(headers[':method'], headers[':path'], ['/blob', '/health', '/stats'], hasEnd && bodyless(raw));
    if (!hasEnd) {
      // Discard an open request stream without reading an unbounded body.
      stream.close(constants.NGHTTP2_CANCEL);
      return;
    }
    if (state.active === 0) idle(session, state);
    if (rejection) reply(stream, rejection.status, errorBody(rejection.code));
    else if (headers[':path'] === '/health') reply(stream, 200, { status: 'ok' });
    else if (headers[':path'] === '/stats') {
      reply(stream, 200, { active, sessions: sessions.size, generatedBytes, backpressureWaits, blocked });
    } else if (active >= CAPACITY || state.active >= 4) {
      reply(stream, 503, errorBody('busy'));
    } else {
      clearTimeout(state.idle);
      active++;
      state.active++;
      void sendBlob(stream, session, state);
    }
  });
  return server;
}

if (import.meta.main) {
  const server = createProvider();
  server.listen(port(9797), process.env.HOST ?? '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(JSON.stringify({ port: address.port }));
  });
}
