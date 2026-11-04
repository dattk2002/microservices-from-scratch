import { performance } from 'node:perf_hooks';
import { serve, json, readJson, numberSetting, HttpError } from '../../lib/http.mts';
import { Registry, identifier, localUrl, leaseValue } from './model.mts';
import { object, loopbackHost } from './transport.mts';
export async function main(): Promise<void> {
  loopbackHost();
  const registry = new Registry(() => performance.now(), numberSetting('CAPACITY', 16, 1, 256));
  await serve('registry', 4300, async (req,res) => {
    if (req.method === 'GET' && req.url === '/services/catalog') {
      json(res, 200, {members: registry.list().map(({id,url}) => ({id,url}))}); return;
    }
    if (req.method === 'POST' && req.url === '/registrations') {
      const b = object(await readJson(req));
      json(res, 201, registry.register(identifier(b.id), localUrl(b.url), leaseValue(b.lease))); return;
    }
    if (req.method === 'POST' && (req.url === '/renew' || req.url === '/remove')) {
      const b = object(await readJson(req));
      if (typeof b.owner !== 'string') throw new HttpError(400, 'owner_required', 'Expected owner');
      if (req.url === '/renew') registry.renew(identifier(b.id), b.owner, leaseValue(b.lease));
      else registry.remove(identifier(b.id), b.owner);
      json(res, 200, {ok:true}); return;
    }
    throw new HttpError(404, 'not_found', 'Unknown route');
  });
}
if (import.meta.main) await main();
