import { createServer } from 'node:http';
import { deferred } from './deferred.mts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, numberSetting } from '../../lib/http.mts';
import { connectWorker } from './client.mts';
import { createDemoRunner } from './demo.mts';
import {
  DEADLINE_MS, MAX_BYTES, errorBody, fault, http1Fields, requireBodyless, requireGet, workerOrigin,
} from './protocol.mts';
import { listenLoopback } from './startup.mts';

async function requireEmptyRequest(req: IncomingMessage, deadline: number, signal: AbortSignal) {
  if (signal.aborted) throw fault(400, 'invalid_body');
  const { promise, resolve, reject } = deferred<void>();
  const timer = setTimeout(() => reject(fault(408, 'body_timeout')), Math.max(0, deadline - performance.now()));
  const invalidBody = () => reject(fault(400, 'invalid_body'));
  function end() {
    if (performance.now() >= deadline) reject(fault(408, 'body_timeout'));
    else if (req.rawTrailers.length !== 0) invalidBody();
    else resolve();
  }
  try {
    signal.addEventListener('abort', invalidBody, { once: true });
    req.once('data', invalidBody);
    req.once('end', end);
    req.once('aborted', invalidBody);
    req.resume();
    await promise;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', invalidBody);
    req.off('data', invalidBody);
    req.off('end', end);
    req.off('aborted', invalidBody);
  }
}

async function main() {
  const port = numberSetting('PORT', 4087, 0, 65535);
  const origin = workerOrigin(process.env.WORKER_ORIGIN ?? 'http://127.0.0.1:3087');
  const runDemo = createDemoRunner(connectWorker(origin));
  const inFlight = new Set<AbortController>();

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const deadline = performance.now() + DEADLINE_MS;
    const abort = new AbortController();
    const cancel = () => abort.abort();
    inFlight.add(abort);
    req.on('error', cancel);
    res.on('error', cancel);
    res.once('close', cancel);
    try {
      const fields = http1Fields(req.rawHeaders);
      requireGet(req.url ?? '', req.method, ['/demo']);
      requireBodyless(fields);
      await requireEmptyRequest(req, deadline, abort.signal);
      json(res, 200, await runDemo(abort.signal));
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const failure = error instanceof HttpError ? error : fault(500, 'internal_error');
      if (failure.status === 405) res.setHeader('allow', 'GET');
      // Bound invalid or half-open requests without keeping their connections alive.
      res.setHeader('connection', 'close');
      json(res, failure.status, errorBody(failure.code));
    } finally {
      inFlight.delete(abort);
      res.off('close', cancel);
    }
  }

  const server = createServer({
    maxHeaderSize: MAX_BYTES,
    headersTimeout: 5000,
    requestTimeout: 5000,
    connectionsCheckingInterval: 1000,
  });
  server.maxHeadersCount = 0;
  server.maxConnections = 64;
  server.setTimeout(5000);
  const receive = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res).catch(() => res.destroy());
  };
  server.on('request', receive);
  server.on('checkContinue', receive);
  server.on('checkExpectation', receive);

  await listenLoopback(server, 'gateway', port, () => {
    for (const abort of inFlight) abort.abort();
    server.closeAllConnections();
  });
}

if (import.meta.main) await main();
