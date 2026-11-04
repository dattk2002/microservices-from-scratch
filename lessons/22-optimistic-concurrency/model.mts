import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';

export const MAX_VERSION = Number.MAX_SAFE_INTEGER;
function versionValid(n: number): boolean { return Number.isSafeInteger(n) && n >= 1 && n <= MAX_VERSION; }
export function etag(version: number): string { return `"v${version}"`; }
export function parseMatch(header: string | undefined): number {
  if (header === undefined) throw new HttpError(428, 'precondition_required', 'Supply one strong version ETag');
  const match = /^"v([1-9][0-9]*)"$/.exec(header);
  const version = match ? Number(match[1]) : NaN;
  if (!versionValid(version)) throw new HttpError(400, 'invalid_if_match', 'Expected one strong version ETag');
  return version;
}
export function valueInput(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !('value' in body)) throw new HttpError(400, 'invalid_value', 'Expected {value:string}');
  const value = body.value;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new HttpError(400, 'invalid_value', 'Value must contain 1..200 characters, not only whitespace');
  }
  return value;
}
export type Resource = {value:string; version:number};
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=200;
        CREATE TABLE IF NOT EXISTS resource(
          id INTEGER PRIMARY KEY CHECK(id=1),
          value TEXT NOT NULL,
          version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991));
        INSERT OR IGNORE INTO resource VALUES(1,'initial',1);`);
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  read(): Resource {
    const row = this.db.prepare('SELECT value, version FROM resource WHERE id=1').get();
    if (!row || typeof row.value !== 'string' || typeof row.version !== 'number' || !versionValid(row.version)) throw new Error('Corrupt resource');
    return {value:row.value, version:row.version};
  }
  update(version: number, input: unknown): Resource {
    if (!versionValid(version)) throw new HttpError(400, 'invalid_version', 'Invalid version');
    const value = valueInput({value:input});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.read();
      if (current.version !== version) throw new HttpError(412, 'version_conflict', 'Re-read and explicitly revise');
      if (version === MAX_VERSION) throw new HttpError(409, 'version_exhausted', 'Version cannot increase');
      const row = this.db.prepare('UPDATE resource SET value=?, version=version+1 WHERE id=1 AND version=? RETURNING value,version').get(value, version);
      if (!row || typeof row.value !== 'string' || typeof row.version !== 'number') throw new Error('Compare update failed');
      this.db.exec('COMMIT');
      return {value:row.value, version:row.version};
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
