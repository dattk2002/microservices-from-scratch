import { once, type EventEmitter } from 'node:events';
import { request } from 'node:http';
import { connect, constants, createServer } from 'node:http2';
import type { ClientHttp2Session, ClientHttp2Stream, ServerHttp2Session } from 'node:http2';
import type { TestContext } from 'node:test';

export function gate() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export const LENGTH = 262_144;
export const DIGEST = 'fe94555a98997280a2f45c43c8ef2a8aa1cf173f0f5c995d1a9d752d876b792c';

export function peer(t: TestContext, origin: string, window = 4096) {
  const session = connect(origin, { settings: { initialWindowSize: window } });
  t.after(() => session.destroy());
  session.on('error', () => {});
  const timer = setTimeout(() => session.destroy(), 5000);
  session.once('close', () => clearTimeout(timer));
  return session;
}

export function open(session: ClientHttp2Session, path: string): ClientHttp2Stream {
  const stream = session.request({ ':path': path }, { endStream: true });
  stream.on('error', () => {});
  return stream;
}

export async function h2Body(stream: ClientHttp2Stream, cap = 8192) {
  const status = new Promise<number>((resolve, reject) => {
    const signal = AbortSignal.timeout(3500);
    const expired = () => reject(signal.reason);
    signal.addEventListener('abort', expired, { once: true });
    stream.once('response', (headers) => {
      signal.removeEventListener('abort', expired);
      const code = headers[':status'];
      if (typeof code === 'number') resolve(code);
      else reject(new Error('missing status'));
    });
  });
  void status.catch(() => {});
  const chunks: Buffer[] = [];
  let count = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new Error('non-binary chunk');
    count += chunk.length;
    if (count > cap) throw new Error('fixture body exceeds cap');
    chunks.push(chunk);
  }
  return { status: await status, body: Buffer.concat(chunks, count) };
}

export function pull(t: TestContext, origin: string, path = '/blob', options: { method?: string; headers?: string[] } = {}) {
  let size = 0;
  let responseStarted = false;
  const prefix = gate();
  const done = new Promise<{ status: number; complete: boolean; body: Buffer; allow?: string }>((resolve, reject) => {
    const outgoing = request(origin + path, { ...options, agent: false, signal: AbortSignal.timeout(4000) });
    t.after(() => outgoing.destroy());
    outgoing.once('error', (error) => {
      if (!responseStarted) reject(error);
    });
    outgoing.once('response', (incoming) => {
      responseStarted = true;
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > LENGTH) {
          reject(new Error('downstream body exceeds cap'));
          incoming.destroy();
          return;
        }
        chunks.push(chunk);
        if (size === LENGTH - 1) prefix.resolve();
      });
      incoming.on('error', () => {});
      incoming.once('close', () => resolve({
        status: incoming.statusCode ?? 0, complete: incoming.complete,
        body: Buffer.concat(chunks), allow: incoming.headers.allow,
      }));
    });
    outgoing.end();
  });
  void done.catch(() => {});
  return {
    done,
    prefix: () => Promise.race([
      prefix.promise,
      done.then(() => { throw new Error('response closed before the withheld byte boundary'); }),
    ]),
  };
}

export type Mode = 'valid' | 'truncate' | 'oversized' | 'reset' | 'no-error-reset' | 'wrong' | 'duplicate' |
  'initial-only' | 'missing' | 'stall' | 'no-head' | 'redirect' | 'misdirected' | 'coding';

type FixtureListener = EventEmitter & {
  listen(options: { host: string; port: number; signal?: AbortSignal }): unknown;
  readonly listening: boolean;
};

export async function listenFixture(
  server: FixtureListener,
  registerCleanup: (cleanup: () => void | Promise<void>) => void,
  startup = AbortSignal.timeout(2000),
) {
  const controller = new AbortController();
  const stop = async () => {
    if (controller.signal.aborted) return;
    const closed = server.listening ? once(server, 'close') : undefined;
    controller.abort();
    await closed;
  };
  registerCleanup(stop);
  const signal = AbortSignal.any([startup, controller.signal]);
  signal.throwIfAborted();
  try {
    server.listen({ host: '127.0.0.1', port: 0, signal: controller.signal });
    await once(server, 'listening', { signal });
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function sourceFixture(t: TestContext) {
  const server = createServer();
  const sessions = new Set<ServerHttp2Session>();
  let requests = 0;
  let mode: Mode = 'valid';
  let redirect = '';
  let releaseReset: (() => void) | undefined;
  let active = 0;
  t.after(() => {
    for (const session of sessions) session.destroy();
  });
  server.on('session', (session) => {
    sessions.add(session);
    session.on('error', () => {});
    session.once('close', () => sessions.delete(session));
  });
  server.on('stream', (stream) => {
    stream.on('error', () => {});
    requests++;
    active++;
    const transfer = mode;
    const lifetime = setTimeout(() => stream.close(constants.NGHTTP2_CANCEL), 3800);
    stream.once('close', () => { clearTimeout(lifetime); active--; });
    if (transfer === 'no-head') return;
    if (transfer === 'redirect' || transfer === 'misdirected') {
      stream.respond({
        ':status': transfer === 'redirect' ? 307 : 421,
        location: redirect + '/blob',
        'content-length': 0,
      });
      stream.end();
      return;
    }
    const reset = transfer === 'reset' || transfer === 'no-error-reset';
    const sendTrailer = ['valid', 'wrong', 'duplicate', 'oversized', 'coding'].includes(transfer);
    if (sendTrailer) stream.once('wantTrailers', () => {
      stream.sendTrailers({
        'x-blob-complete': transfer === 'duplicate' ? ['1', '1'] : transfer === 'wrong' ? '0' : '1',
      });
    });
    stream.respond({
      ':status': 200,
      'content-type': 'application/octet-stream',
      'content-length': LENGTH,
      ...(transfer === 'initial-only' ? { 'x-blob-complete': '1' } : {}),
      ...(transfer === 'coding' ? { 'content-encoding': 'identity' } : {}),
    }, { waitForTrailers: sendTrailer || reset });
    const total = transfer === 'truncate' ? 4096 : transfer === 'oversized' ? LENGTH + 4096 : LENGTH;
    let offset = 0;
    const write = () => {
      if (stream.closed || stream.destroyed) return;
      while (offset < total) {
        const chunk = Buffer.alloc(4096);
        for (let index = 0; index < chunk.length; index++) {
          const n = offset + index;
          chunk[index] = (n ^ (n >>> 8)) & 255;
        }
        offset += chunk.length;
        if (!stream.write(chunk)) {
          stream.once('drain', write);
          return;
        }
      }
      if (reset) {
        releaseReset = () => stream.close(
          transfer === 'reset' ? constants.NGHTTP2_INTERNAL_ERROR : constants.NGHTTP2_NO_ERROR,
        );
      } else if (transfer !== 'stall') stream.end();
    };
    write();
  });
  await listenFixture(server, (cleanup) => t.after(cleanup));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    use(value: Mode, location = '') { mode = value; redirect = location; releaseReset = undefined; },
    get requests() { return requests; },
    get active() { return active; },
    get canReset() { return releaseReset !== undefined; },
    reset() {
      if (!releaseReset) throw new Error('fixture has not flushed all DATA');
      releaseReset();
    },
  };
}
