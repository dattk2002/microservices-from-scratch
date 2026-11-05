import { HttpError, json, numberSetting, serve } from '../../lib/http.mts';
import { id } from './model.mts';
import { LEGACY_LIMIT, translate } from './translation.mts';
import { invalidUpstream, origin, upstream } from './transport.mts';
export async function main() {
  const provider = origin(process.env.LEGACY_ORIGIN);
  const deadline = numberSetting('UPSTREAM_MS', 200, 20, 2000);
  return serve('adapter',3030,async (req,res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method !== 'GET' || !url.pathname.startsWith('/products/')) {json(res,404,{error:'not_found'}); return;}
    let key: string;
    try {key=id(decodeURIComponent(url.pathname.slice(10)));} catch {throw new HttpError(400,'invalid_id','Invalid id');}
    try {
      const raw = await upstream(`${provider}/catalog/${encodeURIComponent(key)}`, LEGACY_LIMIT, deadline);
      json(res,200,invalidUpstream(() => translate(raw,key)));
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      json(res,error.status,{error:error.code});
    }
  });
}
if (import.meta.main) await main();
