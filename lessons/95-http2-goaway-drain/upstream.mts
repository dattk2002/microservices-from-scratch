import { connect, constants } from 'node:http2';
import type { ClientHttp2Session } from 'node:http2';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { expired, MAX_ACTIVE, MAX_SESSIONS, selectSession } from './core.mts';
import type { SessionState } from './core.mts';
import { Fault, LIMIT, responseLength, validWorkBody } from './protocol.mts';
import { ResponseEnd } from './response-end.mts';

const { NGHTTP2_CANCEL, NGHTTP2_NO_ERROR } = constants;

function observedTransport(socket: Socket, boundary: ResponseEnd) {
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
    boundary.observe(chunk);
    if (!transport.push(chunk)) socket.pause();
  });
  socket.once('end', () => transport.push(null));
  socket.on('error', (error) => transport.destroy(error));
  socket.once('close', () => transport.destroy());
  return transport;
}

type Peer = {
  state: SessionState;
  active: number;
  session: ClientHttp2Session;
  socket: Socket;
  boundary: ResponseEnd;
};

export class WorkerPool {
  readonly #peers = new Set<Peer>();
  readonly #port: number;
  readonly #onClose: () => void;
  #active = 0;
  #stopping = false;

  constructor(port: number, onClose: () => void) {
    this.#port = port;
    this.#onClose = onClose;
  }

  get empty() { return this.#peers.size === 0; }

  #open(): Peer {
    const socket = createConnection({ host: '127.0.0.1', port: this.#port });
    try {
      const boundary = new ResponseEnd();
      const session = connect(`http://127.0.0.1:${this.#port}`, {
        createConnection: () => observedTransport(socket, boundary),
        maxHeaderListPairs: 64,
        maxReservedRemoteStreams: 0,
        settings: { enablePush: false, maxHeaderListSize: LIMIT },
      });
      const peer: Peer = { state: 'open', active: 0, session, socket, boundary };
      this.#peers.add(peer);
      session.on('goaway', () => { peer.state = 'draining'; });
      const destroy = () => {
        peer.state = 'closed';
        session.destroy();
        socket.destroy();
      };
      session.on('error', destroy);
      session.on('frameError', (id) => { if (id === 0) destroy(); });
      session.on('stream', (stream) => {
        stream.on('error', () => {});
        destroy();
      });
      session.once('close', destroy);
      socket.once('close', () => {
        peer.state = 'closed';
        this.#peers.delete(peer);
        this.#onClose();
      });
      session.setTimeout(5000, destroy);
      return peer;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  async call(deadline: number, signal: AbortSignal): Promise<void> {
    if (this.#stopping || this.#active >= MAX_ACTIVE) throw new Fault(503, 'busy');
    if (expired(deadline, performance.now())) throw new Fault(504, 'upstream_timeout');
    if (signal.aborted) throw new Fault(502, 'upstream_failure');

    const available = selectSession(this.#peers, ({ session, active }) =>
      !session.closed && !session.destroyed
      && active < (session.connecting ? MAX_ACTIVE : (session.remoteSettings.maxConcurrentStreams ?? MAX_ACTIVE)));
    if (!available && this.#peers.size >= MAX_SESSIONS) throw new Fault(503, 'busy');

    const peer = available ?? this.#open();
    this.#active++;
    peer.active++;
    try {
      await workOnce(peer, deadline, signal);
    } finally {
      peer.active--;
      this.#active--;
    }
  }

  stop() {
    this.#stopping = true;
    for (const peer of this.#peers) {
      if (peer.state === 'open') {
        peer.state = 'draining';
        peer.session.close();
      }
    }
  }

  force() {
    for (const { session, socket } of this.#peers) {
      session.destroy();
      socket.destroy();
    }
  }
}

function workOnce({ session, boundary }: Peer, deadline: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stream = session.request({ ':method': 'GET', ':path': '/work' }, { endStream: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let expected: number | undefined;
    let validHeaders = false;
    let ended = false;
    let settled = false;
    let id: number | undefined;

    const track = () => {
      id = stream.id;
      if (id !== undefined) boundary.track(id);
    };
    if (stream.pending) stream.once('ready', track);
    else track();

    function finish(status?: 502 | 504) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', disconnect);
      stream.off('ready', track);
      if (id !== undefined) boundary.forget(id);
      if (status === undefined) {
        resolve();
      } else {
        reject(new Fault(status, status === 504 ? 'upstream_timeout' : 'upstream_failure'));
        if (!stream.closed && !stream.destroyed) stream.close(NGHTTP2_CANCEL);
      }
    }

    const timeout = () => finish(504);
    const fail = () => finish(expired(deadline, performance.now()) ? 504 : 502);
    const disconnect = () => finish(502);
    const timer = setTimeout(timeout, Math.max(0, Math.ceil(deadline - performance.now())));
    signal.addEventListener('abort', disconnect, { once: true });
    stream.on('error', fail);
    stream.on('frameError', fail);
    stream.once('aborted', fail);
    stream.on('headers', fail);
    stream.on('trailers', fail);
    stream.once('response', (_headers, _flags, raw) => {
      if (settled) return;
      try {
        expected = responseLength(raw);
        validHeaders = true;
      } catch {
        fail();
      }
    });
    stream.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > LIMIT) fail();
      else chunks.push(chunk);
    });
    stream.once('end', () => { ended = true; });
    stream.once('close', () => {
      if (settled) return;
      if (expired(deadline, performance.now())) {
        timeout();
      } else if (stream.rstCode !== NGHTTP2_NO_ERROR || id === undefined || !boundary.complete(id)
          || !validHeaders || !ended || (expected !== undefined && bytes !== expected)
          || !validWorkBody(Buffer.concat(chunks, bytes))) {
        fail();
      } else {
        finish();
      }
    });
    if (signal.aborted) disconnect();
  });
}
