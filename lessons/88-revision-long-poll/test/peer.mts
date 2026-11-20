import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

const snapshot = '{"revision":2,"value":42}';
const jsonMedia = 'Content-Type: application/json';
const validMedia = 'Content-Type: APPLICATION/JSON ; CHARSET="UTF-8"';

function head(status: number, ...fields: string[]): string {
  return [`HTTP/1.1 ${status} Fixture`, 'Connection: close', ...fields, '', ''].join('\r\n');
}

function sendJson(socket: Socket, status: number, body: string, ...fields: string[]): void {
  socket.end(head(status, jsonMedia, `Content-Length: ${Buffer.byteLength(body)}`, ...fields) + body);
}

function errorBody(code: string): string {
  return JSON.stringify({ error: { code, message: code } });
}

function chunk(body: string): string {
  return `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n`;
}

type Exchange = {
  socket: Socket;
  mode: string;
  modeCalls: number;
  redirect: string | undefined;
  later: (ms: number, callback: () => void, terminal?: boolean) => void;
};

function respond({ socket, mode, modeCalls, redirect, later }: Exchange): void {
  switch (mode) {
    case 'valid':
      socket.end(head(200, validMedia, 'Content-Encoding: identity', `Content-Length: ${snapshot.length}`) + snapshot);
      break;
    case 'close-delimited':
      socket.end(head(200, jsonMedia) + snapshot);
      break;
    case 'chunked':
      socket.end(head(200, jsonMedia, 'Transfer-Encoding: chunked') + chunk(snapshot) + '0\r\n\r\n');
      break;
    case 'trailer-media':
      socket.end(head(200, jsonMedia, 'Transfer-Encoding: chunked') + chunk(snapshot) +
        '0\r\nContent-Type: application/json\r\n\r\n');
      break;
    case 'empty': socket.end(head(204)); break;
    case 'empty-type': socket.end(head(204, jsonMedia)); break;
    case 'empty-length': socket.end(head(204, 'Content-Length: 0')); break;
    case 'empty-transfer': socket.end(head(204, 'Transfer-Encoding: chunked') + '0\r\n\r\n'); break;
    case 'future': sendJson(socket, 409, errorBody('future_revision')); break;
    case 'busy': sendJson(socket, 503, errorBody('busy')); break;
    case 'future-wrong-code': sendJson(socket, 409, errorBody('internal_error')); break;
    case 'busy-wrong-code': sendJson(socket, 503, errorBody('internal_error')); break;
    case 'future-wrong-message': sendJson(socket, 409, '{"error":{"code":"future_revision","message":"other"}}'); break;
    case 'busy-array': sendJson(socket, 503, '[]'); break;
    case 'future-null': sendJson(socket, 409, 'null'); break;
    case 'busy-extra': sendJson(socket, 503, '{"error":{"code":"busy","message":"busy","extra":1}}'); break;
    case 'same': sendJson(socket, 200, '{"revision":1,"value":42}'); break;
    case 'schema-extra': sendJson(socket, 200, '{"revision":2,"value":42,"extra":1}'); break;
    case 'revision-range': sendJson(socket, 200, '{"revision":17,"value":42}'); break;
    case 'value-range': sendJson(socket, 200, '{"revision":2,"value":101}'); break;
    case 'primitive': sendJson(socket, 200, 'false'); break;
    case 'malformed': sendJson(socket, 200, '{"revision":2'); break;
    case 'non-utf8':
      socket.end(Buffer.concat([Buffer.from(head(200, jsonMedia, 'Content-Length: 4')), Buffer.from([34, 0xc0, 0xaf, 34])]));
      break;
    case 'bad-media':
      socket.end(head(200, 'Content-Type: application/json; charset="utf-8"; extra=yes') + snapshot);
      break;
    case 'bad-coding': sendJson(socket, 200, snapshot, 'Content-Encoding: gzip'); break;
    case 'duplicate-late':
      sendJson(socket, 200, snapshot, ...Array<string>(1050).fill('X: x'), jsonMedia);
      break;
    case 'duplicate-coding':
      sendJson(socket, 200, snapshot, 'Content-Encoding: identity', 'Content-Encoding: identity');
      break;
    case 'duplicate-length': sendJson(socket, 200, snapshot, `Content-Length: ${snapshot.length}`); break;
    case 'big-headers': sendJson(socket, 200, snapshot, 'X: ' + 'x'.repeat(8192)); break;
    case 'bounded': sendJson(socket, 200, snapshot.padStart(8192, ' ')); break;
    case 'oversized':
      socket.end(head(200, jsonMedia, 'Transfer-Encoding: chunked') +
        chunk(snapshot.padStart(8193, ' ')) + '0\r\n\r\n');
      break;
    case 'truncated':
      socket.end(head(200, jsonMedia, `Content-Length: ${snapshot.length + 9}`) + snapshot);
      break;
    case 'premature-close': socket.destroy(); break;
    case 'late-header': later(650, () => sendJson(socket, 200, snapshot), true); break;
    case 'late-eof':
      later(280, () => socket.write(head(200, jsonMedia, 'Transfer-Encoding: chunked') + chunk(snapshot)));
      later(650, () => socket.end('0\r\n\r\n'), true);
      break;
    case 'redirect': socket.end(head(307, `Location: ${redirect}/hit`, 'Content-Length: 0')); break;
    case 'retry421':
      if (modeCalls === 1) sendJson(socket, 421, snapshot);
      else sendJson(socket, 200, snapshot);
      break;
    default: sendJson(socket, 500, errorBody('internal_error'));
  }
}

