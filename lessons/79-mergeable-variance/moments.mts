import { json, readJson } from '../../lib/http.mts';
import { fail, parseEvent, privateDatabaseFile } from './protocol.mts';
import { method, serveJson, start } from './service.mts';
import { MomentsStore } from './store.mts';

async function main(): Promise<void> {
  const id = process.env.MOMENTS_ID;
  if (id !== 'a' && id !== 'b') throw new Error('MOMENTS_ID must be a or b');
  const file = privateDatabaseFile(process.env.DB_PATH);

  // Node 24.12 may emit a SQLite warning. Load it only when starting the service.
  const { DatabaseSync } = await import('node:sqlite');
  process.umask(0o077);
  const db = new DatabaseSync(file);
  try {
    const store = new MomentsStore(db, id);
    const server = await serveJson(`moments-${id}`, 3079, async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.search) fail(400, 'invalid_request');

      switch (url.pathname) {
        case '/events': {
          method(req, res, 'POST');
          const receipt = store.accept(parseEvent(await readJson(req)));
          json(res, receipt.duplicate ? 200 : 201, receipt);
          return;
        }
        case '/snapshot':
          method(req, res, 'GET');
          json(res, 200, store.snapshot());
          return;
        default:
          fail(404, 'not_found');
      }
    });
    server.once('close', () => db.close());
  } catch (error) {
    db.close();
    throw error;
  }
}

if (import.meta.main) start(main);
