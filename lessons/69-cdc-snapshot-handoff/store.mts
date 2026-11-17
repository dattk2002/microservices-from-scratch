import type { DatabaseSync } from 'node:sqlite';
import { batch, cursor, fail, itemValue, key, snapshot, sourceOrigin } from './protocol.mts';
import type { Batch, Item, Snapshot, State } from './protocol.mts';

function atomic<T>(db:DatabaseSync,work:()=>T,read=false):T {
 db.exec(read?'BEGIN':'BEGIN IMMEDIATE');
 try {const result=work();db.exec('COMMIT');return result;}
 catch(error){db.exec('ROLLBACK');throw error;}
}
function identity(db:DatabaseSync,name:string) {
 db.exec('PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
 atomic(db,()=>{
  db.exec('CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), name TEXT NOT NULL)');
  const old=db.prepare('SELECT name FROM identity WHERE singleton=1').get();
  if(old&&old.name!==name)throw new Error('Database identity mismatch');
  if(!old)db.prepare('INSERT INTO identity VALUES (1,?)').run(name);
 });
}
function items(db:DatabaseSync):Item[] {
 return db.prepare('SELECT key,value FROM items ORDER BY key').all().map(row=>({key:key(row.key),value:itemValue(row.value)}));
}
const itemTable=`CREATE TABLE IF NOT EXISTS items (
 key TEXT PRIMARY KEY CHECK(key IN ('k0','k1','k2','k3','k4','k5','k6','k7')),
 value TEXT NOT NULL CHECK(typeof(value)='text' AND length(value) BETWEEN 1 AND 24 AND value NOT GLOB '*[^A-Za-z]*')
) STRICT;`;

export class SourceStore {
 readonly db:DatabaseSync;
 constructor(db:DatabaseSync) {
  this.db=db;identity(db,'source:v1');
  atomic(db,()=>db.exec(`${itemTable}
   CREATE TABLE IF NOT EXISTS changes (
    seq INTEGER PRIMARY KEY CHECK(seq BETWEEN 1 AND 32),
    key TEXT NOT NULL CHECK(key IN ('k0','k1','k2','k3','k4','k5','k6','k7')),
    value TEXT CHECK(value IS NULL OR (typeof(value)='text' AND length(value) BETWEEN 1 AND 24 AND value NOT GLOB '*[^A-Za-z]*'))
   ) STRICT;
   CREATE TRIGGER IF NOT EXISTS immutable_update BEFORE UPDATE ON changes BEGIN SELECT RAISE(ABORT,'immutable change log'); END;
   CREATE TRIGGER IF NOT EXISTS immutable_delete BEFORE DELETE ON changes BEGIN SELECT RAISE(ABORT,'immutable change log'); END;
   CREATE TRIGGER IF NOT EXISTS capacity_insert BEFORE INSERT ON items
   WHEN NOT EXISTS(SELECT 1 FROM items WHERE key=NEW.key) AND (SELECT COUNT(*) FROM changes)>=32
   BEGIN SELECT RAISE(ABORT,'cdc_capacity'); END;
   CREATE TRIGGER IF NOT EXISTS capacity_update BEFORE UPDATE ON items
   WHEN OLD.value<>NEW.value AND (SELECT COUNT(*) FROM changes)>=32
   BEGIN SELECT RAISE(ABORT,'cdc_capacity'); END;
   CREATE TRIGGER IF NOT EXISTS capacity_delete BEFORE DELETE ON items
   WHEN (SELECT COUNT(*) FROM changes)>=32 BEGIN SELECT RAISE(ABORT,'cdc_capacity'); END;
   CREATE TRIGGER IF NOT EXISTS cdc_insert AFTER INSERT ON items BEGIN
    INSERT INTO changes VALUES ((SELECT COALESCE(MAX(seq),0)+1 FROM changes),NEW.key,NEW.value); END;
   CREATE TRIGGER IF NOT EXISTS cdc_update AFTER UPDATE ON items WHEN OLD.value<>NEW.value BEGIN
    INSERT INTO changes VALUES ((SELECT COALESCE(MAX(seq),0)+1 FROM changes),NEW.key,NEW.value); END;
   CREATE TRIGGER IF NOT EXISTS cdc_delete AFTER DELETE ON items BEGIN
    INSERT INTO changes VALUES ((SELECT COALESCE(MAX(seq),0)+1 FROM changes),OLD.key,NULL); END;
  `));
 }
 private mutate<T>(work:()=>T):T {
  try{return atomic(this.db,work);}
  catch(error){if(error instanceof Error&&error.message==='cdc_capacity')fail(429,'capacity');throw error;}
 }
 put(rawKey:unknown,rawValue:unknown):Item {
  const k=key(rawKey),value=itemValue(rawValue);
  return this.mutate(()=>{
   this.db.prepare('INSERT INTO items VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k,value);
   return {key:k,value};
  });
 }
 remove(rawKey:unknown):{key:string;value:null} {
  const k=key(rawKey);
  return this.mutate(()=>{
   if(this.db.prepare('DELETE FROM items WHERE key=?').run(k).changes===0)fail(404,'absent');
   return {key:k,value:null};
  });
 }
 private highwater():number {
  const row=this.db.prepare('SELECT COALESCE(MAX(seq),0) AS through FROM changes').get();
  return cursor(row?.through);
 }
 snapshot():Snapshot {
  // The first SELECT establishes the same read boundary for highwater and items.
  return atomic(this.db,()=>({through:this.highwater(),items:items(this.db)}),true);
 }
 changes(rawAfter:unknown):Batch {
  const after=cursor(rawAfter);
  return atomic(this.db,()=>{
   const through=this.highwater();if(after>through)fail(409,'cursor_ahead');
   const changes=this.db.prepare('SELECT seq,key,value FROM changes WHERE seq>? ORDER BY seq LIMIT 4').all(after)
    .map(row=>({seq:cursor(row.seq),key:key(row.key),value:row.value===null?null:itemValue(row.value)}));
   return {after,through,changes};
  },true);
 }
}

export class ReplicaStore {
 readonly db:DatabaseSync;
 readonly origin:string;
 constructor(db:DatabaseSync,origin:string) {
  this.db=db;this.origin=sourceOrigin(origin);identity(db,`replica:v1:${this.origin}`);
  atomic(db,()=>db.exec(`${itemTable}
   CREATE TABLE IF NOT EXISTS progress (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint INTEGER NOT NULL CHECK(checkpoint BETWEEN 0 AND 32),
    phase TEXT NOT NULL CHECK(phase IN ('empty','ready'))
   ) STRICT;
   INSERT OR IGNORE INTO progress VALUES (1,0,'empty');
  `));
 }
 state():State {
  const row=this.db.prepare('SELECT checkpoint,phase FROM progress WHERE singleton=1').get();
  if(row?.phase!=='empty'&&row?.phase!=='ready')throw new Error('Corrupt replica progress');
  return {checkpoint:cursor(row.checkpoint),phase:row.phase,items:items(this.db)};
 }
 bootstrap(value:unknown):State {
  return atomic(this.db,()=>{
   if(this.state().phase==='ready')return this.state();
   const boundary=snapshot(value);
   this.db.exec('DELETE FROM items');
   for(const item of boundary.items)this.db.prepare('INSERT INTO items VALUES (?,?)').run(item.key,item.value);
   this.db.prepare("UPDATE progress SET checkpoint=?,phase='ready' WHERE singleton=1").run(boundary.through);
   return this.state();
  });
 }
 apply(value:unknown):State {
  return atomic(this.db,()=>{
   const current=this.state();if(current.phase!=='ready')fail(409,'not_bootstrapped');
   // Validate every record before mutating. SQL failures roll back items and progress.
   const received=batch(value,current.checkpoint);
   for(const change of received.changes) {
    if(change.value===null)this.db.prepare('DELETE FROM items WHERE key=?').run(change.key);
    else this.db.prepare('INSERT INTO items VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(change.key,change.value);
   }
   const last=received.changes.at(-1);
   if(last)this.db.prepare('UPDATE progress SET checkpoint=? WHERE singleton=1').run(last.seq);
   return this.state();
  });
 }
}
