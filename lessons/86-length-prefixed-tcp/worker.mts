import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { numberSetting } from '../../lib/http.mts';
import { encodeFrame } from './framing.mts';
import { runListener } from './listener.mts';
import { parseJson, requestText } from './protocol.mts';
import { exchangeFrame } from './rpc.mts';

async function main(): Promise<void> {
  const port = numberSetting('PORT', 3086, 0, 65535);
  const active = new Set<Socket>();
  const server = createServer({allowHalfOpen: true}, (socket) => {
    const startedAt = performance.now();
    if (active.size >= 8) {
      socket.on('error', () => {});
      socket.destroy();
      return;
    }

    active.add(socket);
    const done = exchangeFrame(socket, startedAt, (payload) => {
      const text = requestText(parseJson(payload));
      return encodeFrame(Buffer.from(JSON.stringify({echo: text})));
    });
    void done.catch(() => {
      // An invalid request has no error reply in the TCP protocol.
    }).finally(() => active.delete(socket));
  });
  await runListener(server, 'worker', port, () => {
    for (const socket of active) socket.destroy();
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