async function main(): Promise<void> {
  const sockets = new Set<Socket>();
  let mode = 'valid';
  let count = 0;
  let modeCalls = 0;
  let lateTerminals = 0;
  let lastRequest = '';
  let lastEncoding: string | undefined;
  const server = createServer(socket => {
    sockets.add(socket);
    const timers = new Set<NodeJS.Timeout>();
    socket.on('error', () => {});
    socket.once('close', () => {
      sockets.delete(socket);
      for (const timer of timers) clearTimeout(timer);
    });
    socket.setTimeout(2000, () => socket.destroy());
    let request = '';
    function onData(bytes: Buffer): void {
      request += bytes.toString('latin1');
      if (request.length > 8192) { socket.destroy(); return; }
      const end = request.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const [first = '', ...headers] = request.slice(0, end).split('\r\n');
      const path = first.split(' ')[1];
      if (path === '/stats') {
        sendJson(socket, 200, JSON.stringify({ count, lastRequest, lastEncoding, lateTerminals }));
        return;
      }
      if (path?.startsWith('/mode/')) {
        mode = path.slice('/mode/'.length);
        modeCalls = 0;
        sendJson(socket, 200, '{}');
        return;
      }

      count++;
      modeCalls++;
      lastRequest = first;
      lastEncoding = headers.find(line => /^accept-encoding:/i.test(line))?.split(':')[1]?.trim();
      if (count > 180) { socket.destroy(); return; }
      respond({
        socket, mode, modeCalls, redirect: process.env.REDIRECT_ORIGIN,
        later(ms, callback, terminal = false) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (socket.destroyed) return;
            if (terminal) lateTerminals++;
            callback();
          }, ms);
          timers.add(timer);
        },
      });
    }
    socket.on('data', onData);
  });
  server.maxConnections = 64;
  function stop(): void {
    server.close();
    for (const socket of sockets) socket.destroy();
  }
  try {
    process.once('SIGTERM', stop);
    await new Promise<void>((resolve, reject) => {
      server.once('close', resolve);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') { reject(new Error('Expected TCP port')); return; }
        console.log(JSON.stringify({ service: 'fixture', port: address.port }));
      });
    });
  } finally {
    process.off('SIGTERM', stop);
    if (server.listening) {
      const closed = new Promise<void>(resolve => server.once('close', resolve));
      stop();
      await closed;
    }
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
