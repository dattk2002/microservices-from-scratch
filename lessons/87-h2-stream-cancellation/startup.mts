import type { Server } from 'node:net';

export async function listenLoopback(
  server: Server,
  service: string,
  port: number,
  abortOwned: () => void,
) {
  function shutdown() {
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
    server.close();
    abortOwned();
  }

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
    console.log(JSON.stringify({ service, port: address.port }));
  } catch (error) {
    shutdown();
    throw error;
  }
}
