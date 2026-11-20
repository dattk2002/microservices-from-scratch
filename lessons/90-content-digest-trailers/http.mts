import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json } from '../../lib/http.mts';
import { rawFieldValues } from './headers.mts';

type Handler = (req: IncomingMessage, res: ServerResponse, shutdown: AbortSignal) => void | Promise<void>;

export function problem(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function pathOf(req: IncomingMessage): string {
  const target = req.url ?? '';
  const query = target.indexOf('?');
  return query === -1 ? target : target.slice(0, query);
}

export function requireBodyless(
  req: IncomingMessage, res: ServerResponse, method: string,
): void {
  if (req.method !== method) {
    res.setHeader('allow', method);
    problem(405, 'method_not_allowed');
  }
  if (req.url?.includes('?')) problem(400, 'invalid_query');

  const lengths = rawFieldValues(req.rawHeaders, 'content-length');
  const [length] = lengths;
  if (rawFieldValues(req.rawHeaders, 'transfer-encoding').length !== 0
    || lengths.length > 1 || (length !== undefined && !/^0+$/.test(length))) {
    problem(400, 'invalid_body');
  }
}

export async function serve(service: string, port: number, handler: Handler): Promise<void> {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handler(req, res, shutdown.signal);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      // An early rejection can leave an unread request body.
      res.setHeader('connection', 'close');
      const code = error instanceof HttpError ? error.code : 'internal_error';
      json(res, error instanceof HttpError ? error.status : 500, {error: {code, message: code}});
    }
  };

  const server = createServer({
    maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000,
    connectionsCheckingInterval: 1000,
  }, onRequest);
  server.maxHeadersCount = 0;
  server.setTimeout(5000, socket => socket.destroy());
  server.on('checkContinue', onRequest);
  server.on('checkExpectation', onRequest);

  // Keep owning accept errors after the startup wait has removed its listener.
  let failure: Error | undefined;
  server.on('error', error => {
    failure ??= error;
    stop();
  });

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
    if (!shutdown.signal.aborted) {
      console.log(JSON.stringify({service, port: address.port}));
      await once(shutdown.signal, 'abort');
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    shutdown.abort();
    if (server.listening) {
      await new Promise<void>(resolve => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
  }
  if (failure) throw failure;
}
