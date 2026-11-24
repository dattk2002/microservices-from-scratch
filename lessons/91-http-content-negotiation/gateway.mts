import { fail, portSetting, sendGreeting, serve } from './http.mts';
import { providerOrigin, requestGreeting } from './upstream.mts';

if (import.meta.main) {
  const port = portSetting(4091);
  const origin = providerOrigin(process.env.PROVIDER_ORIGIN ?? 'http://127.0.0.1:3091', port);
  let active = 0;
  await serve('gateway', port, async (res, accept, ranges, shutdown) => {
    if (active >= 8) fail(503, 'busy');
    const caller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) caller.abort();
    };
    res.once('close', disconnect);
    active++;
    try {
      if (res.destroyed) disconnect();
      const signal = AbortSignal.any([caller.signal, shutdown]);
      const variant = await requestGreeting(origin, accept, ranges, signal).catch(() => {
        fail(502, 'upstream_failure');
      });
      sendGreeting(res, variant);
    } finally {
      active--;
      res.off('close', disconnect);
    }
  });
}
