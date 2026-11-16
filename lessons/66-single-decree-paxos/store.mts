import type { DatabaseSync } from 'node:sqlite';
import { attempt, ballot, color, fail, origins, parseBallot, parseValue, state } from './protocol.mts';
import type { Attempt, Chosen, Id, Origins, Reply, State, Value } from './protocol.mts';

class Journal {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync, identity: string) {
    this.db = db;
    db.exec('PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.atomic(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS records (slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 0 AND 16), body TEXT NOT NULL);`);
      const old = db.prepare('SELECT name FROM identity WHERE singleton=1').get();
      if (old && old.name !== identity) throw new Error('Database identity mismatch');
      if (!old) db.prepare('INSERT INTO identity VALUES (1,?)').run(identity);
    });
  }
  atomic<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  read(slot: number): unknown {
    const row = this.db.prepare('SELECT body FROM records WHERE slot=?').get(slot);
    if (!row) return undefined;
    if (typeof row.body !== 'string') throw new Error('Corrupt journal');
    const value: unknown = JSON.parse(row.body); return value;
  }
  save(slot: number, body: State | Attempt) {
    this.db.prepare('INSERT INTO records VALUES (?,?) ON CONFLICT(slot) DO UPDATE SET body=excluded.body').run(slot, JSON.stringify(body));
  }
}
export class AcceptorStore {
  readonly journal: Journal;
  readonly id: Id;
  constructor(db: DatabaseSync, id: Id) {
    if (id !== 'a' && id !== 'b' && id !== 'c') throw new Error('Invalid replica identity');
    this.id = id; this.journal = new Journal(db, `acceptor:${id}`);
    this.journal.atomic(() => {
      if (this.journal.read(0) === undefined) this.journal.save(0, { id, promised: 0, accepted: null });
      this.state();
    });
  }
  state(): State {
    const row = this.journal.read(0);
    if (!state(row) || row.id !== this.id) throw new Error('Corrupt acceptor state');
    return row;
  }
  prepare(b: number): Reply {
    parseBallot(b);
    return this.journal.atomic(() => {
      const s = this.state(); const ok = b >= s.promised;
      if (ok) { s.promised = b; this.journal.save(0, s); }
      return { ...s, ballot: b, ok };
    });
  }
  accept(b: number, value: Value): Reply {
    parseBallot(b); parseValue(value);
    return this.journal.atomic(() => {
      const s = this.state();
      if (s.accepted?.ballot === b && s.accepted.value !== value) fail(409, 'ballot_conflict');
      const ok = b >= s.promised;
      if (ok) { s.promised = b; s.accepted = { ballot: b, value }; this.journal.save(0, s); }
      // COMMIT (synchronous=FULL) finishes before the caller can emit this reply.
      return { ...s, ballot: b, ok };
    });
  }
}
export class ProposerStore {
  readonly journal: Journal;
  readonly targets: Origins;
  constructor(db: DatabaseSync, targets: Origins) {
    this.targets = Object.freeze(origins(targets.a, targets.b, targets.c));
    this.journal = new Journal(db, `proposer:${this.targets.a}|${this.targets.b}|${this.targets.c}`);
    for (const row of db.prepare('SELECT slot FROM records').all()) {
      if (!ballot(row.slot)) throw new Error('Corrupt attempt slot');
      this.get(row.slot);
    }
  }
  find(b: number): Attempt | undefined {
    parseBallot(b); const row = this.journal.read(b);
    if (row === undefined) return undefined;
    if (!attempt(row) || row.ballot !== b) throw new Error('Corrupt attempt');
    return row;
  }
  get(b: number): Attempt { const row = this.find(b); if (!row) fail(404, 'unknown_ballot'); return row; }
  create(b: number, requested: Value): Attempt {
    parseBallot(b); parseValue(requested);
    return this.journal.atomic(() => {
      const old = this.find(b);
      if (old) { if (old.requested !== requested) fail(409, 'ballot_conflict'); return old; }
      const row: Attempt = { ballot: b, requested, value: null, phase: 'preparing' };
      this.journal.save(b, row); return row;
    });
  }
  adopt(b: number, value: Value): Attempt {
    parseValue(value);
    return this.journal.atomic(() => {
      const row = this.get(b);
      if (row.phase !== 'preparing') { if (row.value !== value) fail(409, 'ballot_conflict'); return row; }
      row.value = value; row.phase = 'accepting'; this.journal.save(b, row); return row;
    });
  }
  choose(b: number): Chosen {
    return this.journal.atomic(() => {
      const row = this.get(b);
      if (row.phase === 'preparing' || !color(row.value)) throw new Error('Value not adopted');
      const chosen: Chosen = { ...row, value: row.value, phase: 'chosen' };
      this.journal.save(b, chosen); return chosen;
    });
  }
}
