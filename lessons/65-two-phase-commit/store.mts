import type { DatabaseSync } from 'node:sqlite';
import { fail, localRecord, transaction } from './protocol.mts';
import type { ParticipantId, LocalRecord, LocalPhase, Transaction, Vote, Decision, Origins } from './protocol.mts';

// A single SQLite transaction contains every local transition and its replay receipt.
class Journal {
 readonly db:DatabaseSync;
 constructor(db:DatabaseSync, identity:string) {
  this.db=db;
  db.exec('PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  this.atomic(()=>{
   db.exec('CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), name TEXT NOT NULL); CREATE TABLE IF NOT EXISTS records (tx_id TEXT PRIMARY KEY, body TEXT NOT NULL);');
   const old=db.prepare('SELECT name FROM identity WHERE singleton=1').get();
   if(old && old.name!==identity)throw new Error('Database identity conflict');
   if(!old)db.prepare('INSERT INTO identity VALUES (1,?)').run(identity);
  });
 }
 atomic<T>(work:()=>T):T {
  this.db.exec('BEGIN IMMEDIATE');
  try {const result=work();this.db.exec('COMMIT');return result;}
  catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 read(id:string):unknown {
  const row=this.db.prepare('SELECT body FROM records WHERE tx_id=?').get(id);
  if(!row)return undefined;
  if(typeof row.body!=='string')throw new Error('Corrupt journal');
  const value:unknown=JSON.parse(row.body);return value;
 }
 all():unknown[] {
  return this.db.prepare('SELECT body FROM records ORDER BY tx_id').all().map(row=>{
   if(typeof row.body!=='string')throw new Error('Corrupt journal');
   const value:unknown=JSON.parse(row.body);return value;
  });
 }
 room() { if(this.all().length>=8)fail(429,'capacity'); }
 save(record:LocalRecord|Transaction) {
  this.db.prepare('INSERT INTO records VALUES (?,?) ON CONFLICT(tx_id) DO UPDATE SET body=excluded.body').run(record.txId,JSON.stringify(record));
 }
}
export class Participant {
 readonly journal:Journal;
 readonly id:ParticipantId;
 constructor(db:DatabaseSync,id:ParticipantId) {this.journal=new Journal(db,`participant:${id}`);this.id=id;}
 private read(txId:string):LocalRecord|undefined {
  const row=this.journal.read(txId);
  if(row===undefined)return undefined;
  if(!localRecord(row))throw new Error('Invalid participant record');return row;
 }
 private match(row:LocalRecord, amount:number) {if(row.amount!==amount)fail(409,'tx_conflict');}
 state() {
  const transactions=this.journal.all().map(row=>{if(!localRecord(row))throw new Error('Invalid participant record');return row;});
  const committed=transactions.filter(t=>t.phase==='committed').reduce((n,t)=>n+t.amount,0);
  const reserved=transactions.filter(t=>t.phase==='prepared').reduce((n,t)=>n+t.amount,0);
  return {participant:this.id,committed,available:4-committed-reserved,transactions};
 }
 prepare(txId:string,amount:number):{txId:string;amount:number;vote:Vote} {
  return this.journal.atomic(()=>{
   const old=this.read(txId);
   if(old){this.match(old,amount);return {txId,amount,vote:old.phase==='prepared'||old.phase==='committed'?'yes':'no'};}
   this.journal.room();const state=this.state();
   const yes=!state.transactions.some(t=>t.phase==='prepared')&&amount<=state.available;
   this.journal.save({txId,amount,phase:yes?'prepared':'rejected'});
   return {txId,amount,vote:yes?'yes':'no'};
  });
 }
 decide(txId:string,amount:number,decision:Decision):{txId:string;amount:number;phase:'committed'|'aborted'} {
  return this.journal.atomic(()=>{
   const old=this.read(txId);if(old)this.match(old,amount);
   const phase=decision==='commit'?'committed':'aborted';
   if(old?.phase==='committed'||old?.phase==='aborted') {
    if(old.phase!==phase)fail(409,'decision_conflict');
    return {txId,amount,phase};
   }
   if(decision==='commit' && old?.phase!=='prepared')fail(409,'not_prepared');
   if(!old)this.journal.room();
   this.journal.save({txId,amount,phase});return {txId,amount,phase};
  });
 }
}
export class CoordinatorStore {
 readonly journal:Journal;
 constructor(db:DatabaseSync, targets?:Origins) {this.journal=new Journal(db,targets?`coordinator:${targets.a}|${targets.b}`:'coordinator:unit');}
 get(txId:string):Transaction {
  const row=this.journal.read(txId);if(row===undefined)fail(404,'unknown_transaction');
  if(!transaction(row))throw new Error('Invalid coordinator record');return row;
 }
 create(txId:string,amount:number) {
  return this.journal.atomic(()=>{
   const old=this.journal.read(txId);
   if(old!==undefined){const record=this.get(txId);if(record.amount!==amount)fail(409,'tx_conflict');return {created:false,record};}
   this.journal.room();
   const record:Transaction={txId,amount,phase:'preparing',votes:{a:null,b:null},acks:{a:false,b:false}};
   this.journal.save(record);return {created:true,record};
  });
 }
 vote(txId:string,id:ParticipantId,vote:Vote) {
  return this.journal.atomic(()=>{
   const t=this.get(txId);if(t.phase!=='preparing')return t;
   if(t.votes[id]!==null && t.votes[id]!==vote)throw new Error('Vote conflict');
   t.votes[id]=vote;
   if(vote==='no')t.phase='abort';
   else if(t.votes.a==='yes'&&t.votes.b==='yes')t.phase='commit';
   this.journal.save(t);return t;
  });
 }
 abort(txId:string) {
  return this.journal.atomic(()=>{const t=this.get(txId);if(t.phase==='preparing'){t.phase='abort';this.journal.save(t);}return t;});
 }
 ack(txId:string,id:ParticipantId) {
  return this.journal.atomic(()=>{const t=this.get(txId);if(t.phase==='preparing')fail(409,'undecided');t.acks[id]=true;this.journal.save(t);return t;});
 }
}
