import { DatabaseSync } from 'node:sqlite';
import { serve, json, readJson, HttpError } from '../../lib/http.mts';
import { parseConfig, record, integer } from './policy.mts';
import { badInput } from './transport.mts';
export function openControl(path: string) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS config (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)");
  db.prepare('INSERT OR IGNORE INTO config VALUES(1,?)').run(JSON.stringify({version:0, enabled:false, rollout:0, salt:'demo'}));
  const get = () => {
    const row = db.prepare('SELECT payload FROM config WHERE id=1').get();
    if (!row || typeof row.payload !== 'string') throw new Error('corrupt config');
    return parseConfig(JSON.parse(row.payload));
  };
  const publish = (value: unknown) => {
    const input = record(value);
    if (Object.keys(input).sort().join(',') !== 'enabled,expectedVersion,rollout,salt') throw new Error('invalid fields');
    const expected = integer(input.expectedVersion, 0, Number.MAX_SAFE_INTEGER - 1);
    const next = parseConfig({version:expected+1, enabled:input.enabled, rollout:input.rollout, salt:input.salt});
    db.exec('BEGIN IMMEDIATE');
    try {
      if (get().version !== expected) throw new HttpError(409, 'version_conflict', 'Read current version');
      db.prepare('UPDATE config SET payload=? WHERE id=1').run(JSON.stringify(next));
      db.exec('COMMIT'); return next;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return {db, get, publish};
}
export async function main() {
  const store = openControl(process.env.DB_PATH ?? 'flags.sqlite'); let failed = false;
  try {
    const server = await serve('flag-control', 4040, async (req,res) => {
      if (req.url === '/teaching/failure' && req.method === 'POST' && process.env.TEACHING_CONTROLS === '1') {
        const b = record(await readJson(req)); if (typeof b.failed !== 'boolean') badInput(); failed = b.failed; json(res,200,{failed}); return;
      }
      if (req.url === '/config' && req.method === 'GET') { json(res,failed ? 503 : 200,failed ? {error:'outage'} : store.get()); return; }
      if (req.url === '/config' && req.method === 'POST') {
        const value = await readJson(req);
        try { json(res,200,store.publish(value)); } catch(error) { if (error instanceof HttpError) throw error; badInput(); } return;
      }
      json(res,404,{error:'not_found'});
    });
    server.once('close', () => store.db.close());
  } catch(error) { store.db.close(); throw error; }
}
if (import.meta.main) await main();
