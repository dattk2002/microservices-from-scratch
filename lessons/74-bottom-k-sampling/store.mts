import type { DatabaseSync } from 'node:sqlite';
import { algorithm, bottom4, eventValid, sampleValid } from './contracts.mts';
import type { Snapshot, SampleId } from './contracts.mts';
export class SampleStore {
  readonly db: DatabaseSync;
  readonly id: SampleId;
  constructor(db: DatabaseSync, id: SampleId) {
    this.db=db; this.id=id;
    if (id !== 'a' && id !== 'b') throw new Error('Invalid SAMPLE_ID');
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS config (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, algorithm TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY, priority TEXT NOT NULL);`);
    this.transaction(()=>{
      const config=db.prepare('SELECT id,algorithm FROM config WHERE singleton=1').get();
      if (config && (config.id !== id || config.algorithm !== algorithm)) throw new Error('Persistent configuration mismatch');
      db.prepare('INSERT OR IGNORE INTO config VALUES (1,?,?)').run(id,algorithm);
      this.snapshot();
    });
  }
  private transaction<T>(action: ()=>T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value=action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(id: string): {retained: boolean} {
    if (!eventValid({id})) throw new Error('Invalid event id');
    return this.transaction(()=>{
      const before=this.snapshot().sample;
      const next=bottom4([...before.map(row=>row.id),id]);
      // A replay (retained or evicted) is a no-op, without a receipts table.
      if (JSON.stringify(before) !== JSON.stringify(next)) {
        this.db.exec('DELETE FROM sample');
        const insert=this.db.prepare('INSERT INTO sample VALUES (?,?)');
        for (const row of next) insert.run(row.id,row.priority);
      }
      return {retained:next.some(row=>row.id === id)};
    });
  }
  snapshot(): Snapshot {
    const rows=this.db.prepare('SELECT id,priority FROM sample ORDER BY priority COLLATE BINARY,id COLLATE BINARY').all();
    if (!sampleValid(rows)) throw new Error('Corrupt sample');
    return {id:this.id,algorithm,sample:rows.map(row=>({id:row.id,priority:row.priority}))};
  }
}
