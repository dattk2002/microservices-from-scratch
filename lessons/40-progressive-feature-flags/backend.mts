import {serve, json} from '../../lib/http.mts';
export async function main() {
  const variant = process.env.VARIANT ?? 'stable';
  if (variant !== 'stable' && variant !== 'canary') throw new Error('Invalid VARIANT');
  await serve(`backend-${variant}`,4041,(req,res) => {
    if (req.method !== 'GET' || req.url !== '/hello') { json(res,404,{error:'not_found'}); return; }
    json(res,200,{variant});
  });
}
if (import.meta.main) await main();
