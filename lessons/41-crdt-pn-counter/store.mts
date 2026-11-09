import { DatabaseSync } from 'node:sqlite';
import { bad, change, merge, parseState, value, zero } from './model.mts';
import type { Actor, State } from './model.mts';
export class Store {
  readonly db: DatabaseSync;
  readonly actor: Actor;
  constructor(path: string, actor: Actor) {
    this.actor=actor;
    this.db=new DatabaseSync(path);
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY CHECK(id=1), actor TEXT NOT NULL, state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, delta INTEGER NOT NULL, reply TEXT NOT NULL)');
      this.db.prepare('INSERT OR IGNORE INTO counter VALUES(1,?,?)').run(actor,JSON.stringify(zero()));
      if(this.db.prepare('SELECT actor FROM counter').get()?.actor !== actor) throw new Error('Actor identity mismatch');
      this.read();
    } catch(e) { this.db.close(); throw e; }
  }
  read(): State { const row=this.db.prepare('SELECT state FROM counter WHERE id=1').get(); if(typeof row?.state !== 'string') throw new Error('Missing state'); return parseState(JSON.parse(row.state)); }
  envelope() { const state=this.read(); return {actor:this.actor,state,value:value(state)}; }
  transaction<T>(f:()=>T): T { this.db.exec('BEGIN IMMEDIATE'); try { const result=f(); this.db.exec('COMMIT'); return result; } catch(e) { this.db.exec('ROLLBACK'); throw e; } }
  write(state: State) { this.db.prepare('UPDATE counter SET state=? WHERE id=1').run(JSON.stringify(state)); }
  apply(input: unknown): unknown {
    const {id,delta}=change(input);
    return this.transaction(()=>{
      const old=this.db.prepare('SELECT delta,reply FROM receipts WHERE id=?').get(id);
      if(old) { if(old.delta !== delta) bad(409); if(typeof old.reply !== 'string') throw new Error('Invalid receipt'); return JSON.parse(old.reply) as unknown; }
      const count=this.db.prepare('SELECT count(*) AS count FROM receipts').get();
      if(Number(count?.count)>=16) bad(409);
      const state=this.read(); const component=delta>0?state.p:state.n;
      if(component[this.actor]+Math.abs(delta)>1_000_000) bad(409);
      component[this.actor]+=Math.abs(delta); this.write(state);
      const reply=this.envelope();
      this.db.prepare('INSERT INTO receipts VALUES(?,?,?)').run(id,delta,JSON.stringify(reply)); return reply;
    });
  }
  receive(input: unknown) { const incoming=parseState(input); return this.transaction(()=>{ this.write(merge(this.read(),incoming)); return this.envelope(); }); }
  close() { this.db.close(); }
}
