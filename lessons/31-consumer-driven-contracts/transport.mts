import { request } from 'node:http';

export const RESPONSE_BYTES = 2048;
export const CONTROL_BYTES = 256;
export const REQUEST_MS = 400;
export const TOTAL_MS = 1200;
export function loopbackOrigin(value: unknown): string {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(value)) throw new Error('Invalid PROVIDER_ORIGIN');
  const url = new URL(value);
  if (Number(url.port) < 1 || Number(url.port) > 65535 || url.origin !== value) throw new Error('Invalid PROVIDER_ORIGIN');
  return value;
}
export async function readBytes(stream: AsyncIterable<Buffer | string>, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of stream) {
    const chunk: Buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > limit) throw new Error('body: byte limit exceeded');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function upstream(origin: string, spec: {method: 'GET'; path: string}, signal: AbortSignal): Promise<{status: number; body: unknown}> {
  // Only catalogue paths reach here; redirects are never followed by node:http.
  return new Promise((resolve, reject) => {
    const req = request(origin + spec.path, {method: spec.method, signal}, res => {
      void (async () => {
        try {
          if (res.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('body: expected JSON content type');
          const bytes = await readBytes(res, RESPONSE_BYTES);
          let body: unknown;
          try { body = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('body: invalid JSON'); }
          resolve({status: res.statusCode ?? 0, body});
        } catch (error) {
          res.destroy();
          const safe = error instanceof Error && ['body: byte limit exceeded', 'body: invalid JSON', 'body: expected JSON content type'].includes(error.message);
          reject(safe ? error : new Error('upstream: unavailable or deadline exceeded'));
        }
      })();
    });
    req.once('error', () => reject(new Error('upstream: unavailable or deadline exceeded')));
    req.end();
  });
}
