import { json, numberSetting, serve } from '../../lib/http.mts';
import {
  compareItems, fail, normalizeOrigins, parseQueryPage, requestTarget, upstreamFailure,
  validateHost, validatePage,
} from './protocol.mts';
import type { Item, Origins, QueryPage, Shard, Vector } from './protocol.mts';

const DEADLINE_MS = 500;
const MAX_UPSTREAM_BYTES = 8192;

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
  if (encoding !== undefined && encoding !== 'identity') upstreamFailure();
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
      !response.body) upstreamFailure();

  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const chunks: Uint8Array[] = [];
  let size = 0;
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_UPSTREAM_BYTES) upstreamFailure();
      chunks.push(chunk.value);
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    const body: unknown = JSON.parse(decoded);
    return body;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function aggregate(
  origins: Origins,
  query: QueryPage,
  fetchShard: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): Promise<{ snapshots: Vector; items: Item[]; next: Item | null }> {
  const expiresAt = now() + DEADLINE_MS;
  const controller = new AbortController();
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.after) {
    params.set('afterScore', String(query.after.score));
    params.set('afterId', query.after.id);
  }
  const readPage = async (shard: Shard): Promise<Item[]> => {
    const url = `${origins[shard]}/snapshots/${query.snapshots[shard]}/page?${params}`;
    const response = await fetchShard(url, { redirect: 'error', signal: controller.signal });
    const body = await boundedJson(response, controller.signal);
    // All non-200 statuses, including an unknown snapshot, fail the whole vector.
    if (response.status !== 200) upstreamFailure();
    return validatePage(body, shard, query.snapshots[shard], query);
  };
  const timeout = setTimeout(() => controller.abort(), DEADLINE_MS);
  try {
    const [a, b] = await Promise.all([readPage('a'), readPage('b')]);
    const items = [...a, ...b].sort(compareItems).slice(0, query.limit);
    if (now() >= expiresAt) upstreamFailure();
    return { snapshots: query.snapshots, items, next: items.at(-1) ?? null };
  } catch {
    return upstreamFailure();
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

async function main(): Promise<void> {
  validateHost(process.env.HOST);
  const origins = normalizeOrigins(process.env.SHARD_A_ORIGIN, process.env.SHARD_B_ORIGIN);
  const port = numberSetting('PORT', 3176, 0, 65535);
  const listener = new URL(`http://127.0.0.1:${port}`).origin;
  if (listener === origins.a || listener === origins.b) throw new Error('Query origin must differ from shard origins');

  await serve('keyset-query', 3176, async (req, res) => {
    const { path, search } = requestTarget(req.url);
    if (path !== '/page') fail(404, 'not_found');
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      fail(405, 'method_not_allowed');
    }
    json(res, 200, await aggregate(origins, parseQueryPage(search)));
  });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  });
}
