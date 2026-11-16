import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { ProposerStore } from './store.mts';
import { Proposer } from './engine.mts';
import { fail, origins, parseBallot, request } from './protocol.mts';

export async function main() {
  const targets = origins(process.env.A_ORIGIN, process.env.B_ORIGIN, process.env.C_ORIGIN);
  const path = process.env.DB_PATH;
  if (!path || path === ':memory:') throw new Error('Private durable DB_PATH required');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    const store = new ProposerStore(db, targets); const proposer = new Proposer(store);
    const server = await serve('paxos-proposer', 3071, async (req, res) => {
      if (req.method === 'POST' && req.url === '/propose') {
        let raw: unknown;
        try { raw = await readJson(req); }
        catch (error) { if (error instanceof HttpError) fail(400, 'invalid_body'); throw error; }
        const body = request(raw, true); return json(res, 200, await proposer.propose(body.ballot, body.value));
      }
      if (req.method === 'GET' && req.url?.startsWith('/attempts/')) {
        const raw = req.url.slice('/attempts/'.length);
        if (!/^(?:[1-9]|1[0-6])$/.test(raw)) fail(400, 'invalid_body');
        return json(res, 200, store.get(parseBallot(Number(raw))));
      }
      fail(404, 'not_found');
    });
    server.once('close', () => db.close()); return server;
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) await main();
