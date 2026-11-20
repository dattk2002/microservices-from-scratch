import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

export const storeEntry = new URL('../store.mts', import.meta.url);
export const gatewayEntry = new URL('../gateway.mts', import.meta.url);
export const peerEntry = new URL('./peer-fixture.mts', import.meta.url);

export async function withDb<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'lesson-89-'));
  try { return await run(join(dir, 'profile.sqlite')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

export async function withService<T>(
  entry: URL, env: Record<string, string>, run: (service: RunningService) => Promise<T>,
): Promise<T> {
  const service = await startService(entry, env);
  try { return await run(service); }
  finally { await service.stop(); }
}

type Input = {
  method?: string;
  path?: string;
  fields?: string[];
  body?: string | Buffer;
  signal?: AbortSignal;
  pauseBody?: boolean;
  chunked?: boolean;
  allowEmptyResponse?: boolean;
};

export async function wire(origin: string, options: Input = {}) {
  const { method = 'GET', path = '/profile', fields = [], body, pauseBody = false, chunked = false } = options;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  const headers = ['host', new URL(origin).host, 'connection', 'close', ...fields];
  if (body !== undefined && !chunked) headers.push('content-length', String(Buffer.byteLength(body)));
  if (chunked) headers.push('transfer-encoding', 'chunked');
  const { req, res } = await new Promise<{ req: ClientRequest; res: IncomingMessage }>((resolve, reject) => {
    const req = request(origin, { method, path, headers, agent: false, signal }, res => {
      res.on('error', () => {});
      resolve({ req, res });
    });
    const failed = (error: unknown) => { req.destroy(); reject(error); };
    req.on('error', failed);
    req.once('close', () => reject(new Error('Connection closed before response headers')));
    try {
      if (pauseBody) req.flushHeaders();
      else if (chunked && body !== undefined) {
        req.write(body.slice(0, 4000));
        req.end(body.slice(4000));
      } else req.end(body);
    } catch (error) {
      failed(error);
    }
  });
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of res) {
      assert.ok(Buffer.isBuffer(chunk));
      size += chunk.length;
      assert.ok(size <= 10_000, 'Fixture expects a bounded response');
      chunks.push(chunk);
    }
    const value: unknown = size === 0 && options.allowEmptyResponse
      ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return { status: res.statusCode, etag: res.headers.etag, allow: res.headers.allow, body: value };
  } finally {
    res.destroy();
    req.destroy();
  }
}

export function patch(origin: string, ifMatch: string, body: string, extraFields: string[] = []) {
  return wire(origin, { method: 'PATCH', fields: ['content-type', 'application/merge-patch+json', 'if-match', ifMatch, ...extraFields], body });
}

export function assertError(reply: Awaited<ReturnType<typeof wire>>, status: number, code: string): void {
  assert.equal(reply.status, status);
  assert.deepEqual(reply.body, { error: { code, message: code } });
  assert.equal(reply.etag, undefined);
}

export function filler(): string[] {
  const fields: string[] = [];
  for (let i = 0; i < 1100; i++) fields.push('x', 'x');
  return fields;
}

export async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = performance.now() + 2000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await delay(10);
  } while (performance.now() < end);
  assert.fail('Fixture did not reach the expected state');
}
