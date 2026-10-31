import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json, methodNotAllowed } from '../../lib/http.mts';
import { deadline } from './budget.mts';
import { query, scope, start } from './lifecycle.mts';

type Work = { workId: string; state: 'running' | 'completed' | 'cancelled'; deadlineMs: number; reason?: 'caller' | 'deadline'; release?: () => void };
const records = new Map<string, Work>();
const observers = new Set<() => void>();
const publish = () => { for (const observer of [...observers]) observer(); };
const snapshot = (record: Work) => ({ workId: record.workId, state: record.state, deadlineMs: record.deadlineMs, ...(record.reason ? { reason: record.reason } : {}) });

async function observe(req: IncomingMessage, res: ServerResponse, id: string, until: string) {
  if (observers.size >= 64) throw new HttpError(429, 'overloaded', 'Too many observers');
  const work = scope(req, res, Date.now() + 2000);
  try {
    await new Promise<void>((resolve, reject) => {
      const clean = () => { observers.delete(changed); work.signal.removeEventListener('abort', aborted); };
      const changed = () => { if (records.get(id)?.state === until) { clean(); resolve(); } };
      const aborted = () => { clean(); reject(new HttpError(408, 'observation_timeout', 'State not observed within 2000ms')); };
      observers.add(changed);
      work.signal.addEventListener('abort', aborted, { once: true });
      if (work.signal.aborted) aborted(); else changed();
    });
    const record = records.get(id);
    if (!record) throw new HttpError(404, 'not_found', 'Work no longer retained');
    work.check();
    json(res, 200, snapshot(record));
  } finally { work.dispose(); }
}

async function main(): Promise<void> {
  await start('catalog-deadline', 4401, async (req, res, url) => {
    if (url.pathname === '/health') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      json(res, 200, { status: 'ok' }); return;
    }
    const control = /^\/work\/([a-z0-9-]{1,48})(\/release)?$/.exec(url.pathname);
    if (control) {
      const id = control[1]!;
      const record = records.get(id);
      if (control[2]) {
        if (req.method !== 'POST') methodNotAllowed(res, 'POST');
        if (!record) throw new HttpError(404, 'not_found', 'Unknown work');
        if (record.state !== 'running' || !record.release) throw new HttpError(409, 'not_waiting', 'Work cannot be released');
        record.release();
        json(res, 200, { released: true });
        return;
      }
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      const until = url.searchParams.get('until');
      if ([...url.searchParams.keys()].some(key => key !== 'until') || url.searchParams.getAll('until').length > 1 ||
          (until !== null && !['running', 'completed', 'cancelled'].includes(until))) {
        throw new HttpError(400, 'invalid_query', 'Use optional until=running|completed|cancelled');
      }
      if (until !== null) { await observe(req, res, id, until); return; }
      if (!record) throw new HttpError(404, 'not_found', 'Unknown work');
      json(res, 200, snapshot(record));
      return;
    }
    if (!/^\/products\/[a-z0-9-]+$/.test(url.pathname)) throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    const { workId, hold, productId } = query(url);
    const end = deadline(req.headers['x-request-deadline-ms'], Date.now, false);
    if (productId !== 'pencil') throw new HttpError(404, 'not_found', 'Unknown product');
    if (records.has(workId)) throw new HttpError(409, 'duplicate_work', 'Use a fresh workId for each quote');
    if (records.size >= 128) {
      const oldest = [...records].find(([, record]) => record.state !== 'running');
      if (!oldest) throw new HttpError(429, 'overloaded', 'All 128 work slots are active');
      records.delete(oldest[0]);
    }
    const work = scope(req, res, end);
    const record: Work = { workId, state: 'running', deadlineMs: end };
    try {
      work.check();
      records.set(workId, record);
      if (hold) {
        // A cancellable manual stock-approval wait, controlled by the local lab API.
        await new Promise<void>((resolve, reject) => {
          const clean = () => { delete record.release; work.signal.removeEventListener('abort', aborted); };
          const aborted = () => { clean(); reject(new Error('Stock approval cancelled')); };
          record.release = () => { clean(); resolve(); };
          work.signal.addEventListener('abort', aborted, { once: true });
          if (work.signal.aborted) aborted();
          publish();
        });
      }
      work.check();
      record.state = 'completed';
      publish();
      json(res, 200, { productId, priceCents: 125, workId, deadlineMs: end });
    } catch (error: unknown) {
      record.state = 'cancelled';
      record.reason = work.signal.reason === 'caller' ? 'caller' : 'deadline';
      publish();
      work.check();
      throw error;
    } finally { work.dispose(); }
  });
}

if (import.meta.main) await main();
