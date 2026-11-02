import { setTimeout as delay } from 'node:timers/promises';
import { HttpError, json, numberSetting, readJson, serve } from '../../lib/http.mts';
import { Store, note, snapshot } from './data.mts';

export async function startProvider(role: 'legacy' | 'extracted') {
  const path = process.env.DB_PATH;
  if (!path) throw new Error('DB_PATH required');
  const drainMs = numberSetting('DRAIN_MS', 1200, 100, 3000);
  const testing = process.env.TEST_CONTROL === '1';
  const store = new Store(path, role);
  let active = 0;
  let held = false;
  let holdReply = false;
  let committed = 0;
  try {
    if (!(role === 'legacy' ? ['open', 'frozen'] : ['passive', 'active']).includes(store.state())) {
      throw new Error('Invalid provider state');
    }
    const server = await serve(role, role === 'legacy' ? 4021 : 4022, async (req, res) => {
      const path = req.url;
      if (path === '/status' && req.method === 'GET') {
        json(res, 200, { state: store.state(), active, committed }); return;
      }
      if (testing && req.method === 'POST' && (path === '/control/hold' || path === '/control/hold-reply' || path === '/control/release')) {
        held = path === '/control/hold';
        holdReply = path === '/control/hold-reply';
        json(res, 200, { held, holdReply }); return;
      }
      if (role === 'legacy' && path === '/freeze' && req.method === 'POST') {
        store.setState('frozen'); // Durable fence before awaiting any previously admitted work.
        const end = performance.now() + drainMs;
        while (active > 0) {
          if (performance.now() >= end) throw new HttpError(503, 'drain_timeout', 'Frozen; retry migration after drain');
          await delay(10);
        }
        json(res, 200, store.rows()); return;
      }
      if (role === 'extracted' && path === '/copy' && req.method === 'POST') {
        json(res, 200, { hash: store.copy(snapshot(await readJson(req))) }); return;
      }
      if (role === 'extracted' && path === '/activate' && req.method === 'POST') {
        const value = await readJson(req);
        if (typeof value !== 'object' || value === null || !('hash' in value) || typeof value.hash !== 'string') {
          throw new HttpError(400, 'invalid_hash', 'hash required');
        }
        store.activate(value.hash); json(res, 200, { state: store.state() }); return;
      }
      if (path === '/notes' && (req.method === 'GET' || req.method === 'POST')) {
        // Admission is synchronous after body parsing; freeze cannot race the counter increment.
        const input = req.method === 'POST' ? note(await readJson(req)) : undefined;
        if (store.state() !== (role === 'legacy' ? 'open' : 'active')) {
          throw new HttpError(503, 'not_owner', 'Provider is fenced or passive');
        }
        if (!input) { json(res, 200, store.rows()); return; }
        active++;
        try {
          const end = performance.now() + 3000;
          while (held) {
            if (performance.now() >= end) throw new HttpError(503, 'hold_timeout', 'Test gate deadline');
            await delay(10);
          }
          store.put(input);
          committed++;
          // Test-only gate models losing the response after a durable business commit.
          const replyDeadline = performance.now() + 3000;
          while (holdReply && performance.now() < replyDeadline) await delay(10);
          json(res, 200, input);
        } finally { active--; }
        return;
      }
      throw new HttpError(404, 'not_found', 'Unknown route or method');
    });
    server.once('close', () => store.close());
    return server;
  } catch (error) { store.close(); throw error; }
}
