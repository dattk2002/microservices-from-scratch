import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { Store, digest, note, snapshot } from './data.mts';
import { owner } from './policy.mts';

function origin(raw: string | undefined): string {
  if (!raw) throw new Error('Provider origin required');
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) throw new Error('Use a loopback HTTP origin');
  return url.origin;
}
export async function main() {
  const legacy = origin(process.env.LEGACY_URL);
  const extracted = origin(process.env.EXTRACTED_URL);
  if (legacy === extracted) throw new Error('Providers must be separate');
  if (!process.env.DB_PATH) throw new Error('DB_PATH required');
  const store = new Store(process.env.DB_PATH, 'facade');
  let migrating = false;
  async function call(base: string, path: string, body?: unknown) {
    try {
      const response = await fetch(base + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(4000), redirect: 'error',
      });
      const value: unknown = await response.json();
      return { status: response.status, value };
    } catch {
      // A timed-out POST may have committed. Never retry or choose the other provider.
      throw new HttpError(503, 'owner_unavailable', 'Outcome may be unknown; no automatic retry or fallback');
    }
  }
  async function requireOK(base: string, path: string, body: unknown) {
    const result = await call(base, path, body);
    if (result.status !== 200) throw new HttpError(503, 'migration_paused', 'Barrier remains closed; retry migration');
    return result.value;
  }
  try {
    store.phase();
    const server = await serve('facade', 4020, async (req, res) => {
      if (req.url === '/migration' && req.method === 'GET') {
        json(res, 200, { phase: store.phase(), migrating }); return;
      }
      if (req.url === '/migrate' && req.method === 'POST') {
        if (migrating) throw new HttpError(409, 'migration_busy', 'Only one migration attempt');
        if (store.phase() === 'extracted-owner') { json(res, 200, { phase: store.phase() }); return; }
        store.advance('copy-cutover');
        migrating = true;
        try {
          const rows = snapshot(await requireOK(legacy, '/freeze', {}));
          const hash = digest(rows);
          const copied = await requireOK(extracted, '/copy', rows);
          if (typeof copied !== 'object' || copied === null || !('hash' in copied) || copied.hash !== hash) {
            throw new Error('Target copy digest mismatch');
          }
          await requireOK(extracted, '/activate', { hash });
          store.advance('extracted-owner');
          json(res, 200, { phase: store.phase() });
        } finally { migrating = false; }
        return;
      }
      if (req.url === '/notes' && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? note(await readJson(req)) : undefined;
        const selected = owner(store.phase());
        if (!selected) throw new HttpError(503, 'cutover_barrier', 'Migration paused; retry after operator completes it');
        const result = await call(selected === 'legacy' ? legacy : extracted, '/notes', body);
        json(res, result.status, result.value); return;
      }
      throw new HttpError(404, 'not_found', 'Unknown route or method');
    });
    server.once('close', () => store.close());
    return server;
  } catch (error) { store.close(); throw error; }
}
if (import.meta.main) await main();
