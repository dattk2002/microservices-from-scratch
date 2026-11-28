import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Server, Socket } from 'node:net';
import { deadline, limit } from './contracts.mts';

export const httpOptions = {
  maxHeaderSize: limit,
  headersTimeout: deadline,
  requestTimeout: deadline,
  connectionsCheckingInterval: 100,
  keepAliveTimeout: deadline,
};

const singleton = new Set([
  'host', 'content-type', 'content-length', 'transfer-encoding', 'content-encoding',
  'trailer', 'expect', 'location', 'upgrade', 'connection',
]);

export function representation(raw: string[]): Map<string, string> {
  const fields = new Map<string, string>();
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index];
    const value = raw[index + 1];
    if (key === undefined || value === undefined) throw new Error('Incomplete header pair');
    const name = key.toLowerCase();
    if (!singleton.has(name)) continue;
    if (fields.has(name)) throw new Error('Duplicate header');
    fields.set(name, value);
  }
  if (fields.has('trailer') ||
      (fields.has('transfer-encoding') && (fields.has('content-length') ||
        fields.get('transfer-encoding')?.toLowerCase() !== 'chunked'))) {
    throw new Error('Ambiguous framing');
  }
  return fields;
}

export function validJsonMedia(value: string | undefined): boolean {
  return value !== undefined &&
    /^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(value) &&
    !/[\r\n]/.test(value);
}

export function reply(response: ServerResponse, status: number, data: object, allow?: string): void {
  if (response.destroyed) return;
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
    ...(allow === undefined ? {} : { allow }),
  });
  response.end(body);
}

export function errorReply(response: ServerResponse, status: number, code: string, allow?: string): void {
  reply(response, status, { error: { code, message: code } }, allow);
}

type RouteError = { status: number; code: string; allow?: string };
type Route = { path: '/health' | '/value' } | RouteError;

const badRequest: RouteError = { status: 400, code: 'bad_request' };

function bodylessHeaders(request: IncomingMessage): boolean {
  try {
    const headers = representation(request.rawHeaders);
    return !headers.has('transfer-encoding') && !headers.has('content-encoding') &&
      !headers.has('expect') && (headers.get('content-length') ?? '0') === '0';
  } catch {
    return false;
  }
}

function classifyRoute(request: IncomingMessage): Route {
  const target = request.url;
  if (target?.includes('?')) return badRequest;
  if (target !== '/health' && target !== '/value') return { status: 404, code: 'not_found' };
  if (request.method !== 'GET') return { status: 405, code: 'method_not_allowed', allow: 'GET' };
  return { path: target };
}

export async function bodylessRoute(request: IncomingMessage, response: ServerResponse): Promise<string | undefined> {
  const end = performance.now() + deadline;
  try {
    if (!bodylessHeaders(request)) throw new Error('Body or unsupported framing');
    const timer = setTimeout(() => request.destroy(), deadline);
    try {
      for await (const _chunk of request) {
        throw new Error('Body on bodyless route');
      }
      if (!request.complete || request.rawTrailers.length || performance.now() >= end) {
        throw new Error('Incomplete request');
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    errorReply(response, badRequest.status, badRequest.code);
    return;
  }
  const route = classifyRoute(request);
  if ('status' in route) {
    errorReply(response, route.status, route.code, route.allow);
  } else if (request.headers.connection?.split(',').some((token) => token.trim().toLowerCase() === 'upgrade') ||
      request.rawHeaders.some((field, index) => index % 2 === 0 && field.toLowerCase() === 'upgrade')) {
    errorReply(response, badRequest.status, badRequest.code);
  } else {
    return route.path;
  }
}

export function rejectUpgrade(request: IncomingMessage, socket: Duplex, authorized = true): void {
  const route = bodylessHeaders(request) ? classifyRoute(request) : badRequest;
  const { status, code, allow } = 'status' in route ? route :
    authorized ? badRequest : { status: 403, code: 'forbidden' };
  const body = JSON.stringify({ error: { code, message: code } });
  const headers = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}`,
    'Content-Type: application/json;charset=utf-8',
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Connection: close',
  ];
  if (allow !== undefined) headers.push(`Allow: ${allow}`);
  // The HTTP parser has detached. Bound the raw write/close and consume socket errors.
  const timer = setTimeout(() => socket.destroy(), deadline);
  socket.once('close', () => clearTimeout(timer));
  socket.on('error', () => socket.destroy());
  socket.end(headers.join('\r\n') + '\r\n\r\n' + (request.method === 'HEAD' ? '' : body));
}

export function trackConnections(server: Server, lifetime?: number): () => void {
  const sockets = new Map<Socket, NodeJS.Timeout | undefined>();
  server.maxConnections = 64;
  server.prependListener('connection', (socket: Socket) => {
    // A one-shot timer is independent of the socket's inactivity timer.
    const timer = lifetime === undefined ? undefined : setTimeout(() => socket.destroy(), lifetime);
    sockets.set(socket, timer);
    socket.once('close', () => {
      clearTimeout(timer);
      sockets.delete(socket);
    });
  });
  return () => {
    server.close();
    for (const [socket, timer] of sockets) {
      clearTimeout(timer);
      socket.destroy();
    }
  };
}

export function listen(server: Server, port: number, stop = trackConnections(server)): void {
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(JSON.stringify({ port: address.port }));
  });
}
