import { connect, constants } from 'node:http2';
import { Duplex } from 'node:stream';
import { FastEnd } from './fast-end.mts';
import { createConnection, type Socket } from 'node:net';
import type { OpenSession } from './demo.mts';
import { h2Options, sendHeaders } from './protocol.mts';

function observingTransport(socket: Socket, fast: FastEnd) {
  const transport = new Duplex({
    read() { socket.resume(); },
    write(chunk: Buffer, _encoding, done) { socket.write(chunk, done); },
    final(done) { socket.end(done); },
    destroy(error, done) {
      socket.destroy();
      done(error);
    },
  });
  socket.on('data', (chunk: Buffer) => {
    fast.observe(chunk);
    if (!transport.push(chunk)) socket.pause();
  });
  socket.once('end', () => transport.push(null));
  socket.on('error', (error) => transport.destroy(error));
  socket.once('close', () => transport.destroy());
  return transport;
}

export function connectWorker(origin: URL): OpenSession {
  const authority = origin.host;
  const port = origin.port === '' ? 80 : Number(origin.port);
  return (onFailure) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    try {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.on('error', onFailure);
      socket.setNoDelay();
      const fast = new FastEnd();
      const session = connect(origin, {
        ...h2Options,
        settings: { ...h2Options.settings, enablePush: false },
        maxReservedRemoteStreams: 0,
        createConnection: () => observingTransport(socket, fast),
      });
      session.on('error', onFailure);
      session.on('goaway', onFailure);
      session.on('frameError', onFailure);
      session.once('close', onFailure);
      session.on('stream', (stream) => {
        stream.on('error', onFailure);
        onFailure();
      });

      return {
        closed,
        open(path, events) {
          const stream = session.request(sendHeaders({
            ':method': 'GET', ':scheme': 'http', ':authority': authority, ':path': path,
          }, 'request'), { endStream: true });
          if (path === '/fast') {
            const track = () => {
              if (stream.id === undefined) events.error();
              else fast.track(stream.id);
            };
            if (stream.pending) stream.once('ready', track);
            else track();
          }
          stream.on('response', (_headers, flags, raw) => {
            events.headers(raw, (flags & constants.NGHTTP2_FLAG_END_STREAM) !== 0);
            // Start reading after Node has delivered the initial response headers.
            stream.on('data', events.data);
          });
          stream.on('headers', events.extraHeaders);
          stream.on('trailers', events.extraHeaders);
          stream.on('end', () => {
            if (path === '/fast' && !fast.ended) events.error();
            else events.end();
          });
          stream.on('aborted', events.error);
          stream.on('error', events.error);
          stream.on('frameError', events.error);
          stream.once('close', () => events.close(stream.rstCode));
          return stream;
        },
        destroy() {
          // A peer GOAWAY can put Node in graceful shutdown before we get here.
          // Close the owned socket in that case to avoid waiting for a peer FIN.
          if (session.closed || !fast.ended) socket.destroy();
          session.destroy();
        },
      };
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
}
