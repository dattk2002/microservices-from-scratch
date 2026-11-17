import type { IncomingMessage, ServerResponse } from 'node:http';
import { serve, json, numberSetting } from '../../lib/http.mts';
import { key, invalid, semantic, estimate, merge, validSnapshot, validateHost } from './protocol.mts';
import type { Identity, Snapshot } from './protocol.mts';

export function normalizeOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '0'
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Sources must be loopback HTTP origins');
  }
  return url.origin;
}
export function configuredOrigins(a: string, b: string, host: unknown, port: number): [string, string] {
  validateHost(host);
  const first = normalizeOrigin(a), second = normalizeOrigin(b);
  const listener = port === 0 ? undefined : new URL(`http://127.0.0.1:${port}`).origin;
  if (first === second || first === listener || second === listener) throw new Error('Origins must be distinct');
  return [first, second];
}
function failure(): never { return semantic(502, 'upstream_failure'); }

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body) failure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  // Cancellation is best effort; a misbehaving peer must not delay the deadline.
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) failure();
      chunks.push(chunk.value);
    }
    const wire = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const parsed: unknown = JSON.parse(wire);
    return parsed;
  } finally { signal.removeEventListener('abort', cancel); cancel(); }
}

export async function readEstimate(a: string, b: string, query: unknown, fetcher: typeof fetch = fetch): Promise<{ key: string; estimate: number; total: number }> {
  if (!key(query)) invalid();
  const [first, second] = configuredOrigins(a, b, undefined, 0);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, 500);
  });
  const snapshot = async (origin: string, id: Identity): Promise<Snapshot> => {
    const response = await fetcher(origin + '/snapshot', { method: 'GET', redirect: 'error', signal: controller.signal });
    const body = await readBody(response, controller.signal);
    if (response.status !== 200 || !validSnapshot(body, id)) failure();
    return body;
  };
  const work = async () => {
    const [left, right] = await Promise.all([snapshot(first, 'a'), snapshot(second, 'b')]);
    return { key: query, estimate: estimate(merge(left.cells, right.cells), query), total: left.total + right.total };
  };
  try { return await Promise.race([work(), deadline]); }
  catch { return failure(); }
  finally { clearTimeout(timer); controller.abort(); }
}

export function aggregateHandler(a: string, b: string) {
  const [first, second] = configuredOrigins(a, b, undefined, 0);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://aggregate');
    const parts = url.pathname.split('/');
    if (parts.length !== 3 || parts[1] !== 'estimate') semantic(404, 'not_found');
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); semantic(405, 'method_not_allowed'); }
    if (url.search || !key(parts[2])) invalid();
    json(res, 200, await readEstimate(first, second, parts[2]));
  };
}
export async function main(): Promise<void> {
  const a = process.env.SOURCE_A_ORIGIN, b = process.env.SOURCE_B_ORIGIN;
  if (!a || !b) throw new Error('SOURCE_A_ORIGIN and SOURCE_B_ORIGIN required');
  const [first, second] = configuredOrigins(a, b, process.env.HOST, numberSetting('PORT', 3272, 0, 65535));
  await serve('count-min-aggregate', 3272, aggregateHandler(first, second));
}
if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1;
});
