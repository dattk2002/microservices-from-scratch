import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fieldValues, maxBytes } from './policy.mts';

type Handler = (res: ServerResponse) => void | Promise<void>;

export function json(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  }).end(body);
}

export function errorReply(res: ServerResponse, status: number, code: string): void {
  json(res, status, { error: { code, message: code } });
}

function hasInvalidBody(req: IncomingMessage): boolean {
  const lengths = fieldValues(req.rawHeaders, 'content-length');
  const [length] = lengths;
  return lengths.length > 1 || (length !== undefined && !/^0+$/.test(length))
    || fieldValues(req.rawHeaders, 'transfer-encoding').length !== 0
    || fieldValues(req.rawHeaders, 'trailer').length !== 0
    || fieldValues(req.rawHeaders, 'expect').length !== 0
    || fieldValues(req.rawHeaders, 'content-type').length > 1
    || fieldValues(req.rawHeaders, 'content-encoding').length !== 0
    || fieldValues(req.rawHeaders, 'host').length > 1;
}

export async function serve(name: string, defaultPort: number, path: string, handle: Handler): Promise<void> {
  const setting = process.env.PORT ?? String(defaultPort);
  const port = Number(setting);
  if (!/^[0-9]+$/.test(setting) || !Number.isSafeInteger(port) || port > 65535) throw new Error('Invalid PORT');

  function route(req: IncomingMessage, res: ServerResponse): void {
    const target = req.url ?? '';
    const query = target.indexOf('?');
    const pathname = query === -1 ? target : target.slice(0, query);
    // No route reads request bodies. Close after an early rejection so unread bytes
    // cannot keep the connection alive. This also suppresses automatic 100 Continue.
    const reject = (status: number, code: string): void => {
      res.setHeader('connection', 'close');
      errorReply(res, status, code);
    };
    if (fieldValues(req.rawHeaders, 'host').length > 1) return reject(400, 'invalid_body');
    if (pathname !== '/health' && pathname !== path) return reject(404, 'not_found');
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      return reject(405, 'method_not_allowed');
    }
    if (query !== -1) return reject(400, 'invalid_query');
    if (hasInvalidBody(req)) return reject(400, 'invalid_body');
    if (pathname === '/health') return json(res, 200, {status: 'ok'});

    Promise.resolve().then(() => {
      if (!res.destroyed) return handle(res);
    }).catch(() => {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) res.destroy();
      else reject(500, 'internal_error');
    });
  }

  const server = createServer({
    maxHeaderSize: maxBytes, headersTimeout: 500, requestTimeout: 500, connectionsCheckingInterval: 100,
  }, route);
  server.maxHeadersCount = 0;
  server.setTimeout(5000, socket => socket.destroy());
  server.on('checkContinue', route);
  server.on('checkExpectation', route);

  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  let failure: Error | undefined;
  server.on('error', error => {
    failure = error;
    stop();
  });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const listening = once(server, 'listening');
    server.listen(port, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    if (!shutdown.signal.aborted) {
      console.log(JSON.stringify({service: name, port: address.port}));
      await once(shutdown.signal, 'abort');
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    if (server.listening) {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }
  if (failure) throw failure;
}
