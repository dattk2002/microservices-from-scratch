import { serve, json, readJson, HttpError, numberSetting } from '../../lib/http.mts';
import { Queue, object, identity } from './store.mts';
export async function main() {
  const lease = numberSetting('LEASE_MS', 3000, 20, 10000);
  const capacity = numberSetting('CAPACITY', 100, 1, 100);
  const q = new Queue(process.env.DB_PATH ?? 'queue.sqlite', Date.now, capacity, lease);
  try {
    const server = await serve('queue-owner', 3026, async (req, res) => {
      const path = req.url ?? '';
      if (req.method === 'GET' && path === '/dead') return json(res, 200, { messages: q.list() });
      if (req.method === 'GET' && path.startsWith('/messages/')) return json(res, 200, q.get(identity(path.slice(10))));
      if (req.method !== 'POST') throw new HttpError(404, 'route', 'Unknown route');
      const p = object(await readJson(req));
      if (path === '/messages') { q.admit(identity(p.id), p.payload); return json(res, 202, q.get(identity(p.id))); }
      if (path === '/claim') return json(res, 200, { message: q.claim() ?? null });
      if (path === '/finish') {
        const id = identity(p.id);
        if (typeof p.token !== 'string' || p.token.length > 64 || !['ok', 'poison', 'transient'].includes(String(p.outcome))) throw new HttpError(400, 'input', 'Invalid finish');
        if (!q.finish(id, p.token, String(p.outcome))) throw new HttpError(409, 'stale', 'Claim no longer valid');
        return json(res, 200, q.get(id));
      }
      if (path === '/redrive') {
        const id = identity(p.id);
        if (!Number.isSafeInteger(p.expectedRedrives) || typeof p.expectedRedrives !== 'number' || p.expectedRedrives < 0 || p.expectedRedrives > 2) throw new HttpError(400, 'input', 'Invalid redrive version');
        if (!q.redrive(id, p.expectedRedrives)) throw new HttpError(409, 'redrive_rejected', 'Requires dead state, current version and remaining budget');
        return json(res, 200, q.get(id));
      }
      throw new HttpError(404, 'route', 'Unknown route');
    });
    server.once('close', () => q.close()); return server;
  } catch (e) { q.close(); throw e; }
}
if (import.meta.main) await main();
