import { randomBytes } from 'node:crypto';
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { Decoder, encodeFrame } from './codec.mts';
import { fields, websocketAccept, upgradeHeaders } from './handshake.mts';
import { Heartbeat } from './heartbeat.mts';
import { boundedWriter, CloseState, closeWindow } from './transport.mts';

const CAPACITY = 8;

const CLOSE_TIMEOUT = 250;
const HTTP_TIMEOUT = 500;

type Rejection = { status: number; code: string; allow?: string };
const badRequest: Rejection = { status: 400, code: 'bad_request' };
const busy: Rejection = { status: 503, code: 'busy' };

function errorBody(code: string): string {
  return JSON.stringify({ error: { code, message: code } });
}

function bodyless(request: IncomingMessage): boolean {
  const lengths = fields(request, 'content-length');
  return (lengths.length === 0 || (lengths.length === 1 && lengths[0] === '0'))
    && fields(request, 'transfer-encoding').length === 0
    && fields(request, 'trailer').length === 0
    && fields(request, 'content-encoding').length === 0
    && fields(request, 'content-type').length <= 1
    && fields(request, 'expect').length === 0;
}

export function validHost(host: string): boolean {
  const match = /^(?:127\.0\.0\.1|localhost)(?::([1-9][0-9]{0,4}))?(?![\s\S])/i.exec(host);
  return match !== null && (match[1] === undefined || Number(match[1]) <= 65535);
}

function route(request: IncomingMessage): Rejection | undefined {
  const target = request.url ?? '';
  if (target.includes('?')) return badRequest;
  if (target !== '/health' && target !== '/events') return { status: 404, code: 'not_found' };
  if (request.method !== 'GET') return { status: 405, code: 'method_not_allowed', allow: 'GET' };
  const hosts = fields(request, 'host');
  if (!bodyless(request) || hosts.length > 1 ||
      (request.httpVersion === '1.1' && (hosts.length !== 1 || !validHost(hosts[0] ?? '')))) {
    return badRequest;
  }
}

function acceptKey(request: IncomingMessage): string | undefined {
  const [version, ...otherVersions] = fields(request, 'sec-websocket-version');
  const [key, ...otherKeys] = fields(request, 'sec-websocket-key');
  if (request.httpVersion !== '1.1' || fields(request, 'origin').length > 1 ||
      !upgradeHeaders(request) ||
      version !== '13' || otherVersions.length || otherKeys.length ||
      fields(request, 'sec-websocket-protocol').length !== 0 ||
      key === undefined || !/^[A-Za-z0-9+/]{22}==$/.test(key)) return;
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length !== 16 || decoded.toString('base64') !== key) return;
  return websocketAccept(key);
}

function rejectDetachedHttp(socket: Duplex, rejection: Rejection): void {
  const body = errorBody(rejection.code);
  const timer = setTimeout(() => socket.destroy(), CLOSE_TIMEOUT);
  socket.once('close', () => clearTimeout(timer));
  socket.once('error', () => socket.destroy());
  socket.end([
    `HTTP/1.1 ${rejection.status} ${STATUS_CODES[rejection.status]}`,
    'Connection: close',
    'Content-Type: application/json;charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    ...(rejection.allow ? [`Allow: ${rejection.allow}`] : []),
    '', body,
  ].join('\r\n'));
}

type Peer = { start: (accept: string, head: Buffer) => void; shutdown: () => void };

