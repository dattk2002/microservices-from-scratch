import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, json, numberSetting, serve } from '../../lib/http.mts';
import { Metrics } from './metrics.mts';

export async function start(role: 'gateway' | 'downstream') {
  const metrics = new Metrics();
  const workMs = numberSetting('WORK_MS', 50, 0, 3000);
  const deadlineMs = numberSetting('DEADLINE_MS', 1000, 10, 5000);
  const fail = process.env.FAIL_WORK === '1';
  const downstream = role === 'gateway' ? new URL(process.env.DOWNSTREAM_URL ?? 'http://127.0.0.1:3919') : undefined;
  if (downstream && (downstream.protocol !== 'http:' || downstream.hostname !== '127.0.0.1' || downstream.username || downstream.password)) throw new Error('DOWNSTREAM_URL must be loopback HTTP without credentials');
  return serve(role, role === 'gateway' ? 3918 : 3919, async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/metrics') {
      if (req.method !== 'GET') { json(res, 405, { error: 'Use GET' }); return; }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
      res.end(metrics.render()); return;
    }
    const complete = metrics.begin(path, req.method ?? 'OTHER');
    const cancel = new AbortController();
    res.once('finish', () => complete(res.statusCode < 400 ? 'ok' : 'error', res.statusCode));
    res.once('close', () => {
      if (!res.writableFinished) { complete('cancelled', 0); cancel.abort(); }
    });
    try {
      if (path !== '/work') throw new HttpError(404, 'not_found', 'Use /work');
      if (req.method !== 'GET') { res.setHeader('allow', 'GET'); throw new HttpError(405, 'method_not_allowed', 'Use GET'); }
      if (role === 'downstream') {
        await delay(workMs, undefined, { signal: cancel.signal });
        if (fail) throw new HttpError(500, 'work_failed', 'Configured failure');
        json(res, 200, { result: 'computed' });
      } else {
        try {
          const response = await fetch(new URL('/work', downstream), { signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(deadlineMs)]) });
          await response.arrayBuffer();
          if (!response.ok) throw new HttpError(502, 'dependency_failed', 'Downstream rejected work');
          if (!res.destroyed) json(res, 200, { result: 'computed', via: 'gateway' });
        } catch (error) {
          if (cancel.signal.aborted) return;
          if (error instanceof HttpError) throw error;
          throw new HttpError(error instanceof Error && error.name === 'TimeoutError' ? 504 : 502, 'dependency_unavailable', 'Downstream did not complete');
        }
      }
    } catch (error) {
      if (res.destroyed || cancel.signal.aborted) return;
      if (error instanceof HttpError) json(res, error.status, { error: error.code });
      else json(res, 500, { error: 'internal_error' });
    }
  });
}
