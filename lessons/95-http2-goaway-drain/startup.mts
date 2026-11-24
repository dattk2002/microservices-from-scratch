import type { Server, Socket } from 'node:net';
import { DRAIN_MS } from './core.mts';

export function setting(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if ((raw.length === 0 || /[^0-9]/.test(raw)) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

export function trackSockets(server: Server, idleMs: number) {
  const sockets = new Set<Socket>();
  server.prependListener('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(idleMs, () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  return sockets;
}

export async function serve(
  server: Server,
  service: string,
  port: number,
  begin: (now: number) => void,
  force: () => void,
  drained: () => boolean,
) {
  let closed = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;

  function stop() {
    if (stopping) return;
    stopping = true;
    const now = performance.now();
    timer = setTimeout(force, Math.max(0, now + DRAIN_MS - performance.now()));
    server.close();
    begin(now);
  }

  function dispose() {
    clearTimeout(timer);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
  }

  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    console.log(JSON.stringify({ service, port: address.port }));
    // The listening server can close before outgoing sessions. Keep the force
    // timer armed until those sessions finish, without keeping the process alive.
    server.once('close', () => {
      closed = true;
      if (drained()) dispose();
      else timer?.unref();
    });
    return () => {
      if (closed && drained()) dispose();
    };
  } catch (error) {
    dispose();
    server.close();
    force();
    throw error;
  }
}
