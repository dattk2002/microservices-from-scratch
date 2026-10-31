import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { deadline, remaining } from '../budget.mts';

test('unit: importing all service entrypoints exits naturally without starting listeners', async () => {
  const entries = ['gateway.mts', 'orders.mts', 'catalog.mts'].map(name => new URL(`../${name}`, import.meta.url).href);
  const script = `${entries.map(entry => `await import(${JSON.stringify(entry)});`).join('\n')}\nconsole.log('imports-complete');`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
    env: { PATH: process.env.PATH ?? '', HOST: '127.0.0.1', PORT: '0', CATALOG_URL: 'http://127.0.0.1:1', ORDERS_URL: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-8192); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  let timedOut = false;
  const supervision = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 3000);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
  } finally {
    clearTimeout(supervision);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  assert.equal(timedOut, false, `Imports kept the process alive: ${stdout}${stderr}`);
  assert.equal(code, 0, stderr);
  assert.equal(stdout, 'imports-complete\n', 'Imports must not print service readiness');
  assert.equal(stderr, '');
});

test('unit: an absolute deadline loses budget at each hop without being extended', () => {
  let now = 1_000;
  const clock = () => now;
  const end = deadline('1800', clock, false);
  assert.equal(end, 1800);
  assert.equal(remaining(end, clock), 800);
  now = 1_450;
  assert.equal(deadline(String(end), clock, false), 1800);
  assert.equal(remaining(end, clock), 350);
  now = 1_801;
  assert.equal(remaining(end, clock), 0);
});

test('unit: only the gateway supplies a default and metadata cannot buy extra budget', () => {
  const clock = () => 1_000;
  assert.equal(deadline(undefined, clock, true), 2000);
  assert.equal(deadline('6000', clock, false), 6000);
  for (const raw of [undefined, '', '0', '-1', '1.5', ' 1200', '1200 ', '1e3', '001200', '1200,1300', ['1200'], '9007199254740992', '6001']) {
    assert.throws(() => deadline(raw, clock, false), { status: 400, code: 'invalid_deadline' });
  }
  for (const raw of ['1000', '999']) {
    assert.throws(() => deadline(raw, clock, false), { status: 504, code: 'deadline_exceeded' });
  }
});

