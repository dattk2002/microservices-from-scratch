import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

export function latch() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

export async function within<T>(promise: Promise<T>, label: string, ms = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

export async function service(t: TestContext, name: 'worker' | 'gateway', env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--v8-pool-size=1', fileURLToPath(new URL(`../${name}.mts`, import.meta.url))], {
    env: { PATH: process.env.PATH ?? '', PORT: '0', UV_THREADPOOL_SIZE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let resolveExit: (value: { code: number | null; signal: string | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    resolveExit = resolve;
  });
  // Register child cleanup before opening the line reader or starting another peer.
  t.after(async () => {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1000);
    try { await within(exited, `${name} cleanup`); } finally { clearTimeout(force); }
  });
  let stderr = '';
  child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8192); });
  const firstWork = latch();
  let starts = 0;
  let finishes = 0;
  let finishesAtExit: number | undefined;
  // Child close follows EOF on its stdout. Snapshot the finish log count at
  // that boundary, with no assumption about when the HTTP/1 caller reads.
  child.once('close', (code, signal) => {
    finishesAtExit = finishes;
    resolveExit({ code, signal });
  });
  const lines = createInterface({ input: child.stdout });
  t.after(() => lines.close());
  const port = await within(new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    void exited.then(() => reject(new Error(`${name} exited before ready: ${stderr}`)));
    lines.on('line', (line) => {
      const event: unknown = JSON.parse(line);
      if (typeof event !== 'object' || event === null) return;
      if ('port' in event && typeof event.port === 'number') resolve(event.port);
      if ('event' in event) {
        if (event.event === 'work-started') {
          starts++;
          firstWork.open();
        } else if (event.event === 'work-finished') {
          finishes++;
        }
      }
    });
  }), `${name} readiness`);
  return { child, exited, port, firstWork: firstWork.promise, workStarts: () => starts, workFinishesAtExit: () => finishesAtExit };
}

export function httpCall(port: number, {
  path = '/work', method = 'GET', headers, body, signal,
}: { path?: string; method?: string; headers?: Record<string, string | string[]>; body?: string; signal?: AbortSignal } = {}) {
  return new Promise<{ status: number | undefined; type: string | undefined; allow: string | undefined; body: unknown }>((resolve, reject) => {
    const deadline = performance.now() + 2000;
    const total = AbortSignal.timeout(2000);
    const req = request({
      host: '127.0.0.1', port, path, method, headers, agent: false, maxHeaderSize: 8192,
      signal: signal ? AbortSignal.any([total, signal]) : total,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8192) req.destroy(new Error('HTTP/1 fixture response too large'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.once('end', () => {
        try {
          const fields = res.headersDistinct;
          assert.ok(res.complete && performance.now() < deadline);
          for (const key of ['content-type', 'content-length', 'content-encoding', 'transfer-encoding', 'allow']) {
            assert.ok((fields[key]?.length ?? 0) <= 1);
          }
          assert.equal(fields['content-encoding'], undefined);
          assert.equal(fields['transfer-encoding'], undefined);
          const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const value: unknown = text === '' ? undefined : JSON.parse(text);
          resolve({ status: res.statusCode, type: fields['content-type']?.[0], allow: fields.allow?.[0], body: value });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.maxHeadersCount = 0;
    req.on('error', reject);
    req.end(body);
  });
}
