import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

type Cleanup = () => void | Promise<void>;

export function cleanupStack(t: TestContext): Cleanup[] {
  const stack: Cleanup[] = [];
  t.after(async () => {
    const failures: unknown[] = [];
    for (const cleanup of stack.reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'fixture cleanup failed');
  });
  return stack;
}

export async function privateDir(stack: Cleanup[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'uds93-'));
  stack.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function start(stack: Cleanup[], service: 'provider' | 'gateway', dir: string) {
  const script = fileURLToPath(new URL(`../${service}.mts`, import.meta.url));
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, SOCKET_DIR: dir, PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const closed = new Promise<number | null>(resolve => child.once('close', resolve));
  async function stop(): Promise<void> {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 1000);
    try {
      await deadline(closed, 2500);
    } finally {
      clearTimeout(force);
    }
  }
  stack.push(stop);
  const ready = new Promise<unknown>((resolve, reject) => {
    let line = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${service} readiness timeout`));
    }, 3000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      reject(new Error(`${service} closed before readiness (${code})`));
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      line += chunk;
      if (line.length > 1024) {
        clearTimeout(timer);
        reject(new Error('excess readiness output'));
        child.kill('SIGKILL');
      } else if (line.includes('\n')) {
        clearTimeout(timer);
        child.stdout.removeAllListeners('data');
        child.stdout.resume();
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      }
    });
  });
  return { ready, stop, closed: () => deadline(closed, 3500) };
}

export async function deadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('fixture deadline')), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
