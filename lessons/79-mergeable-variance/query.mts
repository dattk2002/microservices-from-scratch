import { json, numberSetting } from '../../lib/http.mts';
import { fail, origins, parseSnapshot } from './protocol.mts';
import type { Origins, Snapshot, SourceId } from './protocol.mts';
import { method, serveJson, start } from './service.mts';
import { merge, summarize } from './statistics.mts';
import type { Statistics } from './statistics.mts';

const deadlineMs = 500;
const bodyLimit = 8192;

async function readSnapshot(
  origin: string, id: SourceId, signal: AbortSignal, fetcher: typeof fetch,
): Promise<Snapshot> {
  const response = await fetcher(origin + '/snapshot', { redirect: 'error', signal });
  const body = response.body;
  const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  // Fetch can decode content before exposing the stream. Only accept unencoded wire bodies.
  const validEncoding = encoding === null || encoding.toLowerCase() === 'identity';
  const validLength = length === null || (/^\d+$/.test(length) && Number(length) <= bodyLimit);

  // The source has only one successful snapshot status. No upstream errors are forwarded.
  if (!body || response.status !== 200 || media !== 'application/json'
      || !validEncoding || !validLength || signal.aborted) {
    if (body) void body.cancel().catch(() => {});
    fail(502, 'upstream_failure');
  }

  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let complete = false;
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > bodyLimit) fail(502, 'upstream_failure');
      chunks.push(chunk.value);
    }

    complete = true;
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    return parseSnapshot(raw, id);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
}

export async function aggregate(config: Origins, fetcher: typeof fetch = fetch): Promise<Statistics> {
  const expiresAt = performance.now() + deadlineMs;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Upstream deadline exceeded')), deadlineMs);
  });

  try {
    const [a, b] = await Promise.race([
      Promise.all([
        readSnapshot(config.a, 'a', controller.signal, fetcher),
        readSnapshot(config.b, 'b', controller.signal, fetcher),
      ]),
      deadline,
    ]);
    const result = summarize(merge(a, b));
    // The completed bodies can win the race while the timer callback is delayed.
    if (performance.now() >= expiresAt) fail(502, 'upstream_failure');
    return result;
  } catch {
    fail(502, 'upstream_failure');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function main(): Promise<void> {
  const config = origins(process.env.SOURCE_A_ORIGIN, process.env.SOURCE_B_ORIGIN);
  const defaultPort = 3179;
  const port = numberSetting('PORT', defaultPort, 0, 65535);
  if (port !== 0 && Object.values(config).includes(new URL(`http://127.0.0.1:${port}`).origin)) {
    throw new Error('Query listener must differ from source origins');
  }

  await serveJson('variance-query', defaultPort, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/statistics') fail(404, 'not_found');
    method(req, res, 'GET');
    if (url.search) fail(400, 'invalid_request');
    json(res, 200, await aggregate(config));
  });
}

if (import.meta.main) start(main);
