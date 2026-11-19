import { json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { errorBody, fail, isObjectId, replyError, selectRange, validPutBody } from './protocol.mts';
import { ObjectStore } from './store.mts';

async function main(): Promise<void> {
  const path = process.env.DB_PATH;
  if (!path?.trim() || path === ':memory:' || /^file:/i.test(path)) {
    throw new Error('DB_PATH must name a private SQLite file');
  }

  // Node 24.12 can emit a warning when SQLite loads. Imports of this entrypoint
  // must stay inert even on that version.
  const {DatabaseSync} = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    const store = new ObjectStore(db);
    const server = await serve('object', 8082, async (req, res) => {
      try {
        const [route, query] = (req.url ?? '/').split('?', 2);
        const match = route?.match(/^\/objects\/([^/]*)$/);
        if (!match) fail(404, 'not_found');
        const id = match[1];
        if (query !== undefined || !isObjectId(id)) fail(400, 'invalid_request');

        if (req.method === 'PUT') {
          const body = await readJson(req);
          if (!validPutBody(body)) fail(400, 'invalid_request');
          const {created, etag, size} = store.put(id, body.text);
          json(res, created ? 201 : 200, {etag, size});
          return;
        }
        if (req.method !== 'GET') methodNotAllowed(res, 'GET, PUT');

        const object = store.get(id);
        if (!object) fail(404, 'unknown_object');
        const {bytes, etag} = object;
        const range = selectRange(req.headersDistinct.range?.join(','),
          req.headersDistinct['if-range']?.join(','), etag, bytes.length);
        res.setHeader('etag', etag);
        res.setHeader('accept-ranges', 'bytes');
        if (range.kind === 'unsatisfiable') {
          res.setHeader('content-range', `bytes */${bytes.length}`);
          json(res, 416, errorBody('range_not_satisfiable'));
          return;
        }
        let body = bytes;
        if (range.kind === 'partial') {
          res.setHeader('content-range', `bytes ${range.start}-${range.end}/${bytes.length}`);
          body = bytes.subarray(range.start, range.end + 1);
        }
        res.writeHead(range.kind === 'partial' ? 206 : 200, {
          'content-type': 'application/octet-stream',
          'content-length': body.byteLength,
        });
        res.end(body);
      } catch (error) {
        replyError(res, error);
      }
    });
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
