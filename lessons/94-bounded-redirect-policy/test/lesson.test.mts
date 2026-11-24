import { atDeadline } from '../request.mts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { follow, origins, resolveLocation } from '../policy.mts';
import type { Hop } from '../policy.mts';
import { boot, wire } from './support.mts';

const start = 'http://127.0.0.1:8081';
const target = 'http://127.0.0.1:8082';
const allowed = { start, target };
const redirect = (location: string): Hop => ({status: 302, headers: ['Location', location], body: Buffer.alloc(0)});
const success = (): Hop => ({
  status: 200, headers: ['Content-Type', 'application/json; charset="UTF-8"'],
  body: Buffer.from('{"resource":"manual"}'),
});

test('unit: configured origins normalize and must be distinct literal loopback HTTP origins', () => {
  assert.deepEqual(origins('HTTP://127.0.0.1:08081/', target), allowed);
  assert.throws(() => origins(start, 'http://127.0.0.1:08081/'));
  for (const invalid of [undefined, 'http://localhost:8081', 'http://127.1:8081', start + '/start',
    start + '?', start + '#', 'http://@127.0.0.1:8081', ' https://127.0.0.1:8081', start + '/.']) {
    assert.throws(() => origins(invalid, target), String(invalid));
  }
});

test('unit: resolve relative, absolute and network-path references with HTTP OWS', () => {
  assert.equal(resolveLocation(start + '/step/1', '\t../resource ', allowed), start + '/resource');
  assert.equal(resolveLocation(start + '/start', target + '/step/2', allowed), target + '/step/2');
  assert.equal(resolveLocation(start + '/start', '//127.0.0.1:8082/resource', allowed), target + '/resource');
});

test('unit: reject unsupported components, origins and paths before a call', () => {
  for (const location of ['', '/resource?', '/resource#', '/private', '/res ource', '/step/1%ZZ',
    '/step/\t1', 'http:/resource', 'https://127.0.0.1:8082/resource', 'http://localhost:8082/resource',
    'http://127.1:8082/resource', 'http://127.0.0.1:8083/resource', 'http://@127.0.0.1:8082/resource',
    'http://127.0.0.1:8082\\resource', '///127.0.0.1:8082/resource']) {
    assert.equal(resolveLocation(start + '/start', location, allowed), undefined, location);
  }
});

test('unit: three redirects succeed and a fourth redirect never causes a fifth call', async () => {
  for (const [last, expected] of [[success(), 'success'], [redirect('/resource'), 'upstream_failure']]) {
    const calls: string[] = [];
    const steps = [redirect('/step/1'), redirect('/step/2'), redirect('/step/3'), last];
    const result = await follow(allowed, () => 0, async url => {
      calls.push(url);
      const response = steps.shift();
      assert.ok(response && typeof response !== 'string');
      return response;
    });
    assert.equal(result, expected);
    assert.deepEqual(calls, [start + '/start', start + '/step/1', start + '/step/2', start + '/step/3']);
  }
});

test('unit: normalized loop is detected before opening another hop', async () => {
  const calls: string[] = [];
  const result = await follow(allowed, () => 0, async url => {
    calls.push(url);
    return redirect('/step/../start');
  });
  assert.equal(result, 'upstream_failure');
  assert.deepEqual(calls, [start + '/start']);
});

test('unit: the same monotonic deadline applies to each hop and to final EOF', async () => {
  let now = 10;
  const deadlines: number[] = [];
  const result = await follow(allowed, () => now, async (_url, deadline) => {
    deadlines.push(deadline);
    now += 250;
    return deadlines.length === 1 ? redirect('/resource') : success();
  });
  assert.equal(result, 'upstream_timeout');
  assert.deepEqual(deadlines, [510, 510]);
});

test('unit: final representation requires the complete media type and exact resource schema', async () => {
  for (const hop of [
    {...success(), headers: ['Content-Type', 'application/json; invalid']},
    {...success(), headers: ['Content-Type', 'application/json; charset = utf-8']},
    {...success(), headers: [...success().headers, 'content-TYPE', 'application/json']},
    {...success(), headers: [...success().headers, 'Content-Encoding', 'gzip']},
    {...success(), body: Buffer.from([0x22, 0xff, 0x22])},
    ...['null', '[]', '"manual"', '{"resource":true}', '{"resource":"manual","other":0}',
      '{"resource":"other","resource":"manual"}']
      .map(raw => ({...success(), body: Buffer.from(raw)})),
  ]) {
    assert.equal(await follow(allowed, () => 0, async () => hop), 'upstream_failure');
  }
  assert.equal(await follow(allowed, () => 0, async () => success()), 'success');
});

