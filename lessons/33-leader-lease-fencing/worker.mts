import { HttpError, json, readJson, serve } from '../../lib/http.mts';
import { grant, identity, integer, object, payload, receipt } from './state.mts';
import type { Grant } from './state.mts';
import { call, origin, settings } from './runtime.mts';

export type Call = (target: 'coordinator' | 'sink', path: string, body: unknown) => Promise<unknown>;
export class Worker {
  private readonly holder: string;
  private readonly ttl: number;
  private readonly call: Call;
  private current: Grant | undefined;
  private busy = false;
  constructor(holder: string, ttl: number, call: Call) {
    this.holder = identity(holder); this.ttl = integer(ttl, 1, 10000); this.call = call;
  }
  async execute(action: unknown, body: unknown, teaching = false): Promise<unknown> {
    if (typeof action !== 'string' || !['acquire', 'renew', 'release', 'write', 'stale-write'].includes(action)) throw new HttpError(404, 'not_found', 'Unknown command');
    if (action === 'stale-write' && !teaching) throw new HttpError(404, 'not_found', 'Teaching controls disabled');
    if (this.busy) throw new HttpError(429, 'busy', 'One in-flight command per worker');
    this.busy = true;
    try {
      const input = object(body);
      if (action === 'acquire') {
        const next = grant(await this.call('coordinator', '/acquire', {holder: this.holder, ttl: this.ttl}));
        if (next.holder !== this.holder || (this.current && next.generation <= this.current.generation)) throw new HttpError(502, 'upstream', 'Unexpected grant identity or generation');
        this.current = next;
        return next;
      }
      const current = this.current;
      if (!current) throw new HttpError(409, 'no_lease', 'Acquire first');
      if (action === 'release') {
        const reply = object(await this.call('coordinator', '/release', {holder: this.holder, generation: current.generation}));
        if (reply.released !== true) throw new HttpError(502, 'upstream', 'Invalid release reply');
        this.current = undefined;
        return {released: true};
      }
      let id = ''; let value = '';
      if (action === 'write' || action === 'stale-write') { id = identity(input.id); value = payload(input.payload); }
      if (action !== 'stale-write') {
        const next = grant(await this.call('coordinator', '/renew', {holder: this.holder, generation: current.generation, ttl: this.ttl}));
        if (next.holder !== this.holder || next.generation !== current.generation) throw new HttpError(502, 'upstream', 'Unexpected renewal identity or generation');
        this.current = next;
        if (action === 'renew') return next;
      }
      const result = receipt(await this.call('sink', '/write', {generation: current.generation, id, payload: value}));
      if (result.generation !== current.generation) throw new HttpError(502, 'upstream', 'Unexpected sink generation');
      return result;
    } finally { this.busy = false; }
  }
}
export async function main() {
  const config = settings();
  const coordinator = origin(process.env.COORDINATOR_URL);
  const sink = origin(process.env.SINK_URL);
  const worker = new Worker(identity(process.env.HOLDER), config.ttl, (target, path, body) => call((target === 'coordinator' ? coordinator : sink) + path, body));
  const server = await serve('lease-worker', 3333, async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method', 'Use POST');
    const action = req.url === '/teaching/stale-write' ? 'stale-write' : req.url?.slice(1);
    json(res, 200, await worker.execute(action, await readJson(req), config.teaching));
  });
  server.maxConnections = 32;
  server.keepAliveTimeout = 1000;
  return server;
}
if (import.meta.main) await main();
