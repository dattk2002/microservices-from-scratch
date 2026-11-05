import { HttpError, json, numberSetting, readJson, serve } from '../../lib/http.mts';
import { canonical, CANONICAL_LIMIT, exact, id, integer, object } from './model.mts';
import { invalidUpstream, origin, upstream } from './transport.mts';
export function quoteInput(value: unknown): {productId: string; quantity: number} {
  const body=object(value); exact(body,['productId','quantity']);
  return {productId:id(body.productId),quantity:integer(body.quantity,1,1000)};
}
export async function main() {
  const products=origin(process.env.PRODUCTS_ORIGIN);
  const deadline=numberSetting('UPSTREAM_MS',500,20,3000);
  return serve('orders',3031,async (req,res) => {
    if (req.method !== 'POST' || req.url !== '/quotes') {json(res,404,{error:'not_found'}); return;}
    const raw=await readJson(req);
    let input: ReturnType<typeof quoteInput>;
    try {input=quoteInput(raw);} catch {throw new HttpError(400,'invalid_quote','Invalid quote input');}
    const value=await upstream(`${products}/products/${input.productId}`,CANONICAL_LIMIT,deadline);
    const product=invalidUpstream(() => canonical(value,input.productId));
    if (product.availability === 'unavailable' || product.availableUnits < input.quantity) throw new HttpError(409,'unavailable','Insufficient available units');
    const total=BigInt(product.unitCents)*BigInt(input.quantity);
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new HttpError(422,'total_overflow','Quote total too large');
    json(res,200,{productId:product.id,quantity:input.quantity,unitCents:product.unitCents,currency:product.currency,totalCents:Number(total)});
  });
}
if (import.meta.main) await main();
