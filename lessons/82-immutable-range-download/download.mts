import {requestOnce} from './request-once.mts';
import { MAX_OBJECT_BYTES, fail, isPrintable, isStrongTag, strongTag, validErrorBody } from './protocol.mts';
import type { ResumeRequest } from './protocol.mts';

const DEADLINE_MS = 500;
const MAX_ERROR_BYTES = 8192;
const PARAMETER_TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED_PARAMETER = String.raw`"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"`;
const CONTENT_TYPE = new RegExp(
  String.raw`^([^;\s]+)(?:[ \t]*;[ \t]*${PARAMETER_TOKEN}=(?:${PARAMETER_TOKEN}|${QUOTED_PARAMETER}))*$`,
);

type DownloadResult = {text: string; etag: string; resumed: boolean};

export function objectOrigin(raw: string | undefined): string {
  if (!raw || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/i.test(raw)) {
    throw new Error('OBJECT_ORIGIN must be an HTTP origin on 127.0.0.1');
  }
  const url = new URL(raw);
  if (url.port === '0') throw new Error('OBJECT_ORIGIN port cannot be 0');
  return url.origin;
}

async function readBounded(
  response: Response, mediaType: string, limit: number, expectedLength: number | undefined,
  signal: AbortSignal, checkDeadline: () => void,
): Promise<Buffer> {
  // Fetch can hide repeated field boundaries inside a quoted parameter.
  const contentType = response.headers.get('content-type') ?? '';
  const actualMediaType = contentType.includes(',') ? undefined : CONTENT_TYPE.exec(contentType)?.[1]?.toLowerCase();
  const encoding = response.headers.get('content-encoding');
  if (actualMediaType !== mediaType || (encoding !== null && encoding.toLowerCase() !== 'identity')) {
    throw new Error('Invalid upstream media type or encoding');
  }
  const header = response.headers.get('content-length');
  const length = header !== null && /^[0-9]+$/.test(header) ? Number(header) : undefined;
  if ((header !== null && (length === undefined || length > limit))
    || (mediaType === 'application/octet-stream' && (length === undefined || length < 1))
    || (expectedLength !== undefined && length !== expectedLength)) {
    throw new Error('Invalid upstream length header');
  }
  if (!response.body) throw new Error('Missing upstream body');

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let complete = false;
  try {
    signal.addEventListener('abort', cancel, {once: true});
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      checkDeadline();
      const part = await reader.read();
      checkDeadline();
      if (part.done) break;
      if (part.value.byteLength === 0) continue;
      size += part.value.byteLength;
      if (size > (length ?? limit)) throw new Error('Upstream body exceeded its byte limit');
      chunks.push(part.value);
    }
    complete = true;
    if (length !== undefined && size !== length) throw new Error('Upstream body length mismatch');
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

function checkedDownload(bytes: Buffer, etag: string, resumed: boolean): DownloadResult {
  // Latin-1 preserves every byte as a code point, including non-ASCII bytes
  // which must fail the printable check. Hash the original bytes.
  const text = bytes.toString('latin1');
  if (!isPrintable(text, 1) || strongTag(bytes) !== etag) throw new Error('Invalid object bytes');
  return {text, etag, resumed};
}

async function decodeResponse(
  response: Response, prefix: Buffer, suppliedTag: string | null, signal: AbortSignal, checkDeadline: () => void,
): Promise<DownloadResult | null> {
  if (response.status === 404 || response.status === 416) {
    if (response.status === 416 && (prefix.length === 0 || suppliedTag === null
      || response.headers.get('etag') !== suppliedTag
      || response.headers.get('content-range') !== `bytes */${prefix.length}`)) {
      throw new Error('Invalid completed-prefix metadata');
    }
    const code = response.status === 404 ? 'unknown_object' : 'range_not_satisfiable';
    const bytes = await readBounded(response, 'application/json', MAX_ERROR_BYTES, undefined, signal, checkDeadline);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes));
    if (!validErrorBody(value, code)) throw new Error('Invalid upstream error envelope');
    if (response.status === 404) return null;
    if (suppliedTag === null) throw new Error('Missing prefix validator');
    return checkedDownload(prefix, suppliedTag, true);
  }

  if (response.status !== 200 && response.status !== 206) throw new Error('Unexpected upstream status');
  const etag = response.headers.get('etag');
  if (!isStrongTag(etag)) throw new Error('Invalid upstream ETag');

  const range = response.headers.get('content-range');
  if (response.status === 200) {
    if (range !== null) throw new Error('Unexpected Content-Range');
    const bytes = await readBounded(response, 'application/octet-stream', MAX_OBJECT_BYTES, undefined, signal, checkDeadline);
    return checkedDownload(bytes, etag, false);
  }

  if (prefix.length === 0 || etag !== suppliedTag) throw new Error('Unsolicited or mismatching partial object');
  const match = range?.match(/^bytes (0|[1-9][0-9]*)-(0|[1-9][0-9]*)\/([1-9][0-9]*)$/);
  if (!match) throw new Error('Invalid partial Content-Range');
  const [start, end, total] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (start !== prefix.length || end !== total - 1 || end < start || total > MAX_OBJECT_BYTES) {
    throw new Error('Partial response does not match the requested suffix');
  }
  const bytes = await readBounded(response, 'application/octet-stream', MAX_OBJECT_BYTES, total - start, signal, checkDeadline);
  return checkedDownload(Buffer.concat([prefix, bytes]), etag, true);
}

export async function download(
  origin: string, input: ResumeRequest, fetcher: typeof fetch = requestOnce, now: () => number = () => performance.now(),
): Promise<DownloadResult> {
  const deadline = now() + DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const checkDeadline = () => {
    controller.signal.throwIfAborted();
    if (now() >= deadline) throw new Error('Upstream deadline exceeded');
  };
  let response: Response | undefined;
  let result: DownloadResult | null;
  try {
    const prefix = Buffer.from(input.prefix, 'utf8');
    const headers = new Headers({'accept-encoding': 'identity'});
    if (prefix.length !== 0 && input.etag !== null) {
      headers.set('range', `bytes=${prefix.length}-`);
      headers.set('if-range', input.etag);
    }
    checkDeadline();
    response = await fetcher(origin + '/objects/' + input.id,
      {method: 'GET', headers, redirect: 'error', signal: controller.signal});
    checkDeadline();
    result = await decodeResponse(response, prefix, input.etag, controller.signal, checkDeadline);
    checkDeadline();
  } catch {
    fail(502, 'upstream_failure');
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
    controller.abort();
  }

  if (result === null) fail(404, 'unknown_object');
  return result;
}
