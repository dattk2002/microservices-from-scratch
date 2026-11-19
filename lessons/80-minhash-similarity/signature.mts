import { json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { fail, replyError } from './errors.mts';
import { validValueBody } from './model.mts';
import { SignatureStore } from './store.mts';

export function databasePath(path: string | undefined): string {
  if (!path || path === ':memory:' || /^file:/i.test(path)) {
    throw new Error('DB_PATH must name a private SQLite file');
  }
  return path;
}

async function main(): Promise<void> {
  const id = process.env.SET_ID;
  if (id !== 'a' && id !== 'b') throw new Error('SET_ID must be a or b');
  const path = databasePath(process.env.DB_PATH);

  // Node 24.12 emits a warning when SQLite loads. Keep it out of entrypoint imports.
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    const store = new SignatureStore(db, id);
    const server = await serve('minhash-signature', 8081, async (req, res) => {
      try {
        const [route, query] = (req.url ?? '/').split('?', 2);
        if (route !== '/signature' && route !== '/values') fail(404, 'not_found');
        if (query !== undefined) fail(400, 'invalid_request');
        if (route === '/signature') {
          if (req.method !== 'GET') methodNotAllowed(res, 'GET');
          json(res, 200, store.snapshot());
          return;
        }
        if (req.method !== 'POST') methodNotAllowed(res, 'POST');
        const body = await readJson(req);
        if (!validValueBody(body)) fail(400, 'invalid_request');
        json(res, 200, store.add(body.value));
      } catch (error) {
        replyError(res, error);
      }
    });
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
