import type { Exchange } from './engine.mts';

export async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('Missing upstream body');
  const reader = response.body.getReader();
  try {
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8192) throw new Error('Upstream JSON exceeds 8192 bytes');
      chunks.push(part.value);
    }
    if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('Expected JSON');
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); return value;
  } finally {
    try { await reader.cancel(); } catch { /* Aborted transport. */ }
    reader.releaseLock();
  }
}
export const exchange: Exchange = async (origin, path, body, signal) => {
  const response = await fetch(origin + path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    redirect: 'error', signal,
  });
  // Bound and decode all statuses, including errors; status is never a vote by itself.
  return { status: response.status, body: await boundedJson(response, signal) };
};
