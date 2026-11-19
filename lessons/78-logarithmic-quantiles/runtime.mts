import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, serve } from '../../lib/http.mts';

export function listen(
  service: string,
  defaultPort: number,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
) {
  if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
  return serve(service, defaultPort, async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'internal_error';
      res.setHeader('connection', 'close');
      json(res, status, { error: { code, message: code } });
    }
  });
}
