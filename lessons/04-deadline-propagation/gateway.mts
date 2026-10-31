import { HttpError, json, methodNotAllowed } from '../../lib/http.mts';
import { deadline } from './budget.mts';
import { forward, origin, query, scope, start } from './lifecycle.mts';

async function main(): Promise<void> {
  const orders = origin('ORDERS_URL', 'http://127.0.0.1:4402');
  await start('gateway-deadline', 4400, async (req, res, url) => {
    if (url.pathname === '/health') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      json(res, 200, { status: 'ok' }); return;
    }
    if (!/^\/quote\/[a-z0-9-]+$/.test(url.pathname)) throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const { workId } = query(url);
    const end = deadline(req.headers['x-request-deadline-ms'], Date.now, true);
    const work = scope(req, res, end);
    try {
      work.check();
      const result = await forward(new URL(`${url.pathname}${url.search}`, orders), end, work.signal, workId);
      work.check();
      json(res, 200, result);
    } finally { work.dispose(); }
  });
}

if (import.meta.main) await main();
