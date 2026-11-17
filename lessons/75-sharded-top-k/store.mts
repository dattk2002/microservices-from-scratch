import type { DatabaseSync } from 'node:sqlite';
import { compare, exact, fail, integer, invalid, itemList, owned } from './ranking.mts';
import type { Item, Shard } from './ranking.mts';

type Snapshot = {revision:number,items:Item[]};
type State = {shard:Shard,revision:number,items:Item[],snapshots:Snapshot[]};
function parseState(v:unknown):State {
  if(!exact(v,['shard','revision','items','snapshots'])||(v.shard!=='a'&&v.shard!=='b')||!integer(v.revision,0,16)||!itemList(v.items,v.shard,8,false)||!Array.isArray(v.snapshots)||v.snapshots.length<1||v.snapshots.length>4) throw new Error('Corrupt shard state');
  const snapshots:Snapshot[]=[];
  for(const s of v.snapshots) {
    if(!exact(s,['revision','items'])||!integer(s.revision,0,v.revision)||!itemList(s.items,v.shard,8,false)||snapshots.some(p=>p.revision===s.revision)) throw new Error('Corrupt snapshot');
    snapshots.push({revision:s.revision,items:s.items});
  }
  if(!snapshots.some(s=>s.revision===0&&s.items.length===0)) throw new Error('Missing empty snapshot zero');
  return {shard:v.shard,revision:v.revision,items:v.items,snapshots};
}

// A single durable row makes live revision and published payloads one SQLite commit.
// The entrypoint owns the database, including cleanup if construction fails.
export class ShardStore {
  private readonly db:DatabaseSync;
  private readonly shard:Shard;
  constructor(db:DatabaseSync,shard:Shard) {
    this.db=db;this.shard=shard;
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS shard_state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    try {
      if(!db.prepare('SELECT id FROM shard_state WHERE id=1').get()) db.prepare('INSERT INTO shard_state VALUES(1,?)').run(JSON.stringify({shard,revision:0,items:[],snapshots:[{revision:0,items:[]}]}));
      if(this.read().shard!==shard) throw new Error('Shard identity mismatch');
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  close():void {this.db.close();}
  private read():State {
    const row=this.db.prepare('SELECT data FROM shard_state WHERE id=1').get();
    if(typeof row?.data!=='string') throw new Error('Missing shard state');
    const v:unknown=JSON.parse(row.data);return parseState(v);
  }
  private change(fn:(state:State)=>void):{revision:number} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const s=this.read();fn(s);
      this.db.prepare('UPDATE shard_state SET data=? WHERE id=1').run(JSON.stringify(s));
      this.db.exec('COMMIT');return {revision:s.revision};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  write(id:unknown,body:unknown):{revision:number} {
    if(!owned(id,this.shard)||!exact(body,['score'])||!integer(body.score,0,100)) invalid();
    const score=body.score;
    return this.change(s=>{
      const item=s.items.find(x=>x.id===id);
      if(item?.score===score) return;
      if(s.revision===16) fail(409,'revision_exhausted');
      if(item) item.score=score;else s.items.push({id,score});
      s.revision++;
    });
  }
  publish(body:unknown):{revision:number} {
    if(!exact(body,[])) invalid();
    return this.change(s=>{
      if(s.snapshots.some(p=>p.revision===s.revision)) return;
      if(s.snapshots.length===4) fail(429,'snapshot_capacity');
      s.snapshots.push({revision:s.revision,items:s.items.map(item=>({...item}))});
    });
  }
  top(revision:unknown,k:unknown):{shard:Shard,revision:number,items:Item[]} {
    if(!integer(revision,0,16)||!integer(k,1,8)) invalid();
    const s=this.read(),snapshot=s.snapshots.find(p=>p.revision===revision);
    if(!snapshot) fail(404,'unknown_snapshot');
    return {shard:s.shard,revision,items:snapshot.items.toSorted(compare).slice(0,k)};
  }
}
