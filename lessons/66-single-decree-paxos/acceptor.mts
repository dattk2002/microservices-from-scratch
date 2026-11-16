import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { AcceptorStore } from './store.mts';
import { fail, request } from './protocol.mts';

export async function main() {
  const id = process.env.REPLICA_ID;
  if (id !== 'a' && id !== 'b' && id !== 'c') throw new Error('REPLICA_ID must be a, b or c');
  const path = process.env.DB_PATH;
  if (!path || path === ':memory:') throw new Error('Private durable DB_PATH required');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    const store = new AcceptorStore(db, id);
    const server = await serve(`paxos-${id}`, 3068, async (req, res) => {
      if (req.method === 'GET' && req.url === '/state') return json(res, 200, store.state());
      if (req.method === 'POST' && (req.url === '/prepare' || req.url === '/accept')) {
        let raw: unknown;
        try { raw = await readJson(req); }
        catch (error) { if (error instanceof HttpError) fail(400, 'invalid_body'); throw error; }
        if (req.url === '/prepare') return json(res, 200, store.prepare(request(raw, false).ballot));
        const body = request(raw, true); return json(res, 200, store.accept(body.ballot, body.value));
      }
      fail(404, 'not_found');
    });
    server.once('close', () => db.close()); return server;
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) await main();
