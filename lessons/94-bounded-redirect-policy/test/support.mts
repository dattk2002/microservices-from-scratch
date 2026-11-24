import { spawn } from 'node:child_process';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { TestContext } from 'node:test';

export async function boot(t: TestContext, entry: string, env: Record<string, string> = {}): Promise<string> {
  const child = spawn(process.execPath, [new URL('../' + entry + '.mts', import.meta.url).pathname], {
    env: {...process.env, ...env, PORT: '0'},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); });
  let outputFailure: Error | undefined;
  let ready = false;
  let totalOutputBytes = 0;
  t.after(async () => {
    child.kill('SIGTERM');
    const guard = setTimeout(() => child.kill('SIGKILL'), 750);
    try { await closed; }
    finally { clearTimeout(guard); }
    if (outputFailure) throw outputFailure;
  });

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Startup timeout in ${entry}: ${stderr}`)), 3000);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.on('error', fail);
    child.once('close', code => fail(new Error(`${entry} exited (${code}): ${stderr}`)));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
    });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (outputFailure) return;
      totalOutputBytes += Buffer.byteLength(chunk);
      if (totalOutputBytes > 8192) {
        outputFailure = new Error('Excessive child output, including after readiness');
        fail(outputFailure);
        child.kill('SIGKILL');
        return;
      }
      if (ready) return;
      stdout += chunk;
      const end = stdout.indexOf('\n');
      if (end === -1) return;
      try {
        const message: unknown = JSON.parse(stdout.slice(0, end));
        if (message === null || typeof message !== 'object' || Array.isArray(message)
          || !('service' in message) || message.service !== entry || !('port' in message)
          || typeof message.port !== 'number' || !Number.isInteger(message.port)
          || message.port < 1 || message.port > 65535) throw new Error('Invalid startup output');
        clearTimeout(timer);
        ready = true;
        resolve('http://127.0.0.1:' + message.port);
      } catch (error) {
        fail(error instanceof Error ? error : new Error('Invalid startup output'));
      }
    });
  });
}

type Options = { method?: string; headers?: string[]; body?: string; signal?: AbortSignal };
type Reply = { status: number | undefined; headers: IncomingHttpHeaders; text: string };

export function wire(origin: string, path: string, options: Options = {}): Promise<Reply> {
  const deadline = AbortSignal.timeout(2500);
  const signal = options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  return new Promise((resolve, reject) => {
    const target = new URL(origin);
    const call = request(target, {
      path, method: options.method ?? 'GET', agent: false, signal, maxHeaderSize: 8192,
      headers: ['Host', target.host, ...(options.headers ?? [])],
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('error', reject);
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 8192) chunks.push(chunk);
        else call.destroy(new Error('Oversized gateway response'));
      });
      response.once('end', () => {
        if (!response.complete) return reject(new Error('Incomplete gateway response'));
        resolve({status: response.statusCode, headers: response.headers,
          text: new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks))});
      });
    });
    call.once('error', reject);
    call.end(options.body);
  });
}
