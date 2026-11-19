import { request as httpRequest } from 'node:http';
import type { Member } from './placement.mts';
import { exact, fail } from './protocol.mts';

const DEADLINE_MS = 500;
const MAX_BYTES = 8192;
const MAX_HEADER_BYTES = 8192;
const MEDIA_TOKEN = /[\w!#$%&'*+.^`|~-]+/.source;
const QUOTED_PARAMETER = /"(?:[\t !#-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"/.source;
const JSON_CONTENT_TYPE = new RegExp(
  String.raw`^[ \t]*application/json(?:[ \t]*;[ \t]*${MEDIA_TOKEN}=(?:${MEDIA_TOKEN}|${QUOTED_PARAMETER}))*[ \t]*$`, 'i',
);

function normalizeOrigin(raw: string | undefined): string {
  if (raw === undefined || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/i.test(raw)) {
    throw new Error('Each member must have a loopback HTTP origin on 127.0.0.1');
  }
  const url = new URL(raw);
  if (url.port === '0') throw new Error('Member origin port cannot be 0');
  return url.origin;
}

export function memberOrigins(
  a: string | undefined, b: string | undefined, c: string | undefined,
): Readonly<Record<Member, string>> {
  const origins = { a: normalizeOrigin(a), b: normalizeOrigin(b), c: normalizeOrigin(c) };
  if (new Set(Object.values(origins)).size !== 3) throw new Error('Member origins must be distinct');
  return origins;
}

type LookupReply = AsyncIterable<Uint8Array> & {
  statusCode?: number;
  headersDistinct: Readonly<Record<string, readonly string[] | undefined>>;
  destroy: () => void;
};

type LookupTransport = (url: string, signal: AbortSignal) => Promise<LookupReply>;

function directLookup(url: string, signal: AbortSignal): Promise<LookupReply> {
  return new Promise((resolve, reject) => {
    // A one-use agent keeps this request off the global agent, including its proxy settings.
    const req = httpRequest(url, { method: 'GET', agent: false, signal, maxHeaderSize: MAX_HEADER_BYTES }, resolve);
    // Inspect every field within the byte limit, including fields after Node's default count limit.
    req.maxHeadersCount = 0;
    req.once('error', reject);
    req.once('close', () => reject(new Error('Upstream closed before replying')));
    req.end();
  });
}

function singleHeader(response: LookupReply, name: string): string | undefined {
  const values = response.headersDistinct[name];
  if (values && values.length !== 1) throw new Error('Duplicate upstream header');
  return values?.[0];
}

async function readReply(response: LookupReply, assertTime: () => void): Promise<unknown> {
  assertTime();
  if (response.statusCode !== 200) throw new Error('Unexpected upstream status');
  const contentType = singleHeader(response, 'content-type');
  const encoding = singleHeader(response, 'content-encoding')?.trim().toLowerCase();
  const length = singleHeader(response, 'content-length');
  if (contentType === undefined || !JSON_CONTENT_TYPE.test(contentType) || (encoding !== undefined && encoding !== 'identity')
    || (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BYTES))) {
    throw new Error('Invalid upstream headers');
  }

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    assertTime();
    bytes += chunk.byteLength;
    if (bytes > MAX_BYTES) throw new Error('Upstream body exceeds byte limit');
    if (chunk.byteLength > 0) chunks.push(chunk);
  }
  assertTime();
  const wire = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const decoded: unknown = JSON.parse(wire);
  return decoded;
}

export async function fetchLookup(
  origin: string,
  owner: Member,
  key: string,
  transport: LookupTransport = directLookup,
  now: () => number = () => performance.now(),
): Promise<string> {
  const deadline = now() + DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  const assertTime = () => {
    controller.signal.throwIfAborted();
    if (now() >= deadline) throw new Error('Upstream deadline exceeded');
  };
  let response: LookupReply | undefined;
  try {
    response = await transport(origin + '/lookup/' + key, controller.signal);
    const reply = await readReply(response, assertTime);
    const value = `${owner}/${key}`;
    if (!exact(reply, ['member', 'key', 'value']) || reply.member !== owner
      || reply.key !== key || reply.value !== value) {
      throw new Error('Invalid upstream lookup');
    }
    assertTime();
    return value;
  } catch {
    return fail(502, 'upstream_failure');
  } finally {
    clearTimeout(timer);
    controller.abort();
    response?.destroy();
  }
}
