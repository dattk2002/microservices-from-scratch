import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from '../../lib/http.mts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

export function fail(status: number, code: string): never {
  throw new HttpError(status, code, code);
}

export function lessonHandler(handle: Handler): Handler {
  return async (req, res) => {
    try {
      await handle(req, res);
    } catch (error) {
      // Keep the lesson's error envelope even for failures raised by shared HTTP helpers.
      if (error instanceof HttpError) fail(error.status, error.code);
      fail(500, 'internal_error');
    }
  };
}

export function pathOf(req: IncomingMessage): string {
  const path = req.url ?? '';
  if (path.includes('?')) fail(400, 'invalid_query');
  return path;
}

export function requireNoBody(req: IncomingMessage): void {
  const length = req.headers['content-length'];
  if (req.headers['transfer-encoding'] !== undefined || (length !== undefined && !/^0+$/.test(length))) {
    fail(400, 'invalid_body');
  }
}
