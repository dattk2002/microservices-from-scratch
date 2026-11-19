import { json, methodNotAllowed, serve } from '../../lib/http.mts';
import { fail, replyError } from './errors.mts';
import { compareSlots, validSignature } from './model.mts';
import type { SetId, Signature, Similarity } from './model.mts';

const DEADLINE_MS = 500;
const MAX_BODY_BYTES = 8192;
type Origins = readonly [string, string];

function sourceOrigin(raw: string | undefined): string {
  if (raw === undefined || !/^http:\/\/127\.0\.0\.1(?::[0-9]+)?\/?$/i.test(raw)) {
    throw new Error('Each source must be a loopback HTTP origin on 127.0.0.1');
  }
  const url = new URL(raw);
  if (url.port === '0') throw new Error('Source port cannot be 0');
  return url.origin;
}

export function sourceOrigins(a: string | undefined, b: string | undefined): Origins {
  const first = sourceOrigin(a);
  const second = sourceOrigin(b);
  if (first === second) throw new Error('Source origins must be distinct');
  return [first, second];
}

async function fetchSignature(origin: string, id: SetId, signal: AbortSignal, fetcher: typeof fetch): Promise<Signature> {
  const response = await fetcher(origin + '/signature', {method: 'GET', signal, redirect: 'error'});
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (response.status !== 200 || mediaType !== 'application/json' || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Invalid upstream status or media type');
  }
  // Fetch may decode compressed bodies while retaining the original HTTP headers.
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  if ((encoding !== null && encoding.toLowerCase() !== 'identity')
    || (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES))) {
    void response.body.cancel().catch(() => {});
    throw new Error('Invalid upstream body encoding or length');
  }

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  let complete = false;
  try {
    signal.addEventListener('abort', cancel, {once: true});
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) throw new Error('Upstream body too large');
      chunks.push(part.value);
    }
    complete = true;
    const wire = new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks));
    const body: unknown = JSON.parse(wire);
    if (!validSignature(body, id)) throw new Error('Invalid upstream signature');
    return body;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function compareSources(origins: Origins, fetcher: typeof fetch = fetch): Promise<Similarity> {
  const deadline = performance.now() + DEADLINE_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const [a, b] = await Promise.all([
      fetchSignature(origins[0], 'a', controller.signal, fetcher),
      fetchSignature(origins[1], 'b', controller.signal, fetcher),
    ]);
    controller.signal.throwIfAborted();
    const similarity = compareSlots(a.slots, b.slots);
    if (performance.now() >= deadline) throw new Error('Upstream deadline exceeded');
    return similarity;
  } catch {
    fail(502, 'upstream_failure');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main(): Promise<void> {
  const origins = sourceOrigins(process.env.SOURCE_A_ORIGIN, process.env.SOURCE_B_ORIGIN);
  await serve('minhash-compare', 8083, async (req, res) => {
    try {
      const [route, query] = (req.url ?? '/').split('?', 2);
      if (route !== '/similarity') fail(404, 'not_found');
      if (query !== undefined) fail(400, 'invalid_request');
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      json(res, 200, await compareSources(origins));
    } catch (error) {
      replyError(res, error);
    }
  });
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
