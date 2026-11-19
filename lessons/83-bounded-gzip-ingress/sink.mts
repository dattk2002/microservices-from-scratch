import type { DatabaseSync } from 'node:sqlite';
import { json, serve } from '../../lib/http.mts';
import { readMessage } from './body.mts';
import { endpoint, problem, requestEncoding, requireMethod, validId } from './protocol.mts';
import type { Message } from './protocol.mts';

const CAPACITY = 16;

export function databasePath(raw: string | undefined): string {
  if (!raw?.trim() || raw.includes('\0') || raw === ':memory:' || /^file:/i.test(raw)) {
    throw new Error('DB_PATH must name a private SQLite file');
  }
  return raw;
}

class ReceiptStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec(`
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
  }

  count(): number {
    const count = this.#db.prepare('SELECT count(*) AS count FROM messages').get()?.count;
    if (typeof count !== 'number') throw new Error('Invalid receipt count');
    return count;
  }

  get(id: string): Message | undefined {
    const row = this.#db.prepare('SELECT text FROM messages WHERE id = ?').get(id);
    if (row === undefined) return;
    if (typeof row.text !== 'string') throw new Error('Invalid stored message');
    return {id, text: row.text};
  }

  register(message: Message): boolean {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.get(message.id);
      if (prior) {
        if (prior.text !== message.text) throw problem(409, 'id_conflict');
      } else {
        if (this.count() >= CAPACITY) throw problem(429, 'capacity');
        this.#db.prepare('INSERT INTO messages (id, text) VALUES (?, ?)').run(message.id, message.text);
      }
      this.#db.exec('COMMIT');
      return prior !== undefined;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const path = databasePath(process.env.DB_PATH);
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    const receipts = new ReceiptStore(db);
    let requests = 0;
    const server = await serve('sink', 8084, endpoint(async (req, res, acceptedAt, signal) => {
      const [route, query] = (req.url ?? '/').split('?', 2);
      if (route === '/messages' && req.method === 'POST') requests++;
      if (query !== undefined) throw problem(400, 'invalid_request');

      if (route === '/messages') {
        requireMethod(req, res, 'POST');
        if (requestEncoding(req.headersDistinct) !== 'identity') throw problem(415, 'unsupported_encoding');
        const message = await readMessage(req, 'identity', {acceptedAt, signal});
        const duplicate = receipts.register(message);
        json(res, duplicate ? 200 : 201, {id: message.id, duplicate});
        return;
      }
      if (route === '/stats') {
        requireMethod(req, res, 'GET');
        json(res, 200, {count: receipts.count(), requests});
        return;
      }
      if (route?.startsWith('/messages/')) {
        const id = route.slice('/messages/'.length);
        if (validId(id)) {
          requireMethod(req, res, 'GET');
          const message = receipts.get(id);
          if (message) {
            json(res, 200, message);
            return;
          }
        }
      }
      throw problem(404, 'not_found');
    }));
    server.maxHeadersCount = 0;
    server.once('close', () => db.close());
  } catch (error) {
    db.close();
    throw error;
  }
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
