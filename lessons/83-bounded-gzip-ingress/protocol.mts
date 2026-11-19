import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json } from '../../lib/http.mts';

export type Message = {id: string; text: string};
export type Encoding = 'gzip' | 'identity';
export type Clock = () => number;

const TOKEN = "[!#$%&'*+.^_\x60|~0-9a-z-]+";
const QUOTED_VALUE = /"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"/.source;
// Parse the whole field so a comma in a quoted parameter remains valid.
const JSON_MEDIA_TYPE = new RegExp(
  '^[ \\t]*application/json(?:[ \\t]*;(?:[ \\t]*' + TOKEN + '=(?:' + TOKEN + '|' + QUOTED_VALUE
  + '))?)*[ \\t]*$', 'i',
);

export function problem(status: number, code: string): HttpError {
  return new HttpError(status, code, code);
}

export function errorEnvelope<Code extends string>(code: Code) {
  return {error: {code, message: code}};
}

export function exactObject(value: unknown, ...keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function isJson(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && JSON_MEDIA_TYPE.test(contentType);
}

export function requestEncoding(headers: IncomingMessage['headersDistinct']): Encoding {
  const mediaTypes = headers['content-type'];
  if (mediaTypes?.length !== 1 || !isJson(mediaTypes[0])) throw problem(415, 'unsupported_media_type');
  const encodings = headers['content-encoding'];
  if (encodings === undefined) return 'identity';
  const value = encodings.length === 1 && encodings[0]?.trim().toLowerCase();
  if (value === 'identity' || value === 'gzip') return value;
  throw problem(415, 'unsupported_encoding');
}

export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]{1,16}$/.test(value);
}

export function validateMessage(value: unknown): Message {
  if (!exactObject(value, 'id', 'text') || !validId(value.id)
    || typeof value.text !== 'string' || !/^[A-Za-z ]{1,256}$/.test(value.text)) {
    throw problem(400, 'invalid_message');
  }
  return {id: value.id, text: value.text};
}

export function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
}

export function requireMethod(req: IncomingMessage, res: ServerResponse, method: string): void {
  if (req.method !== method) {
    res.setHeader('allow', method);
    throw problem(405, 'method_not_allowed');
  }
}

type RequestHandler = (
  req: IncomingMessage, res: ServerResponse, acceptedAt: number, signal: AbortSignal,
) => Promise<void>;

export function endpoint(handler: RequestHandler) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const acceptedAt = performance.now();
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    try {
      await handler(req, res, acceptedAt, controller.signal);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      // An early rejection may leave unread request bytes. End the connection after the reply.
      res.setHeader('connection', 'close');
      if (error instanceof HttpError) json(res, error.status, errorEnvelope(error.code));
      else json(res, 500, errorEnvelope('internal_error'));
    } finally {
      res.off('close', disconnect);
    }
  };
}
