import { configuredSocket, failure, json, runDirectly, serve } from './http.mts';
import { readValue } from './upstream.mts';

async function main(): Promise<void> {
  const socketPath = configuredSocket();
  const rawPort = process.env.PORT ?? '8093';
  const port = Number(rawPort);
  if (!/^[0-9]+$/.test(rawPort) || port > 65535) throw new Error('PORT must be an integer from 0 to 65535');

  let active = 0;
  await serve({ port, host: '127.0.0.1' }, ['/health', '/value'], async (path, res, signal) => {
    if (path === '/health') return json(res, 200, { ok: true });
    if (active >= 8) return failure(res, 503, 'busy');
    active++;
    try {
      const value = await readValue(socketPath, signal);
      if (!signal.aborted) json(res, 200, value);
    } catch {
      if (!signal.aborted && !res.destroyed) failure(res, 502, 'upstream_failure');
    } finally {
      active--;
    }
  });
}

runDirectly(import.meta.url, main);
