import { HttpError, json, methodNotAllowed, serve } from '../../lib/http.mts';

export async function startDownstream() {
  let entered = 0;
  return serve('token-downstream', 4411, (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/work' && url.pathname !== '/stats') throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    if (url.search) throw new HttpError(400, 'invalid_query', 'No query parameters supported');
    if (url.pathname === '/stats') { json(res, 200, { entered }); return; }
    entered++;
    json(res, 200, { state: 'ok' });
  });
}
if (import.meta.main) await startDownstream();
