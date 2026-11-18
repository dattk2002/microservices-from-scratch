import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, numberSetting, serve } from '../../lib/http.mts';
import { fail, parseOrigins, parseSummary, validateHost } from './protocol.mts';
import type { Origins } from './protocol.mts';
import { mergeSummaries } from './summary.mts';
import type { HeavyHitters, Source, Summary } from './summary.mts';

const DEFAULT_PORT = 3177;
const BODY_LIMIT = 8192;
const DEADLINE_MS = 500;

export async function readSummary(response: Response, source: Source, signal: AbortSignal): Promise<Summary> {
  const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  const encoding = response.headers.get('content-encoding');
  const length = response.headers.get('content-length');
  const body = response.body;
  // Fetch may decompress the body while leaving the upstream headers intact.
  if (response.status !== 200 || media !== 'application/json' || !body
    || (encoding !== null && encoding.toLowerCase() !== 'identity')
    || (length !== null && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT))) {
    void body?.cancel().catch(() => {});
    throw new Error('Unexpected upstream response');
  }

  const reader = body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  const chunks: Uint8Array[] = [];
  let size = 0;
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > BODY_LIMIT) throw new Error('Upstream body exceeds 8192 bytes');
      chunks.push(part.value);
    }
    const wire = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    const payload: unknown = JSON.parse(wire);
    const summary = parseSummary(payload, source);
    if (!summary) throw new Error('Invalid upstream summary');
    return summary;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function pull(origins: Origins): Promise<HeavyHitters> {
  const deadline = performance.now() + DEADLINE_MS;
  const controller = new AbortController();
  const { signal } = controller;
  const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
  async function fetchSource(source: Source): Promise<Summary> {
    const response = await fetch(origins[source] + '/summary', { redirect: 'error', signal });
    return readSummary(response, source, signal);
  }
  try {
    const [a, b] = await Promise.all([fetchSource('a'), fetchSource('b')]);
    const result = mergeSummaries(a, b);
    // A ready body can resume before a delayed abort timer runs.
    if (performance.now() >= deadline) throw new Error('Upstream deadline exceeded');
    return result;
  } catch {
    fail(502, 'upstream_failure');
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function queryHandler(origins: Origins) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const target = req.url ?? '/';
    const path = target.split('?', 1)[0];
    if (path !== '/heavy') fail(404, 'not_found');
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      fail(405, 'method_not_allowed');
    }
    if (target !== path) fail(400, 'invalid_request');
    json(res, 200, await pull(origins));
  };
}

async function main(): Promise<void> {
  validateHost(process.env.HOST);
  const origins = parseOrigins(process.env.SOURCE_A_ORIGIN, process.env.SOURCE_B_ORIGIN);
  const port = numberSetting('PORT', DEFAULT_PORT, 0, 65535);
  if (port !== 0) {
    const ownOrigin = new URL(`http://127.0.0.1:${port}`).origin;
    if (ownOrigin === origins.a || ownOrigin === origins.b) throw new Error('Query origin must differ from source origins');
  }
  await serve('mg77-query', DEFAULT_PORT, queryHandler(origins));
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
