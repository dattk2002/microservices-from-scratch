import { serve, json, numberSetting } from '../../lib/http.mts';
import { Budget, hedge, realClock } from './hedge.mts';
import { loopback, upstream, validId } from './protocol.mts';
export async function main() {
  if ((process.env.HOST ?? '127.0.0.1') !== '127.0.0.1') throw new Error('Loopback only');
  const origins = [loopback(process.env.PRIMARY_URL ?? 'http://127.0.0.1:3031'), loopback(process.env.SECONDARY_URL ?? 'http://127.0.0.1:3032')];
  const delay = numberSetting('HEDGE_MS', 50, 1, 5000); const deadline = numberSetting('DEADLINE_MS', 1000, delay + 1, 10000);
  const budget = new Budget(numberSetting('HEDGE_CAPACITY', 2, 0, 100));
  return serve('hedging-client', 3030, async (req, res) => {
    if (req.method !== 'GET') { req.resume(); json(res, 405, {error: 'safe GET only'}); return; }
    if (req.url === '/stats') { json(res, 200, {extra: budget.active, skipped: budget.skipped}); return; }
    const match = /^\/items\/([A-Za-z0-9_-]{1,64})$/.exec(req.url ?? ''); const id = match?.[1];
    if (!id || !validId(id)) { json(res, 404, {error: 'route'}); return; }
    const caller = new AbortController(); const close = () => { if (!res.writableEnded) caller.abort(); };
    res.once('close', close);
    try {
      const reply = await hedge((i, signal) => upstream(origins[i]!, id, signal), realClock, budget, caller.signal, delay, deadline);
      if (!res.destroyed) json(res, reply.status, reply.value ?? {error: `read_${reply.status}`});
    } finally { res.off('close', close); }
  });
}
if (import.meta.main) await main();
