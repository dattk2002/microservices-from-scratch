import { once } from 'node:events';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import type { TestContext } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

type PeerRequest = {
  head: string;
  socket: Socket;
  disconnected: Promise<void>;
};

export async function openPeer(t: TestContext, reply: (socket: Socket) => void) {
  const requests: PeerRequest[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer({allowHalfOpen: true}, socket => {
    connections++;
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      if (head.length > 8192) {
        socket.destroy();
        return;
      }
      const terminator = head.indexOf('\r\n\r\n');
      if (terminator < 0) return;
      socket.off('data', onData);
      const disconnected = new Promise<void>(resolve => {
        socket.once('end', resolve);
        socket.once('close', resolve);
      });
      requests.push({head: head.slice(0, terminator), socket, disconnected});
      reply(socket);
    };
    socket.on('data', onData);
  });
  t.after(async () => {
    const closed = server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : undefined;
    for (const socket of sockets) socket.destroy();
    await closed;
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    get connections() { return connections; },
  };
}

export type Reply = {
  status: number | undefined;
  headers: IncomingHttpHeaders;
  rawHeaders: string[];
  rawTrailers: string[];
  body: Buffer;
};

export function call(
  origin: string, method: string, path: string,
  options: {headers?: Record<string, string> | string[]; body?: string; signal?: AbortSignal} = {},
): Promise<Reply> {
  const timer = AbortSignal.timeout(3000);
  const signal = options.signal ? AbortSignal.any([timer, options.signal]) : timer;
  return new Promise((resolve, reject) => {
    const req = request(origin, {
      method, path, headers: options.headers, agent: false, signal, maxHeaderSize: 8192,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('error', reject);
      res.once('end', () => {
        if (!res.complete) {
          reject(new Error('Incomplete application response'));
          return;
        }
        resolve({
          status: res.statusCode, headers: res.headers,
          rawHeaders: res.rawHeaders, rawTrailers: res.rawTrailers, body: Buffer.concat(chunks),
        });
      });
    });
    req.maxHeadersCount = 0;
    req.on('error', reject);
    req.end(options.body);
  });
}

export const blobFields = [
  'Content-Type: application/octet-stream', 'Transfer-Encoding: chunked', 'Trailer: Content-Digest',
];

export function chunkedWire(
  body: Buffer, trailers: readonly string[],
  {status = '200 OK', fields = blobFields}: {status?: string; fields?: readonly string[]} = {},
): Buffer {
  const head = Buffer.from(`HTTP/1.1 ${status}\r\n${fields.join('\r\n')}\r\n\r\n`);
  const chunks = body.length > 0 ? [Buffer.from(`${body.length.toString(16)}\r\n`), body, Buffer.from('\r\n')] : [];
  const tail = Buffer.from('0\r\n' + trailers.map(line => line + '\r\n').join('') + '\r\n');
  return Buffer.concat([head, ...chunks, tail]);
}

export async function waitForRequests(requests: readonly PeerRequest[], count: number): Promise<void> {
  const signal = AbortSignal.timeout(2500);
  while (requests.length < count) await pause(5, undefined, {signal});
  if (requests.length !== count) throw new Error(`Expected ${count} calls, saw ${requests.length}`);
}
