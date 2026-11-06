import { HttpError, json, serve } from '../../lib/http.mts';
import { CONTROL_BYTES, REQUEST_MS, readBytes } from './transport.mts';

// Provider owns its own fixtures, states and revisions; no consumer imports.
const revisions = ['compatible', 'additive', 'removal', 'type', 'status', 'oversized', 'slow'] as const;
type Revision = typeof revisions[number];
function revision(value: unknown): Revision {
  if (typeof value !== 'string') throw new HttpError(400, 'revision', 'revision must be a string');
  for (const candidate of revisions) if (candidate === value) return candidate;
  throw new HttpError(400, 'revision', 'unknown revision');
}
export async function main() {
  const teaching = process.env.TEACHING_CONTROLS === '1';
  let current: Revision = 'compatible';
  let requests = 0;
  return serve('contract-provider', 3131, async (req, res) => {
    if (req.url === '/__teaching' && teaching) {
      if (req.method === 'GET') return json(res, 200, {revision: current, requests});
      if (req.method !== 'POST') throw new HttpError(405, 'method', 'Use POST or GET');
      if (req.headers['content-type'] !== 'application/json') throw new HttpError(415, 'content_type', 'Use application/json');
      let body: unknown;
      const timer = setTimeout(() => req.destroy(), REQUEST_MS);
      try { body = JSON.parse((await readBytes(req.iterator({destroyOnReturn: false}), CONTROL_BYTES)).toString('utf8')); }
      catch {
        req.resume();
        res.setHeader('connection', 'close');
        throw new HttpError(400, 'body', 'Invalid or oversized control body');
      } finally { clearTimeout(timer); }
      if (typeof body !== 'object' || body === null || Array.isArray(body) || !('revision' in body) || Object.keys(body).length !== 1) throw new HttpError(400, 'body', 'Expected revision only');
      current = revision(body.revision);
      return json(res, 200, {revision: current});
    }
    if (req.method !== 'GET') throw new HttpError(405, 'method', 'Use GET');
    if (req.url !== '/products/tea' && req.url !== '/products/absent') throw new HttpError(404, 'route', 'Unknown route');
    requests++;
    const selected = current;
    if (selected === 'slow') {
      // Timer is bounded and cancelled when the upstream client aborts.
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); res.off('close', finish); resolve(); };
        const timer = setTimeout(finish, 800);
        res.once('close', finish);
      });
      if (res.destroyed) return;
    }
    if (req.url === '/products/absent') return json(res, 404, {code: 'PRODUCT_MISSING'});
    if (selected === 'removal') return json(res, 200, {id: 'tea'});
    if (selected === 'type') return json(res, 200, {id: 'tea', priceCents: '1250'});
    if (selected === 'status') return json(res, 201, {id: 'tea', priceCents: 1250});
    if (selected === 'additive') return json(res, 200, {id: 'tea', priceCents: 1250, note: '\u0000'.repeat(256)});
    // Valid identity/schema/status; only the byte budget differs from a legal reply.
    if (selected === 'oversized') return json(res, 200, {id: 'tea', priceCents: 1250, note: 'x'.repeat(2048)});
    return json(res, 200, {id: 'tea', priceCents: 1250});
  });
}
if (import.meta.main) await main();
