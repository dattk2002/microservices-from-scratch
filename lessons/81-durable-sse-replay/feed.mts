import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { databasePath, isEventPayload, parseCursor } from './contracts.mts';
import { fail, replyError } from './errors.mts';
import { encodeEvents } from './sse.mts';
import { FeedStore } from './store.mts';

export async function handleFeedRequest(store: FeedStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const target = req.url ?? '/';
    if (target.split('?', 1)[0] !== '/events') fail(404, 'not_found');
    if (target !== '/events') fail(400, 'invalid_request');
    if (req.method === 'POST') {
      const payload = await readJson(req);
      if (!isEventPayload(payload)) fail(400, 'invalid_request');
      const {created, sequence} = store.append(payload);
      json(res, created ? 201 : 200, {sequence});
      return;
    }
    if (req.method !== 'GET') methodNotAllowed(res, 'GET, POST');

    const header = req.headers['last-event-id'];
    const after = header === undefined ? 0 : typeof header === 'string' ? parseCursor(header) : undefined;
    if (after === undefined) fail(400, 'invalid_request');

    const wire = encodeEvents(store.capture(after));
    res.writeHead(200, {'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store'});
    res.end(wire);
  } catch (error) {
    replyError(res, error);
  }
}

async function main(): Promise<void> {
  const path = databasePath(process.env.DB_PATH);
  // Loading SQLite can emit a warning on the minimum supported Node version.
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    const store = new FeedStore(db);
    const server = await serve('feed', 8081, (req, res) => handleFeedRequest(store, req, res));
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
