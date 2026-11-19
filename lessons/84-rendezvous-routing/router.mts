import { json, readJson, serve } from '../../lib/http.mts';
import { MembershipStore } from './membership.mts';
import { ownerFor } from './placement.mts';
import { fail, isKey, replyError, requestPath, requireEmptyBody, requireMethod } from './protocol.mts';
import { fetchLookup, memberOrigins } from './upstream.mts';

async function main(): Promise<void> {
  const origins = memberOrigins(process.env.MEMBER_A_ORIGIN, process.env.MEMBER_B_ORIGIN, process.env.MEMBER_C_ORIGIN);
  const path = process.env.DB_PATH;
  if (!path || path === ':memory:') throw new Error('DB_PATH must name a private SQLite file');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path);
  try {
    const store = new MembershipStore(db);
    const server = await serve('rendezvous-router', 8080, async (req, res) => {
      try {
        const route = requestPath(req);
        if (route === '/membership') {
          requireMethod(req, res, 'PUT');
          json(res, 200, store.update(await readJson(req)));
          return;
        }
        if (!route.startsWith('/route/')) fail(404, 'not_found');
        requireMethod(req, res, 'GET');
        requireEmptyBody(req);
        const key = route.slice('/route/'.length);
        if (!isKey(key)) fail(400, 'invalid_key');

        // Capture both revision and placement before waiting on the selected backend.
        const { revision, members } = store.read();
        const owner = ownerFor(key, members);
        const value = await fetchLookup(origins[owner], owner, key);
        json(res, 200, { revision, members, owner, key, value });
      } catch (error) {
        replyError(res, error);
      }
    });
    // Preserve framing headers beyond Node's default field-count truncation.
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
