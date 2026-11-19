import { json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { download, objectOrigin } from './download.mts';
import { fail, replyError, validResumeBody } from './protocol.mts';

async function main(): Promise<void> {
  const origin = objectOrigin(process.env.OBJECT_ORIGIN);
  const nativeServer = await serve('downloader', 8083, async (req, res) => {
    try {
      const [route, query] = (req.url ?? '/').split('?', 2);
      if (route !== '/resume') fail(404, 'not_found');
      if (query !== undefined) fail(400, 'invalid_request');
      if (req.method !== 'POST') methodNotAllowed(res, 'POST');
      const body = await readJson(req);
      if (!validResumeBody(body)) fail(400, 'invalid_request');
      json(res, 200, await download(origin, body));
    } catch (error) {
      replyError(res, error);
    }
  });
  nativeServer.maxHeadersCount = 0;
}

if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
