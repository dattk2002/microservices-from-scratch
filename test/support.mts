import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { ChildProcess } from 'node:child_process';

export type RunningService = { url: string; child: ChildProcess; stop: () => Promise<void> };

export async function startService(entry: URL, env: Record<string, string> = {}): Promise<RunningService> {
  const child = spawn(process.execPath, [fileURLToPath(entry)], {
    env: { PATH: process.env.PATH ?? '', HOST: '127.0.0.1', PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await exited; } finally { clearTimeout(kill); }
  };
  try {
    const port = await new Promise<number>((resolve, reject) => {
      const lines = createInterface({ input: child.stdout! });
      const timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 5000);
      const clean = () => { clearTimeout(timer); lines.close(); child.off('exit', onExit); };
      const onExit = (code: number | null) => { clean(); reject(new Error(`Service exited ${code}: ${stderr}`)); };
      child.once('exit', onExit);
      child.once('error', (error) => { clean(); reject(error); });
      lines.on('line', (line) => {
        try {
          const value = JSON.parse(line) as { port?: unknown };
          if (typeof value.port === 'number' && Number.isInteger(value.port) && value.port > 0) {
            clean(); resolve(value.port);
          }
        } catch { /* Service logs may contain non-readiness lines. */ }
      });
    });
    return { child, url: `http://127.0.0.1:${port}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
}
