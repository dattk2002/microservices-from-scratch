// Independent, bounded test-only fault fixture. Never a lesson entrypoint.
import { serve, json, readJson } from '../../../lib/http.mts';
import { fail, record } from '../core.mts';
export async function main() {
  if (process.env.TEACHING_CONTROLS !== '1') throw new Error('Test controls required');
  const target = new URL(process.env.TARGET_ORIGIN ?? '');
  let mode = 'normal'; let leaks = 0;
  const pending = new Set<() => void>();
  await serve('fixture', 0, async (req, res) => {
    if (req.url === '/teaching/state' && req.method === 'GET') return json(res, 200, {pending:pending.size, leaks});
    if (req.url === '/leak') { leaks++; return json(res, 200, {}); }
    if (req.url === '/teaching/mode' && req.method === 'POST') {
      const v = record(await readJson(req));
      if (typeof v.mode !== 'string' || !['normal','malformed','oversized','redirect','wrong-dek','error','hold'].includes(v.mode)) fail();
      mode = v.mode; leaks = 0;
      if (mode === 'normal') { for (const release of pending) release(); pending.clear(); }
      return json(res, 200, {});
    }
    if (req.method !== 'POST' || (req.url !== '/wrap' && req.url !== '/unwrap')) fail(404);
    const value = record(await readJson(req));
    if (req.url === '/wrap') {
      if (mode === 'hold') {
        if (pending.size >= 8) fail(503);
        await new Promise<void>(resolve => {
          const release = () => { pending.delete(release); resolve(); };
          pending.add(release); res.once('close', release);
        });
        if (res.destroyed) return;
      }
      if (mode === 'error') return json(res, 503, {});
      if (mode === 'redirect') { res.writeHead(307, {location:new URL('/leak', process.env.REDIRECT_ORIGIN ?? target).href}); res.end(); return; }
      if (mode === 'malformed') return json(res, 200, {kekId:'v1',iv:[],tag:'',ciphertext:''});
      if (mode === 'wrong-dek') value.dek = Buffer.alloc(32, 99).toString('base64');
    }
    const response = await fetch(new URL(req.url, target), {method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(value),signal:AbortSignal.timeout(2000)});
    const text = await response.text();
    res.writeHead(response.status, {'content-type':'application/json'});
    // Still valid JSON with a completely valid envelope: only the byte budget is violated.
    res.end(req.url === '/wrap' && mode === 'oversized' ? text + ' '.repeat(513) : text);
  });
}
if (import.meta.main) await main();
