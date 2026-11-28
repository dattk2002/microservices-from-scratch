import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as httpsServer, request as httpsRequest } from 'node:https';
import { connect as tcpConnect, createServer as tcpServer, type Server, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { TestContext } from 'node:test';
import type { PKI } from '../pki.mts';

export async function bound(t: TestContext, server: Server): Promise<number> {
  const sockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture listen timed out')), 2500);
    server.once('error', (error) => { clearTimeout(timer); reject(error); });
    server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return address.port;
}

export async function fixture(t: TestContext, pki: PKI, pair = pki.server) {
  const timers = new Set<NodeJS.Timeout>();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  let count = 0;
  let handler = (_request: IncomingMessage, response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"value":"trusted"}');
  };
  const server = httpsServer({
    ...pair, ca: pki.ca, requestCert: true, rejectUnauthorized: true, handshakeTimeout: 1000,
    headersTimeout: 1000, requestTimeout: 1000,
  }, (request, response) => {
    count++;
    handler(request, response);
  });
  server.on('tlsClientError', (_error, socket) => socket.destroy());
  const port = await bound(t, server);
  return {
    port,
    hits: () => count,
    set(handlerForNextRequest: typeof handler) { handler = handlerForNextRequest; },
    later(fn: () => void, ms: number) {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
      timers.add(timer);
    },
  };
}

export function stalled(t: TestContext) {
  let hits = 0;
  let closed = 0;
  const server = tcpServer((socket) => {
    hits++;
    socket.once('close', () => { closed++; });
    socket.resume();
  });
  return { port: bound(t, server), hits: () => hits, closed: () => closed };
}

export function exchange(url: string, options: Parameters<typeof httpsRequest>[1] = {}) {
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const controller = new AbortController();
  const result = new Promise<{ status: number | undefined; body: unknown; allow?: string }>((resolve, reject) => {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]);
    const call = request(target, { ...options, agent: false, signal }, async (response) => {
      try {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of response) {
          assert.ok(Buffer.isBuffer(chunk));
          length += chunk.length;
          assert.ok(length <= 8192);
          chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString();
        const body: unknown = text ? JSON.parse(text) : undefined;
        resolve({ status: response.statusCode, body, allow: response.headers.allow });
      } catch (error) {
        call.destroy();
        reject(error);
      }
    });
    call.on('error', reject);
    call.end();
  });
  return { result, cancel: () => controller.abort() };
}

export async function until(predicate: () => boolean) {
  const end = performance.now() + 2000;
  while (!predicate()) {
    if (performance.now() >= end) throw new Error('Fixture did not observe expected event');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export async function rawHttp(url: string, payload: string, tls?: { ca: string; cert: string; key: string }) {
  const port = Number(new URL(url).port);
  const socket = tls === undefined
    ? tcpConnect({ host: '127.0.0.1', port })
    : tlsConnect({ ...tls, host: '127.0.0.1', port, servername: 'provider.local' });
  const timer = setTimeout(() => socket.destroy(new Error('Raw HTTP fixture deadline')), 2500);
  try {
    socket.once(tls === undefined ? 'connect' : 'secureConnect', () => socket.write(payload));
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of socket) {
      assert.ok(Buffer.isBuffer(chunk));
      size += chunk.length;
      assert.ok(size <= 8192);
      chunks.push(chunk);
    }
    const wire = Buffer.concat(chunks).toString('utf8');
    const boundary = wire.indexOf('\r\n\r\n');
    assert.ok(boundary > 0, 'expected a complete HTTP header block');
    const headers = wire.slice(0, boundary);
    const text = wire.slice(boundary + 4);
    assert.match(headers, /\r\nContent-Type: application\/json;charset=utf-8\r\n/i);
    assert.equal(Number(/\r\nContent-Length: (\d+)\r\n/i.exec(headers)?.[1]), Buffer.byteLength(text));
    const body: unknown = JSON.parse(text);
    return { headers, body };
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
}
