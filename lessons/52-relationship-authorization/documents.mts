import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { documents, member, minimum, record, users } from './contract.mts';
export const texts: Readonly<Record<string,string>> = {plan:'Kế hoạch giả tưởng: trồng cây trên Mặt Trăng.',runbook:'Sổ tay giả tưởng: kiểm tra đèn của trạm Mây.'};
export async function main() {
 const origin = new URL(process.env.POLICY_ORIGIN ?? 'http://127.0.0.1:5252');
 if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid POLICY_ORIGIN');
 await serve('documents',5253,async(req,res) => {
  if (req.method !== 'POST' || req.url !== '/read') throw new HttpError(404,'not_found','Unknown route');
  const b = record(await readJson(req));
  const user = member(b.user,users), document = member(b.document,documents), minRevision = minimum(b.minRevision);
  let decision: {allowed:boolean;revision:number};
  try {
   const signal = AbortSignal.timeout(700);
   const response = await fetch(new URL('/check',origin),{method:'POST',redirect:'error',signal,headers:{'content-type':'application/json'},body:JSON.stringify({user,document,permission:'view',minRevision})});
   if (!response.body) throw new Error('Missing body');
   const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
   try { while (true) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > 1024) throw new Error('Large reply'); chunks.push(r.value); } }
   finally { await reader.cancel(); }
   const value = record(JSON.parse(Buffer.concat(chunks).toString('utf8')));
   if (response.status === 409 && minRevision > 0 && record(value.error).code === 'future_revision') throw new HttpError(409,'future_revision','Minimum revision unavailable');
   if (response.status !== 200 || typeof value.allowed !== 'boolean' || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < minRevision || value.revision > 64) throw new Error('Invalid decision');
   decision = {allowed:value.allowed,revision:value.revision};
  } catch(e) {
   if (e instanceof HttpError && e.status === 409) throw e;
   throw new HttpError(502,'policy_unavailable','Policy unavailable');
  }
  if (!decision.allowed) throw new HttpError(403,'denied','Access denied');
  json(res,200,{document,text:texts[document],policyRevision:decision.revision});
 });
}
if (import.meta.main) await main();
