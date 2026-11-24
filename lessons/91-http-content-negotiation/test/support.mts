import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import type { IncomingMessage, RequestListener } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';

export async function start(t: TestContext, name: 'provider' | 'gateway', env: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'lesson-91-'));
  let stop = async () => {};
  t.after(async () => {
    try { await stop(); }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });

  const child = spawn(process.execPath, ['--v8-pool-size=1', fileURLToPath(new URL(`../${name}.mts`, import.meta.url))], {
    cwd,
    env: { PATH: process.env.PATH ?? '', PORT: '0', UV_THREADPOOL_SIZE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  stop = async () => {
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 750);
    try { await closed; }
    finally { clearTimeout(kill); }
  };

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  let output = '';
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Startup timed out: ${stderr}`)), 4000);
      const onExit = () => finish(new Error(`Service exited: ${stderr}`));
      function finish(error: Error | undefined, port = 0) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.off('exit', onExit);
        if (error) reject(error);
        else resolve(port);
      }
      function onData(chunk: Buffer) {
        output += chunk.toString();
        if (output.length > 8192) return finish(new Error('Excessive readiness output'));
        const lineEnd = output.indexOf('\n');
        if (lineEnd === -1) return;
        try {
          const value: unknown = JSON.parse(output.slice(0, lineEnd));
          if (typeof value !== 'object' || value === null || !('port' in value) ||
              typeof value.port !== 'number' || !Number.isInteger(value.port) ||
              value.port < 1 || value.port > 65535) throw new Error('Invalid readiness port');
          finish(undefined, value.port);
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Invalid readiness output'));
        }
      }
      child.once('error', finish);
      child.once('exit', onExit);
      child.stdout.on('data', onData);
    });
    return { origin: `http://127.0.0.1:${port}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function listen(t: TestContext, handle: RequestListener): Promise<string> {
  const server = createServer({ maxHeaderSize: 8192 }, handle);
  server.maxHeadersCount = 0;
  server.setTimeout(3000);
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 3000);
    server.once('error', error => { clearTimeout(timer); reject(error); });
    server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected fixture socket');
  return `http://127.0.0.1:${address.port}`;
}

type Reply = { status: number; headers: IncomingMessage['headers']; body: Buffer };

export function exchange(
  origin: string, path: string, headers: Record<string, string | string[]> | string[] = {}, method = 'GET',
): Promise<Reply> {
  const expiresAt = performance.now() + 2500;
  return new Promise((resolve, reject) => {
    const req = request(new URL(origin), {
      path, headers, method, agent: false, maxHeaderSize: 8192, signal: AbortSignal.timeout(2500),
    }, async res => {
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of res) {
          if (!Buffer.isBuffer(chunk)) throw new Error('Expected response bytes');
          size += chunk.length;
          if (size > 8192) throw new Error('Client response exceeds test limit');
          chunks.push(chunk);
        }
        if (!res.complete || performance.now() >= expiresAt) throw new Error('Client response incomplete or late');
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks, size) });
      } catch (error) {
        req.destroy();
        reject(error);
      }
    });
    req.maxHeadersCount = 0;
    req.on('error', reject);
    req.end();
  });
}
