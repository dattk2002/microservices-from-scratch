import { request } from 'node:http';

type WireOptions = {
  method?: string;
  headers?: string[];
  body?: Buffer | string;
  leaveOpen?: boolean;
};

export type WireResponse = { status: number; headers: string[]; body: Buffer };

export function openWire(origin: string, path: string, options: WireOptions = {}) {
  const target = new URL(origin);
  const req = request({
    hostname: target.hostname,
    port: target.port,
    path,
    method: options.method ?? 'GET',
    headers: ['host', target.host, 'connection', 'close', ...(options.headers ?? [])],
    agent: false,
    maxHeaderSize: 8192,
    signal: AbortSignal.timeout(3000),
  });
  try {
    req.maxHeadersCount = 0;
    const reply = new Promise<WireResponse>((resolve, reject) => {
      let receivedResponse = false;
      req.on('error', reject);
      req.once('close', () => {
        if (!receivedResponse) reject(new Error('Test request closed before response'));
      });
      req.once('response', res => {
        receivedResponse = true;
        const chunks: Buffer[] = [];
        res.on('error', reject);
        res.once('close', () => {
          if (!res.readableEnded) reject(new Error('Test response closed before EOF'));
        });
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('end', () => {
          if (!res.complete) reject(new Error('Incomplete test response'));
          else resolve({ status: res.statusCode ?? 0, headers: res.rawHeaders, body: Buffer.concat(chunks) });
        });
      });
    });
    // A held test request can fail before the test reaches its barrier.
    void reply.catch(() => {});
    if (options.leaveOpen) req.write(options.body);
    else req.end(options.body);
    return {
      reply,
      abort() { req.destroy(new Error('Test caller disconnected')); },
    };
  } catch (error) {
    req.destroy();
    throw error;
  }
}

export async function wire(origin: string, path: string, options?: WireOptions): Promise<WireResponse> {
  const call = openWire(origin, path, options);
  try { return await call.reply; }
  finally { call.abort(); }
}

export function jsonBody(response: WireResponse): unknown {
  return JSON.parse(response.body.toString('utf8'));
}

export function fields(response: WireResponse, name: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < response.headers.length; i += 2) {
    if (response.headers[i]?.toLowerCase() === name) result.push(response.headers[i + 1] ?? '');
  }
  return result;
}
