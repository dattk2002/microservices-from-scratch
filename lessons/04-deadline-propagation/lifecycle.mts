import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, numberSetting } from '../../lib/http.mts';
import { remaining } from './budget.mts';

export function scope(req: IncomingMessage, res: ServerResponse, end: number) {
  const controller = new AbortController();
  const abort = (reason: 'caller' | 'deadline') => { if (!controller.signal.aborted) controller.abort(reason); };
  const disconnected = () => { if (!res.writableFinished) abort('caller'); };
  const interrupted = () => abort('caller');
  req.once('aborted', interrupted);
  res.once('close', disconnected);
  const timer = setTimeout(() => abort('deadline'), remaining(end, Date.now));
  if (req.aborted || res.destroyed) abort('caller');
  return {
    signal: controller.signal,
    check() {
      if (controller.signal.aborted && controller.signal.reason === 'caller') {
        throw new HttpError(499, 'caller_disconnected', 'Caller disconnected');
      }
      if (controller.signal.aborted || remaining(end, Date.now) === 0) {
        throw new HttpError(504, 'deadline_exceeded', 'End-to-end budget expired');
      }
    },
    dispose() {
      clearTimeout(timer);
      req.off('aborted', interrupted);
      res.off('close', disconnected);
    },
  };
}

export async function start(name: string, port: number, handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>) {
  const server = createServer({ maxHeaderSize: 4096 }, (req, res) => {
    void Promise.resolve().then(async () => {
      if ((req.url?.length ?? 0) > 2048) throw new HttpError(414, 'uri_too_long', 'URL exceeds 2048 bytes');
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
        res.setHeader('connection', 'close');
        req.resume();
        throw new HttpError(400, 'unexpected_body', 'These endpoints accept no request body');
      }
      await handler(req, res, new URL(req.url ?? '/', 'http://localhost'));
    }).catch((error: unknown) => {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof HttpError) json(res, error.status, { error: { code: error.code, message: error.message } });
      else json(res, 500, { error: { code: 'internal_error', message: 'Unexpected service error' } });
    });
  });
  server.maxHeadersCount = 32;
  server.maxConnections = 128;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.setTimeout(6000, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(numberSetting('PORT', port, 0, 65535), process.env.HOST ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  console.log(JSON.stringify({ service: name, port: address.port }));
  const shutdown = () => {
    server.close();
    // This lesson stops immediately; graceful draining belongs to lesson10.
    server.closeAllConnections();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  server.once('close', () => { process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown); });
}

export function origin(name: string, fallback: string): URL {
  const url = new URL(process.env[name] ?? fallback);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${name} must be a loopback HTTP origin`);
  }
  return url;
}

export function query(url: URL): { workId: string; hold: boolean; productId: string } {
  const workId = url.searchParams.get('workId');
  const hold = url.searchParams.get('hold');
  const productId = url.pathname.split('/')[2];
  if (!workId || !/^[a-z0-9-]{1,48}$/.test(workId) || !productId || !/^[a-z0-9-]{1,48}$/.test(productId) ||
      (hold !== null && hold !== '1') || [...url.searchParams.keys()].some(key => !['workId', 'hold'].includes(key)) ||
      url.searchParams.getAll('workId').length !== 1 || url.searchParams.getAll('hold').length > 1) {
    throw new HttpError(400, 'invalid_query', 'Use workId (1..48 lowercase letters/digits/hyphens) and optional hold=1');
  }
  return { workId, hold: hold === '1', productId };
}

export type Quote = { productId: string; priceCents: number; workId: string; deadlineMs: number };
export async function forward(url: URL, end: number, signal: AbortSignal, expectedId: string): Promise<Quote> {
  let upstream: Response;
  try { upstream = await fetch(url, { headers: { 'x-request-deadline-ms': String(end) }, signal, redirect: 'manual' }); }
  catch {
    if (signal.aborted) throw new HttpError(signal.reason === 'caller' ? 499 : 504, signal.reason === 'caller' ? 'caller_disconnected' : 'deadline_exceeded', 'Request cancelled');
    throw new HttpError(503, 'dependency_unavailable', 'Cannot reach downstream service');
  }
  if (upstream.status !== 200) {
    await upstream.body?.cancel();
    const codes: Readonly<Record<number, string>> = { 404: 'not_found', 429: 'overloaded', 503: 'dependency_unavailable', 504: 'deadline_exceeded' };
    const code = codes[upstream.status];
    throw new HttpError(code ? upstream.status : 502, code ?? 'invalid_upstream', 'Downstream request failed');
  }
  if (upstream.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !upstream.body) {
    await upstream.body?.cancel();
    throw new HttpError(502, 'invalid_upstream', 'Expected bounded JSON');
  }
  const reader = upstream.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) throw new HttpError(502, 'invalid_upstream', 'Response exceeds 8192 bytes');
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value !== 'object' || value === null || !('productId' in value) || value.productId !== 'pencil' ||
        !('priceCents' in value) || typeof value.priceCents !== 'number' || !Number.isSafeInteger(value.priceCents) || value.priceCents < 0 || value.priceCents > 1_000_000_000 ||
        !('workId' in value) || value.workId !== expectedId || !('deadlineMs' in value) || value.deadlineMs !== end) {
      throw new HttpError(502, 'invalid_upstream', 'Invalid quote or extended deadline');
    }
    return { productId: value.productId, priceCents: value.priceCents, workId: value.workId, deadlineMs: value.deadlineMs };
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    if (signal.aborted) throw new HttpError(signal.reason === 'caller' ? 499 : 504, signal.reason === 'caller' ? 'caller_disconnected' : 'deadline_exceeded', 'Request cancelled');
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, 'invalid_upstream', 'Invalid downstream JSON');
  } finally { reader.releaseLock(); }
}
