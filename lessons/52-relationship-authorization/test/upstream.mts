import { HttpError, json, readJson, serve } from '../../../lib/http.mts';
import { member, record } from '../contract.mts';
export async function main() {
 let mode='invalid', redirectHits=0;
 const redirectOrigin = process.env.REDIRECT_ORIGIN;
 await serve('fixture',0,async(req,res) => {
  if (req.url === '/mode' && req.method === 'POST') { const b=record(await readJson(req)); mode=member(b.mode,['invalid','oversized','slow','redirect','low','denied','future','unavailable']); redirectHits=0; json(res,200,{}); return; }
  if (req.url === '/counts') { json(res,200,{redirectHits}); return; }
  // A followed redirect must fail the counter assertion even if the final
  // malformed decision still makes documents return502.
  if (req.url === '/target') { redirectHits++; json(res,200,{allowed:'invalid',revision:1}); return; }
  if (req.url !== '/check') throw new HttpError(404,'missing','Missing');
  await readJson(req);
  if (mode === 'unavailable') { res.destroy(); return; }
  if (mode === 'slow') { const timer=setTimeout(() => json(res,200,{allowed:true,revision:1}),1100); res.once('close',() => clearTimeout(timer)); return; }
  if (mode === 'redirect') { res.writeHead(307,{location:`${redirectOrigin ?? 'http://127.0.0.1:1'}/target`}); res.end(); return; }
  if (mode === 'future') { json(res,409,{error:{code:'future_revision',message:'Minimum revision unavailable'}}); return; }
  json(res,200,mode === 'invalid' ? {allowed:'true',revision:1} : {allowed:mode !== 'denied',revision:mode === 'low' ? 0 : 1,...(mode === 'oversized' ? {padding:'x'.repeat(1024)} : {})});
 });
}
if (import.meta.main) await main();
