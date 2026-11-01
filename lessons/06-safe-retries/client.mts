import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError, json, numberSetting, serve } from '../../lib/http.mts';
import { DeadlineError, retry } from './retry.mts';

export async function main() {
  const upstream = new URL(process.env.UPSTREAM_URL ?? 'http://127.0.0.1:4601');
  if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) {
    throw new Error('UPSTREAM_URL must be a loopback HTTP origin');
  }
  const maxAttempts = numberSetting('MAX_ATTEMPTS', 3, 1, 10);
  const budget = numberSetting('BUDGET_MS', 1000, 1, 10000);
  const baseMs = numberSetting('BASE_MS', 20, 0, 1000);
  const capMs = numberSetting('CAP_MS', 100, 0, 2000);
  await serve('retry-client', 4600, async (req, res) => {
    const safe = req.url === '/quote' && req.method === 'GET';
    const protectedPost = req.url === '/protected' && req.method === 'POST';
    const unsafe = req.url === '/unsafe' && req.method === 'POST';
    if (!safe && !protectedPost && !unsafe) throw new HttpError(404, 'not_found', 'Unknown operation');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (protectedPost) {
      const key = req.headers['idempotency-key'];
      if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key) || req.headersDistinct['idempotency-key']?.length !== 1) {
        throw new HttpError(400, 'invalid_key', 'One ASCII key required');
      }
      headers['idempotency-key'] = key;
    }
    // POST endpoints are commands with a fixed payload, not arbitrary request forwarding.
    req.resume();
    let attempts = 0;
    try {
      const result = await retry(async remaining => {
        attempts++;
        try {
          const response = await fetch(new URL(safe ? '/quote' : protectedPost ? '/protected' : '/unsafe', upstream), {
            method: safe ? 'GET' : 'POST', headers,
            ...(safe ? {} : { body: '{"item":"pencil"}' }),
            signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))), redirect: 'error',
          });
          // Body consumption belongs to the same attempt and deadline as response headers.
          const body = await response.text();
          return { status: response.status, body };
        } catch (error) {
          if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new DeadlineError();
          // Transport exceptions are deliberately not classified as transient in this lesson.
          throw error;
        }
      }, { maxAttempts, baseMs, capMs, deadline: performance.now() + budget, permitted: safe || protectedPost,
        now: () => performance.now(), rng: Math.random, sleep: async ms => { await sleep(ms); } });
      res.setHeader('x-attempts', attempts);
      res.writeHead(result.status, { 'content-type': 'application/json' }); res.end(result.body);
    } catch (error) {
      res.setHeader('x-attempts', attempts);
      json(res, error instanceof DeadlineError ? 504 : 502, { error: error instanceof DeadlineError ? 'deadline_exceeded' : 'upstream_transport' });
    }
  });
}
if (import.meta.main) await main();