test('unit: redirect requires a single Location and accepts bounded opaque identity bytes', async () => {
  for (const headers of [[], ['Location', '/resource', 'lOcAtIoN', '/resource'],
    ['Location', '/resource', 'Content-Encoding', 'gzip']]) {
    let calls = 0;
    assert.equal(await follow(allowed, () => 0, async () => {
      calls++;
      return {status: 302, headers, body: Buffer.alloc(0)};
    }), 'upstream_failure');
    assert.equal(calls, 1);
  }
  for (const status of [301, 302, 303, 307, 308, 300, 304, 305, 306, 421]) {
    const calls: string[] = [];
    const result = await follow(allowed, () => 0, async url => {
      calls.push(url);
      return url.endsWith('/start')
        ? {status, headers: ['Location', '/resource'], body: Buffer.from([0xff])}
        : success();
    });
    const follows = [301, 302, 303, 307, 308].includes(status);
    assert.equal(result, follows ? 'success' : 'upstream_failure', String(status));
    assert.deepEqual(calls, follows ? [start + '/start', start + '/resource'] : [start + '/start']);
  }
});

test('unit: importing all entrypoints leaves stdout and stderr empty', async () => {
  const script = ['gateway', 'redirector', 'resource']
    .map(name => `await import(${JSON.stringify(new URL('../' + name + '.mts', import.meta.url).href)})`)
    .join(';');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { timeout: 3000, maxBuffer: 8192 });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

const responseBody = '{"resource":"manual"}';
const jsonType = { 'content-type': 'application/json' };
const failure = (code: string) => ({ error: { code, message: code } });

async function expectReply(origin: string, status: number, body: unknown, signal?: AbortSignal) {
  const reply = await wire(origin, '/resource', {signal});
  assert.equal(reply.status, status, reply.text);
  assert.equal(reply.headers['content-type'], 'application/json;charset=utf-8');
  assert.equal(reply.headers['set-cookie'], undefined);
  const result: unknown = JSON.parse(reply.text);
  assert.deepEqual(result, body);
}

test('integration: three independent services handle the fixed redirect and bodyless routes', async t => {
  const resource = await boot(t, 'resource');
  const redirector = await boot(t, 'redirector', {TARGET_ORIGIN: resource});
  const gateway = await boot(t, 'gateway', {START_ORIGIN: redirector, TARGET_ORIGIN: resource});
  await expectReply(gateway, 200, {resource: 'manual'});
  for (const origin of [gateway, redirector, resource]) {
    assert.equal((await wire(origin, '/health')).status, 200);
    for (const [path, method] of [['/health', 'GET'], ['/unknown', 'GET'], ['/health', 'POST']]) {
      const malformed = await wire(origin, path ?? '', {method, headers: ['Host', 'other.invalid']});
      assert.equal(malformed.status, 400);
    }
    const method = await wire(origin, '/health', {method: 'POST'});
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, 'GET');
    assert.deepEqual(JSON.parse(method.text), failure('method_not_allowed'));
    const query = await wire(origin, '/health?');
    assert.equal(query.status, 400);
    assert.deepEqual(JSON.parse(query.text), failure('invalid_query'));
    assert.equal((await wire(origin, '/unknown')).status, 404);
    const body = await wire(origin, '/health', {headers: ['Content-Length', '1'], body: 'x'});
    assert.equal(body.status, 400);
    assert.deepEqual(JSON.parse(body.text), failure('invalid_body'));
  }
});

test('integration: invalid or identical normalized origins fail before gateway startup', async () => {
  for (const invalid of ['http://localhost:8082', start + '/', target + '#']) {
    await assert.rejects(promisify(execFile)(process.execPath,
      [new URL('../gateway.mts', import.meta.url).pathname],
      {env: {...process.env, PORT: '0', START_ORIGIN: start, TARGET_ORIGIN: invalid},
        timeout: 3000, maxBuffer: 8192}), {code: 1, stdout: ''});
  }
});

