import { createServer } from 'node:http';
import type { RequestListener } from 'node:http';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { HttpError, json, numberSetting } from '../../lib/http.mts';
import { encodeFrame } from './framing.mts';
import { problem, readJsonRequest } from './http-body.mts';
import { runListener } from './listener.mts';
import { checkEcho, parseJson, requestText, workerAddress } from './protocol.mts';
import { exchangeFrame } from './rpc.mts';

export function createGateway(workerOrigin: string | undefined) {
  const peer = workerAddress(workerOrigin);
  let active = 0;

  const handleRequest: RequestListener = async (req, res) => {
    const startedAt = performance.now();
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    res.on('error', disconnect);
    req.on('error', disconnect);
    try {
      const target = req.url ?? '';
      const queryAt = target.indexOf('?');
      const path = queryAt === -1 ? target : target.slice(0, queryAt);
      if (path !== '/echo') throw problem(404, 'not_found');
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        throw problem(405, 'method_not_allowed');
      }
      if (queryAt !== -1) throw problem(400, 'invalid_query');

      const parsed = await readJsonRequest(req, startedAt);
      let text: string;
      try {
        text = requestText(parsed);
      } catch {
        throw problem(400, 'invalid_body');
      }
      if (controller.signal.aborted) return;
      if (active >= 8) throw problem(503, 'busy');

      const send = encodeFrame(Buffer.from(JSON.stringify({text})));
      active++;
      try {
        const dialedAt = performance.now();
        const socket = createConnection({...peer, allowHalfOpen: true, noDelay: true});
        await exchangeFrame(socket, dialedAt, (payload) => checkEcho(parseJson(payload), text), {
          send, signal: controller.signal,
        });
      } catch {
        throw problem(502, 'upstream_failure');
      } finally {
        active--;
      }
      if (!res.destroyed) json(res, 200, {echo: text});
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      res.setHeader('connection', 'close');
      const failure = error instanceof HttpError ? error : problem(500, 'internal_error');
      json(res, failure.status, {error: {code: failure.code, message: failure.code}});
    } finally {
      res.off('close', disconnect);
    }
  };
  const server = createServer({maxHeaderSize: 8192, connectionsCheckingInterval: 1000}, handleRequest);
  server.on('checkExpectation', handleRequest);
  // Preserve relevant duplicates even after thousands of short, unrelated fields.
  server.maxHeadersCount = 0;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.setTimeout(5000);
  return server;
}

async function main(): Promise<void> {
  const server = createGateway(process.env.WORKER_ORIGIN);
  const port = numberSetting('PORT', 4086, 0, 65535);
  await runListener(server, 'gateway', port, () => server.closeAllConnections());
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
