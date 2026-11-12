import { DatabaseSync } from 'node:sqlite';
import { fail, packet, snapshot, same } from './protocol.mts';
import type { Packet, Replica, Snapshot, Transfer } from './protocol.mts';
export class Store {
 readonly db:DatabaseSync;
 readonly id:Replica;
 constructor(path:string,id:Replica) {
  this.id=id; this.db=new DatabaseSync(path);
  try {
   this.db.exec(`CREATE TABLE IF NOT EXISTS local (id TEXT PRIMARY KEY, balance INTEGER, sent INTEGER, received INTEGER, acked INTEGER, snapshot TEXT);
    CREATE TABLE IF NOT EXISTS packets (direction TEXT, seq INTEGER, body TEXT, PRIMARY KEY(direction,seq));`);
   const row=this.db.prepare('SELECT id FROM local').get();
   if(row && row.id!==id) throw new Error('Database replica identity conflict');
   if(!row) this.db.prepare('INSERT INTO local VALUES (?,10,0,0,0,NULL)').run(id);
  } catch(e) { this.db.close(); throw e; }
 }
 close() { this.db.close(); }
 private row() {
  const r=this.db.prepare('SELECT * FROM local').get();
  if(!r||typeof r.balance!=='number'||typeof r.sent!=='number'||typeof r.received!=='number'||typeof r.acked!=='number') throw new Error('Invalid database');
  return {balance:r.balance,sent:r.sent,received:r.received,acked:r.acked,snapshot:r.snapshot};
 }
 private atomic<T>(work:()=>T):T {
  this.db.exec('BEGIN IMMEDIATE');
  try { const result=work(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; }
 }
 private decode(value:unknown):Packet { if(typeof value!=='string') throw new Error('Invalid stored packet'); const p:unknown=JSON.parse(value); if(!packet(p)) throw new Error('Invalid stored packet'); return p; }
 private append(p:Packet) { this.db.prepare('INSERT INTO packets VALUES (?,?,?)').run('out',p.seq,JSON.stringify(p)); this.db.prepare('UPDATE local SET sent=?').run(p.seq); }
 private save(s:Snapshot) { this.db.prepare('UPDATE local SET snapshot=?').run(JSON.stringify(s)); }
 snapshot():Snapshot|null { const raw=this.row().snapshot; if(raw===null) return null; if(typeof raw!=='string') throw new Error('Invalid snapshot'); const s:unknown=JSON.parse(raw); if(!snapshot(s,this.id)) throw new Error('Invalid snapshot'); return s; }
 state() { const r=this.row(); return {replica:this.id,balance:r.balance,outbox:this.db.prepare("SELECT body FROM packets WHERE direction='out' ORDER BY seq").all().map(r=>this.decode(r.body)),sentThrough:r.sent,receivedThrough:r.received}; }
 head():Packet|null { const row=this.db.prepare("SELECT body FROM packets WHERE direction='out' ORDER BY seq LIMIT 1").get(); return row?this.decode(row.body):null; }
 transfer(amount:number):Transfer { return this.atomic(()=>{
  const r=this.row(); if(r.balance<amount) fail(409,'insufficient'); if(r.sent===16) fail(429,'exhausted');
  const p:Transfer={from:this.id,seq:r.sent+1,kind:'transfer',amount};
  this.db.prepare('UPDATE local SET balance=balance-?').run(amount); this.append(p); return p;
 }); }
 ack(seq:number) { this.atomic(()=>{ const r=this.row(); if(seq<=r.acked) return; const p=this.head(); if(!p||p.seq!==seq) fail(409,'ack_conflict'); this.db.prepare("DELETE FROM packets WHERE direction='out' AND seq=?").run(seq); this.db.prepare('UPDATE local SET acked=?').run(seq); }); }
 begin(id:string):{created:boolean;snapshot:Snapshot} { return this.atomic(()=>{
  const s=this.snapshot(); if(s) { if(s.snapshotId!==id) fail(409,'snapshot_conflict'); return {created:false,snapshot:s}; }
  const r=this.row(); if(r.sent===16) fail(429,'exhausted');
  const next:Snapshot={snapshotId:id,localBalance:r.balance,channelOpen:true,inFlight:[]}; this.save(next); this.append({from:this.id,seq:r.sent+1,kind:'marker',snapshotId:id}); return {created:true,snapshot:next};
 }); }
 receive(p:Packet) { this.atomic(()=>{
  if(p.from===this.id) fail(400,'wrong_replica');
  const r=this.row();
  if(p.seq<=r.received) { const old=this.db.prepare("SELECT body FROM packets WHERE direction='in' AND seq=?").get(p.seq); if(!old||!same(this.decode(old.body),p)) fail(409,'replay_conflict'); return; }
  if(p.seq!==r.received+1) fail(409,'sequence_gap');
  const s=this.snapshot();
  if(p.kind==='marker') {
   if(s && s.snapshotId!==p.snapshotId) fail(409,'snapshot_conflict');
   if(!s) { if(r.sent===16) fail(429,'exhausted'); this.save({snapshotId:p.snapshotId,localBalance:r.balance,channelOpen:false,inFlight:[]}); this.append({from:this.id,seq:r.sent+1,kind:'marker',snapshotId:p.snapshotId}); }
   else { s.channelOpen=false; this.save(s); }
  } else {
   this.db.prepare('UPDATE local SET balance=balance+?').run(p.amount);
   if(s?.channelOpen) { s.inFlight.push(p); this.save(s); }
  }
  this.db.prepare("INSERT INTO packets VALUES ('in',?,?)").run(p.seq,JSON.stringify(p)); this.db.prepare('UPDATE local SET received=?').run(p.seq);
 }); }
}
