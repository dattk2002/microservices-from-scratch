import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, serve } from '../../lib/http.mts';
import { fail } from './protocol.mts';

export function serveJson(
  name: string, port: number, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
) {
  if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1') throw new Error('HOST must be 127.0.0.1');
  return serve(name, port, async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof HttpError) fail(error.status, error.code);
      fail(500, 'internal_error');
    }
  });
}

export function method(req: IncomingMessage, res: ServerResponse, allowed: string): void {
  if (req.method === allowed) return;
  res.setHeader('allow', allowed);
  fail(405, 'method_not_allowed');
}

export function start(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  });
}
