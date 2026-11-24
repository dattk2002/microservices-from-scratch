import { once } from 'node:events';
import { lstatSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ListenOptions } from 'node:net';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEADLINE_MS, fields, MAX_BYTES, safeFraming, socketPath } from './contract.mts';

export function configuredSocket(): string {
  const dir = process.env.SOCKET_DIR ?? '';
  const uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(dir) || dir.includes('\0')) {
    throw new Error('A POSIX uid and an absolute SOCKET_DIR are required');
  }
  // Strip trailing slashes for lstat so the OS cannot follow a final symlink via "/".
  const stat = lstatSync(dir.replace(/\/+$/, '') || '/');
  return socketPath(dir, uid, {
    directory: stat.isDirectory(), uid: stat.uid, mode: stat.mode, canonical: realpathSync(dir),
  });
}

export function runDirectly(url: string, main: () => Promise<void>): void {
  const entry = process.argv[1];
  if (entry && pathToFileURL(entry).href === url) {
    void main().catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'startup_failure');
      process.exitCode = 1;
    });
  }
}

export function json(res: ServerResponse, status: number, data: object): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  res.end(body);
}

export function failure(res: ServerResponse, status: number, code: string): void {
  json(res, status, { error: { code, message: code } });
}

function hasBodyOrAmbiguity(req: IncomingMessage): boolean {
  const raw = req.rawHeaders;
  const length = fields(raw, 'content-length')[0];
  const coding = fields(raw, 'content-encoding');
  return fields(raw, 'host').length > 1 || !safeFraming(raw) || (length !== undefined && Number(length) !== 0)
    || fields(raw, 'transfer-encoding').length !== 0 || fields(raw, 'expect').length !== 0
    || fields(raw, 'content-type').length > 1 || coding.length > 1
    || (coding[0] !== undefined && coding[0].toLowerCase() !== 'identity');
}

type Handler = (path: string, res: ServerResponse, signal: AbortSignal) => void | Promise<void>;

export async function serve(options: ListenOptions, routes: readonly string[], handle: Handler): Promise<void> {
  const shutdown = new AbortController();
  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    req.on('error', ignoreError);
    res.on('error', ignoreError);
    const caller = new AbortController();
    const onClose = () => { if (!res.writableFinished) caller.abort(); };
    res.once('close', onClose);
    try {
      if (fields(req.rawHeaders, 'host').length > 1) return failure(res, 400, 'invalid_body');
      const path = req.url?.split('?', 1)[0];
      if (path === undefined || !routes.includes(path)) return failure(res, 404, 'not_found');
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET');
        return failure(res, 405, 'method_not_allowed');
      }
      if (req.url?.includes('?')) return failure(res, 400, 'invalid_query');
      // Every route is bodyless. Framed bodies are rejected at headers, before waiting for bytes.
      if (hasBodyOrAmbiguity(req)) return failure(res, 400, 'invalid_body');
      await handle(path, res, AbortSignal.any([caller.signal, shutdown.signal]));
    } catch {
      if (!res.headersSent && !res.destroyed && !caller.signal.aborted) failure(res, 500, 'internal_error');
    } finally {
      res.off('close', onClose);
    }
  }

  const server = createServer({
    maxHeaderSize: MAX_BYTES, headersTimeout: DEADLINE_MS, requestTimeout: DEADLINE_MS,
    connectionsCheckingInterval: 100,
  }, dispatch);
  server.maxHeadersCount = 0;
  server.setTimeout(DEADLINE_MS * 2);
  server.on('checkContinue', dispatch);
  server.on('checkExpectation', dispatch);

  const stop = () => {
    shutdown.abort();
    server.close();
    server.closeAllConnections();
  };
  try {
    server.listen(options);
    await once(server, 'listening');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    const closed = once(server, 'close');
    const address = server.address();
    console.log(JSON.stringify(typeof address === 'string' ? { socketPath: address } : { port: address?.port }));
    await closed;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      shutdown.abort();
      server.closeAllConnections();
    });
  }
}

function ignoreError(): void {}
