import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
import { parsePhase, transition } from './policy.mts';
import type { Phase } from './policy.mts';

export type Note = { id: string; text: string };
export function note(value: unknown): Note {
  if (typeof value !== 'object' || value === null || !('id' in value) || !('text' in value)
      || Object.keys(value).length !== 2 || typeof value.id !== 'string'
      || !/^[a-z0-9-]{1,24}$/.test(value.id) || typeof value.text !== 'string'
      || value.text.trim().length === 0 || value.text.length > 64 || /[\u0000-\u001f\uD800-\uDFFF]/u.test(value.text)) {
    throw new HttpError(400, 'invalid_note', 'Use {id: lowercase slug, text: 1..64 characters}');
  }
  return { id: value.id, text: value.text };
}
export function snapshot(value: unknown): Note[] {
  if (!Array.isArray(value) || value.length > 30) throw new Error('Snapshot exceeds 30 notes');
  const rows = value.map(note).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate snapshot IDs');
  return rows;
}
export function digest(rows: Note[]): string {
  return createHash('sha256').update(JSON.stringify(snapshot(rows))).digest('hex');
}
function open(path: string, role: 'legacy' | 'extracted' | 'facade'): DatabaseSync {
  if (!path || path === ':memory:') throw new Error('Use a durable DB_PATH');
  const db = new DatabaseSync(path, { timeout: 500 });
  const id = { legacy: 202001, extracted: 202002, facade: 202003 }[role];
  try {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    const current = db.prepare('PRAGMA application_id').get()?.application_id;
    if (current === 0) {
      if (db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.n !== 0) {
        throw new Error('Refuse unowned existing database');
      }
      db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL) STRICT;
        PRAGMA application_id=${id}; PRAGMA user_version=1;`);
      db.prepare('INSERT INTO meta VALUES (?, ?)').run('state', role === 'legacy' ? 'open' : role === 'extracted' ? 'passive' : 'legacy-only');
    } else if (current !== id || db.prepare('PRAGMA user_version').get()?.user_version !== 1) {
      throw new Error('Wrong database owner or schema version');
    }
    db.exec('COMMIT');
    return db;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close(); throw error;
  }
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, role: 'legacy' | 'extracted' | 'facade') { this.db = open(path, role); }
  state(): string {
    const value = this.db.prepare("SELECT value FROM meta WHERE key='state'").get()?.value;
    if (typeof value !== 'string') throw new Error('Missing durable state');
    return value;
  }
  setState(value: string) { this.db.prepare("UPDATE meta SET value=? WHERE key='state'").run(value); }
  phase(): Phase { return parsePhase(this.state()); }
  advance(to: Phase) { this.setState(transition(this.phase(), to)); }
  rows(): Note[] { return snapshot(this.db.prepare('SELECT id, text FROM notes ORDER BY id').all()); }
  put(value: Note) {
    const parsed = note(value);
    if (this.rows().length >= 30 && !this.db.prepare('SELECT id FROM notes WHERE id=?').get(parsed.id)) {
      throw new HttpError(409, 'capacity', 'Teaching dataset limit is 30 notes');
    }
    this.db.prepare('INSERT INTO notes VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text').run(parsed.id, parsed.text);
  }
  copy(rows: Note[]): string {
    const checked = snapshot(rows);
    const hash = digest(checked);
    if (this.state() === 'active') {
      // An interrupted activate response must never cause replacement of business data.
      const original = this.db.prepare("SELECT value FROM meta WHERE key='copy-hash'").get()?.value;
      if (original !== hash) throw new Error('Activated copy differs; manual intervention required');
      return hash;
    }
    if (this.state() !== 'passive') throw new Error('Target is not passive');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM notes');
      for (const row of checked) this.put(row);
      if (digest(this.rows()) !== hash) throw new Error('Copy validation failed');
      this.db.prepare("INSERT OR REPLACE INTO meta VALUES ('copy-hash', ?)").run(hash);
      this.db.exec('COMMIT'); return hash;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  activate(hash: string) {
    const copied = this.db.prepare("SELECT value FROM meta WHERE key='copy-hash'").get()?.value;
    if (copied !== hash || !['passive', 'active'].includes(this.state())) throw new Error('Unvalidated activation');
    this.setState('active');
  }
  close() { this.db.close(); }
}
