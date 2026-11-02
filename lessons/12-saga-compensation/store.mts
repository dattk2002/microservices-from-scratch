import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, refusal INTEGER NOT NULL, state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effects(id TEXT PRIMARY KEY, refusal INTEGER NOT NULL, state TEXT NOT NULL);`);
  }
  order(id: string) { return this.db.prepare('SELECT * FROM orders WHERE id=?').get(id); }
  create(id: string, refusal: boolean) {
    this.db.prepare("INSERT OR IGNORE INTO orders VALUES(?,?,'reserving')").run(id, Number(refusal));
    const row = this.order(id);
    if (row?.refusal !== Number(refusal)) throw new HttpError(409, 'conflict', 'ID reused with different payload');
  }
  set(id: string, state: string) { this.db.prepare('UPDATE orders SET state=? WHERE id=?').run(state, id); }
  effect(id: string, refusal: boolean, operation: string) {
    const old = this.db.prepare('SELECT * FROM effects WHERE id=?').get(id);
    if (old && old.refusal !== Number(refusal)) throw new HttpError(409, 'conflict', 'ID reused');
    if (operation === 'release') {
      if (old?.state === 'reserved') this.db.prepare("UPDATE effects SET state='released' WHERE id=?").run(id);
      return 'released';
    }
    if (old) return String(old.state);
    const state = operation === 'reserve' ? 'reserved' : refusal ? 'refused' : 'charged';
    this.db.prepare('INSERT INTO effects VALUES(?,?,?)').run(id, Number(refusal), state);
    return state;
  }
  close() { this.db.close(); }
}
