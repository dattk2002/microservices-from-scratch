import { json, methodNotAllowed, readJson } from '../../lib/http.mts';
import { fail, parseEvent } from './contracts.mts';
import { listen } from './runtime.mts';
import { HistogramStore } from './store.mts';

export async function main(): Promise<void> {
  const id = process.env.HISTOGRAM_ID;
  if (id !== 'a' && id !== 'b') throw new Error('HISTOGRAM_ID must be a or b');
  const file = process.env.DB_PATH;
  if (!file || file === ':memory:' || /^file:/i.test(file)) throw new Error('Private DB_PATH file required');

  // Loading node:sqlite only here keeps imports silent on Node 24.12.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  try {
    const store = new HistogramStore(db, id);
    const server = await listen(`histogram-${id}`, 3078, async (req, res) => {
      const target = req.url ?? '/';
      const [path] = target.split('?', 1);
      if (path === '/events') {
        if (req.method !== 'POST') methodNotAllowed(res, 'POST');
        if (target !== path) fail(400, 'invalid_request');
        const receipt = store.record(parseEvent(await readJson(req)));
        json(res, receipt.duplicate ? 200 : 201, receipt);
      } else if (path === '/snapshot') {
        if (req.method !== 'GET') methodNotAllowed(res, 'GET');
        if (target !== path) fail(400, 'invalid_request');
        json(res, 200, store.snapshot());
      } else {
        fail(404, 'not_found');
      }
    });
    server.once('close', () => db.close());
  } catch (error) {
    db.close();
    throw error;
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Startup failed');
    process.exitCode = 1;
  });
}
