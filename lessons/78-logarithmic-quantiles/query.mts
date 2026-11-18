import { json, methodNotAllowed } from '../../lib/http.mts';
import { fail, parsePercentile, parseSnapshot, sourceOrigins } from './contracts.mts';
import type { Origins, SourceId } from './contracts.mts';
import { quantile } from './quantiles.mts';
import { listen } from './runtime.mts';

const DEADLINE_MS = 500;
const MAX_JSON_BYTES = 8192;

async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (media !== 'application/json' || !response.body) fail(502, 'upstream_failure');
  // Fetch can decode a compressed body while preserving its wire headers.
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.toLowerCase() !== 'identity') fail(502, 'upstream_failure');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) {
    fail(502, 'upstream_failure');
  }

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_JSON_BYTES) fail(502, 'upstream_failure');
      chunks.push(next.value);
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
    const body: unknown = JSON.parse(text);
    return body;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function readQuantile(origins: Origins, p: number, fetcher: typeof fetch = fetch) {
  const deadline = performance.now() + DEADLINE_MS;
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const fetchSnapshot = async (id: SourceId) => {
      const response = await fetcher(origins[id] + '/snapshot', { signal, redirect: 'error' });
      if (response.status !== 200) fail(502, 'upstream_failure');
      return parseSnapshot(await readBoundedJson(response, signal), id);
    };

    const [a, b] = await Promise.all([fetchSnapshot('a'), fetchSnapshot('b')]);
    const result = quantile(a.bins, b.bins, p);
    // The timer may still be pending when the final body read completes.
    if (performance.now() >= deadline) fail(502, 'upstream_failure');
    return result;
  } catch {
    fail(502, 'upstream_failure');
  } finally {
    clearTimeout(timer);
    // If either source fails, stop the other source's fetch or body read as well.
    controller.abort();
  }
}

export async function main(): Promise<void> {
  const origins = sourceOrigins(process.env.SOURCE_A_ORIGIN, process.env.SOURCE_B_ORIGIN);
  await listen('quantile-query', 3178, async (req, res) => {
    const target = req.url ?? '/';
    const [path] = target.split('?', 1);
    if (path !== '/quantile') fail(404, 'not_found');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const p = parsePercentile(target.slice(path.length));
    json(res, 200, await readQuantile(origins, p));
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  });
}
