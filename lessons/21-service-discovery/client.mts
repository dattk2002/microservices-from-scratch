import { serve, json, HttpError } from '../../lib/http.mts';
import { RoundRobin, identifier, localUrl } from './model.mts';
import type { Member } from './model.mts';
import { request, object, loopbackHost } from './transport.mts';
export async function main(): Promise<void> {
  loopbackHost();
  const registry = localUrl(process.env.REGISTRY_URL ?? 'http://127.0.0.1:4300');
  const rr = new RoundRobin();
  await serve('client', 4303, async (req,res) => {
    if (req.method !== 'GET' || req.url !== '/product') throw new HttpError(404, 'not_found', 'Unknown route');
    try {
      const discovery = await request(`${registry}/services/catalog`);
      if (!discovery.ok) throw new Error('Registry unavailable');
      const body = object(await discovery.json());
      if (!Array.isArray(body.members) || body.members.length > 256) throw new Error('Invalid members');
      const members: Member[] = body.members.map((value: unknown) => {
        const m = object(value); return {id:identifier(m.id), url:localUrl(m.url), owner:'', expires:0};
      });
      const member = rr.next(members);
      if (!member) throw new Error('No instances');
      const upstream = await request(`${member.url}/product`);
      if (!upstream.ok) throw new Error('Instance failed');
      json(res, 200, await upstream.json());
    } catch { throw new HttpError(503, 'discovery_unavailable', 'No usable Catalog response'); }
  });
}
if (import.meta.main) await main();
