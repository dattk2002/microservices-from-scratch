import { performance } from 'node:perf_hooks';
import { json } from '../../lib/http.mts';
import { fail, parseAfter, parseValue } from './contracts.mts';
import { prepareDocument, putDocument } from './document.mts';
import { methodNotAllowed, noContent, readRequestJson, requestTarget, requireNoBody } from './http.mts';
import { isDirectRun, serveLesson } from './server.mts';
import { createWaiters } from './waiters.mts';

export async function main(): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(process.env.DB_PATH ?? 'revision-document.sqlite');
  try {
    const store = prepareDocument(db);
    const waiters = createWaiters({
      read: store.read,
      now: () => performance.now(),
      schedule: setTimeout,
      cancel: clearTimeout,
    });

    try {
      await serveLesson('origin', 3088, async (req, res, signal, started) => {
        const { path, query } = requestTarget(req);
        if (path === '/document') {
          if (req.method !== 'GET' && req.method !== 'PUT') methodNotAllowed(res, 'GET, PUT');
          if (query !== undefined) fail(400, 'invalid_query');
          if (req.method === 'GET') {
            requireNoBody(req);
            json(res, 200, store.read());
            return;
          }
          const value = parseValue(await readRequestJson(req, started, signal));
          signal.throwIfAborted();
          json(res, 200, putDocument(store, value, waiters.notify));
          return;
        }
        if (path === '/changes') {
          if (req.method !== 'GET') methodNotAllowed(res, 'GET');
          const after = parseAfter(query);
          requireNoBody(req);
          const snapshot = await waiters.poll(after, signal);
          signal.throwIfAborted();
          if (snapshot === null) noContent(res);
          else json(res, 200, snapshot);
          return;
        }
        if (path === '/stats') {
          if (req.method !== 'GET') methodNotAllowed(res, 'GET');
          if (query !== undefined) fail(400, 'invalid_query');
          requireNoBody(req);
          json(res, 200, { waiting: waiters.waiting });
          return;
        }
        fail(404, 'not_found');
      });
    } finally {
      waiters.shutdown();
    }
  } finally {
    db.close();
  }
}

if (isDirectRun(import.meta.url)) await main();
