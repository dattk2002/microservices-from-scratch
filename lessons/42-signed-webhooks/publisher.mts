import { DatabaseSync } from 'node:sqlite';
import { serve, json, numberSetting } from '../../lib/http.mts';
import { secretSetting, event, object, parse, rawBody, sign, fail, acknowledgment } from './core.mts';
export async function main() {
 const secret=secretSetting();
 const path=process.env.DB_PATH; if(!path) throw new Error('DB_PATH required');
 const origin=new URL(process.env.RECEIVER_ORIGIN??'');
 if(origin.protocol!=='http:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash) throw new Error('RECEIVER_ORIGIN must be HTTP origin');
 const deadline=numberSetting('DELIVERY_TIMEOUT_MS',800,50,3000);
 const db=new DatabaseSync(path);
 db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,delta INTEGER NOT NULL,raw BLOB NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0,outcome TEXT NOT NULL DEFAULT 'pending')");
 // Active work is process-local. A crash leaves the persisted attempt uncertain; never resume automatically.
 let active=false;
 try {
 const server=await serve('signed-webhook-publisher',4241,async(req,res)=>{
  if(req.method==='POST'&&req.url==='/events') {
   const e=event(parse(await rawBody(req)));
   const old=db.prepare('SELECT delta FROM events WHERE id=?').get(e.id);
   if(old&&old.delta!==e.delta) fail(409,'payload_conflict');
   if(!old) {
    const count=db.prepare('SELECT count(*) AS n FROM events').get();
    if(!count||typeof count.n!=='number'||count.n>=16) fail(409,'event_capacity');
    db.prepare('INSERT INTO events(id,delta,raw) VALUES(?,?,?)').run(e.id,e.delta,Buffer.from(JSON.stringify(e)));
   }
   json(res,old?200:201,e);return;
  }
  if(req.method==='GET'&&req.url?.startsWith('/events/')) {
   let id:string;try{id=decodeURIComponent(req.url.slice(8));}catch{fail(400,'invalid_id');}
   const row=db.prepare('SELECT id,delta,attempts,delivered,outcome FROM events WHERE id=?').get(id);
   if(!row) fail(404,'not_found');json(res,200,{...row,busy:active});return;
  }
  if(req.method==='POST'&&req.url==='/deliver') {
   const o=object(parse(await rawBody(req)));
   if(typeof o.id!=='string') fail(400,'invalid_id');
   const row=db.prepare('SELECT raw,attempts FROM events WHERE id=?').get(o.id);
   if(!row) fail(404,'not_found');
   if(active) fail(409,'delivery_busy');
   if(typeof row.attempts!=='number'||row.attempts>=8) fail(409,'attempt_limit');
   if(!(row.raw instanceof Uint8Array)) throw new Error('Invalid retained bytes');
   const id=o.id;const raw=Buffer.from(row.raw);
   active=true;
   db.prepare("UPDATE events SET attempts=attempts+1,outcome='uncertain' WHERE id=?").run(id);
   try {
    const timestamp=String(Math.floor(Date.now()/1000));
    const response=await fetch(new URL('/webhook',origin),{method:'POST',redirect:'error',headers:{'content-type':'application/json','x-demo-timestamp':timestamp,'x-demo-signature':sign(secret,timestamp,raw)},body:raw,signal:AbortSignal.timeout(deadline)});
    if(!response.ok) {await response.body?.cancel();fail(502,'upstream_status');}
    const reader=response.body?.getReader(); if(!reader) fail(502,'missing_ack');
    const chunks:Uint8Array[]=[];let size=0;
    try {while(true) {const part=await reader.read();if(part.done) break;size+=part.value.length;if(size>512) fail(502,'ack_too_large');chunks.push(part.value);}} finally {await reader.cancel().catch(()=>{});}
    const ack=acknowledgment(parse(Buffer.concat(chunks)),id);
    db.prepare("UPDATE events SET delivered=1,outcome='delivered' WHERE id=?").run(id);
    json(res,200,ack);
   } catch {
    json(res,502,{error:'delivery_uncertain'});
   } finally {active=false;}
   return;
  }
  fail(404,'not_found');
 });
 server.once('close',()=>db.close());
 } catch(error) {db.close();throw error;}
}
if(import.meta.main) await main();
