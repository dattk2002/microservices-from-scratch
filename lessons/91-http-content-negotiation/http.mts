import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fieldValues, framing, MAX_HEADERS } from './fields.mts';
import { parseAccept } from './accept.mts';
import type { Range, Variant } from './accept.mts';
import { greeting, plainGreeting } from './representation.mts';

class Problem extends Error {
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

export function fail(status: number, code: string): never {
  throw new Problem(status, code);
}

function send(res: ServerResponse, status: number, media: Variant, body: string): void {
  res.writeHead(status, {
    'Content-Type': `${media}; charset=utf-8`,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, data: unknown): void {
  send(res, status, 'application/json', JSON.stringify(data));
}

export function sendGreeting(res: ServerResponse, variant: Variant | undefined): void {
  res.setHeader('Vary', 'Accept');
  if (variant === undefined) fail(406, 'not_acceptable');
  if (variant === 'application/json') json(res, 200, greeting);
  else send(res, 200, variant, plainGreeting);
}

function bodyless(req: IncomingMessage): void {
  try {
    const { length, chunked } = framing(req.rawHeaders);
    if (!chunked && (length === undefined || length === 0)) return;
  } catch {
    // Node handles framing syntax errors rejected by its HTTP parser itself.
  }
  fail(400, 'unexpected_body');
}

export function portSetting(fallback: number): number {
  const raw = process.env.PORT;
  const port = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  return port;
}

type Negotiate = (
  res: ServerResponse, accept: string | undefined, ranges: readonly Range[], shutdown: AbortSignal,
) => void | Promise<void>;

export async function serve(service: string, port: number, negotiate: Negotiate): Promise<void> {
  const shutdown = new AbortController();
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // All routes are bodyless. Close instead of draining an untrusted body.
    res.setHeader('Connection', 'close');
    req.on('error', () => res.destroy());
    try {
      if (fieldValues(req.rawHeaders, 'host').length > 1) fail(400, 'invalid_headers');
      const [path, query] = (req.url ?? '').split('?', 2);
      if (path !== '/health' && path !== '/greeting') fail(404, 'not_found');
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        fail(405, 'method_not_allowed');
      }
      if (query !== undefined) fail(400, 'unsupported_query');
      bodyless(req);
      if (path === '/health') {
        json(res, 200, { ok: true });
        return;
      }

      const lines = fieldValues(req.rawHeaders, 'accept');
      const accept = lines.length ? lines.join(',') : undefined;
      let ranges: readonly Range[];
      try { ranges = parseAccept(accept); }
      catch { fail(400, 'invalid_accept'); }
      await negotiate(res, accept, ranges, shutdown.signal);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const status = error instanceof Problem ? error.status : 500;
      const code = error instanceof Problem ? error.message : 'internal_error';
      json(res, status, { error: { code, message: code } });
    }
  };
  const server = createServer({
    maxHeaderSize: MAX_HEADERS, headersTimeout: 5000, requestTimeout: 5000,
    connectionsCheckingInterval: 500, keepAliveTimeout: 1000,
  }, handle);
  server.maxHeadersCount = 0;
  server.setTimeout(5000);
  server.on('checkContinue', handle);
  server.on('checkExpectation', handle);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
  const stop = () => {
    shutdown.abort();
    server.close();
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  console.log(JSON.stringify({ service, port: address.port }));
}
