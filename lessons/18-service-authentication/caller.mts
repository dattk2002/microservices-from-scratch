import { serve, json, readJson, HttpError } from '../../lib/http.mts';
import { configuredKey, issue, loopbackURL, loopbackHost } from './auth.mts';

export async function main() {
  loopbackHost();
  const key = configuredKey('private');
  const resource = loopbackURL(process.env.RESOURCE_URL);
  return serve('caller', 3019, async (req, res) => {
    if (req.url !== '/call') throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'POST') throw new HttpError(405, 'method', 'Use POST');
    const input = await readJson(req);
    if (typeof input !== 'object' || input === null || !('report' in input) || input.report !== 'monthly') throw new HttpError(400, 'input', 'report must be monthly');
    try {
      const response = await fetch(`${resource}/reports`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${issue(key)}` },
        body: JSON.stringify({ report: 'monthly' }), signal: AbortSignal.timeout(1500), redirect: 'error',
      });
      const body: unknown = await response.json();
      json(res, response.status, body);
    } catch { throw new HttpError(502, 'upstream_unavailable', 'Resource unavailable within deadline'); }
  });
}
if (import.meta.main) {
  try { await main(); } catch { console.error('Caller startup failed'); process.exitCode = 1; }
}
