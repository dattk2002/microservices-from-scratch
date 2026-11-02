import { HttpError, json, methodNotAllowed, serve } from '../../lib/http.mts';

// Control routes are a deterministic local test fixture, disabled in normal runs.
export async function startDownstream(name: string, port: number) {
  const controls = process.env.TEST_CONTROLS === '1';
  let blocked = false;
  let fail = false;
  let entered = 0;
  const pending = new Set<() => void>();
  const observers = new Set<() => void>();
  return serve(name, port, async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (controls && url.pathname === '/control') {
      if (req.method !== 'POST') methodNotAllowed(res, 'POST');
      const mode = url.searchParams.get('mode');
      if (!['hold', 'open', 'fail'].includes(mode ?? '')) throw new HttpError(400, 'invalid_mode', 'Use hold, open or fail');
      blocked = mode === 'hold'; fail = mode === 'fail';
      if (!blocked) for (const release of pending) release();
      json(res, 200, { mode }); return;
    }
    if (controls && url.pathname === '/stats') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      json(res, 200, { entered, active: pending.size }); return;
    }
    if (controls && url.pathname === '/barrier') {
      if (req.method !== 'GET') methodNotAllowed(res, 'GET');
      const count = Number(url.searchParams.get('count'));
      if (!Number.isSafeInteger(count) || count < 1) throw new HttpError(400, 'invalid_count', 'Positive count required');
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); observers.delete(check); res.off('close', finish); resolve(); };
        const check = () => { if (entered >= count) finish(); };
        const timer = setTimeout(finish, 3000);
        observers.add(check); res.once('close', finish); check();
      });
      if (!res.destroyed) json(res, entered >= count ? 200 : 408, { entered });
      return;
    }
    if (url.pathname !== '/work') throw new HttpError(404, 'not_found', 'Unknown route');
    if (req.method !== 'GET') methodNotAllowed(res, 'GET');
    entered++;
    for (const check of observers) check();
    if (blocked) await new Promise<void>((resolve) => {
      const release = () => { pending.delete(release); res.off('close', release); resolve(); };
      pending.add(release); res.once('close', release);
    });
    if (!res.destroyed) json(res, fail ? 500 : 200, { service: name });
  });
}
