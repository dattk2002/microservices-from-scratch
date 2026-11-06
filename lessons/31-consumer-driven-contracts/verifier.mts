import { HttpError, json, serve } from '../../lib/http.mts';
import { catalogue } from './contracts.mts';
import { consume, quote } from './client.mts';
import { loopbackOrigin, TOTAL_MS } from './transport.mts';

export async function verify(origin: string) {
  const total = AbortSignal.timeout(TOTAL_MS);
  const results: {interaction: string; ok: boolean; mismatch?: string; value?: ReturnType<typeof quote>}[] = [];
  for (const item of catalogue) {
    try {
      const parsed = await consume(origin, item.id, total);
      results.push({interaction: item.id, ok: true, value: quote(parsed)});
    } catch (error) {
      // Only local validation messages are emitted; never serialize upstream bodies/URLs.
      results.push({interaction: item.id, ok: false, mismatch: error instanceof Error ? error.message : 'verification failed'});
    }
  }
  return {ok: results.every(item => item.ok), results};
}
export async function main() {
  const origin = loopbackOrigin(process.env.PROVIDER_ORIGIN);
  let busy = false;
  return serve('contract-verifier', 3133, async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method', 'Use GET');
    // No caller URL, query, request body or interaction list is accepted.
    if (req.url !== '/verify') throw new HttpError(404, 'route', 'Use /verify without query');
    if (req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) throw new HttpError(400, 'body', 'No body accepted');
    if (busy) throw new HttpError(429, 'busy', 'One verification at a time');
    busy = true;
    try {
      const report = await verify(origin);
      json(res, report.ok ? 200 : 409, report);
    } finally { busy = false; }
  });
}
if (import.meta.main) await main();
