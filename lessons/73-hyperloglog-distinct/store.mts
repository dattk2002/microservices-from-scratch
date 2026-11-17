import type { DatabaseSync } from 'node:sqlite';
import { ALGORITHM, add, exact, fail, validId, validSnapshot, validValue } from './protocol.mts';
import type { SketchId, Snapshot } from './protocol.mts';

export class Sketch {
  private readonly db: DatabaseSync;
  private readonly id: SketchId;
  private constructor(db: DatabaseSync, id: SketchId) { this.db = db; this.id = id; }

  static async open(path: string, id: string): Promise<Sketch> {
    if (!validId(id)) throw new Error('SKETCH_ID must be a or b');
    // No runtime SQLite import in the entrypoint graph: Node 24.12 warns on loading it.
    const {DatabaseSync} = await import('node:sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sketch (singleton INTEGER PRIMARY KEY CHECK(singleton=1), data TEXT NOT NULL)');
      const sketch = new Sketch(db, id);
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO sketch(singleton,data) VALUES(1,?) ON CONFLICT(singleton) DO NOTHING')
          .run(JSON.stringify({id,algorithm:ALGORITHM,registers:Array<number>(16).fill(0)}));
        sketch.snapshot(); // Persisted identity, algorithm and all ranks must match before serving.
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return sketch;
    } catch (error) { db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  snapshot(): Snapshot {
    const row = this.db.prepare('SELECT data FROM sketch WHERE singleton=1').get();
    if (typeof row?.data !== 'string') throw new Error('Missing persisted sketch');
    const value: unknown = JSON.parse(row.data);
    if (exact(value, ['id','algorithm','registers'])) {
      if (value.id !== this.id) throw new Error('Sketch identity mismatch');
      if (value.algorithm !== ALGORITHM) throw new Error('Sketch algorithm mismatch');
    }
    if (!validSnapshot(value, this.id)) throw new Error('Invalid persisted sketch');
    return value;
  }
  write(body: unknown): {changed: boolean} {
    if (!exact(body, ['value']) || !validValue(body.value)) fail(400, 'invalid_request');
    const value = body.value;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const snapshot = this.snapshot();
      const changed = add(snapshot.registers, value);
      if (changed) this.db.prepare('UPDATE sketch SET data=? WHERE singleton=1').run(JSON.stringify(snapshot));
      this.db.exec('COMMIT');
      return {changed};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
