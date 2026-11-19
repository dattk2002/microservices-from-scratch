import { json, serve } from '../../lib/http.mts';
import { fail, isKey, isMember, replyError, requestPath, requireEmptyBody, requireMethod } from './protocol.mts';

async function main(): Promise<void> {
  const member = process.env.MEMBER_ID;
  if (!isMember(member)) throw new Error('MEMBER_ID must be a, b or c');
  let requests = 0;

  const server = await serve('rendezvous-backend', 8081, (req, res) => {
    try {
      const path = requestPath(req);
      if (path === '/stats') {
        requireMethod(req, res, 'GET');
        requireEmptyBody(req);
        json(res, 200, { requests });
        return;
      }
      if (!path.startsWith('/lookup/')) fail(404, 'not_found');
      requireMethod(req, res, 'GET');
      requireEmptyBody(req);
      const key = path.slice('/lookup/'.length);
      if (!isKey(key)) fail(400, 'invalid_key');
      requests = Math.min(requests + 1, Number.MAX_SAFE_INTEGER);
      json(res, 200, { member, key, value: `${member}/${key}` });
    } catch (error) {
      replyError(res, error);
    }
  });
  // The HTTP parser still enforces its finite header-byte limit.
  server.maxHeadersCount = 0;
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
