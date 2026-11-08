import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export function conflict(): never {throw new HttpError(409,'conflict','Payload, transition or retained identity limit conflicts');}
export type Phase = 'try'|'confirm'|'cancel';
export type Status = 'held'|'confirmed'|'cancelled';
export class Participant {
 readonly db: DatabaseSync; readonly capacity: number;
 constructor(db: DatabaseSync, capacity: number) {
 this.db=db; this.capacity=capacity;
 db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS config(capacity INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, units INTEGER NOT NULL, status TEXT NOT NULL)');
 const old=db.prepare('SELECT capacity FROM config').get();
 if(old && old.capacity!==capacity) throw new Error('Capacity differs from durable configuration');
 if(!old) db.prepare('INSERT INTO config VALUES (?)').run(capacity);
 }
 state(){
 const rows=this.db.prepare('SELECT units,status FROM reservations').all();
 let held=0,consumed=0;
 for(const r of rows){if(r.status==='held') held+=Number(r.units); if(r.status==='confirmed') consumed+=Number(r.units);}
 return {capacity:this.capacity,available:this.capacity-held-consumed,held,consumed};
 }
 apply(phase: Phase,id:string,units:number):Status {
 this.db.exec('BEGIN IMMEDIATE');
 try {
 const old=this.db.prepare('SELECT units,status FROM reservations WHERE id=?').get(id);
 let status:Status;
 if(old){
 if(old.units!==units) conflict();
 if(phase==='try'){if(old.status==='cancelled') conflict(); status=old.status==='confirmed'?'confirmed':'held';}
 else if(phase==='confirm'){if(old.status==='cancelled') conflict(); status='confirmed';}
 else {if(old.status==='confirmed') conflict(); status='cancelled';}
 this.db.prepare('UPDATE reservations SET status=? WHERE id=?').run(status,id);
 } else {
 if(phase==='confirm') conflict();
 const count=this.db.prepare('SELECT count(*) AS n FROM reservations').get();
 if(Number(count?.n)>=16) conflict();
 if(phase==='try' && this.state().available<units) conflict();
 status=phase==='cancel'?'cancelled':'held';
 this.db.prepare('INSERT INTO reservations VALUES (?,?,?)').run(id,units,status);
 }
 this.db.exec('COMMIT'); return status;
 } catch(e){this.db.exec('ROLLBACK');throw e;}
 }
}
export type Transaction={id:string;quantity:number;amount:number;decision:'undecided'|'commit'|'abort';inventory:boolean;wallet:boolean;status:'pending'|'committed'|'aborted'};
export class Transactions {
 readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY, quantity INTEGER, amount INTEGER, decision TEXT, inventory INTEGER, wallet INTEGER)");}
 get(id:string):Transaction|undefined {
 const r=this.db.prepare('SELECT * FROM transactions WHERE id=?').get(id); if(!r)return;
 if(typeof r.id!=='string'||typeof r.quantity!=='number'||typeof r.amount!=='number'||(r.decision!=='undecided'&&r.decision!=='commit'&&r.decision!=='abort'))throw new Error('Corrupt transaction');
 const inventory=r.inventory===1,wallet=r.wallet===1;
 return {id:r.id,quantity:r.quantity,amount:r.amount,decision:r.decision,inventory,wallet,status:inventory&&wallet?(r.decision==='commit'?'committed':'aborted'):'pending'};
 }
 bind(id:string,q:number,a:number):Transaction {
 const old=this.get(id);if(old){if(old.quantity!==q||old.amount!==a)conflict();return old;}
 if(Number(this.db.prepare('SELECT count(*) AS n FROM transactions').get()?.n)>=16)conflict();
 this.db.prepare("INSERT INTO transactions VALUES (?,?,?,'undecided',0,0)").run(id,q,a);return this.get(id)!;
 }
 decide(id:string,d:'commit'|'abort') {const old=this.get(id);if(!old)conflict();if(old.decision!=='undecided'&&old.decision!==d)conflict();this.db.prepare('UPDATE transactions SET decision=? WHERE id=?').run(d,id);}
 acknowledge(id:string,resource:'inventory'|'wallet'){this.db.prepare(`UPDATE transactions SET ${resource}=1 WHERE id=?`).run(id);}
}
