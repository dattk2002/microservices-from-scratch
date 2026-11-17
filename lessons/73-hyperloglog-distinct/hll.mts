import { json, numberSetting, readJson, serve } from '../../lib/http.mts';
import { fail, replyError, validateHost } from './protocol.mts';
import { Sketch } from './store.mts';

export async function main(): Promise<void> {
  validateHost(process.env.HOST);
  numberSetting('PORT', 7301, 0, 65535);
  const file = process.env.DB_PATH, id = process.env.SKETCH_ID;
  if (!file || file === ':memory:' || !id) throw new Error('Private DB_PATH file and SKETCH_ID required');
  const sketch = await Sketch.open(file, id);
  try {
    const server = await serve('hll-source', 7301, async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', 'http://sketch');
        if (url.search) fail(400, 'invalid_request');
        if (url.pathname === '/snapshot') {
          if (req.method !== 'GET') { res.setHeader('allow', 'GET'); fail(405, 'method_not_allowed'); }
          json(res, 200, sketch.snapshot());
        } else if (url.pathname === '/values') {
          if (req.method !== 'POST') { res.setHeader('allow', 'POST'); fail(405, 'method_not_allowed'); }
          json(res, 200, sketch.write(await readJson(req)));
        } else fail(404, 'not_found');
      } catch (error) { replyError(res, error); }
    });
    server.once('close', () => sketch.close());
  } catch (error) { sketch.close(); throw error; }
}
if (import.meta.main) main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
