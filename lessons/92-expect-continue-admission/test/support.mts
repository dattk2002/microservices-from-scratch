import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import {createConnection, createServer} from 'node:net';
import type {Socket} from 'node:net';
import {performance} from 'node:perf_hooks';
import type {TestContext} from 'node:test';
import {fileURLToPath} from 'node:url';
import {record} from '../core.mts';

const receiver = fileURLToPath(new URL('../receiver.mts', import.meta.url));
const uploader = fileURLToPath(new URL('../uploader.mts', import.meta.url));
const baseEnv = {UV_THREADPOOL_SIZE: '1'};

export async function startReceiver(t: TestContext): Promise<number> {
  const child = spawn(process.execPath, ['--v8-pool-size=1', receiver], {
    env: {...baseEnv, PORT: '0'}, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false;
  const closed = new Promise<void>(resolve => child.once('close', () => {
    exited = true;
    resolve();
  }));
  t.after(async () => {
    if (!exited) child.kill('SIGKILL');
    await closed;
  });

  let output = '';
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Receiver startup timeout: ${stderr}`)), 4000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', () => { clearTimeout(timer); reject(new Error(`Receiver exited: ${stderr}`)); });
    child.stdout.on('data', (chunk: Buffer) => {
      if (output.includes('\n')) return;
      output += chunk.toString();
      if (output.length > 8192) {
        clearTimeout(timer);
        reject(new Error('Receiver readiness output exceeded bound'));
        return;
      }
      const line = output.split('\n')[0];
      if (!output.includes('\n') || line === undefined) return;
      clearTimeout(timer);
      try {
        const value: unknown = JSON.parse(line);
        assert.ok(record(value) && typeof value.port === 'number' && Number.isInteger(value.port));
        assert.ok(value.port > 0 && value.port <= 65535);
        resolve(value.port);
      } catch (error) {
        reject(error);
      }
    });
  });
}

export function runUploader(port: number, payload = 'hello') {
  return new Promise<{code: number; body: unknown}>((resolve, reject) => {
    execFile(process.execPath, ['--v8-pool-size=1', uploader], {
      env: {...baseEnv, RECEIVER_ORIGIN: `http://127.0.0.1:${port}`, PAYLOAD: payload},
      timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 8192,
    }, (error, stdout, stderr) => {
      try {
        assert.equal(stderr, '');
        assert.ok(!error || error.code === 1, error?.message);
        assert.equal(stdout.trim().split('\n').length, 1);
        const body: unknown = JSON.parse(stdout);
        resolve({code: error ? 1 : 0, body});
      } catch (failure) {
        reject(failure);
      }
    });
  });
}

export const uploadHeaders = (length: number, expect = '100-continue') =>
  'POST /upload HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n'
  + `Content-Type: application/octet-stream\r\nContent-Length: ${length}\r\n`
  + (expect ? `Expect: ${expect}\r\n` : '') + '\r\n';

export function rawExchange(t: TestContext, port: number, headers: string, onContinue?: (socket: Socket) => void) {
  const socket = createConnection({host: '127.0.0.1', port});
  t.after(() => socket.destroy());
  let wire = '';
  let continues = 0;
  let notifyContinue: () => void = () => {};
  const continued = new Promise<void>(resolve => { notifyContinue = resolve; });
  const closed = new Promise<{wire: string; continues: number}>((resolve, reject) => {
    const timer = setTimeout(() => socket.destroy(new Error('Raw exchange deadline')), 2000);
    socket.on('error', reject);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve({wire, continues});
    });
    socket.on('data', (chunk: Buffer) => {
      if (wire.length + chunk.length > 16384) {
        socket.destroy(new Error('Raw response exceeded bound'));
        return;
      }
      wire += chunk.toString('latin1');
      const count = wire.match(/HTTP\/1\.1 100 Continue\r\n\r\n/g)?.length ?? 0;
      if (count > continues && continues === 0) {
        notifyContinue();
        onContinue?.(socket);
      }
      continues = count;
    });
    socket.once('connect', () => socket.write(headers, 'latin1'));
  });
  // Cleanup and rejection handling are registered before the caller awaits any other resource.
  void closed.catch(() => {});
  return {socket, closed, async waitContinue() {
    await Promise.race([continued, closed.then(() => { throw new Error('Closed before 100'); })]);
  }};
}

export function finalReply(wire: string) {
  const final = wire.replace(/^(?:HTTP\/1\.1 100 Continue\r\n\r\n)+/, '');
  const split = final.indexOf('\r\n\r\n');
  assert.ok(split > 0, wire);
  const status = Number(/^HTTP\/1\.1 (\d{3}) /u.exec(final)?.[1]);
  const body: unknown = JSON.parse(final.slice(split + 4));
  return {status, body, headers: final.slice(0, split).toLowerCase()};
}

export async function stats(t: TestContext, port: number) {
  const {wire} = await rawExchange(t, port, 'GET /stats HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n').closed;
  const {status, body} = finalReply(wire);
  assert.equal(status, 200);
  assert.ok(record(body));
  return body;
}

export async function waitStats(t: TestContext, port: number, predicate: (value: Record<string, unknown>) => boolean) {
  const deadline = performance.now() + 1000;
  do {
    const value = await stats(t, port);
    if (predicate(value)) return value;
  } while (performance.now() < deadline);
  throw new Error('Stats did not reach the expected state');
}

export function jsonFrame(status: number, body: string, extra = '') {
  return `HTTP/1.1 ${status} Status\r\nContent-Type: application/json; charset=utf-8\r\n`
    + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`;
}

type PeerMode = {initial?: string; afterBody?: string | ((socket: Socket) => void)};

export async function startPeer(t: TestContext) {
  const sockets = new Set<Socket>();
  let nextMode: PeerMode = {};
  let requests = 0;
  let payloadBytes = 0;
  let connections = 0;
  let lastClosed: Promise<void> = Promise.resolve();

  const server = createServer(socket => {
    sockets.add(socket);
    connections++;
    lastClosed = new Promise<void>(resolve => socket.once('close', resolve));
    const timer = setTimeout(() => socket.destroy(), 2000);
    socket.once('close', () => { clearTimeout(timer); sockets.delete(socket); });
    socket.on('error', () => {});
    const mode = nextMode;
    let headers = Buffer.alloc(0);
    let headerDone = false;
    let bodyBytes = 0;
    let expected = 0;
    let replied = false;

    socket.on('data', (chunk: Buffer) => {
      if (!headerDone) {
        if (headers.length + chunk.length > 16384) return socket.destroy();
        headers = Buffer.concat([headers, chunk]);
        const split = headers.indexOf('\r\n\r\n');
        if (split < 0) return;
        expected = Number(/\r\ncontent-length: (\d+)\r\n/i.exec(headers.subarray(0, split + 2).toString('latin1'))?.[1]);
        chunk = headers.subarray(split + 4);
        headerDone = true;
        requests++;
        if (mode.initial) socket.write(mode.initial);
      }
      bodyBytes += chunk.length;
      payloadBytes += chunk.length;
      if (bodyBytes > 16384) return socket.destroy();
      if (!replied && mode.afterBody && bodyBytes >= expected) {
        replied = true;
        if (typeof mode.afterBody === 'string') socket.end(mode.afterBody);
        else mode.afterBody(socket);
      }
    });
    socket.on('end', () => socket.end());
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Peer startup deadline')), 2000);
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.listen(0, '127.0.0.1', () => { clearTimeout(timer); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    port: address.port,
    mode(value: PeerMode) { nextMode = value; },
    counts: () => ({requests, connections, payloadBytes}),
    closed: () => lastClosed,
  };
}
