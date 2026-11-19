import { once } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';
import { json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { parseOriginValue, parsePutValue } from './contracts.mts';
import type { OriginValue } from './contracts.mts';
import { fail, lessonHandler, pathOf, requireNoBody } from './http-contract.mts';

export function prepareAdvance(db: DatabaseSync): (value: number) => OriginValue | undefined {
  const advance = db.prepare(`
    UPDATE snapshot SET version = version + 1, value = ?
    WHERE id = 1 AND version < 16 AND value <> ?
    RETURNING version, value
  `);
  return value => {
    // Finish stepping RETURNING so SQLite commits or throws before the handler replies.
    const [row] = advance.all(value, value);
    return row === undefined ? undefined : parseOriginValue(row);
  };
}

export async function main(): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(process.env.DB_PATH ?? 'swr-origin.sqlite');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL CHECK (version BETWEEN 0 AND 16),
        value INTEGER NOT NULL CHECK (value BETWEEN 0 AND 100)
      ) STRICT;
      INSERT INTO snapshot (id, version, value) VALUES (1, 0, 0) ON CONFLICT (id) DO NOTHING;
    `);
    const select = db.prepare('SELECT version, value FROM snapshot WHERE id = 1');
    const advance = prepareAdvance(db);
    let reads = 0;

    const server = await serve('swr-origin', 3085, lessonHandler(async (req, res) => {
      const path = pathOf(req);
      if (path === '/stats') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        requireNoBody(req);
        json(res, 200, { reads });
        return;
      }

      if (path !== '/value') fail(404, 'not_found');

      if (req.method === 'GET') {
        requireNoBody(req);
        const value = parseOriginValue(select.get());
        reads = Math.min(reads + 1, Number.MAX_SAFE_INTEGER);
        json(res, 200, value);
        return;
      }

      if (req.method !== 'PUT') methodNotAllowed(res, 'GET, PUT');
      const body = await readJson(req);
      let value: number;
      try {
        value = parsePutValue(body);
      } catch {
        fail(400, 'invalid_body');
      }

      // The conditional update makes the value and increment one atomic write.
      const row = advance(value);
      if (row) {
        json(res, 200, row);
        return;
      }

      // This DB is private. No other handler can interleave these synchronous statements.
      const current = parseOriginValue(select.get());
      if (value !== current.value) fail(409, 'revision_exhausted');
      json(res, 200, current);
    }));
    server.maxHeadersCount = 0;
    try {
      await once(server, 'close');
    } finally {
      if (server.listening) {
        server.close();
        server.closeAllConnections();
      }
    }
  } finally {
    db.close();
  }
}

if (import.meta.main) await main();
