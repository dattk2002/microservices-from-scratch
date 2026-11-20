import { once } from 'node:events';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { HttpError, json, numberSetting } from '../../lib/http.mts';
import { BODY_MS, errorBody, etagVersion, fail, matchesMedia } from './contract.mts';
import { MAX_BYTES, validateJson } from './merge.mts';
import type { Json } from './merge.mts';

export type Call = { method: 'GET' } | { method: 'PATCH'; version: number; patch: Json; bytes: Buffer };
type Handler = (call: Call, res: ServerResponse, signal: AbortSignal) => void | Promise<void>;

export function runningDirectly(url: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(entry).href === url;
}

export function fields(raw: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const value = raw[i + 1];
    if (raw[i]?.toLowerCase() === name && value !== undefined) values.push(value.replace(/^[ \t]+|[ \t]+$/g, ''));
  }
  return values;
}

function contentLength(raw: string[]): number | undefined {
  const length = fields(raw, 'content-length');
  const transfer = fields(raw, 'transfer-encoding');
  const trailer = fields(raw, 'trailer');
  if (length.length > 1 || trailer.length > 1 || transfer.length > 1
    || (transfer[0] !== undefined && (transfer[0].toLowerCase() !== 'chunked' || length.length !== 0))) {
    fail(400, 'invalid_body');
  }
  const value = length[0];
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) fail(400, 'invalid_body');
  return Number(value);
}

function isIdentity(values: string[]): boolean {
  return values.length === 0 || (values.length === 1 && values[0]?.toLowerCase() === 'identity');
}

export function requireJsonHeaders(raw: string[], kind: 'patch' | 'json'): void {
  const media = fields(raw, 'content-type');
  if (media.length !== 1 || !matchesMedia(media[0], kind) || !isIdentity(fields(raw, 'content-encoding'))) {
    fail(415, 'unsupported_media_type');
  }
  const length = contentLength(raw);
  if (length !== undefined && length > MAX_BYTES) fail(413, 'body_too_large');
}

export function requireSafeTrailers(raw: string[], kind: 'patch' | 'json'): void {
  if (fields(raw, 'content-type').length || fields(raw, 'content-encoding').length) fail(415, 'unsupported_media_type');
  if (kind === 'patch' && fields(raw, 'if-match').length) fail(400, 'invalid_precondition');
  const framing = ['content-length', 'transfer-encoding', 'trailer'];
  if (kind === 'json') framing.push('etag');
  if (framing.some(name => fields(raw, name).length !== 0)) fail(400, 'invalid_body');
}

function requireNoBody(req: IncomingMessage): void {
  if ((contentLength(req.rawHeaders) ?? 0) !== 0 || fields(req.rawHeaders, 'transfer-encoding').length !== 0
    || fields(req.rawHeaders, 'content-type').length > 1 || fields(req.rawHeaders, 'content-encoding').length > 1) {
    fail(400, 'invalid_body');
  }
}

export function readBytes(message: IncomingMessage, started: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const expired = () => performance.now() - started >= BODY_MS;
    const stop = () => {
      clearTimeout(timer);
      message.off('data', onData);
      message.off('end', onEnd);
      message.off('close', onClose);
      message.off('error', onError);
    };
    const onError = (error: Error) => {
      stop();
      message.pause();
      reject(error);
    };
    const onTimeout = () => onError(new HttpError(408, 'body_timeout', 'body_timeout'));
    const onClose = () => onError(new HttpError(400, 'invalid_body', 'invalid_body'));
    const onData = (chunk: Buffer) => {
      if (expired()) { onTimeout(); return; }
      size += chunk.length;
      if (size > MAX_BYTES) onError(new HttpError(413, 'body_too_large', 'body_too_large'));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      if (expired()) { onTimeout(); return; }
      if (!message.complete) { onClose(); return; }
      stop();
      resolve(Buffer.concat(chunks, size));
    };
    const timer = setTimeout(onTimeout, Math.max(0, Math.ceil(BODY_MS - (performance.now() - started))));
    if (expired()) { onTimeout(); return; }
    if (message.destroyed) { onClose(); return; }
    message.on('data', onData);
    message.once('end', onEnd);
    message.once('close', onClose);
    message.once('error', onError);
  });
}

export function parseBody(bytes: Buffer): Json {
  let text: string;
  let body: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    body = JSON.parse(text);
  } catch {
    fail(400, 'invalid_json');
  }
  // JSON.parse has established the syntax, but it keeps only the last duplicate member.
  // Skip whole string tokens and check every number in the wire-bounded text.
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g)) {
    if (!token.startsWith('"') && !Number.isFinite(Number(token))) fail(400, 'invalid_body');
  }
  validateJson(body);
  return body;
}

async function parseCall(req: IncomingMessage, res: ServerResponse, started: number): Promise<Call> {
  const [path] = req.url?.split('?', 1) ?? [];
  if (path !== '/profile') fail(404, 'not_found');
  if (req.url?.includes('?')) fail(400, 'invalid_query');

  if (req.method === 'GET') {
    requireNoBody(req);
    return { method: 'GET' };
  }
  if (req.method !== 'PATCH') {
    res.setHeader('allow', 'GET, PATCH');
    fail(405, 'method_not_allowed');
  }

  const validators = fields(req.rawHeaders, 'if-match');
  if (validators.length === 0) fail(428, 'precondition_required');
  const version = etagVersion(validators[0]);
  if (validators.length !== 1 || version === undefined) fail(400, 'invalid_precondition');
  requireJsonHeaders(req.rawHeaders, 'patch');
  const bytes = await readBytes(req, started);
  requireSafeTrailers(req.rawTrailers, 'patch');
  return { method: 'PATCH', version, bytes, patch: parseBody(bytes) };
}

export function ignoreLateError(): void {}

export async function serveProfile(service: string, defaultPort: number, handler: Handler): Promise<void> {
  const port = numberSetting('PORT', defaultPort, 0, 65535);
  const shutdown = new AbortController();
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    req.on('error', ignoreLateError);
    res.on('error', ignoreLateError);
    const caller = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) caller.abort();
    };
    res.once('close', onClose);
    try {
      const call = await parseCall(req, res, started);
      const signal = AbortSignal.any([caller.signal, shutdown.signal]);
      signal.throwIfAborted();
      await handler(call, res, signal);
    } catch (error) {
      if (caller.signal.aborted || res.destroyed || res.writableEnded) return;
      req.resume();
      res.setHeader('connection', 'close');
      if (error instanceof HttpError) json(res, error.status, errorBody(error.code));
      else json(res, 500, errorBody('internal_error'));
    } finally {
      res.off('close', onClose);
    }
  }

  const server = createServer({ maxHeaderSize: 8192, connectionsCheckingInterval: 1000 }, handle);
  // Node dispatches unknown expectations here instead of emitting 'request'.
  server.on('checkExpectation', handle);
  server.maxHeadersCount = 0;
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.setTimeout(5000);
  const close = () => {
    shutdown.abort();
    server.close();
    server.closeAllConnections();
  };
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
    const stopped = once(server, 'close');
    console.log(JSON.stringify({ service, port: address.port }));
    await stopped;
  } finally {
    process.off('SIGTERM', close);
    process.off('SIGINT', close);
    await new Promise<void>(resolve => {
      server.close(() => resolve());
      shutdown.abort();
      server.closeAllConnections();
    });
  }
}
