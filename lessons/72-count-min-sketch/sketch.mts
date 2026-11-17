import type { IncomingMessage, ServerResponse } from 'node:http';
import { openSync, closeSync, fchmodSync } from 'node:fs';
import { serve, json, readJson, HttpError } from '../../lib/http.mts';
import { identity, invalid, semantic, validateHost } from './protocol.mts';
import { SketchStore } from './store.mts';

export function sketchHandler(store: SketchStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      const url = new URL(req.url ?? '/', 'http://sketch');
      if (url.search) invalid();
      if (url.pathname === '/snapshot') {
        if (req.method !== 'GET') { res.setHeader('allow', 'GET'); semantic(405, 'method_not_allowed'); }
        json(res, 200, store.snapshot()); return;
      }
      if (url.pathname === '/events') {
        if (req.method !== 'POST') { res.setHeader('allow', 'POST'); semantic(405, 'method_not_allowed'); }
        const result = store.accept(await readJson(req));
        json(res, result.duplicate ? 200 : 201, result); return;
      }
      semantic(404, 'not_found');
    } catch (error) {
      if (error instanceof HttpError) semantic(error.status, error.code);
      semantic(500, 'internal_error');
    }
  };
}

export async function main(): Promise<void> {
  validateHost(process.env.HOST);
  const id = process.env.SKETCH_ID, file = process.env.DB_PATH;
  if (!identity(id)) throw new Error('SKETCH_ID must be a or b');
  if (!file || file === ':memory:') throw new Error('DB_PATH must name a private database file');
  // The operator must give each logical source its own private path.
  const descriptor = openSync(file, 'a', 0o600);
  try { fchmodSync(descriptor, 0o600); }
  finally { closeSync(descriptor); }
  // Deliberately inside main: Node 24.12 emits an experimental SQLite warning
  // on module load, so even importing the entrypoint must not load node:sqlite.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const store = new SketchStore(db, id);
    const server = await serve(`count-min-${id}`, id === 'a' ? 3072 : 3073, sketchHandler(store));
    server.once('close', () => db.close());
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1;
});
