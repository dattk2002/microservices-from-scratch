import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { exact, id, object } from './model.mts';
export const scenarios = ['valid','v2','missing','unavailable','malformed','ambiguous','mismatch','currency','failure','slow','oversized','maximum','redirect'] as const;
export function scenario(value: unknown): string {
  if (typeof value !== 'string' || !scenarios.some(item => item === value)) throw new Error('unknown scenario');
  return value;
}
export async function main() {
  const controls = process.env.TEACHING_CONTROLS === '1';
  let mode = 'valid';
  return serve('legacy', 3029, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/teaching/scenario' && req.method === 'POST' && controls) {
      const body = object(await readJson(req));
      try { exact(body, ['scenario']); mode = scenario(body.scenario); }
      catch { throw new HttpError(400, 'invalid_scenario', 'Expected known string scenario'); }
      json(res, 200, {scenario: mode}); return;
    }
    if (req.method !== 'GET' || !url.pathname.startsWith('/catalog/')) { json(res,404,{error:'not_found'}); return; }
    let key: string;
    try { key = id(decodeURIComponent(url.pathname.slice(9))); } catch { throw new HttpError(400,'invalid_id','Invalid id'); }
    if (key === 'missing' || mode === 'missing') { json(res,404,{error:'not_found'}); return; }
    if (mode === 'failure') { json(res,503,{error:'temporary'}); return; }
    if (mode === 'redirect') { res.writeHead(302,{location:'/catalog/pen','content-type':'application/json'}); res.end('{}'); return; }
    if (mode === 'slow') { await new Promise<void>(resolve => { const timer = setTimeout(resolve, 700); res.once('close', () => {clearTimeout(timer); resolve();}); }); if (res.destroyed) return; }
    const value: Record<string, unknown> = mode === 'v2' ?
      {item:`N:${key}`,price:'12.34',money:'USD',boxes:3,units_per_box:4,state:'A',label:'Bút'} :
      {sku:`L:${key}`,unit_price:'12.34',currency:'USD',packs:3,pack_size:4,status:'A',description:'Bút'};
    if (mode === 'unavailable') {value.packs=0; value.status='O';}
    if (mode === 'malformed') value.unit_price='12.345';
    if (mode === 'ambiguous') value.price='12.34';
    if (mode === 'mismatch') value.sku='L:other';
    if (mode === 'currency') value.currency=['USD'];
    if (mode === 'oversized') value.description='x'.repeat(10000);
    if (mode === 'maximum') {value.description='\u0000'.repeat(80); value.unit_price='90071992547409.91'; value.packs=1000; value.pack_size=1000;}
    json(res,200,value);
  });
}
if (import.meta.main) await main();
