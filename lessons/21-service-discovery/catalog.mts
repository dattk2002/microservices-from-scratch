import { serve, json, numberSetting, HttpError } from '../../lib/http.mts';
import { identifier, localUrl } from './model.mts';
import { request, object, loopbackHost } from './transport.mts';
export async function main(): Promise<void> {
  loopbackHost();
  const id = identifier(process.env.INSTANCE_ID ?? 'catalog-a');
  const registry = localUrl(process.env.REGISTRY_URL ?? 'http://127.0.0.1:4300');
  const lease = numberSetting('LEASE_MS', 3000, 1000, 5000);
  const server = await serve('catalog', 4301, (req,res) => {
    if (req.method !== 'GET' || req.url !== '/product') throw new HttpError(404, 'not_found', 'Unknown route');
    json(res, 200, {instance:id, product:'tra-sen', price:42000});
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('TCP expected');
  let owner = '';
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const response = await request(`${registry}/renew`, 'POST', {id, owner, lease});
      if (!response.ok) throw new Error('Lease lost');
      if (!stopped) timer = setTimeout(() => { void renew(); }, Math.floor(lease / 3));
    } catch {
      // Fail closed; no uncertain write is replayed. Restart creates a fresh incarnation.
      stopped = true; server.close(); server.closeAllConnections(); process.exitCode = 1;
    }
  };
  const shutdown = (): void => {
    stopped = true; clearTimeout(timer);
    if (owner) void request(`${registry}/remove`, 'POST', {id,owner}).catch(() => {});
  };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  try {
    const response = await request(`${registry}/registrations`, 'POST', {id, url:`http://127.0.0.1:${address.port}`, lease});
    if (response.status !== 201) throw new Error('Registration rejected');
    const body = object(await response.json());
    if (typeof body.owner !== 'string') throw new Error('Invalid owner');
    owner = body.owner;
    if (!stopped) timer = setTimeout(() => { void renew(); }, Math.floor(lease / 3));
    else shutdown();
  } catch (error) { shutdown(); server.close(); server.closeAllConnections(); throw error; }
}
if (import.meta.main) await main();
