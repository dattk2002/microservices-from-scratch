import { serve, json, readJson, HttpError, numberSetting } from '../../lib/http.mts';
import { Store } from './store.mts';

export async function main() {
  const store = new Store(process.env.DB_PATH ?? 'jobs.sqlite', numberSetting('CAPACITY', 100, 1, 100000), numberSetting('ATTEMPTS', 3, 1, 10), numberSetting('LEASE_MS', 2000, 100, 100000));
  try {
    function object(value: unknown): Record<string, unknown> {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'input', 'Expected object');
      return Object.fromEntries(Object.entries(value));
    }
    const server = await serve('job-owner', 3017, async (req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'POST' && path === '/jobs') {
        const input = object(await readJson(req));
        if (typeof input.n !== 'number' || !Number.isSafeInteger(input.n) || input.n < 0 || input.n > 10000 || (input.fail !== undefined && typeof input.fail !== 'boolean')) throw new HttpError(400, 'input', 'n: integer 0..10000; fail: boolean');
        let id: string;
        try { id = store.admit(input.n, input.fail === true); }
        catch (error) { if (!(error instanceof Error) || error.message !== 'capacity') throw error; res.setHeader('retry-after', '1'); throw new HttpError(503, 'capacity', 'Retention capacity reached'); }
        res.setHeader('location', `/jobs/${id}`); res.setHeader('retry-after', '1');
        json(res, 202, { id, state: 'queued' }); return;
      }
      if (req.method === 'POST' && path === '/claims') { json(res, 200, { job: store.claim() ?? null }); return; }
      const match = /^\/jobs\/([a-f0-9-]{36})(\/result|\/complete)?$/.exec(path);
      if (!match?.[1]) throw new HttpError(404, 'not_found', 'Unknown route');
      const id = match[1];
      if (req.method === 'POST' && match[2] === '/complete') {
        const input = object(await readJson(req));
        if (typeof input.token !== 'string' || typeof input.success !== 'boolean') throw new HttpError(400, 'input', 'token and success required');
        if (!store.finish(id, input.token, input.success, typeof input.result === 'number' ? input.result : undefined)) throw new HttpError(409, 'stale_claim', 'Claim expired or replaced');
        json(res, 200, { accepted: true }); return;
      }
      if (req.method !== 'GET' || match[2] === '/complete') throw new HttpError(405, 'method', 'Unsupported method');
      const job = store.get(id);
      if (!job) throw new HttpError(404, 'not_found', 'Unknown job');
      if (match[2] === '/result') {
        if (job.state !== 'succeeded') throw new HttpError(409, 'result_unavailable', 'Inspect job status');
        json(res, 200, { sum: job.result }); return;
      }
      res.setHeader('retry-after', '1');
      json(res, 200, { id, state: job.state, attempt: job.attempt, error: job.error, result: job.state === 'succeeded' ? `/jobs/${id}/result` : null });
    });
    server.once('close', () => store.close());
    return server;
  } catch (error) { store.close(); throw error; }
}

if (import.meta.main) await main();
