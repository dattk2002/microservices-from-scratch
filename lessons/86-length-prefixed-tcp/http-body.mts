import { performance } from 'node:perf_hooks';
import type { IncomingMessage } from 'node:http';
import { HttpError } from '../../lib/http.mts';
import { parseJson } from './protocol.mts';

const JSON_TYPE = /^[ \t]*application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?[ \t]*$/i;
const IDENTITY = /^[ \t]*identity[ \t]*$/i;
const CHUNKED = /^[ \t]*chunked[ \t]*$/i;

function fields(rawHeaders: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const value = rawHeaders[index + 1];
    if (rawHeaders[index]?.toLowerCase() === name && value !== undefined) values.push(value);
  }
  return values;
}

export function problem(status: number, code: string): HttpError {
  return new HttpError(status, code, code);
}

export function jsonRequestLength(rawHeaders: readonly string[]): number | undefined {
  const types = fields(rawHeaders, 'content-type');
  const codings = fields(rawHeaders, 'content-encoding');
  if (types.length !== 1 || !JSON_TYPE.test(types[0] ?? '')
    || codings.length > 1 || (codings[0] !== undefined && !IDENTITY.test(codings[0]))) {
    throw problem(415, 'unsupported_media_type');
  }

  const lengths = fields(rawHeaders, 'content-length');
  const transfers = fields(rawHeaders, 'transfer-encoding');
  const [length] = lengths;
  const [transfer] = transfers;
  if (lengths.length > 1 || transfers.length > 1
    || (length !== undefined && (transfer !== undefined || !/^[ \t]*[0-9]+[ \t]*$/.test(length)))
    || (transfer !== undefined && !CHUNKED.test(transfer))) {
    throw problem(400, 'invalid_body');
  }
  return length === undefined ? undefined : Number(length);
}

const MAX_BODY_BYTES = 8192;
const BODY_MS = 500;

export async function readJsonRequest(
  req: IncomingMessage, startedAt: number, now = () => performance.now(),
): Promise<unknown> {
  const declared = jsonRequestLength(req.rawHeaders);
  if (declared !== undefined && declared > MAX_BODY_BYTES) throw problem(413, 'body_too_large');
  const bytes = await new Promise<Buffer>((resolve, reject) => {
    const deadline = startedAt + BODY_MS;
    const buffer = Buffer.alloc(declared ?? MAX_BODY_BYTES);
    let size = 0;
    let timer: NodeJS.Timeout | undefined;

    const finish = (error?: HttpError) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('close', onInterrupted);
      req.off('error', onInterrupted);
      if (error) {
        req.pause();
        reject(error);
      } else {
        resolve(buffer.subarray(0, size));
      }
    };
    const expire = () => {
      const remaining = deadline - now();
      if (remaining <= 0) finish(problem(408, 'body_timeout'));
      else timer = setTimeout(expire, Math.ceil(remaining));
    };
    const onInterrupted = () => finish(problem(400, 'invalid_body'));
    const onData = (chunk: Buffer) => {
      if (now() >= deadline) finish(problem(408, 'body_timeout'));
      else if (size + chunk.length > MAX_BODY_BYTES) finish(problem(413, 'body_too_large'));
      else if (size + chunk.length > buffer.length) onInterrupted();
      else {
        buffer.set(chunk, size);
        size += chunk.length;
      }
    };
    const onEnd = () => {
      const trailers = req.rawTrailers;
      if (now() >= deadline) finish(problem(408, 'body_timeout'));
      else if (!req.complete || (declared !== undefined && size !== declared)
        || fields(trailers, 'content-length').length || fields(trailers, 'transfer-encoding').length) {
        onInterrupted();
      } else if (fields(trailers, 'content-type').length || fields(trailers, 'content-encoding').length) {
        finish(problem(415, 'unsupported_media_type'));
      } else {
        finish();
      }
    };

    req.once('end', onEnd);
    req.once('close', onInterrupted);
    req.on('error', onInterrupted);
    req.on('data', onData);
    expire();
  });
  try {
    return parseJson(bytes);
  } catch {
    throw problem(400, 'invalid_json');
  }
}
