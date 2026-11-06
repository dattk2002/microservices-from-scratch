import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { LeaseStore, identity, integer, object } from './state.mts';
import { database, settings } from './runtime.mts';

export async function main() {
  const config = settings();
  const db = database();
  try {
    db.exec('CREATE TABLE IF NOT EXISTS teaching_clock(singleton INTEGER PRIMARY KEY CHECK(singleton=1), offset INTEGER NOT NULL); INSERT OR IGNORE INTO teaching_clock VALUES(1,0)');
    let offset = integer(object(db.prepare('SELECT offset FROM teaching_clock WHERE singleton=1').get()).offset, 0, 1000000000);
    if (!config.teaching && offset !== 0) throw new Error('Teaching-clock database cannot be used in normal mode');
    const store = new LeaseStore(db, () => Date.now() + offset);
    const server = await serve('lease-coordinator', 3331, async (req, res) => {
      if (req.method !== 'POST') throw new HttpError(405, 'method', 'Use POST');
      if (req.url === '/teaching/advance') {
        if (!config.teaching) throw new HttpError(404, 'not_found', 'Teaching controls disabled');
        const input = object(await readJson(req));
        const delta = integer(input.ms, 1, 60000);
        const next = integer(offset + delta, 0, 1000000000);
        db.prepare('UPDATE teaching_clock SET offset=? WHERE singleton=1').run(next);
        offset = next;
        json(res, 200, {offset}); return;
      }
      if (req.url !== '/acquire' && req.url !== '/renew' && req.url !== '/release') throw new HttpError(404, 'not_found', 'Unknown command');
      const input = object(await readJson(req));
      const holder = identity(input.holder);
      if (req.url === '/release') {
        if (!store.release(holder, integer(input.generation, 1))) throw new HttpError(409, 'not_current', 'Lease no longer current');
        json(res, 200, {released: true}); return;
      }
      const ttl = integer(input.ttl, 1, 10000);
      const result = req.url === '/acquire' ? store.acquire(holder, ttl) : store.renew(holder, integer(input.generation, 1), ttl);
      if (!result) throw new HttpError(409, 'not_current', 'Lease busy or expired');
      json(res, 200, result);
    });
    server.maxConnections = 32;
    server.keepAliveTimeout = 1000;
    server.once('close', () => db.close());
    return server;
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) await main();
