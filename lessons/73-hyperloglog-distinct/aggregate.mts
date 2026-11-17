import { json, numberSetting, serve } from '../../lib/http.mts';
import { configuredOrigins, estimate, fail, merge, replyError, validSnapshot } from './protocol.mts';
import type { SketchId, Snapshot } from './protocol.mts';

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !response.body) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Invalid upstream media');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, {once:true});
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) throw new Error('Upstream body too large');
      chunks.push(part.value);
    }
    const wire = new TextDecoder('utf-8', {fatal:true}).decode(Buffer.concat(chunks));
    const parsed: unknown = JSON.parse(wire);
    return parsed;
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function aggregate(a: string, b: string, fetcher: typeof fetch = fetch): Promise<{registers: number[]; estimate: number}> {
  const [first, second] = configuredOrigins(a, b, undefined, 0);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline')); }, 500);
  });
  const snapshot = async (origin: string, id: SketchId): Promise<Snapshot> => {
    const response = await fetcher(origin + '/snapshot', {method:'GET',redirect:'error',signal:controller.signal});
    const body = await boundedJson(response, controller.signal);
    if (response.status !== 200 || !validSnapshot(body, id)) throw new Error('Invalid upstream snapshot');
    return body;
  };
  const work = async () => {
    const [left, right] = await Promise.all([snapshot(first, 'a'), snapshot(second, 'b')]);
    controller.signal.throwIfAborted();
    const registers = merge(left.registers, right.registers);
    return {registers,estimate:estimate(registers)};
  };
  try { return await Promise.race([work(), deadline]); }
  catch { return fail(502, 'upstream_failure'); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function main(): Promise<void> {
  const a = process.env.SOURCE_A_ORIGIN, b = process.env.SOURCE_B_ORIGIN;
  if (!a || !b) throw new Error('SOURCE_A_ORIGIN and SOURCE_B_ORIGIN required');
  const [first, second] = configuredOrigins(a, b, process.env.HOST, numberSetting('PORT', 7373, 0, 65535));
  await serve('hll-aggregate', 7373, async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://aggregate');
      if (url.search) fail(400, 'invalid_request');
      if (url.pathname !== '/estimate') fail(404, 'not_found');
      if (req.method !== 'GET') { res.setHeader('allow', 'GET'); fail(405, 'method_not_allowed'); }
      json(res, 200, await aggregate(first, second));
    } catch (error) { replyError(res, error); }
  });
}
if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
