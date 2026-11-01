import { performance } from 'node:perf_hooks';
import { HttpError, json, methodNotAllowed, numberSetting, serve } from '../../lib/http.mts';
import { CircuitBreaker, CircuitOpenError } from './breaker.mts';

export async function main() {
  const upstream = new URL(process.env.UPSTREAM_URL ?? 'http://127.0.0.1:4701');
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('UPSTREAM_URL must be a loopback HTTP origin');
  }
  const timeout = numberSetting('TIMEOUT_MS', 500, 1, 10000);
  const breaker = new CircuitBreaker({
    threshold: numberSetting('FAILURE_THRESHOLD', 2, 1, 100),
    cooldownMs: numberSetting('COOLDOWN_MS', 1000, 1, 60000),
    maxProbes: numberSetting('MAX_PROBES', 1, 1, 10), now: () => performance.now(),
  });
  await serve('breaker-client', 4700, async (req, res) => {
    if (req.url !== '/quote' && req.url !== '/state') throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    if (req.url === '/state') { json(res, 200, { state: breaker.state }); return; }
    try {
      const result = await breaker.run(async () => {
        const response = await fetch(new URL('/quote', upstream), {
          signal: AbortSignal.timeout(timeout), redirect: 'error',
        });
        // Include response-body consumption in both timeout and breaker outcome.
        const body = await response.text();
        return { status: response.status, body };
      });
      res.setHeader('x-circuit-state', breaker.state);
      res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(result.body);
    } catch (error) {
      res.setHeader('x-circuit-state', breaker.state);
      if (error instanceof CircuitOpenError) {
        json(res, 503, { error: 'circuit_open' });
      } else if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        json(res, 504, { error: 'upstream_timeout' });
      } else json(res, 502, { error: 'upstream_transport' });
    }
  });
}
if (import.meta.main) await main();
