import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { fail, invalid, parseRevision, parseShardPage, requestTarget, validateHost } from './protocol.mts';
import { ShardStore } from './store.mts';

function expectMethod(req: IncomingMessage, res: ServerResponse, method: string): void {
  if (req.method === method) return;
  res.setHeader('allow', method);
  fail(405, 'method_not_allowed');
}

function shardHandler(store: ShardStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { path, search } = requestTarget(req.url);
    try {
      if (path === '/publish') {
        expectMethod(req, res, 'POST');
        if (search !== null) invalid();
        json(res, 200, store.publish(await readJson(req)));
        return;
      }

      const item = /^\/items\/([^/]*)$/.exec(path);
      if (item) {
        expectMethod(req, res, 'PUT');
        if (search !== null) invalid();
        json(res, 200, store.write(item[1], await readJson(req)));
        return;
      }

      const page = /^\/snapshots\/([^/]*)\/page$/.exec(path);
      if (page) {
        expectMethod(req, res, 'GET');
        json(res, 200, store.page(parseRevision(page[1]), parseShardPage(search)));
        return;
      }
      fail(404, 'not_found');
    } catch (error) {
      if (error instanceof HttpError) fail(error.status, error.code);
      fail(500, 'internal_error');
    }
  };
}

async function main(): Promise<void> {
  validateHost(process.env.HOST);
  const shard = process.env.SHARD_ID;
  if (shard !== 'a' && shard !== 'b') throw new Error('SHARD_ID must be a or b');
  const file = process.env.DB_PATH;
  if (!file || file === ':memory:' || file.startsWith('file:')) throw new Error('Private DB_PATH file required');

  // SQLite can emit a warning on Node 24.12. Load it only when launching this service.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const store = new ShardStore(db, shard);
    const server = await serve(`keyset-shard-${shard}`, 3076, shardHandler(store));
    server.once('close', () => db.close());
  } catch (error) {
    db.close();
    throw error;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  });
}
