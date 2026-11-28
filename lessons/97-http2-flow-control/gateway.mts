import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { connect, constants } from 'node:http2';
import type { ClientHttp2Stream } from 'node:http2';
import {
  BINARY, BLOB_BYTES, CAPACITY, JSON_BYTES, JSON_MEDIA, JSON_MS, MARKER, STREAM_WINDOW,
  TRANSFER_MS, bodyless, deadline, encodeJson, errorBody, fields, port, rejectRoute, timeout,
} from './protocol.mts';
import { pump } from './pump.mts';

function reply(response: ServerResponse, status: number, value: object) {
  const body = encodeJson(value);
  const socket = response.socket;
  if (socket) {
    const timer = setTimeout(() => socket.destroy(), JSON_MS);
    socket.once('close', () => clearTimeout(timer));
  }
  response.writeHead(status, {
    'content-type': JSON_MEDIA, 'content-length': body.length,
    ...(status === 405 ? { allow: 'GET' } : {}),
  });
  response.end(body);
}

function sourceOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.username || url.password || url.href !== url.origin + '/') {
    throw new Error('PROVIDER_ORIGIN must be an h2c HTTP origin');
  }
  return url.origin;
}

async function* binaryChunks(stream: ClientHttp2Stream): AsyncIterable<Buffer> {
  // The readable iterator pulls only when the pump asks for the next chunk.
  // Keep it in paused/readable mode even while the HTTP/1 writer waits for drain.
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    if (!Buffer.isBuffer(chunk)) throw new Error('expected binary data');
    yield chunk;
  }
}

async function download(origin: string, response: ServerResponse) {
  const operation = deadline(TRANSFER_MS);
  const { signal, controller } = operation;
  const disconnect = () => controller.abort(new Error('caller disconnected'));
  response.once('close', disconnect);
  try {
    operation.check();
    const session = connect(origin, {
      settings: { initialWindowSize: STREAM_WINDOW, maxHeaderListSize: JSON_BYTES, enablePush: false },
      maxHeaderListPairs: 64,
      maxSessionMemory: 2,
    });
    const fail = (error: Error) => controller.abort(error);
    session.on('error', fail);
    const closeSession = () => session.destroy();
    signal.addEventListener('abort', closeSession, { once: true });
    try {
      const upstream = session.request({ ':method': 'GET', ':path': '/blob' }, { endStream: true });
      upstream.on('error', fail);
      let headValid = false;
      let trailers = 0;
      let trailerValid = false;
      upstream.on('trailers', (_headers, flags, raw) => {
        trailers++;
        trailerValid = (flags & constants.NGHTTP2_FLAG_END_STREAM) !== 0 &&
          raw.length === 2 && raw[0] === MARKER && raw[1] === '1';
      });
      upstream.once('response', (headers, flags, raw) => {
        headValid = headers[':status'] === 200 &&
          fields(raw, ':status').length === 1 &&
          (flags & constants.NGHTTP2_FLAG_END_STREAM) === 0 &&
          fields(raw, 'content-type').length === 1 && fields(raw, 'content-type')[0] === BINARY &&
          fields(raw, 'content-length').length === 1 && fields(raw, 'content-length')[0] === String(BLOB_BYTES) &&
          ['content-encoding', 'transfer-encoding', 'content-range', 'trailer', MARKER]
            .every((name) => fields(raw, name).length === 0);
      });
      const closedBeforeHead = () => fail(new Error('upstream closed before headers'));
      upstream.once('close', closedBeforeHead);
      await once(upstream, 'response', { signal });
      upstream.off('close', closedBeforeHead);
      operation.check();
      if (!headValid) throw new Error('invalid upstream response headers');

      let remaining = BLOB_BYTES;
      let lastByte: Buffer | undefined;
      const length = await pump(binaryChunks(upstream), (chunk) => {
        operation.check();
        remaining -= chunk.length;
        let forward = chunk;
        if (remaining === 0) {
          // Copy one byte so retaining the marker byte retains no DATA buffer.
          lastByte = Buffer.from(chunk.subarray(-1));
          forward = chunk.subarray(0, -1);
        }
        if (forward.length === 0) return true;
        if (!response.headersSent) response.writeHead(200, { 'content-type': BINARY, 'content-length': BLOB_BYTES });
        return response.write(forward);
      }, async () => {
        upstream.pause();
        await once(response, 'drain', { signal });
      }, BLOB_BYTES, signal);

      operation.check();
      if (length !== BLOB_BYTES || !upstream.readableEnded || upstream.rstCode !== constants.NGHTTP2_NO_ERROR ||
          trailers !== 1 || !trailerValid || lastByte === undefined) {
        throw new Error('incomplete upstream body');
      }
      const flushed = once(response, 'finish', { signal });
      response.end(lastByte);
      await flushed;
      operation.check();
    } finally {
      signal.removeEventListener('abort', closeSession);
      session.destroy();
    }
  } catch {
    if (response.headersSent || response.destroyed) response.destroy();
    else if (signal.reason === timeout) reply(response, 504, errorBody('upstream_timeout'));
    else reply(response, 502, errorBody('upstream_failure'));
  } finally {
    response.off('close', disconnect);
    operation.dispose();
  }
}

export function createGateway(providerOrigin: string) {
  const origin = sourceOrigin(providerOrigin);
  let active = 0;
  const awaitingHead = new WeakMap<IncomingMessage['socket'], NodeJS.Timeout>();
  const server = createServer({
    maxHeaderSize: JSON_BYTES,
    headersTimeout: JSON_MS,
    requestTimeout: JSON_MS,
    connectionsCheckingInterval: 100,
    keepAlive: false,
  });
  server.maxConnections = 64;
  server.maxHeadersCount = 0;
  server.maxRequestsPerSocket = 1;
  server.on('connection', (socket) => {
    const timer = setTimeout(() => socket.destroy(), JSON_MS);
    awaitingHead.set(socket, timer);
    socket.once('close', () => clearTimeout(timer));
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    clearTimeout(awaitingHead.get(request.socket));
    response.shouldKeepAlive = false;
    const rejection = rejectRoute(request.method, request.url, ['/blob', '/health', '/stats'], bodyless(request.rawHeaders));
    if (rejection) reply(response, rejection.status, errorBody(rejection.code));
    else if (request.url === '/health') reply(response, 200, { status: 'ok' });
    else if (request.url === '/stats') reply(response, 200, { active });
    else if (active >= CAPACITY) reply(response, 503, errorBody('busy'));
    else {
      active++;
      try { await download(origin, response); }
      finally { active--; }
    }
  }

  server.on('request', (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    void handle(request, response).catch(() => response.destroy());
  });
  server.on('checkContinue', (request, response) => server.emit('request', request, response));
  server.on('checkExpectation', (request, response) => server.emit('request', request, response));
  return server;
}

if (import.meta.main) {
  const server = createGateway(process.env.PROVIDER_ORIGIN ?? 'http://127.0.0.1:9797');
  server.listen(port(9798), process.env.HOST ?? '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(JSON.stringify({ port: address.port }));
  });
}
