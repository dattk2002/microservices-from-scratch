import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { fail, isSource, parseEvent, validateHost } from './protocol.mts';
import { StreamStore } from './store.mts';

const DEFAULT_PORT = 3077;

function streamHandler(store: StreamStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const target = req.url ?? '/';
    const path = target.split('?', 1)[0];
    if (path !== '/events' && path !== '/summary') fail(404, 'not_found');
    const method = path === '/events' ? 'POST' : 'GET';
    if (req.method !== method) {
      res.setHeader('allow', method);
      fail(405, 'method_not_allowed');
    }
    if (target !== path) fail(400, 'invalid_request');
    if (path === '/summary') {
      json(res, 200, store.summary());
      return;
    }

    // Keep the shared reader's statuses and use the lesson's fixed error messages.
    const body = await readJson(req).catch((error: unknown) => {
      if (error instanceof HttpError) fail(error.status, error.code);
      throw error;
    });
    const event = parseEvent(body);
    if (!event) fail(400, 'invalid_request');
    const receipt = store.append(event);
    json(res, receipt.duplicate ? 200 : 201, receipt);
  };
}

async function main(): Promise<void> {
  validateHost(process.env.HOST);
  const id = process.env.STREAM_ID;
  const file = process.env.DB_PATH;
  if (!isSource(id)) throw new Error('STREAM_ID must be a or b');
  if (!file || file.trim() === '' || file === ':memory:' || file.startsWith('file:')) {
    throw new Error('DB_PATH must name a private SQLite file');
  }
  // A runtime import here keeps entrypoint imports silent on Node 24.12.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const store = new StreamStore(db, id);
    const server = await serve(`mg77-stream-${id}`, DEFAULT_PORT, streamHandler(store));
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
