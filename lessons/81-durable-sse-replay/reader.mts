import {requestOnce} from './request-once.mts';
import { json, methodNotAllowed, serve } from '../../lib/http.mts';
import { exactKeys, feedOrigin, MAX_BODY_BYTES, replayCursor } from './contracts.mts';
import type { Replay } from './contracts.mts';
import { fail, replyError } from './errors.mts';
import { ReplayParser } from './sse.mts';

const DEADLINE_MS = 500;
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED = String.raw`"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"`;
const CONTENT_TYPE = new RegExp(String.raw`^(${TOKEN}/${TOKEN})(?:[ \t]*;(?:[ \t]*${TOKEN}=(?:${TOKEN}|${QUOTED}))?)*[ \t]*$`);

async function* readChunks(body: ReadableStream<Uint8Array>, signal: AbortSignal, checkDeadline: () => void) {
  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let complete = false;
  let bytes = 0;
  try {
    signal.addEventListener('abort', cancel, {once: true});
    checkDeadline();
    while (true) {
      const part = await reader.read();
      checkDeadline();
      if (part.done) {
        complete = true;
        return;
      }
      bytes += part.value.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error('Upstream body too large');
      yield part.value;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

async function consumeResponse(response: Response, after: number, signal: AbortSignal,
  checkDeadline: () => void): Promise<Replay | undefined> {
  const expectedType = response.status === 200 ? 'text/event-stream'
    : response.status === 409 ? 'application/json' : undefined;
  // Fetch combines repeated Content-Type values. Validate the whole field as a single media type.
  const media = response.headers.get('content-type') ?? '';
  // A comma could hide malformed duplicate fields after Fetch combines them.
  const type = media.includes(',') ? undefined : CONTENT_TYPE.exec(media)?.[1]?.toLowerCase();
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  // Fetch can expose already-decoded bytes with the original encoding header.
  if (!response.body || expectedType === undefined || type !== expectedType
    || (encoding !== null && encoding.toLowerCase() !== 'identity')
    || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES))) {
    throw new Error('Invalid upstream headers');
  }

  const chunks = readChunks(response.body, signal, checkDeadline);
  if (response.status === 200) {
    const parser = new ReplayParser(after);
    for await (const chunk of chunks) parser.push(chunk);
    return parser.finish();
  }

  const pieces: Uint8Array[] = [];
  for await (const chunk of chunks) if (chunk.byteLength !== 0) pieces.push(chunk);
  const wire = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(pieces));
  const value: unknown = JSON.parse(wire);
  if (!exactKeys(value, ['error']) || !exactKeys(value.error, ['code', 'message'])
    || value.error.code !== 'cursor_ahead' || value.error.message !== 'cursor_ahead') {
    throw new Error('Invalid upstream error envelope');
  }
  // Only a fully validated cursor_ahead response reaches this case.
  return undefined;
}

export async function fetchReplay(origin: string, after: number, fetcher: typeof fetch = requestOnce,
  now: () => number = () => performance.now()): Promise<Replay> {
  const deadline = now() + DEADLINE_MS;
  const controller = new AbortController();
  const checkDeadline = () => {
    controller.signal.throwIfAborted();
    if (now() >= deadline) throw new Error('Upstream deadline exceeded');
  };
  let response: Response | undefined;
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    response = await fetcher(origin + '/events', {
      method: 'GET',
      headers: {'last-event-id': String(after), 'accept': 'text/event-stream', 'accept-encoding': 'identity'},
      redirect: 'error',
      signal: controller.signal,
    });
    checkDeadline();
    const replay = await consumeResponse(response, after, controller.signal, checkDeadline);
    checkDeadline();
    if (replay !== undefined) return replay;
  } catch {
    fail(502, 'upstream_failure');
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
  }
  fail(409, 'cursor_ahead');
}

async function main(): Promise<void> {
  const origin = feedOrigin(process.env.FEED_ORIGIN);
  const nativeServer = await serve('reader', 8082, async (req, res) => {
    try {
      const target = req.url ?? '/';
      if (target.split('?', 1)[0] !== '/replay') fail(404, 'not_found');
      const after = replayCursor(target);
      if (after === undefined) fail(400, 'invalid_request');
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      const replay = await fetchReplay(origin, after);
      if (!res.destroyed) json(res, 200, replay);
    } catch (error) {
      replyError(res, error);
    }
  });
  nativeServer.maxHeadersCount = 0;
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
