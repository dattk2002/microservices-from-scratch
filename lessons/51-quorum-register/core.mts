import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Register = {version:number;value:number|null};
export type Receipt = {id:string;value:number;version:number;attempts:number;state:'uncertain'|'acknowledged'};
export function object(v:unknown): v is Record<string,unknown> { return typeof v==='object' && v!==null && !Array.isArray(v); }
export function integer(v:unknown,min:number,max:number):v is number { return typeof v==='number' && Number.isInteger(v) && v>=min && v<=max; }
export function fail(status:number,code:string):never { throw new HttpError(status,code,code); }
export function intersects(n:number,r:number,w:number) { return r+w>n; }
export function parseRegister(v:unknown):Register|null {
  if (!object(v) || Object.keys(v).length!==2 || !integer(v.version,0,16)) return null;
  if (v.version===0) return v.value===null ? {version:0,value:null} : null;
  if (!integer(v.value,1,100)) return null;
  return {version:v.version,value:v.value};
}
export function choose(values:Register[]):Register {
  if (values.length<2) fail(503,'read_quorum');
  const seen = new Map<number,number|null>();
  let best:Register = {version:0,value:null};
  for (const r of values) {
    if (seen.has(r.version) && seen.get(r.version)!==r.value) fail(502,'version_conflict');
    seen.set(r.version,r.value);
    if (r.version>=best.version) best=r;
  }
  return best;
}
export class ReplicaStore {
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS register (slot INTEGER PRIMARY KEY CHECK(slot=1),version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 16),value INTEGER, CHECK((version=0 AND value IS NULL) OR (version>0 AND value BETWEEN 1 AND 100))); INSERT OR IGNORE INTO register VALUES(1,0,NULL)`);
  }
  get():Register {
    const r=parseRegister(this.db.prepare('SELECT version,value FROM register WHERE slot=1').get());
    if (!r) throw new Error('Corrupt register');
    return r;
  }
  put(r:Register):number {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.get();
      const status=r.version>old.version || (r.version===old.version && r.value===old.value) ? 200 : 409;
      if (r.version>old.version) this.db.prepare('UPDATE register SET version=?,value=? WHERE slot=1').run(r.version,r.value);
      this.db.exec('COMMIT');
      return status;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
}
function receipt(v:unknown):Receipt {
  if (!object(v) || typeof v.id!=='string' || !integer(v.value,1,100) || !integer(v.version,1,16) || !integer(v.attempts,1,3) || (v.state!=='uncertain' && v.state!=='acknowledged')) throw new Error('Corrupt receipt');
  return {id:v.id,value:v.value,version:v.version,attempts:v.attempts,state:v.state};
}
export class CommandStore {
  readonly db:DatabaseSync;
  constructor(db:DatabaseSync) {
    this.db=db;
    db.exec(`CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY,value INTEGER NOT NULL CHECK(value BETWEEN 1 AND 100),version INTEGER UNIQUE NOT NULL CHECK(version BETWEEN 1 AND 16),attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),state TEXT NOT NULL CHECK(state IN ('uncertain','acknowledged')))`);
  }
  list():Receipt[] { return this.db.prepare('SELECT * FROM commands ORDER BY version').all().map(receipt); }
  find(id:string):Receipt|undefined { const row=this.db.prepare('SELECT * FROM commands WHERE id=?').get(id); return row ? receipt(row):undefined; }
  begin(id:string,value:number):Receipt {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old=this.find(id);
      if (old && old.value!==value) fail(409,'payload_changed');
      if (old?.state==='acknowledged') { this.db.exec('COMMIT'); return old; }
      if (old) {
        if (old.attempts>=3) fail(409,'attempt_limit');
        this.db.prepare('UPDATE commands SET attempts=attempts+1 WHERE id=?').run(id);
      } else {
        const all=this.list();
        if (all.some(r=>r.state==='uncertain')) fail(409,'unsettled_command');
        if (all.length>=16) fail(409,'capacity');
        this.db.prepare("INSERT INTO commands VALUES(?,?,?,1,'uncertain')").run(id,value,all.length+1);
      }
      const result=this.find(id);
      if (!result) throw new Error('Missing receipt');
      this.db.exec('COMMIT'); return result;
    } catch(e) { this.db.exec('ROLLBACK'); throw e; }
  }
  acknowledge(id:string) { this.db.prepare("UPDATE commands SET state='acknowledged' WHERE id=?").run(id); }
}
export function open(path:string) { const db=new DatabaseSync(path); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000'); return db; }
