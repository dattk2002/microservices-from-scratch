import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError, json, methodNotAllowed, numberSetting, serve } from '../../lib/http.mts';

export async function main() {
  const failFirst = numberSetting('FAIL_FIRST', 2, 0, 10000);
  const delay = numberSetting('DELAY_MS', 0, 0, 10000);
  const failStatus = numberSetting('FAIL_STATUS', 503, 400, 599);
  let calls = 0;
  await serve('breaker-upstream', 4701, async (req, res) => {
    if (req.url !== '/quote' && req.url !== '/state') throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    if (req.url === '/state') { json(res, 200, { calls }); return; }
    const attempt = ++calls;
    if (delay) await sleep(delay);
    json(res, attempt <= failFirst ? failStatus : 200,
      attempt <= failFirst ? { error: 'quote_unavailable' } : { priceCents: 125 });
  });
}
if (import.meta.main) await main();
