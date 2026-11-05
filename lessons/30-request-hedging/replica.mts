import { serve, json, readJson, HttpError } from '../../lib/http.mts';
import { validId, MAX_BODY } from './protocol.mts';
export function modeFrom(raw: unknown): string {
  if (typeof raw !== 'string' || !['normal', 'hold', 'malformed', 'transient', 'fatal', 'oversized', 'maximal', 'wrong-id'].includes(raw)) throw new HttpError(400, 'mode', 'Invalid string mode');
  return raw;
}
export async function main() {
  if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1') throw new Error('Loopback only');
  let mode = 'normal'; let received = 0; let active = 0; let cancelled = 0;
  const held = new Set<() => void>(); const controls = process.env.TEACHING_CONTROLS === '1';
  return serve('read-replica', 3031, async (req, res) => {
    if (req.url === '/stats' && req.method === 'GET') { json(res, 200, {received, active, cancelled, held: held.size}); return; }
    if (controls && req.url === '/control' && req.method === 'POST') {
      const raw = await readJson(req);
      if (typeof raw !== 'object' || raw === null || !('mode' in raw)) throw new HttpError(400, 'mode', 'mode required');
      mode = modeFrom(raw.mode); for (const release of [...held]) release(); json(res, 200, {mode}); return;
    }
    if (req.method !== 'GET') { req.resume(); json(res, 405, {error: 'read only'}); return; }
    const id = req.url?.slice('/items/'.length);
    if (!req.url?.startsWith('/items/') || !id || !validId(id)) { json(res, 404, {error: 'route'}); return; }
    received++; active++;
    let finished = false;
    const finish = () => { if (!finished) { finished = true; active--; } };
    res.once('finish', finish);
    let release = () => {};
    const close = () => { if (!res.writableEnded) { cancelled++; finish(); release(); } };
    res.once('close', close);
    try {
      if (mode === 'hold') await new Promise<void>(resolve => { release = () => { held.delete(release); resolve(); }; held.add(release); });
      if (res.destroyed) return;
      if (mode === 'fatal') json(res, 404, {error: 'missing'});
      else if (mode === 'transient') json(res, 503, {error: 'busy'});
      else if (mode === 'malformed') json(res, 200, {id, text: 123});
      else if (mode === 'wrong-id') json(res, 200, {id: id === 'other' ? 'another' : 'other', text: 'hello'});
      else if (mode === 'oversized') {
        res.writeHead(200, {'content-type':'application/json'});
        res.end(' '.repeat(MAX_BODY+1)+JSON.stringify({id,text:'hello'}));
      }
      else json(res, 200, {id, text: mode === 'maximal' ? '\u0000'.repeat(256) : 'hello'});
    } finally { held.delete(release); res.off('close', close); }
  });
}
if (import.meta.main) await main();
