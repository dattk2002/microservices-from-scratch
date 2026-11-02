import { serve, json, numberSetting } from '../../lib/http.mts';

export async function main() {
  const owner = process.env.OWNER_URL ?? 'http://127.0.0.1:3017';
  const poll = numberSetting('POLL_MS', 100, 10, 10000);
  let held = process.env.HOLD === '1';
  let stopping = false;
  let active: { id: string; token: string } | null = null;
  let completed = 0; let stale = 0;
  const controls = process.env.TEST_CONTROLS === '1';
  const server = await serve('job-worker', 3018, (req, res) => {
    if (controls && req.method === 'POST' && req.url === '/release') { held = false; json(res, 200, {}); return; }
    if (controls && req.method === 'GET' && req.url === '/stats') { json(res, 200, { active, completed, stale }); return; }
    json(res, 404, {});
  });
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  async function post(path: string, body: unknown) {
    return fetch(`${owner}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(1000) });
  }
  try {
    while (!stopping) {
      try {
        const response = await post('/claims', {});
        if (!response.ok) throw new Error('claim unavailable');
        const value: unknown = await response.json();
        if (typeof value !== 'object' || value === null || !('job' in value)) throw new Error('claim shape');
        const job = value.job;
        if (typeof job === 'object' && job !== null && 'id' in job && typeof job.id === 'string' && 'token' in job && typeof job.token === 'string' && 'n' in job && typeof job.n === 'number' && 'fail' in job) {
          active = { id: job.id, token: job.token };
          while (held && !stopping) await new Promise<void>(r => setTimeout(r, 10));
          if (stopping) break;
          let sum = 0; for (let i = 1; i <= job.n; i++) sum += i;
          const done = await post(`/jobs/${job.id}/complete`, { token: job.token, success: job.fail === 0, result: sum });
          if (done.status === 409) stale++; else if (done.ok) completed++;
          active = null;
        }
      } catch { active = null; /* Unknown completion outcome: let lease recovery decide. */ }
      await new Promise<void>(r => setTimeout(r, poll));
    }
  } finally {
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    server.close();
  }
}

if (import.meta.main) await main();
