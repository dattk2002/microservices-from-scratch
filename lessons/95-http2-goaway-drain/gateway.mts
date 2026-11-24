import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { callDeadline, CALL_MS } from './core.mts';
import { bodyless, errorBody, Fault, fieldsOf, JSON_TYPE, LIMIT, route, WORK_RESULT } from './protocol.mts';
import { serve, setting, trackSockets } from './startup.mts';
import { WorkerPool } from './upstream.mts';

function json(res: ServerResponse, status: number, value: unknown) {
  const payload = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(payload),
    connection: 'close',
    ...(status === 405 ? { allow: 'GET' } : {}),
  });
  res.end(payload);
}

async function main() {
  const port = setting('PORT', 8095, 0, 65535);
  const workerPort = setting('WORKER_PORT', 3095, 1, 65535);
  if (port === workerPort) throw new Error('PORT and WORKER_PORT must differ');

  let stopping = false;
  let checkDrained = () => {};
  const pool = new WorkerPool(workerPort, () => checkDrained());

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const deadline = callDeadline(performance.now());
    const cancel = new AbortController();
    const disconnected = () => cancel.abort();
    res.once('close', disconnected);
    try {
      const fields = fieldsOf(req.rawHeaders);
      const path = route(req.url ?? '', req.method ?? '', true);
      bodyless(fields);
      if (stopping) throw new Fault(503, 'busy');
      if (path === '/health') {
        json(res, 200, { status: 'ok' });
        return;
      }
      await pool.call(deadline, cancel.signal);
      if (!res.destroyed) json(res, 200, WORK_RESULT);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const fault = error instanceof Fault ? error : new Fault(502, 'upstream_failure');
      json(res, fault.status, errorBody(fault.message));
    } finally {
      res.off('close', disconnected);
    }
  }

  const server = createServer({
    maxHeaderSize: LIMIT,
    headersTimeout: CALL_MS,
    requestTimeout: CALL_MS,
    connectionsCheckingInterval: 100,
    keepAliveTimeout: CALL_MS,
    requireHostHeader: true,
  });
  server.maxHeadersCount = 0; // Preserve raw duplicates; cap fields in fieldsOf.
  server.maxConnections = 64;
  server.on('request', handle);
  server.on('checkContinue', handle);
  server.on('checkExpectation', handle);
  const sockets = trackSockets(server, 1500);

  checkDrained = await serve(server, 'gateway', port, () => {
    stopping = true;
    pool.stop();
  }, () => {
    pool.force();
    for (const socket of sockets) socket.destroy();
  }, () => pool.empty);
}

if (import.meta.main) await main();
