import { DatabaseSync } from 'node:sqlite';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { documents, key, member, minimum, record, tuple, users } from './contract.mts';
export class Policy {
 readonly db: DatabaseSync;
 constructor(path: string) {
  this.db = new DatabaseSync(path);
  this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL); INSERT OR IGNORE INTO meta VALUES(1,0); CREATE TABLE IF NOT EXISTS tuples (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
 }
 state() {
  const row = this.db.prepare('SELECT revision FROM meta WHERE id=1').get();
  const revision = Number(row?.revision);
  const tuples = this.db.prepare('SELECT value FROM tuples ORDER BY key COLLATE BINARY').all().map(r => tuple(JSON.parse(String(r.value))));
  return {revision,tuples};
 }
 mutate(operation: unknown, input: unknown) {
  const op = member(operation,['add','remove']); const t = tuple(input); const k = key(t);
  this.db.exec('BEGIN IMMEDIATE');
  try {
   const s = this.state(); const exists = s.tuples.some(x => key(x) === k);
   const changed = op === 'add' ? !exists : exists;
   if (changed && (s.revision === 64 || (op === 'add' && s.tuples.length === 32))) throw new HttpError(409,'limit','Policy limit');
   if (changed) {
    if (op === 'add') this.db.prepare('INSERT INTO tuples VALUES(?,?)').run(k,JSON.stringify(t));
    else this.db.prepare('DELETE FROM tuples WHERE key=?').run(k);
    this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
   }
   this.db.exec('COMMIT'); return {changed,revision:s.revision + Number(changed)};
  } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 check(user: unknown, document: unknown, permission: unknown, min: unknown = 0) {
  const u = member(user,users), d = member(document,documents), p = member(permission,['view','edit']), m = minimum(min);
  this.db.exec('BEGIN');
  try {
   const s = this.state();
   if (m > s.revision) throw new HttpError(409,'future_revision','Minimum revision unavailable');
   const reaches = (group: string, seen: Set<string>): boolean => {
    if (seen.has(group)) return false;
    const next = new Set(seen); next.add(group);
    return s.tuples.some(t => t.objectType === 'group' && t.object === group &&
     (t.subjectType === 'user' ? t.subject === u : reaches(t.subject,next)));
   };
   const allowed = s.tuples.some(t => t.objectType === 'document' && t.object === d &&
    (t.relation === 'editor' || p === 'view') && (t.subjectType === 'user' ? t.subject === u : reaches(t.subject,new Set())));
   this.db.exec('COMMIT'); return {allowed,revision:s.revision};
  } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 close() { this.db.close(); }
}
export async function main() {
 const policy = new Policy(process.env.DB_PATH ?? 'policy.sqlite');
 try {
 const server = await serve('policy',5252,async(req,res) => {
  if (req.method === 'GET' && req.url === '/state') { json(res,200,policy.state()); return; }
  if (req.method !== 'POST' || !['/tuples','/check'].includes(req.url ?? '')) throw new HttpError(404,'not_found','Unknown route');
  const b = record(await readJson(req));
  json(res,200,req.url === '/tuples' ? policy.mutate(b.operation,b.tuple) : policy.check(b.user,b.document,b.permission,b.minRevision));
 });
 server.once('close',() => policy.close());
 } catch(e) { policy.close(); throw e; }
}
if (import.meta.main) await main();
