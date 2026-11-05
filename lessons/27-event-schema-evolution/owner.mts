import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { History } from './store.mts';
export async function main() {
 const db = new History(process.env.DB_PATH ?? 'owner.sqlite');
 try {
 const server = await serve('schema-owner', 3027, async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'GET' && u.pathname === '/events') {
   const raw = u.searchParams.get('after') ?? '0';
   if (!/^\d{1,10}$/.test(raw) || Number(raw) > 1000000000) throw new HttpError(400, 'cursor', 'Invalid cursor');
   return json(res, 200, db.page(Number(raw)));
  }
  if (req.method === 'POST' && (u.pathname === '/events' || (u.pathname === '/teaching/raw' && process.env.TEACHING_CONTROLS === '1'))) {
   return json(res, 201, db.append(await readJson(req), u.pathname === '/teaching/raw'));
  }
  throw new HttpError(404, 'route', 'Unknown route');
 });
 server.once('close', () => db.close());
 } catch (e) { db.close(); throw e; }
}
if (import.meta.main) await main();
