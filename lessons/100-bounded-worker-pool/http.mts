import {createServer} from 'node:http';
import type {IncomingMessage, ServerResponse} from 'node:http';

const limit = 8192;
const relevant = new Set(['content-type', 'content-length', 'transfer-encoding',
  'content-encoding', 'trailer', 'expect', 'host']);

export function framing(message: IncomingMessage, json: boolean): boolean {
  const fields = new Map<string, string>();
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    const name = message.rawHeaders[i]?.toLowerCase();
    const value = message.rawHeaders[i + 1];
    if (!name || value === undefined || !relevant.has(name)) continue;
    if (fields.has(name)) return false;
    fields.set(name, value);
  }
  const length = fields.get('content-length');
  const transfer = fields.get('transfer-encoding');
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) return false;
  if (fields.has('trailer') || fields.has('expect')) return false;
  if (transfer !== undefined && (length !== undefined || transfer.toLowerCase() !== 'chunked')) return false;
  const coding = fields.get('content-encoding');
  if (coding !== undefined && coding.toLowerCase() !== 'identity') return false;
  if (!json) return transfer === undefined && (length === undefined || Number(length) === 0);
  return /^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?$/i.test(
    fields.get('content-type') ?? '',
  );
}

function parseWireJson(source: string): unknown {
  const objects: Set<string>[] = [];
  // Scan whole string tokens so punctuation in values cannot change the object stack.
  // JSON.parse checks the full grammar after duplicate decoded keys have been ruled out.
  const token = /"(?:[^"\\]|\\[\s\S])*"([ \t\r\n]*:)?|[{}]/g;
  for (const match of source.matchAll(token)) {
    if (match[0] === '{') {
      objects.push(new Set());
    } else if (match[0] === '}') {
      objects.pop();
    } else if (match[1] !== undefined) {
      const key: unknown = JSON.parse(match[0].slice(0, -match[1].length));
      const keys = objects.at(-1);
      if (typeof key !== 'string' || !keys || keys.has(key)) throw new SyntaxError('invalid or duplicate JSON key');
      keys.add(key);
    }
  }
  return JSON.parse(source);
}

export function readJson(message: IncomingMessage, deadline: number, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const clean = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', fail);
      message.off('data', data);
      message.off('end', end);
      message.off('close', fail);
      message.off('error', fail);
    };
    const fail = () => {
      clean();
      message.pause();
      reject(new Error('incomplete or invalid JSON body'));
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit || performance.now() >= deadline) fail();
      else chunks.push(chunk);
    };
    const end = () => {
      if (!message.complete || message.rawTrailers.length || performance.now() >= deadline) {
        fail();
        return;
      }
      clean();
      try {
        const body = parseWireJson(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true})
          .decode(Buffer.concat(chunks, size)));
        resolve(body);
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(fail, Math.max(0, Math.ceil(deadline - performance.now())));
    message.on('data', data);
    message.once('end', end);
    message.once('error', fail);
    message.once('close', fail);
    signal.addEventListener('abort', fail, {once: true});
    if (signal.aborted) fail();
  });
}

export function reply(response: ServerResponse, status: number, body: object): void {
  if (response.destroyed || response.writableEnded) return;
  const json = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json;charset=utf-8',
    'content-length': Buffer.byteLength(json),
    connection: 'close',
  });
  response.end(json);
}

export function problem(response: ServerResponse, status: number, code: string): void {
  reply(response, status, {error: {code, message: code}});
}

export function serve(
  health: () => object,
  hash: (body: unknown, response: ServerResponse, signal: AbortSignal) => Promise<void>,
  close: () => Promise<void>,
) {
  const rawPort = process.env.PORT ?? '3000';
  if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('invalid PORT');

  const server = createServer({
    maxHeaderSize: limit, headersTimeout: 500, requestTimeout: 500,
    connectionsCheckingInterval: 100, keepAliveTimeout: 500,
  }, (request, response) => {
    const deadline = performance.now() + 500;
    const url = request.url ?? '';
    if (url.includes('?')) return problem(response, 400, 'invalid_request');
    if (url !== '/health' && url !== '/hash') return problem(response, 404, 'not_found');
    const method = url === '/health' ? 'GET' : 'POST';
    if (request.method !== method) {
      response.setHeader('allow', method);
      return problem(response, 405, 'method_not_allowed');
    }
    if (!framing(request, method === 'POST')) return problem(response, 400, 'invalid_request');
    if (method === 'GET') return reply(response, 200, health());

    const controller = new AbortController();
    const abort = () => controller.abort();
    response.once('close', abort);
    void (async () => {
      try {
        const body = await readJson(request, deadline, controller.signal);
        try {
          await hash(body, response, controller.signal);
        } catch {
          problem(response, 500, 'internal_error');
        }
      } catch {
        problem(response, 400, 'invalid_request');
      } finally {
        response.off('close', abort);
      }
    })();
  });
  server.maxHeadersCount = 0;
  server.on('checkContinue', (_request, response) => problem(response, 400, 'invalid_request'));
  server.on('checkExpectation', (_request, response) => problem(response, 400, 'invalid_request'));

  const stop = () => {
    process.off('SIGTERM', stop);
    server.close();
    void close().finally(() => server.closeAllConnections());
  };
  server.once('error', error => {
    process.exitCode = 1;
    console.error(error.message);
    stop();
  });
  process.on('SIGTERM', stop);
  server.listen(Number(rawPort), '127.0.0.1', () => {
    const address = server.address();
    if (address && typeof address !== 'string') console.log(JSON.stringify({port: address.port}));
  });
}
