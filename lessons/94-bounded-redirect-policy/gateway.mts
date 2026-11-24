import { follow, origins, resource } from './policy.mts';
import { requestHop } from './request.mts';
import { errorReply, json, serve } from './server.mts';

async function main(): Promise<void> {
  const allowed = origins(process.env.START_ORIGIN, process.env.TARGET_ORIGIN);
  let active = 0;
  await serve('gateway', 8094, '/resource', async res => {
    if (active >= 8) {
      errorReply(res, 503, 'busy');
      return;
    }
    const caller = new AbortController();
    const cancel = () => caller.abort();
    res.once('close', cancel);
    active++;
    try {
      const result = await follow(allowed, () => performance.now(),
        (url, deadline) => requestHop(url, deadline, caller.signal));
      if (caller.signal.aborted || res.destroyed) return;
      if (result === 'success') json(res, 200, resource);
      else errorReply(res, result === 'upstream_timeout' ? 504 : 502, result);
    } finally {
      active--;
      res.off('close', cancel);
    }
  });
}

if (import.meta.main) await main();