function openPeer(socket: Duplex, remove: () => void): Peer {
  const decoder = new Decoder();
  const heartbeat = new Heartbeat(() => performance.now(), () => randomBytes(8));
  const closeState = new CloseState();
  let closeTimer: ReturnType<typeof closeWindow> | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  const writer = boundedWriter(socket, finishClose);

  function finishClose(): void {
    if (closeState.received && writer.empty() && !socket.destroyed) socket.end();
  }

  function close(payload: Buffer, received = false): void {
    if (received) closeState.receive();
    if (closeState.begin()) {
      clearTimeout(heartbeatTimer);
      closeTimer = closeWindow(() => socket.destroy());
      writer.send(encodeFrame(8, payload));
    }
    finishClose();
  }

  function closeWith(code: number): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code);
    close(payload);
  }

  function checkDeadline(): void {
    if (heartbeat.expired()) closeWith(1001);
  }

  function feed(data: Buffer): void {
    if (socket.destroyed) return;
    if (closeTimer?.expired()) {
      socket.destroy();
      return;
    }
    if (!closeState.sent) checkDeadline();
    decoder.feed(data, (event) => {
      if (event.kind === 'close') {
        close(event.payload, true);
        return false;
      }
      if (event.kind === 'ping' && closeState.acceptsPing) return writer.send(encodeFrame(10, event.payload));
      if (closeState.sent) return;
      if (event.kind === 'error') closeWith(event.code);
      if (event.kind === 'text') return writer.send(encodeFrame(1, Buffer.from(event.text)));
      if (event.kind === 'pong' && heartbeat.pong(event.payload)) scheduleHeartbeat();
    });
  }

  function scheduleHeartbeat(): void {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      const action = heartbeat.tick();
      if (action === 'expired') closeWith(1001);
      else if (!action || writer.send(encodeFrame(9, action))) scheduleHeartbeat();
    }, heartbeat.delay());
  }

  function onError(): void { socket.destroy(); }
  socket.on('data', feed);
  socket.on('error', onError);
  socket.once('close', () => {
    clearTimeout(heartbeatTimer);
    closeTimer?.cancel();
    socket.off('data', feed);
    socket.off('error', onError);
    remove();
  });
  return {
    start(accept, head) {
      // Queue HTTP before processing a frame delivered in the same TCP read.
      const response = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
        + `Connection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`;
      if (writer.send(Buffer.from(response))) {
        scheduleHeartbeat();
        if (head.length) feed(head);
      }
    },
    shutdown: () => closeWith(1001),
  };
}

export function createLessonServer() {
  const peers = new Map<Duplex, Peer>();
  const httpSockets = new WeakMap<Duplex, { timer: NodeJS.Timeout; deadline: number }>();
  let stopping = false;

  function clearHttpTimer(socket: Duplex) {
    clearTimeout(httpSockets.get(socket)?.timer);
    httpSockets.delete(socket);
  }

  function httpExpired(socket: Duplex): boolean {
    return performance.now() >= (httpSockets.get(socket)?.deadline ?? Infinity);
  }

  function httpRoute(request: IncomingMessage, response: ServerResponse): void {
    if (httpExpired(request.socket)) {
      request.socket.destroy();
      return;
    }
    const rejection = route(request) ?? (request.url === '/events' ? badRequest : undefined);
    const body = rejection ? errorBody(rejection.code) : JSON.stringify({ ok: true });
    response.writeHead(rejection?.status ?? 200, {
      'Content-Type': 'application/json;charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      Connection: 'close',
      ...(rejection?.allow ? { Allow: rejection.allow } : {}),
    });
    response.end(body);
  }

  const server = createServer({ maxHeaderSize: 8192, highWaterMark: 4096, requireHostHeader: false }, httpRoute);
  server.maxHeadersCount = 0;
  server.on('checkContinue', httpRoute);
  server.on('checkExpectation', httpRoute);
  server.on('connection', (socket) => {
    const deadline = performance.now() + HTTP_TIMEOUT;
    const timer = setTimeout(() => socket.destroy(), HTTP_TIMEOUT);
    httpSockets.set(socket, { deadline, timer });
    socket.once('close', () => clearHttpTimer(socket));
  });
  server.on('connect', (request, socket) => {
    if (httpExpired(socket)) {
      socket.destroy();
      return;
    }
    clearHttpTimer(socket);
    rejectDetachedHttp(socket, route(request) ?? badRequest);
  });
  server.on('upgrade', (request, socket, head) => {
    if (httpExpired(socket)) {
      socket.destroy();
      return;
    }
    clearHttpTimer(socket);
    const rejection = route(request);
    if (rejection) return rejectDetachedHttp(socket, rejection);
    const accept = request.url === '/events' ? acceptKey(request) : undefined;
    if (!accept) return rejectDetachedHttp(socket, badRequest);
    if (stopping || peers.size >= CAPACITY) return rejectDetachedHttp(socket, busy);

    const peer = openPeer(socket, () => peers.delete(socket));
    peers.set(socket, peer);
    peer.start(accept, head);
  });

  return {
    server,
    shutdown() {
      if (stopping) return;
      stopping = true;
      server.close();
      server.closeAllConnections();
      for (const peer of peers.values()) peer.shutdown();
    },
  };
}

if (import.meta.main) {
  const portText = process.env.PORT ?? '8099';
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port > 65535) throw new Error('invalid_port');
  const { server, shutdown } = createLessonServer();
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address === 'object') console.log(JSON.stringify({ port: address.port }));
  });
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('close', () => {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  });
}
