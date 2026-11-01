import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { json, numberSetting } from '../../lib/http.mts';
import { Lifecycle } from './lifecycle.mts';

export async function main(): Promise<void> {
  const port = numberSetting('PORT', 3010, 0, 65535);
  const workMs = numberSetting('WORK_MS', 1000, 0, 60000);
  const graceMs = numberSetting('SHUTDOWN_MS', 3000, 100, 60000);
  const drainMs = numberSetting('DRAIN_MS', 300, 0, 60000);
  if (drainMs >= graceMs) throw new Error('DRAIN_MS must be less than SHUTDOWN_MS');
  const lifecycle = new Lifecycle();
  let propagationDone = false;
  let closing = false;
  let deadline: NodeJS.Timeout | undefined;
  let propagation: NodeJS.Timeout | undefined;

  function maybeClose() {
    if (!propagationDone || closing || lifecycle.state !== 'draining' || lifecycle.active !== 0) return;
    closing = true;
    lifecycle.stop();
    server.close(() => {
      clearTimeout(deadline);
      clearTimeout(propagation);
      process.off('SIGTERM', shutdown);
      process.off('SIGINT', shutdown);
    });
  }

  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET');
      json(res, 405, { error: 'method_not_allowed' });
      return;
    }
    if (req.url === '/live') {
      json(res, 200, { live: true });
      return;
    }
    if (req.url === '/ready') {
      json(res, lifecycle.ready ? 200 : 503, { ready: lifecycle.ready, state: lifecycle.state, active: lifecycle.active });
      return;
    }
    if (req.url !== '/work') {
      json(res, 404, { error: 'not_found' });
      return;
    }
    const release = lifecycle.admit();
    if (!release) {
      res.setHeader('connection', 'close');
      res.setHeader('retry-after', '1');
      json(res, 503, { error: 'draining' });
      return;
    }
    // Headers acknowledge admission; the body represents eventual work completion.
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.flushHeaders();
    const work = setTimeout(() => res.end(JSON.stringify({ result: 'completed' })), workMs);
    const complete = () => {
      clearTimeout(work);
      release();
      maybeClose();
    };
    res.once('finish', complete);
    res.once('close', complete);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;

  function shutdown() {
    if (lifecycle.state !== 'ready') return;
    lifecycle.drain();
    // Keep this timer referenced: even a stuck handle must not defeat the bound.
    deadline = setTimeout(() => {
      lifecycle.stop(true);
      server.closeAllConnections();
      process.exit(1);
    }, graceMs);
    propagation = setTimeout(() => { propagationDone = true; maybeClose(); }, drainMs);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.HOST ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP listener');
  console.log(JSON.stringify({ service: 'graceful-worker', port: address.port }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
