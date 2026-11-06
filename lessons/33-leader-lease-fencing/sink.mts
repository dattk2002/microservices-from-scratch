import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { FencedSink, identity, integer, object, payload } from './state.mts';
import { database, settings } from './runtime.mts';

export async function main() {
  settings();
  const db = database();
  try {
    const sink = new FencedSink(db);
    const server = await serve('fenced-sink', 3332, async (req, res) => {
      if (req.method !== 'POST') throw new HttpError(405, 'method', 'Use POST');
      if (req.url !== '/write') throw new HttpError(404, 'not_found', 'Unknown command');
      const input = object(await readJson(req));
      json(res, 200, sink.write(integer(input.generation, 1), identity(input.id), payload(input.payload)));
    });
    server.maxConnections = 32;
    server.keepAliveTimeout = 1000;
    server.once('close', () => db.close());
    return server;
  } catch (error) { db.close(); throw error; }
}
if (import.meta.main) await main();
