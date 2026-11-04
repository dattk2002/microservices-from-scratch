import { json, serve } from '../../../lib/http.mts';
export async function main() {
  const mode = process.env.FIXTURE_MODE;
  if (!mode || !['schema', 'sequence', 'missing', 'oversized', 'slow'].includes(mode)) throw new Error('Invalid FIXTURE_MODE');
  return serve('history-fixture', 0, (req, res) => {
    if (req.url !== '/carts/cart/events?after=0&limit=4') { json(res, 404, {}); return; }
    if (mode === 'slow') return; // Reader deadline aborts; shared serve bounds shutdown.
    if (mode === 'oversized') { json(res, 200, { version: 1, events: [{ schema: 1, seq: 1, type: 'created' }], padding: 'x'.repeat(9000) }); return; }
    json(res, 200, { version: 1, events: mode === 'missing' ? [] : [
      { schema: mode === 'schema' ? 2 : 1, seq: mode === 'sequence' ? 2 : 1, type: 'created' },
    ] });
  });
}
if (import.meta.main) await main();
