import { json } from '../../lib/http.mts';
import { fail, storeOrigin } from './contract.mts';
import { runningDirectly, serveProfile } from './http.mts';
import { requestProfile } from './request-once.mts';

async function main(): Promise<void> {
  const origin = storeOrigin(process.env.STORE_ORIGIN ?? 'http://127.0.0.1:3089');
  let active = 0;
  await serveProfile('gateway', 4089, async (call, res, signal) => {
    if (active >= 8) fail(503, 'busy');
    active++;
    let reply: Awaited<ReturnType<typeof requestProfile>>;
    try {
      reply = await requestProfile(origin, call, signal);
    } catch {
      fail(502, 'upstream_failure');
    } finally {
      active--;
    }
    if (reply.etag !== undefined) res.setHeader('etag', reply.etag);
    json(res, reply.status, reply.body);
  });
}

if (runningDirectly(import.meta.url)) await main();
