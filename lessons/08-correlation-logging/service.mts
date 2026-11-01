import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, methodNotAllowed, serve } from '../../lib/http.mts';
import { context, correlationId, logLine } from './context.mts';

export function start(
  service: 'gateway' | 'catalog', port: number,
  quote: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) {
  return serve(service, port, (req, res) => context.run(
    { id: correlationId(req.headers['x-correlation-id']) }, async () => {
      res.setHeader('x-correlation-id', context.getStore()!.id);
      console.log(logLine(service, 'request_started'));
      // Bind explicitly: response events must keep this request's context too.
      res.once('finish', AsyncLocalStorage.bind(() => {
        console.log(logLine(service, 'request_finished', res.statusCode));
      }));
      try {
        if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/quote') {
          throw new HttpError(404, 'not_found', 'Unknown route');
        }
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        await quote(req, res);
      } catch (error: unknown) {
        // Never serialize raw exceptions: they may include URLs or credentials.
        const status = error instanceof HttpError ? error.status : 500;
        json(res, status, { error: error instanceof HttpError ? error.code : 'internal_error' });
      }
    },
  ));
}
