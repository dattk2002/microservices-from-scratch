import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';

const LIMIT = 8192;
const MIME = /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?$/i;
const RELEVANT = new Set(['content-type', 'content-encoding', 'content-length', 'transfer-encoding', 'trailer']);

export class HttpError extends Error {
  status: number;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
  }
}

export function send(res: ServerResponse, status: number, content: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(content);
  res.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
  });
  res.end(body);
}

export function fail(res: ServerResponse, status: number, code: string) {
  send(res, status, { error: { code, message: code } });
}

function bad() { return new HttpError(400, 'bad_request'); }

export function framing(req: IncomingMessage, json: boolean) {
  const headers = new Map<string, string>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i]?.toLowerCase();
    const value = req.rawHeaders[i + 1];
    if (!name || value === undefined || !RELEVANT.has(name)) continue;
    if (headers.has(name)) throw bad();
    headers.set(name, value);
  }
  const length = headers.get('content-length');
  const transfer = headers.get('transfer-encoding');
  const coding = headers.get('content-encoding');
  const type = headers.get('content-type');
  if (headers.has('trailer') || (coding !== undefined && !/^identity$/i.test(coding)) ||
      (transfer !== undefined && (!/^chunked$/i.test(transfer) || length !== undefined)) ||
      (length !== undefined && !/^\d+$/.test(length))) throw bad();
  if (json) {
    if (type === undefined || !MIME.test(type)) throw bad();
    if (length !== undefined && Number(length) > LIMIT) throw new HttpError(413, 'too_large');
  } else if (transfer !== undefined || (length !== undefined && Number(length) !== 0) ||
      coding !== undefined || type !== undefined) throw bad();
}

function parseJson(body: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  // Tokenize at the current offset so punctuation inside strings stays inside its token.
  const token = /[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|[{}\[\],:]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  const next = () => token.exec(text)?.[1];
  let current = next();
  function consume(expected: string) {
    if (current !== expected) throw bad();
    current = next();
  }
  function value(depth: number) {
    if (current === '{' || current === '[') {
      if (depth >= 64) throw bad();
      const object = current === '{';
      const end = object ? '}' : ']';
      const keys = object ? new Set<string>() : undefined;
      current = next();
      if (current !== end) {
        for (;;) {
          if (keys) {
            if (!current?.startsWith('"')) throw bad();
            const key: unknown = JSON.parse(current);
            if (typeof key !== 'string' || keys.has(key)) throw bad();
            keys.add(key);
            consume(current);
            consume(':');
          }
          value(depth + 1);
          if (current !== ',') break;
          consume(',');
        }
      }
      consume(end);
    } else {
      if (!current || '}],:'.includes(current)) throw bad();
      current = next();
    }
  }
  value(0);
  // JSON.parse remains the syntax authority, including trailing input.
  return JSON.parse(text);
}

export async function readJson(req: IncomingMessage, signal: AbortSignal, deadline: number): Promise<unknown> {
  framing(req, true);
  signal.throwIfAborted();
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('close', close);
      signal.removeEventListener('abort', abort);
    };
    const rejectBody = (error: unknown) => {
      cleanup();
      req.pause();
      reject(error);
    };
    const abort = () => rejectBody(signal.reason);
    const close = () => rejectBody(bad());
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > LIMIT) rejectBody(new HttpError(413, 'too_large'));
      else chunks.push(chunk);
    };
    const end = () => {
      if (performance.now() >= deadline) return rejectBody(new HttpError(408, 'timeout'));
      if (!req.complete || req.rawTrailers.length !== 0) return rejectBody(bad());
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    req.on('data', data);
    req.once('end', end);
    req.once('close', close);
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return parseJson(body);
  } catch {
    throw bad();
  }
}

export type Instance = 'a' | 'b';
export function instanceFrom(value: unknown): Instance | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      !Object.hasOwn(value, 'instance') || Object.keys(value).length !== 1 || !('instance' in value)) return;
  if (value.instance === 'a' || value.instance === 'b') return value.instance;
}

export function portFrom(value: string | undefined, ephemeral = false) {
  if (value === undefined && ephemeral) return 0;
  if (value === undefined || !/^\d{1,5}$/.test(value)) throw new Error('invalid port');
  const port = Number(value);
  if (port > 65535 || (port === 0 && !ephemeral)) throw new Error('invalid port');
  return port;
}

type Route = (req: IncomingMessage, res: ServerResponse, deadline: number) => void | Promise<void>;
export async function listen(host: string, port: number, routes: ReadonlyMap<string, readonly [string, Route]>) {
  const server = createServer({ maxHeaderSize: LIMIT, headersTimeout: 1000, requestTimeout: 1500,
    connectionsCheckingInterval: 100, keepAliveTimeout: 500 });
  server.maxHeadersCount = 0;
  server.maxConnections = 64;
  server.setTimeout(1500, (socket) => socket.destroy());
  server.on('checkContinue', (_req, res) => fail(res, 400, 'bad_request'));
  server.on('checkExpectation', (_req, res) => fail(res, 400, 'bad_request'));
  server.on('request', async (req, res) => {
    req.on('error', () => res.destroy());
    const deadline = performance.now() + 500;
    try {
      const path = req.url ?? '';
      if (path.includes('?')) throw bad();
      const route = routes.get(path);
      if (!route) throw new HttpError(404, 'not_found');
      const [method, handler] = route;
      if (req.method !== method) {
        res.setHeader('Allow', method);
        throw new HttpError(405, 'method_not_allowed');
      }
      if (method !== 'POST') framing(req, false);
      await handler(req, res, deadline);
    } catch (error) {
      if (error instanceof HttpError) fail(res, error.status, error.message);
      else fail(res, 500, 'internal_error');
    }
  });
  try {
    const ready = once(server, 'listening', { signal: AbortSignal.timeout(1500) });
    server.listen(port, host);
    await ready;
  } catch (error) {
    server.close();
    server.closeAllConnections();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('expected TCP address');
  }
  return { port: address.port, close: () => { server.close(); server.closeAllConnections(); } };
}

export const health: Route = (_req, res) => send(res, 200, { ok: true });

export function ready(ports: Record<string, number>, close: () => void) {
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  console.log(JSON.stringify(ports));
}

export function startupError(error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
