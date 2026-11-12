import { DatabaseSync } from 'node:sqlite';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { object } from './tracker.mts';

export function openBeacon(path: string, identity: string) {
  if(!/^[a-zA-Z0-9_-]{1,40}$/.test(identity)) throw new Error('Invalid REPLICA_ID');
  const db=new DatabaseSync(path);
  try {
    db.exec('BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS beacon (id INTEGER PRIMARY KEY CHECK(id=1), replica TEXT NOT NULL, incarnation INTEGER NOT NULL, sequence INTEGER NOT NULL)');
    const row=db.prepare('SELECT * FROM beacon WHERE id=1').get();
    if(row && row.replica!==identity) throw new Error('REPLICA_ID conflicts with database');
    if(row && (typeof row.incarnation!=='number' || row.incarnation>=8)) throw new Error('Incarnation exhausted');
    if(row) db.prepare('UPDATE beacon SET incarnation=incarnation+1, sequence=0 WHERE id=1').run();
    else db.prepare('INSERT INTO beacon VALUES (1,?,1,0)').run(identity);
    db.exec('COMMIT');
    return db;
  } catch(error) { try { db.exec('ROLLBACK'); } finally { db.close(); } throw error; }
}
export function heartbeat(db: DatabaseSync, duplicate=false) {
  const row=db.prepare('UPDATE beacon SET sequence=sequence+1 WHERE id=1 AND sequence<32 RETURNING incarnation,sequence');
  const value=duplicate ? db.prepare('SELECT incarnation,sequence FROM beacon WHERE id=1').get():row.get();
  if(!value) throw new HttpError(429,'sequence_exhausted','Sequence exhausted');
  if(value.sequence===0) throw new HttpError(409,'no_heartbeat','No heartbeat yet');
  return value;
}
export async function main() {
  const db=openBeacon(process.env.DB_PATH ?? 'beacon.sqlite',process.env.REPLICA_ID ?? 'beacon');
  let mode='normal';
  try {
    const server=await serve('beacon',5959,async(req,res)=>{
      if(req.url==='/heartbeat' && req.method==='GET') {
        if(mode==='unavailable') throw new HttpError(503,'unavailable','Teaching outage');
        json(res,200,heartbeat(db,mode==='duplicate')); return;
      }
      if(req.url==='/teaching/behavior' && process.env.TEACHING_CONTROLS==='1' && req.method==='POST') {
        const body=await readJson(req);
        if(!object(body,['mode']) || typeof body.mode!=='string' || !['normal','unavailable','duplicate'].includes(body.mode)) throw new HttpError(400,'invalid_body','Invalid mode');
        mode=body.mode; json(res,200,{ok:true}); return;
      }
      throw new HttpError(404,'not_found','Unknown route');
    });
    server.once('close',()=>db.close());
  } catch(error) { db.close(); throw error; }
}
if(import.meta.main) await main();
