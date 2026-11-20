import { once } from 'node:events';
import { request } from 'node:http';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';

export function portOf(url: string): number {
  return Number(new URL(url).port);
}

export function packet(payload: string | Buffer): Buffer {
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

export function openRaw(t: TestContext, port: number) {
  const socket = createConnection({host: '127.0.0.1', port, allowHalfOpen: true, noDelay: true});
  let timer: NodeJS.Timeout | undefined;
  t.after(() => { clearTimeout(timer); socket.destroy(); });

  let error: Error | undefined;
  let ended = false;
  let timedOut = false;
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  socket.on('error', (reason: Error) => { error = reason; });
  socket.once('end', () => {
    ended = true;
    if (!socket.writableEnded) socket.end();
  });

  const opened = new Promise<boolean>((resolve) => {
    socket.once('connect', () => resolve(true));
    socket.once('close', () => resolve(false));
  });
  const closed = new Promise((resolve: (value: {
    bytes: Buffer; error: Error | undefined; ended: boolean; timedOut: boolean;
  }) => void) => {
    socket.once('close', () => {
      clearTimeout(timer);
      resolve({bytes: Buffer.concat(chunks), error, ended, timedOut});
    });
  });
  timer = setTimeout(() => {
    timedOut = true;
    socket.destroy();
  }, 3000);
  return {socket, opened, closed, chunks};
}

type Reply = (socket: Socket) => void;
type Attempt = {socket: Socket; wire?: Buffer; closed: Promise<void>};

export async function startPeer(t: TestContext, initial: Reply) {
  const sockets = new Set<Socket>();
  const attempts: Attempt[] = [];
  let reply = initial;
  const server = createServer({allowHalfOpen: true}, (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => { sockets.delete(socket); resolve(); });
    });
    const attempt: Attempt = {socket, closed};
    attempts.push(attempt);
    const send = reply;
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.once('end', () => {
      attempt.wire = Buffer.concat(chunks);
      server.emit('wire');
      send(socket);
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected loopback TCP peer');

  return {
    origin: `tcp://127.0.0.1:${address.port}`,
    attempts,
    setReply: (next: Reply) => { reply = next; },
    async waitForRequests(count: number) {
      const signal = AbortSignal.timeout(2500);
      while (attempts.filter((attempt) => attempt.wire !== undefined).length < count) {
        await once(server, 'wire', {signal});
      }
    },
  };
}

type HttpOptions = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
};

export function callHttp(t: TestContext, url: string, {
  method = 'POST', path = '/echo', headers = {'content-type': 'application/json'}, body = '{"text":"Hello 86"}',
}: HttpOptions = {}) {
  const call = request(new URL(url), {
    path, method, headers, agent: false, maxHeaderSize: 8192, signal: AbortSignal.timeout(3500),
  });
  t.after(() => { call.destroy(); });

  const response = new Promise<{status: number | undefined; allow: string | undefined; body: unknown}>((resolve, reject) => {
    call.on('error', reject);
    call.once('response', (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('error', reject);
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.once('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const body: unknown = raw === '' ? undefined : JSON.parse(raw);
          resolve({status: incoming.statusCode, allow: incoming.headers.allow, body});
        } catch (error) {
          reject(error);
        }
      });
    });
  });
  call.maxHeadersCount = 0;
  call.end(body === '' ? undefined : body);
  return {call, response};
}
