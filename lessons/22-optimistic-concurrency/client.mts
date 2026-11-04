import { HttpError, json, methodNotAllowed, numberSetting, readJson, serve } from '../../lib/http.mts';
import { parseMatch, valueInput } from './model.mts';

export async function main() {
  const url = new URL(process.env.OWNER_URL ?? '');
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('OWNER_URL must be loopback HTTP origin');
  const deadline = numberSetting('DEADLINE_MS', 500, 10, 5000);
  return serve('editor', 3023, async (req, res) => {
    if (req.url !== '/resource') throw new HttpError(404, 'not_found', 'Use /resource');
    if (req.method !== 'GET' && req.method !== 'PUT' && req.method !== 'PATCH') methodNotAllowed(res, 'GET, PUT, PATCH');
    const headers: Record<string,string> = {};
    let body: string | undefined;
    if (req.method !== 'GET') {
      if (req.rawHeaders.filter((h,i) => i % 2 === 0 && h.toLowerCase() === 'if-match').length > 1) throw new HttpError(400, 'invalid_if_match', 'Exactly one field required');
      parseMatch(req.headers['if-match']);
      headers['if-match'] = req.headers['if-match']!;
      headers['content-type'] = 'application/json';
      body = JSON.stringify({value:valueInput(await readJson(req))});
    }
    const signal = AbortSignal.timeout(deadline);
    try {
      const response = await fetch(new URL('/resource', url), {method:req.method, headers, ...(body === undefined ? {} : {body}), signal});
      const bytes = await response.text(); // Deadline includes consuming the response.
      const tag = response.headers.get('etag');
      if (tag) res.setHeader('etag', tag);
      res.writeHead(response.status, {'content-type':'application/json', 'cache-control':'no-store'});
      res.end(bytes);
    } catch {
      json(res, signal.aborted ? 504 : 503, {error:{code:signal.aborted ? 'owner_deadline' : 'owner_unavailable', message:'Outcome may be unknown; re-read before deciding'}});
    }
  });
}
if (import.meta.main) await main();
