import { serve, json, readJson, HttpError } from '../../lib/http.mts';
import { Sink, object, identity } from './store.mts';
export async function main() {
  const sink = new Sink(process.env.DB_PATH ?? 'sink.sqlite');
  let loseNext = false;
  try {
    const server = await serve('idempotent-sink', 3028, async (req, res) => {
      if (req.method === 'GET' && req.url === '/total') return json(res, 200, { total: sink.total() });
      if (req.method === 'POST' && req.url === '/teaching/lose-next' && process.env.TEACHING_CONTROLS === '1') {
        const p = object(await readJson(req));
        if (Object.keys(p).length) throw new HttpError(400, 'input', 'Expected empty object');
        loseNext = true; return json(res, 200, { armed: true });
      }
      if (req.method === 'POST' && req.url === '/apply') {
        const p = object(await readJson(req));
        const applied = sink.apply(identity(p.id), p.payload);
        if (loseNext) { loseNext = false; res.destroy(); return; }
        return json(res, 200, { applied });
      }
      throw new HttpError(404, 'route', 'Unknown route');
    });
    server.once('close', () => sink.close()); return server;
  } catch (e) { sink.close(); throw e; }
}
if (import.meta.main) await main();
