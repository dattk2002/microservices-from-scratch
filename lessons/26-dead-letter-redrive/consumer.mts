import { DatabaseSync } from 'node:sqlite';
import { serve, json, readJson, HttpError } from '../../lib/http.mts';
import { object, payload } from './store.mts';
function endpoint(name: string): string {
  const u = new URL(process.env[name] ?? '');
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error(`Invalid ${name}`);
  return u.origin;
}
async function post(base: string, path: string, value: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), signal: AbortSignal.timeout(1000) });
  if (!r.ok) throw new Error(`Remote status ${r.status}`);
  return object(await r.json());
}
export async function main() {
  const owner = endpoint('OWNER_URL'); const sink = endpoint('SINK_URL');
  const db = new DatabaseSync(process.env.DB_PATH ?? 'consumer.sqlite');
  db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS local(singleton INTEGER PRIMARY KEY CHECK(singleton=1),fixed INTEGER NOT NULL,steps INTEGER NOT NULL); INSERT OR IGNORE INTO local VALUES(1,0,0)`);
  let busy = false;
  try {
    const server = await serve('consumer', 3027, async (req, res) => {
      if (req.method !== 'POST') throw new HttpError(404, 'route', 'Unknown route');
      const p = object(await readJson(req));
      if (Object.keys(p).length) throw new HttpError(400, 'input', 'Expected empty object');
      if (req.url === '/teaching/fix' && process.env.TEACHING_CONTROLS === '1') {
        db.prepare('UPDATE local SET fixed=1 WHERE singleton=1').run(); return json(res, 200, { fixed: true });
      }
      if (req.url !== '/step') throw new HttpError(404, 'route', 'Unknown route');
      if (busy) throw new HttpError(429, 'busy', 'One active step per consumer');
      busy = true;
      try {
        const reply = await post(owner, '/claim', {});
        if (reply.message === null) return json(res, 200, { idle: true });
        const m = object(reply.message);
        if (typeof m.payload !== 'string' || typeof m.id !== 'string' || typeof m.token !== 'string') throw new Error('Invalid claim');
        const data: unknown = JSON.parse(m.payload); payload(data); const value = object(data);
        const fixed = db.prepare('SELECT fixed FROM local WHERE singleton=1').get()?.fixed === 1;
        let outcome = 'ok';
        if (value.format === 'legacy' && !fixed) outcome = 'poison';
        else if (value.format === 'transient' && !fixed) outcome = 'transient';
        else {
          try { await post(sink, '/apply', { id: m.id, payload: data }); }
          catch { outcome = 'transient'; } // Unknown delivery outcome: retry same operation identity.
        }
        db.prepare('UPDATE local SET steps=steps+1 WHERE singleton=1').run();
        const result = await post(owner, '/finish', { id: m.id, token: m.token, outcome });
        return json(res, 200, result);
      } finally { busy = false; }
    });
    server.once('close', () => db.close()); return server;
  } catch (e) { db.close(); throw e; }
}
if (import.meta.main) await main();
