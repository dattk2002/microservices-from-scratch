import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}

export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

export function readJson(req: IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
    return Promise.reject(new HttpError(415, 'unsupported_media_type', 'Use application/json'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > 8192) {
        failed = true;
        reject(new HttpError(413, 'body_too_large', 'JSON body exceeds 8192 bytes'));
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown); }
      catch { reject(new HttpError(400, 'invalid_json', 'Body must be valid JSON')); }
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new HttpError(400, 'request_aborted', 'Request was interrupted')));
  });
}

export function numberSetting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : (/^\d+$/.test(raw) ? Number(raw) : NaN);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export async function serve(
  service: string, defaultPort: number,
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void,
): Promise<Server> {
  const server = createServer((req, res) => {
    Promise.resolve().then(() => handler(req, res)).catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      res.setHeader('connection', 'close');
      if (error instanceof HttpError) json(res, error.status, {error: {code: error.code, message: error.message}});
      else json(res, 500, {error: {code: 'internal_error', message: 'Unexpected service error'}});
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(numberSetting('PORT', defaultPort, 0, 65535), process.env.HOST ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  console.log(JSON.stringify({service, port: address.port}));
  const shutdown = () => {
    server.close();
    setTimeout(() => server.closeAllConnections(), 1000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

export function methodNotAllowed(res: ServerResponse, allowed: string): never {
  res.setHeader('allow', allowed);
  throw new HttpError(405, 'method_not_allowed', `Use ${allowed}`);
}
