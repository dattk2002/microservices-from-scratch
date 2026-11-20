import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { HttpError } from '../../lib/http.mts';
import { fail, isJsonMedia } from './contracts.mts';

export const HEADER_BYTES = 8192;
export const BODY_BYTES = 8192;
export const HTTP_MS = 500;

export function requestTarget(req: IncomingMessage): { path: string; query: string | undefined } {
  const target = req.url ?? '';
  const separator = target.indexOf('?');
  return separator < 0
    ? { path: target, query: undefined }
    : { path: target.slice(0, separator), query: target.slice(separator + 1) };
}

export function methodNotAllowed(res: ServerResponse, allowed: string): never {
  res.setHeader('allow', allowed);
  fail(405, 'method_not_allowed');
}

function fieldValues(rawFields: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawFields.length; i += 2) {
    if (rawFields[i]?.toLowerCase() === name) values.push(rawFields[i + 1] ?? '');
  }
  return values;
}

function framing(message: IncomingMessage) {
  const length = fieldValues(message.rawHeaders, 'content-length');
  const transfer = fieldValues(message.rawHeaders, 'transfer-encoding');
  return { length, transfer };
}

export function requireNoBody(message: IncomingMessage): void {
  const { length, transfer } = framing(message);
  if (transfer.length || length.length > 1 ||
      (length[0] !== undefined && !/^0+$/.test(length[0].trim()))) fail(400, 'invalid_body');
}

export function validCoding(message: IncomingMessage): boolean {
  const encodings = fieldValues(message.rawHeaders, 'content-encoding');
  return encodings.length === 0 ||
    (encodings.length === 1 && encodings[0]?.trim().toLowerCase() === 'identity');
}

export function validJsonHeaders(message: IncomingMessage): boolean {
  const media = fieldValues(message.rawHeaders, 'content-type');
  return media.length === 1 && isJsonMedia(media[0]) && validCoding(message);
}

export function checkJsonFraming(message: IncomingMessage): void {
  const { length, transfer } = framing(message);
  if (length.length > 1 || transfer.length > 1 ||
      (length.length && transfer.length) ||
      (length[0] !== undefined && !/^\d+$/.test(length[0].trim())) ||
      (transfer[0] !== undefined && transfer[0].trim().toLowerCase() !== 'chunked')) {
    fail(400, 'invalid_body');
  }
  if (length[0] !== undefined && Number(length[0]) > BODY_BYTES) fail(413, 'body_too_large');
}

export function checkTrailers(message: IncomingMessage): void {
  const trailers = message.rawTrailers;
  if (fieldValues(trailers, 'content-type').length || fieldValues(trailers, 'content-encoding').length) {
    fail(415, 'unsupported_media_type');
  }
  if (fieldValues(trailers, 'content-length').length || fieldValues(trailers, 'transfer-encoding').length) {
    fail(400, 'invalid_body');
  }
}

export function requireEmpty204(message: IncomingMessage): void {
  const { length, transfer } = framing(message);
  if (length.length || transfer.length || fieldValues(message.rawHeaders, 'content-type').length || !validCoding(message)) {
    throw new Error('Unexpected representation fields on 204');
  }
}

export function checkDeadline(expiresAt: number, signal: AbortSignal): void {
  signal.throwIfAborted();
  if (performance.now() >= expiresAt) fail(408, 'body_timeout');
}

export async function withDeadline<T>(
  expiresAt: number, caller: AbortSignal, run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timerAbort = new AbortController();
  const signal = AbortSignal.any([caller, timerAbort.signal]);
  let timer: NodeJS.Timeout | undefined;
  function tick(): void {
    const remaining = expiresAt - performance.now();
    if (remaining > 0) timer = setTimeout(tick, Math.ceil(remaining));
    else timerAbort.abort(new HttpError(408, 'body_timeout', 'body_timeout'));
  }
  try {
    tick();
    return await run(signal);
  } finally {
    clearTimeout(timer);
  }
}

export function ignoreLateError(): void {}

export function readBytes(
  message: IncomingMessage, signal: AbortSignal, expiresAt: number, limit = BODY_BYTES,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    function cleanup(): void {
      message.off('data', onData);
      message.off('end', onEnd);
      message.off('close', onClose);
      message.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    }

    function onError(error: unknown): void {
      cleanup();
      message.pause();
      reject(error);
    }

    function onClose(): void { onError(new Error('Message closed before EOF')); }
    function onAbort(): void { onError(signal.reason); }

    function onData(chunk: Buffer): void {
      try {
        checkDeadline(expiresAt, signal);
        size += chunk.byteLength;
        if (size > limit) fail(413, 'body_too_large');
        chunks.push(chunk);
      } catch (error) {
        onError(error);
      }
    }

    function onEnd(): void {
      try {
        checkDeadline(expiresAt, signal);
        if (!message.complete) throw new Error('Incomplete HTTP message');
        const bytes = Buffer.concat(chunks, size);
        cleanup();
        resolve(bytes);
      } catch (error) {
        onError(error);
      }
    }

    message.once('error', onError);
    message.once('close', onClose);
    message.once('end', onEnd);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    else if (message.destroyed) onClose();
    else message.on('data', onData);
  });
}

export function decodeJson(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(400, 'invalid_json');
  }
}

export async function readRequestJson(
  req: IncomingMessage, started: number, caller: AbortSignal,
): Promise<unknown> {
  if (!validJsonHeaders(req)) fail(415, 'unsupported_media_type');
  checkJsonFraming(req);
  const expiresAt = started + HTTP_MS;
  return withDeadline(expiresAt, caller, async signal => {
    const bytes = await readBytes(req, signal, expiresAt);
    checkTrailers(req);
    return decodeJson(bytes);
  });
}

export function noContent(res: ServerResponse): void {
  res.writeHead(204, { 'cache-control': 'no-store' }).end();
}
