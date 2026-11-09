import { createCipheriv, createDecipheriv } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export function fail(status = 400): never { throw new HttpError(status, 'envelope_error', 'Envelope operation rejected'); }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
export function objectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) fail();
  return value;
}
export function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string') fail();
  const result = Buffer.from(value, 'base64');
  if (result.toString('base64') !== value || (length !== undefined && result.length !== length)) fail();
  return result;
}
export function plaintext(value: unknown): Buffer {
  if (typeof value !== 'string' || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) fail();
  const result = Buffer.from(value);
  if (!result.length || result.length > 256) fail();
  return result;
}
export type Data = { iv: string; tag: string; ciphertext: string };
export type Wrapped = Data & { kekId: 'v1' | 'v2' };
export function data(value: unknown, length?: number): Data {
  const v = record(value);
  const iv = bytes(v.iv, 12).toString('base64');
  const tag = bytes(v.tag, 16).toString('base64');
  const ciphertext = bytes(v.ciphertext, length);
  if (length === undefined && (!ciphertext.length || ciphertext.length > 256)) fail();
  return { iv, tag, ciphertext: ciphertext.toString('base64') };
}
export function wrapped(value: unknown): Wrapped {
  const v = record(value);
  if (typeof v.kekId !== 'string' || (v.kekId !== 'v1' && v.kekId !== 'v2')) fail();
  return { ...data(v, 32), kekId: v.kekId };
}
export function encrypt(key: Buffer, iv: Buffer, plain: Buffer, aad: Buffer): Data {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
export function decrypt(key: Buffer, sealed: Data, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes(sealed.iv, 12));
    decipher.setAAD(aad); decipher.setAuthTag(bytes(sealed.tag, 16));
    return Buffer.concat([decipher.update(bytes(sealed.ciphertext)), decipher.final()]);
  } catch { return fail(409); }
}
export function aad(id: string, kekId?: string): Buffer { return Buffer.from(JSON.stringify(kekId ? [1, id, kekId] : [1, id])); }
export function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE IF NOT EXISTS objects (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, wrapped TEXT NOT NULL)');
  return db;
}
export function load(db: DatabaseSync, id: string) {
  const row = db.prepare('SELECT version,data,wrapped FROM objects WHERE id=?').get(id);
  if (!row) fail(404);
  if (typeof row.version !== 'number' || typeof row.data !== 'string' || typeof row.wrapped !== 'string') fail(500);
  return { id, version: row.version, data: data(JSON.parse(row.data)), wrapped: wrapped(JSON.parse(row.wrapped)) };
}
export function admit(db: DatabaseSync, id: string) {
  // No await between count, duplicate check and INSERT: one process owns this DB.
  if (db.prepare('SELECT id FROM objects WHERE id=?').get(id)) fail(409);
  const count = db.prepare('SELECT count(*) AS n FROM objects').get();
  if (!count || typeof count.n !== 'number' || count.n >= 16) fail(409);
}
export function insert(db: DatabaseSync, id: string, sealed: Data, key: Wrapped) {
  admit(db, id);
  db.prepare('INSERT INTO objects VALUES (?,1,?,?)').run(id, JSON.stringify(sealed), JSON.stringify(key));
}
export function replace(db: DatabaseSync, id: string, version: number, key: Wrapped) {
  if (version >= 8) fail(409);
  const result = db.prepare('UPDATE objects SET wrapped=?,version=version+1 WHERE id=? AND version=?').run(JSON.stringify(key), id, version);
  if (result.changes !== 1) fail(409);
}
