import { constants, createServer } from 'node:http2';
import type { Http2Session, ServerHttp2Stream } from 'node:http2';
import { Drain, MAX_ACTIVE } from './core.mts';
import { bodyless, errorBody, Fault, fieldsOf, JSON_TYPE, LIMIT, route, WORK_BODY, WORK_PREFIX, WORK_SUFFIX } from './protocol.mts';
import { serve, setting, trackSockets } from './startup.mts';

const { NGHTTP2_FLAG_END_STREAM, NGHTTP2_NO_ERROR, NGHTTP2_REFUSED_STREAM } = constants;

function replyError(stream: ServerHttp2Stream, fault: Fault, requestEnded: boolean) {
  const headers = { ':status': fault.status, 'content-type': JSON_TYPE,
    ...(fault.status === 405 ? { allow: 'GET' } : {}) };
  if (stream.writableEnded) {
    stream.respond(headers, { endStream: true });
  } else {
    stream.respond(headers);
    stream.end(JSON.stringify(errorBody(fault.message)));
  }
  // A bodyless route never waits for a peer's upload.
  if (!requestEnded) stream.close(NGHTTP2_NO_ERROR);
}

async function main() {
  const port = setting('PORT', 3095, 0, 65535);
  const workMs = setting('WORK_MS', 100, 0, 300);
  const server = createServer({
    maxHeaderListPairs: 64,
    settings: { maxHeaderListSize: LIMIT, maxConcurrentStreams: MAX_ACTIVE },
  });
  server.maxConnections = 16;
  const sockets = trackSockets(server, 5000);
  const sessions = new Map<Http2Session, Drain>();
  let stopping = false;
  let checkDrained = () => {};

  server.on('session', (session: Http2Session) => {
    session.on('error', () => session.destroy());
    if (stopping) {
      session.destroy();
      return;
    }
    const drain = new Drain();
    sessions.set(session, drain);
    session.once('close', () => {
      sessions.delete(session);
      checkDrained();
    });
    session.setTimeout(5000, () => session.destroy());
  });

  server.on('stream', (stream, _headers, flags, raw) => {
    stream.on('error', () => stream.destroy());
    const drain = stream.session && sessions.get(stream.session);
    const id = stream.id;
    if (stopping || !drain || id === undefined || drain.active >= MAX_ACTIVE || !drain.accept(id)) {
      stream.close(NGHTTP2_REFUSED_STREAM);
      return;
    }

    let timer: NodeJS.Timeout | undefined;
    stream.once('close', () => {
      clearTimeout(timer);
      drain.release(id);
    });

    const requestEnded = (flags & NGHTTP2_FLAG_END_STREAM) !== 0;
    try {
      const fields = fieldsOf(raw);
      route(fields.get(':path') ?? '', fields.get(':method') ?? '', false);
      bodyless(fields);
      if (!requestEnded) throw new Fault(400, 'invalid_body');
      stream.respond({ ':status': 200, 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(WORK_BODY) });
      stream.once('finish', () => {
        if (stream.rstCode === NGHTTP2_NO_ERROR) {
          console.log(JSON.stringify({ event: 'work-finished', streamId: id }));
        }
      });
      stream.write(WORK_PREFIX);
      timer = setTimeout(() => stream.end(WORK_SUFFIX), workMs);
      console.log(JSON.stringify({ event: 'work-started', streamId: id }));
    } catch (error) {
      if (error instanceof Fault && !stream.destroyed && !stream.closed) {
        try { replyError(stream, error, requestEnded); } catch { stream.destroy(); }
      } else {
        stream.destroy();
      }
    }
  });

  checkDrained = await serve(server, 'worker', port, (now) => {
    stopping = true;
    for (const [session, drain] of sessions) {
      drain.begin(now);
      if (session.destroyed || session.closed) continue;
      session.goaway(NGHTTP2_NO_ERROR, drain.cutoff);
      session.close();
    }
  }, () => {
    for (const session of sessions.keys()) session.destroy();
    for (const socket of sockets) socket.destroy();
  }, () => sessions.size === 0);
}

if (import.meta.main) await main();
