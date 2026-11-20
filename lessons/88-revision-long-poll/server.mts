import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { HttpError, json, numberSetting } from '../../lib/http.mts';
import { HEADER_BYTES, ignoreLateError } from './http.mts';

type Handler = (req: IncomingMessage, res: ServerResponse, signal: AbortSignal, started: number) => Promise<void>;

export function isDirectRun(moduleUrl: string): boolean {
  return process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === moduleUrl;
}

export async function serveLesson(
  service: string, defaultPort: number, handle: Handler, verifyPort?: (port: number) => void,
): Promise<void> {
  const port = numberSetting('PORT', defaultPort, 0, 65535);
  const shutdown = new AbortController();
  function dispatch(req: IncomingMessage, res: ServerResponse): void {
    const started = performance.now();
    req.on('error', ignoreLateError);
    res.on('error', ignoreLateError);
    const caller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) caller.abort();
    };
    // An ordinary GET request can finish arriving long before its response is sent.
    res.once('close', onClose);
    if (res.destroyed || req.socket.destroyed) onClose();
    const signal = AbortSignal.any([caller.signal, shutdown.signal]);
    void (async () => {
      try {
        signal.throwIfAborted();
        await handle(req, res, signal, started);
      } catch (error) {
        if (signal.aborted || res.destroyed || res.writableEnded) return;
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.setHeader('connection', 'close');
        const status = error instanceof HttpError ? error.status : 500;
        const code = error instanceof HttpError ? error.code : 'internal_error';
        json(res, status, { error: { code, message: code } });
      } finally {
        res.off('close', onClose);
      }
    })();
  }

  const server = createServer({
    maxHeaderSize: HEADER_BYTES, headersTimeout: 5000, requestTimeout: 5000, connectionsCheckingInterval: 1000,
  }, dispatch);
  server.on('checkExpectation', dispatch);
  server.maxHeadersCount = 0;
  server.maxConnections = 128;
  server.setTimeout(5000);
  function stop(): void {
    shutdown.abort();
    server.close();
    server.closeAllConnections();
  }

  try {
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    await new Promise<void>((resolve, reject) => {
      server.once('close', resolve);
      server.on('error', reject);
      server.listen(port, '127.0.0.1', () => {
        try {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
          verifyPort?.(address.port);
          console.log(JSON.stringify({ service, port: address.port }));
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    if (server.listening) {
      const closed = new Promise<void>(resolve => server.once('close', resolve));
      stop();
      await closed;
    }
  }
}
