import { HttpError, json, serve } from '../../lib/http.mts';
import { consume, quote } from './client.mts';
import { loopbackOrigin, TOTAL_MS } from './transport.mts';

export async function main() {
  const origin = loopbackOrigin(process.env.PROVIDER_ORIGIN);
  let busy = false;
  return serve('contract-consumer', 3132, async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method', 'Use GET');
    const id = req.url === '/quote/tea' ? 'product-found' : req.url === '/quote/absent' ? 'product-missing' : undefined;
    if (!id) throw new HttpError(404, 'route', 'Unknown route');
    if (busy) throw new HttpError(429, 'busy', 'One request at a time');
    busy = true;
    try {
      const product = await consume(origin, id, AbortSignal.timeout(TOTAL_MS));
      json(res, product.kind === 'found' ? 200 : 404, quote(product));
    } catch { json(res, 502, {error: 'provider_contract_or_transport'}); }
    finally { busy = false; }
  });
}
if (import.meta.main) await main();
