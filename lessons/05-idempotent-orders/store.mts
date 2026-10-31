import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
import type { OrderInput, Product } from './contract.mts';

export type Replay = { status: number; body: string };
export function conflict(): never {
  throw new HttpError(409, 'idempotency_conflict', 'This key already belongs to different normalized input');
}

export class OrderStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path, { timeout: 1000 });
    try {
      this.#db.exec('PRAGMA foreign_keys = ON');
      const version = this.#db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1) throw new Error('Unsupported Orders database schema');
      this.#db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS orders (
          id TEXT PRIMARY KEY, snapshot TEXT NOT NULL CHECK(json_valid(snapshot))
        );
        CREATE TABLE IF NOT EXISTS replays (
          key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
          order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
          status INTEGER NOT NULL CHECK(status = 201), body TEXT NOT NULL CHECK(json_valid(body))
        );
        PRAGMA user_version = 1;
        COMMIT;`);
    } catch (error) { this.#db.close(); throw error; }
  }
  find(key: string, expected: string): Replay | undefined {
    const row = this.#db.prepare('SELECT fingerprint, status, body FROM replays WHERE key = ?').get(key);
    if (!row) return undefined;
    if (row.fingerprint !== expected) conflict();
    if (row.status !== 201 || typeof row.body !== 'string') throw new Error('Corrupt replay record');
    return { status: row.status, body: row.body };
  }
  complete(key: string, hash: string, input: OrderInput, product: Product): Replay {
    // All statements below are synchronous. Never await while holding the write lock.
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.find(key, hash);
      if (existing) { this.#db.exec('COMMIT'); return existing; }
      const id = randomUUID();
      const body = JSON.stringify({ id, product, quantity: input.quantity, totalCents: product.priceCents * input.quantity });
      this.#db.prepare('INSERT INTO orders(id, snapshot) VALUES (?, ?)').run(id, body);
      this.#db.prepare('INSERT INTO replays(key, fingerprint, order_id, status, body) VALUES (?, ?, ?, 201, ?)')
        .run(key, hash, id, body);
      this.#db.exec('COMMIT');
      return { status: 201, body };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void { this.#db.close(); }
}