async function fixture(t: TestContext,
  handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer({maxHeaderSize: 8192, headersTimeout: 1000, requestTimeout: 1000}, handler);
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  server.setTimeout(1500, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return 'http://127.0.0.1:' + address.port;
}

function later(res: ServerResponse, delay: number, finish: () => void) {
  const timer = setTimeout(finish, delay);
  res.once('close', () => clearTimeout(timer));
}

test('integration: redirects honor relative paths, exact attempt counts, EOF and the header allowlist', async t => {
  const calls: string[] = [];
  const outbound: Array<{fields: string[]; host?: string; accept?: string}> = [];
  let redirectComplete = false;
  let early = false;
  let status = 301;
  const record = (label: string, req: IncomingMessage) => {
    calls.push(`${req.method} ${label}${req.url}`);
    outbound.push({fields: Object.keys(req.headers).sort(), host: req.headers.host, accept: req.headers.accept});
  };
  const destination = await fixture(t, (req, res) => {
    record('target', req);
    if (!redirectComplete) early = true;
    res.writeHead(200, {...jsonType, 'set-cookie': 'session=peer'}).end(responseBody);
  });
  const source = await fixture(t, (req, res) => {
    record('start', req);
    if (req.url === '/start') res.writeHead(status, {Location: 'step/1'}).end();
    else if (req.url === '/step/1') res.writeHead(302, {Location: '2'}).end();
    else if (req.url === '/step/2') {
      res.writeHead(307, {Location: destination + '/resource'}).write(Buffer.from([0, 255]));
      later(res, 35, () => {
        redirectComplete = true;
        res.end(Buffer.from([128]));
      });
    } else res.writeHead(404).end();
  });
  const gateway = await boot(t, 'gateway', {START_ORIGIN: source, TARGET_ORIGIN: destination});
  for (status of [301, 302, 303, 307, 308]) {
    calls.length = 0;
    outbound.length = 0;
    redirectComplete = false;
    const reply = await wire(gateway, '/resource', {headers: [
      'Authorization', 'Bearer demo', 'Cookie', 'secret=demo', 'Proxy-Authorization', 'Basic demo',
      'Connection', 'x-secret', 'X-Secret', 'demo', 'Accept', 'text/html',
    ]});
    assert.equal(reply.status, 200);
    assert.equal(reply.text, responseBody);
    assert.equal(reply.headers['set-cookie'], undefined);
    assert.equal(early, false);
    assert.deepEqual(calls, ['GET start/start', 'GET start/step/1', 'GET start/step/2', 'GET target/resource']);
    assert.deepEqual(outbound, [source, source, source, destination].map(origin => ({
      fields: ['accept', 'host'], host: new URL(origin).host, accept: 'application/json',
    })));
  }
});

test('integration: rejected targets and malformed upstream replies cannot escape the chain policy', async t => {
  const excludedPaths: string[] = [];
  const excluded = await fixture(t, (req, res) => {
    if (req.url !== '/health') excludedPaths.push(req.url ?? '');
    res.writeHead(200, jsonType).end(responseBody);
  });
  assert.equal((await wire(excluded, '/health')).status, 200);
  assert.deepEqual(excludedPaths, []);

  let mode = 'healthy';
  const calls: string[] = [];
  const destination = await fixture(t, (req, res) => {
    calls.push('target' + req.url);
    if (mode === 'late-final') {
      res.writeHead(200, jsonType).write(responseBody);
      later(res, 320, () => res.end());
    } else if (mode === 'oversize' || mode === 'limit') {
      res.writeHead(200, jsonType).write(responseBody);
      res.end(' '.repeat((mode === 'limit' ? 8192 : 8193) - Buffer.byteLength(responseBody)));
    } else res.writeHead(200, jsonType).end(mode === 'malformed' ? '{"resource":' : responseBody);
  });
  const source = await fixture(t, (req, res) => {
    calls.push('start' + req.url);
    const next = destination + '/resource';
    switch (mode) {
      case 'off-origin':
        res.writeHead(302, {Location: excluded + '/resource'}).end();
        return;
      case 'late-duplicate': {
        const fields = ['Location', next, 'Content-Length', '0'];
        for (let index = 0; index < 1100; index++) fields.push('x', 'x');
        fields.push('lOcAtIoN', excluded + '/resource');
        res.writeHead(302, fields).end();
        return;
      }
      case 'header-limit':
        res.writeHead(302, {Location: next, 'X-Padding': 'x'.repeat(8193)}).end();
        return;
      case 'loop':
        res.writeHead(308, {Location: '/step/../start'}).end();
        return;
      case 'hop-limit': {
        const paths = new Map([['/start', '/step/1'], ['/step/1', '/step/2'],
          ['/step/2', '/step/3'], ['/step/3', next]]);
        res.writeHead(301, {Location: paths.get(req.url ?? '') ?? '/resource'}).end();
        return;
      }
      case 'misdirected':
        res.writeHead(421, {Location: next}).end();
        return;
      case 'stall-redirect':
        res.writeHead(302, {Location: next}).write('partial');
        later(res, 750, () => res.end());
        return;
      case 'late-hops':
        later(res, 320, () => res.writeHead(302, {Location: req.url === '/start' ? '/step/1' : next}).end());
        return;
      case 'late-final':
        later(res, 320, () => res.writeHead(302, {Location: next}).end());
        return;
      default:
        res.writeHead(302, {Location: next}).end();
    }
  });
  const gateway = await boot(t, 'gateway', {START_ORIGIN: source, TARGET_ORIGIN: destination});
  await expectReply(gateway, 200, {resource: 'manual'});
  for (const scenario of [
    {mode: 'off-origin', calls: ['start/start']},
    {mode: 'late-duplicate', calls: ['start/start']},
    {mode: 'header-limit', calls: ['start/start']},
    {mode: 'loop', calls: ['start/start']},
    {mode: 'hop-limit', calls: ['start/start', 'start/step/1', 'start/step/2', 'start/step/3']},
    {mode: 'misdirected', calls: ['start/start']},
    {mode: 'malformed', calls: ['start/start', 'target/resource']},
    {mode: 'oversize', calls: ['start/start', 'target/resource']},
    {mode: 'stall-redirect', calls: ['start/start'], timeout: true},
    {mode: 'late-hops', calls: ['start/start', 'start/step/1'], timeout: true},
    {mode: 'late-final', calls: ['start/start', 'target/resource'], timeout: true},
  ]) {
    mode = scenario.mode;
    calls.length = 0;
    const code = scenario.timeout ? 'upstream_timeout' : 'upstream_failure';
    await expectReply(gateway, scenario.timeout ? 504 : 502, failure(code)).catch(cause => {
      throw new Error(`Scenario ${scenario.mode} failed`, {cause});
    });
    assert.deepEqual(excludedPaths, [], mode);
    assert.deepEqual(calls, scenario.calls, mode);
    mode = 'healthy';
    await expectReply(gateway, 200, {resource: 'manual'});
  }
  mode = 'limit';
  await expectReply(gateway, 200, {resource: 'manual'});
});

async function waitFor(predicate: () => boolean) {
  const deadline = performance.now() + 400;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, 'Fixture did not reach the expected state in time');
    await sleep(5);
  }
}

