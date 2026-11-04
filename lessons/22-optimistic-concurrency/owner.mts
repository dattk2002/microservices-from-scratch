import { HttpError, json, methodNotAllowed, readJson, serve } from '../../lib/http.mts';
import { Store, etag, parseMatch, valueInput } from './model.mts';

export async function main() {
  const path = process.env.DB_PATH;
  if (!path) throw new Error('DB_PATH is required');
  const store = new Store(path);
  try {
    const server = await serve('resource-owner', 3022, async (req, res) => {
      if (req.url !== '/resource') throw new HttpError(404, 'not_found', 'Use /resource');
      if (req.method === 'GET') {
        const resource = store.read();
        res.setHeader('etag', etag(resource.version));
        json(res, 200, resource); return;
      }
      if (req.method !== 'PUT' && req.method !== 'PATCH') methodNotAllowed(res, 'GET, PUT, PATCH');
      // rawHeaders preserves duplicates rather than silently accepting the first field.
      const count = req.rawHeaders.filter((h, i) => i % 2 === 0 && h.toLowerCase() === 'if-match').length;
      if (count > 1) throw new HttpError(400, 'invalid_if_match', 'Exactly one field required');
      const version = parseMatch(req.headers['if-match']);
      const value = valueInput(await readJson(req));
      const result = store.update(version, value);
      res.setHeader('etag', etag(result.version));
      json(res, 200, result);
    });
    server.once('close', () => store.close());
    return server;
  } catch (error) { store.close(); throw error; }
}
if (import.meta.main) await main();
