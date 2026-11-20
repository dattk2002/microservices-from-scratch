import { once } from 'node:events';
import type { Server } from 'node:net';

export async function runListener(
  server: Server, service: string, port: number, destroyConnections: () => void,
): Promise<void> {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    server.close();
    destroyConnections();
  };

  try {
    const listening = once(server, 'listening');
    server.listen(port, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');

    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    const closed = once(server, 'close');
    console.log(JSON.stringify({service, port: address.port}));
    await closed;
  } finally {
    stop();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