import { request } from 'node:http';
import type { TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';

async function cluster(t: TestContext) {
  const catalog = await startService(new URL('../catalog.mts', import.meta.url));
  t.after(() => catalog.stop());
  const orders = await startService(new URL('../orders.mts', import.meta.url), { CATALOG_URL: catalog.url });
  t.after(() => orders.stop());
  const gateway = await startService(new URL('../gateway.mts', import.meta.url), { ORDERS_URL: orders.url });
  t.after(() => gateway.stop());
  assert.equal(new Set([catalog.child.pid, orders.child.pid, gateway.child.pid]).size, 3);
  return { catalog, orders, gateway };
}
const get = (url: string, headers: Record<string, string> = {}) => fetch(url, { headers, signal: AbortSignal.timeout(6000) });
async function state(base: string, id: string, until: string): Promise<unknown> {
  const response = await get(`${base}/work/${id}?until=${until}`);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('integration: three processes forward one deadline and release real waiting work', async (t) => {
  const { catalog, gateway } = await cluster(t);
  const end = Date.now() + 4500;
  const pending = get(`${gateway.url}/quote/pencil?workId=healthy&hold=1`, { 'x-request-deadline-ms': String(end) });
  void pending.catch(() => undefined);
  const running = await state(catalog.url, 'healthy', 'running');
  assert.deepEqual(running, { workId: 'healthy', state: 'running', deadlineMs: end });
  const released = await fetch(`${catalog.url}/work/healthy/release`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  assert.equal(released.status, 200);
  await released.body?.cancel();
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { productId: 'pencil', priceCents: 125, workId: 'healthy', deadlineMs: end });
  assert.deepEqual(await state(catalog.url, 'healthy', 'completed'), { workId: 'healthy', state: 'completed', deadlineMs: end });
});

test('integration: every boundary rejects invalid and expired metadata before work starts', async (t) => {
  const { catalog, orders, gateway } = await cluster(t);
  for (const [base, path] of [[gateway.url, '/quote/pencil'], [orders.url, '/quote/pencil'], [catalog.url, '/products/pencil']] as const) {
    for (const [raw, expected] of [['nonsense', 400], [String(Date.now() - 1), 504], [String(Date.now() + 60_000), 400]] as const) {
      const response = await get(`${base}${path}?workId=rejected`, { 'x-request-deadline-ms': raw! });
      assert.equal(response.status, expected);
      await response.body?.cancel();
    }
  }
  const absent = await get(`${catalog.url}/work/rejected`);
  assert.equal(absent.status, 404);
  await absent.body?.cancel();
  const missing = await get(`${orders.url}/quote/pencil?workId=missing`);
  assert.equal(missing.status, 400);
  await missing.body?.cancel();
  const automatic = await get(`${gateway.url}/quote/pencil?workId=automatic`);
  assert.equal(automatic.status, 200);
  const data: unknown = await automatic.json();
  assert.ok(typeof data === 'object' && data !== null && 'deadlineMs' in data && typeof data.deadlineMs === 'number');
  assert.ok(data.deadlineMs > Date.now() && data.deadlineMs <= Date.now() + 1000);
});

test('integration: deadline expiry cancels Catalog work and prevents later release', async (t) => {
  const { catalog, gateway } = await cluster(t);
  const pending = get(`${gateway.url}/quote/pencil?workId=expired&hold=1`, { 'x-request-deadline-ms': String(Date.now() + 1500) });
  void pending.catch(() => undefined);
  await state(catalog.url, 'expired', 'running');
  const response = await pending;
  assert.equal(response.status, 504);
  await response.body?.cancel();
  const cancelled = await state(catalog.url, 'expired', 'cancelled');
  assert.ok(typeof cancelled === 'object' && cancelled !== null && 'state' in cancelled && cancelled.state === 'cancelled');
  const release = await fetch(`${catalog.url}/work/expired/release`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  assert.equal(release.status, 409);
  await release.body?.cancel();
});

test('integration: caller disconnect cancels work through both intermediary processes', async (t) => {
  const { catalog, gateway } = await cluster(t);
  const caller = request(`${gateway.url}/quote/pencil?workId=disconnected&hold=1`, {
    headers: { 'x-request-deadline-ms': String(Date.now() + 4500) },
  });
  const closed = new Promise<void>((resolve) => { caller.once('error', () => resolve()); caller.once('close', () => resolve()); });
  caller.on('response', response => response.resume());
  t.after(() => caller.destroy());
  caller.end();
  await state(catalog.url, 'disconnected', 'running');
  caller.destroy();
  await closed;
  const cancelled = await state(catalog.url, 'disconnected', 'cancelled');
  assert.ok(typeof cancelled === 'object' && cancelled !== null && 'reason' in cancelled);
  assert.equal(cancelled.reason, 'caller');
});

test('integration: methods, unknown products and dependency outage have explicit statuses', async (t) => {
  const { catalog, gateway } = await cluster(t);
  const method = await fetch(`${gateway.url}/quote/pencil?workId=method`, { method: 'POST', signal: AbortSignal.timeout(5000) });
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET');
  await method.body?.cancel();
  for (const service of [catalog, gateway]) {
    const health = await fetch(`${service.url}/health`, { method: 'POST', signal: AbortSignal.timeout(5000) });
    assert.equal(health.status, 405);
    await health.body?.cancel();
  }
  const unknown = await get(`${gateway.url}/quote/missing?workId=unknown`);
  assert.equal(unknown.status, 404);
  await unknown.body?.cancel();
  await catalog.stop();
  const unavailable = await get(`${gateway.url}/quote/pencil?workId=down`);
  assert.equal(unavailable.status, 503);
  await unavailable.body?.cancel();
});

import { createServer } from 'node:http';

test('integration: bounded upstream parsing rejects malformed, oversized and redirected replies', async (t) => {
  const peer = createServer((req, res) => {
    const id = new URL(req.url ?? '/', 'http://localhost').searchParams.get('workId');
    res.setHeader('content-type', id === 'plain' ? 'text/plain' : 'application/json');
    if (id === 'redirect') { res.writeHead(302, { location: '/products/pencil' }); res.end(); }
    else if (id === 'large') res.end(' '.repeat(9000));
    else if (id === 'broken') res.end('{');
    else res.end(JSON.stringify({ productId: 'pencil', priceCents: 125, workId: id, deadlineMs: Number(req.headers['x-request-deadline-ms']) + 1000 }));
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { peer.close(error => error ? reject(error) : resolve()); peer.closeAllConnections(); }));
  const address = peer.address();
  assert.ok(address && typeof address !== 'string');
  const orders = await startService(new URL('../orders.mts', import.meta.url), { CATALOG_URL: `http://127.0.0.1:${address.port}` });
  t.after(() => orders.stop());
  for (const id of ['large', 'broken', 'plain', 'redirect', 'extended']) {
    const response = await get(`${orders.url}/quote/pencil?workId=${id}`, { 'x-request-deadline-ms': String(Date.now() + 4500) });
    assert.equal(response.status, 502, id);
    await response.body?.cancel();
  }
});

test('integration: expiry also aborts a downstream response body that never finishes', async (t) => {
  let started: () => void = () => undefined;
  const bodyStarted = new Promise<void>(resolve => { started = resolve; });
  let closed: () => void = () => undefined;
  const bodyClosed = new Promise<void>(resolve => { closed = resolve; });
  const peer = createServer((_req, res) => {
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    started();
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => { peer.close(error => error ? reject(error) : resolve()); peer.closeAllConnections(); }));
  const address = peer.address();
  assert.ok(address && typeof address !== 'string');
  const orders = await startService(new URL('../orders.mts', import.meta.url), { CATALOG_URL: `http://127.0.0.1:${address.port}` });
  t.after(() => orders.stop());
  const pending = get(`${orders.url}/quote/pencil?workId=streaming`, { 'x-request-deadline-ms': String(Date.now() + 1500) });
  void pending.catch(() => undefined);
  await bodyStarted;
  const response = await pending;
  assert.equal(response.status, 504);
  await response.body?.cancel();
  await bodyClosed;
});
