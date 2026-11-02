import { serve, json, readJson, HttpError } from '../../lib/http.mts';
import { configuredKey, verifier, allowed, loopbackHost } from './auth.mts';

export async function main() {
  loopbackHost();
  const authenticate = verifier(configuredKey('public'));
  return serve('protected-resource', 3018, async (req, res) => {
    if (req.url !== '/reports') throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'POST') throw new HttpError(405, 'method', 'Use POST');
    let identity;
    try {
      const authorization = req.headers.authorization;
      if (!authorization?.startsWith('Bearer ') || authorization.length > 4103) throw new Error();
      identity = authenticate(authorization.slice(7));
    } catch {
      res.setHeader('www-authenticate', 'Bearer');
      throw new HttpError(401, 'unauthenticated', 'Authentication required');
    }
    if (!allowed(identity)) throw new HttpError(403, 'forbidden', 'Permission denied');
    const body = await readJson(req);
    if (typeof body !== 'object' || body === null || !('report' in body) || body.report !== 'monthly') throw new HttpError(400, 'input', 'report must be monthly');
    json(res, 200, { report: 'monthly', requestedBy: identity.sub });
  });
}
if (import.meta.main) {
  try { await main(); } catch { console.error('Resource startup failed'); process.exitCode = 1; }
}
