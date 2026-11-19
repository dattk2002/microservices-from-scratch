import { json, serve } from '../../lib/http.mts';
import { readMessage } from './body.mts';
import { endpoint, problem, requestEncoding, requireMethod } from './protocol.mts';
import { relayMessage, sinkOrigin } from './upstream.mts';

async function main(): Promise<void> {
  const origin = sinkOrigin(process.env.SINK_ORIGIN);
  const nativeServer = await serve('ingress', 8083, endpoint(async (req, res, acceptedAt, signal) => {
    const [route, query] = (req.url ?? '/').split('?', 2);
    if (route !== '/messages') throw problem(404, 'not_found');
    if (query !== undefined) throw problem(400, 'invalid_request');
    requireMethod(req, res, 'POST');
    const message = await readMessage(req, requestEncoding(req.headersDistinct), {acceptedAt, signal});
    const {status, body} = await relayMessage(origin, message, {signal});
    json(res, status, body);
  }));
  nativeServer.maxHeadersCount = 0;
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
