import { json } from '../../lib/http.mts';
import { fail, parseAfter, parseOrigin } from './contracts.mts';
import { methodNotAllowed, noContent, requestTarget, requireNoBody } from './http.mts';
import { createObserver } from './permits.mts';
import { requestChanges } from './request-once.mts';
import { isDirectRun, serveLesson } from './server.mts';

export async function main(): Promise<void> {
  const origin = parseOrigin(process.env.ORIGIN_ORIGIN ?? 'http://127.0.0.1:3088');
  const observe = createObserver((after, signal) => requestChanges(origin, after, signal));
  await serveLesson('observer', 4088, async (req, res, signal) => {
    const { path, query } = requestTarget(req);
    if (path !== '/changes') fail(404, 'not_found');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const after = parseAfter(query);
    requireNoBody(req);

    const result = await observe(after, signal);
    signal.throwIfAborted();
    if (result.status === 200) json(res, 200, result.snapshot);
    else if (result.status === 204) noContent(res);
    else fail(result.status, result.code);
  }, port => {
    if (Number(origin.port || 80) === port) throw new Error('ORIGIN_ORIGIN points to the observer itself');
  });
}

if (isDirectRun(import.meta.url)) await main();