test('integration: ninth chain is busy and a caller disconnect cancels the hop and releases capacity', async t => {
  const held = new Set<ServerResponse>();
  let hold = true;
  const destination = await fixture(t, (_req, res) => res.writeHead(200, jsonType).end(responseBody));
  const source = await fixture(t, (_req, res) => {
    if (!hold) {
      res.writeHead(302, {Location: destination + '/resource'}).end();
      return;
    }
    held.add(res);
    res.once('close', () => { held.delete(res); });
  });
  const gateway = await boot(t, 'gateway', {START_ORIGIN: source, TARGET_ORIGIN: destination});
  const controllers = Array.from({length: 8}, () => new AbortController());
  t.after(() => controllers.forEach(controller => controller.abort()));
  const pending = controllers.map(controller =>
    wire(gateway, '/resource', {signal: controller.signal}).catch((error: unknown) => error));
  await waitFor(() => held.size === 8);
  await expectReply(gateway, 503, failure('busy'));
  const [first] = controllers;
  assert.ok(first);
  first.abort();
  await pending[0];
  await waitFor(() => held.size === 7);
  hold = false;
  await expectReply(gateway, 200, {resource: 'manual'});
  controllers.forEach(controller => controller.abort());
  await Promise.all(pending);
});


test('unit: an early timer notification cannot expire a monotonic deadline', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0;
  let expirations = 0;
  const cancel = atDeadline(500, () => { expirations++; }, () => now);
  now = 499.75;
  t.mock.timers.tick(500);
  assert.equal(expirations, 0, 'timer notification must recheck the deadline clock');
  now = 500;
  t.mock.timers.tick(1);
  assert.equal(expirations, 1);
  cancel();
  t.mock.timers.tick(1000);
  assert.equal(expirations, 1);
});
