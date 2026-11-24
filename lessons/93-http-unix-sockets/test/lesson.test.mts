import assert from 'node:assert/strict';
import { test } from 'node:test';
import { socketPath, parseValue, jsonMedia, decodeUtf8 } from '../contract.mts';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, lstat, mkdir, readFile, readlink, symlink, unlink, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { cleanupStack, deadline, privateDir, start } from './support.mts';

test('unit: socket path requires a canonical private directory and fits in 100 UTF-8 bytes', () => {
  const metadata = { directory: true, uid: 42, mode: 0o40700, canonical: '/private' };
  assert.equal(socketPath('/private', 42, metadata), '/private/provider.sock');
  for (const invalid of [
    { ...metadata, directory: false },
    { ...metadata, uid: 43 },
    { ...metadata, mode: 0o40710 },
    { ...metadata, canonical: '/elsewhere' },
  ]) assert.throws(() => socketPath('/private', 42, invalid));
  assert.throws(() => socketPath('private', 42, metadata));
  const short = '/' + 'a'.repeat(85);
  assert.equal(Buffer.byteLength(socketPath(short, 42, { ...metadata, canonical: short })), 100);
  const long = '/' + 'é'.repeat(43);
  assert.throws(() => socketPath(long, 42, { ...metadata, canonical: long }));
});

test('unit: upstream body requires fatal UTF-8 and exactly the local value', () => {
  assert.deepEqual(parseValue(Buffer.from('{"value":"local-only"}')), { value: 'local-only' });
  for (const wire of ['null', '[]', '42', '{"value":false}', '{"value":"other"}',
    '{"value":"local-only","extra":0}', '{"value":"other","value":"local-only"}']) {
    assert.throws(() => parseValue(Buffer.from(wire)));
  }
  assert.throws(() => parseValue(Buffer.from([0xff])));
});

test('unit: JSON media checks the complete supported representation', () => {
  assert.equal(jsonMedia('Application/JSON; charset="UTF-8"'), true);
  assert.equal(jsonMedia('application/json'), true);
  for (const media of ['application/json;', 'application/json; charset=utf-16',
    'application/json; charset="utf-8', 'application/json; charset=utf-8; charset=utf-8',
    'application/json, application/json']) assert.equal(jsonMedia(media), false);
});

test('unit: importing entrypoints with no configuration exits silently', async () => {
  const run = promisify(execFile);
  const modules = ['provider', 'gateway'].map(name => new URL(`../${name}.mts`, import.meta.url).href);
  const { stdout, stderr } = await run(process.execPath, ['--input-type=module', '-e',
    `await Promise.all(${JSON.stringify(modules)}.map(url => import(url)))`],
  { env: { ...process.env, SOCKET_DIR: '' }, timeout: 2000 });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

function base(ready: unknown): string {
  assert.ok(ready && typeof ready === 'object' && 'port' in ready);
  assert.ok(typeof ready.port === 'number' && ready.port > 0 && ready.port <= 65535);
  return `http://127.0.0.1:${ready.port}`;
}

function get(url: string, path: string, init?: RequestInit) {
  return fetch(url + path, { ...init, signal: AbortSignal.timeout(2500), redirect: 'manual' });
}

async function errorResponse(response: Response, status: number, code: string) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('content-type'), 'application/json;charset=utf-8');
  const body: unknown = await response.json();
  assert.deepEqual(body, { error: { code, message: code } });
}

test('integration: provider lifecycle, collision with active provider, and gateway recovery', async t => {
  const stack = cleanupStack(t);
  const dir = await privateDir(stack);
  const path = join(dir, 'provider.sock');
  const gateway = base(await start(stack, 'gateway', dir).ready);
  assert.deepEqual(await (await get(gateway, '/health')).json(), { ok: true });
  await errorResponse(await get(gateway, '/value'), 502, 'upstream_failure');

  const provider = start(stack, 'provider', dir);
  assert.deepEqual(await provider.ready, { socketPath: path });
  assert.ok((await lstat(path)).isSocket());
  const second = start(stack, 'provider', dir);
  await assert.rejects(second.ready);
  assert.equal(await second.closed(), 1);
  assert.deepEqual(await (await get(gateway, '/value')).json(), { value: 'local-only' });

  await provider.stop();
  assert.equal(await provider.closed(), 0);
  await assert.rejects(lstat(path), { code: 'ENOENT' });
  assert.ok((await lstat(dir)).isDirectory());
  await errorResponse(await get(gateway, '/value'), 502, 'upstream_failure');
  assert.equal((await get(gateway, '/health')).status, 200);

  const restarted = start(stack, 'provider', dir);
  await restarted.ready;
  assert.deepEqual(await (await get(gateway, '/value')).json(), { value: 'local-only' });
  await restarted.stop();
  await assert.rejects(lstat(path), { code: 'ENOENT' });
});

test('integration: startup preserves file, symlink and directory collisions and rejects unsafe directories', async t => {
  const stack = cleanupStack(t);
  const dir = await privateDir(stack);
  const path = join(dir, 'provider.sock');
  async function fails(service: 'provider' | 'gateway', directory: string) {
    const child = start(stack, service, directory);
    await assert.rejects(child.ready);
    assert.equal(await child.closed(), 1);
  }
  await writeFile(path, 'original bytes');
  await fails('provider', dir);
  assert.equal(await readFile(path, 'utf8'), 'original bytes');
  await unlink(path);
  const target = join(dir, 'target');
  await writeFile(target, 'target bytes');
  await symlink(target, path);
  await fails('provider', dir);
  assert.equal(await readlink(path), target);
  assert.equal(await readFile(target, 'utf8'), 'target bytes');
  await unlink(path);
  await mkdir(path);
  await fails('provider', dir);
  assert.ok((await lstat(path)).isDirectory());
  const alias = join(dir, 'alias');
  await symlink(dir, alias);
  await fails('gateway', alias);
  await chmod(dir, 0o750);
  await fails('gateway', dir);
  await fails('provider', dir);
});

test('integration: local route, method, query and body errors do not depend on provider', async t => {
  const stack = cleanupStack(t);
  const dir = await privateDir(stack);
  const url = base(await start(stack, 'gateway', dir).ready);
  await errorResponse(await get(url, '/missing'), 404, 'not_found');
  // URL-based clients can drop a bare '?' (including fetch on Node24.12).
  const emptyQuery = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(url, {
      path: '/value?', agent: false, signal: AbortSignal.timeout(2500),
    }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject).end();
  });
  assert.equal(emptyQuery.status, 400);
  assert.deepEqual(JSON.parse(emptyQuery.body), { error: { code: 'invalid_query', message: 'invalid_query' } });
  for (const [path, method] of [['/value', 'GET'], ['/missing', 'GET'], ['/value', 'POST']]) {
  const duplicateHost = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(url, {
      path, method, headers: ['Host', 'first.invalid', 'Host', 'second.invalid'],
      agent: false, signal: AbortSignal.timeout(2500),
    }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject).end();
  });
  assert.equal(duplicateHost.status, 400);
  assert.deepEqual(JSON.parse(duplicateHost.body), { error: { code: 'invalid_body', message: 'invalid_body' } });
  }
  const wrongMethod = await get(url, '/value', { method: 'POST' });
  assert.equal(wrongMethod.headers.get('allow'), 'GET');
  await errorResponse(wrongMethod, 405, 'method_not_allowed');
  const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
    const req = request(url + '/value', {
      method: 'GET', headers: { 'content-length': '1' }, agent: false, signal: AbortSignal.timeout(2000),
    }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', (chunk: string) => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject).end('x');
  });
  assert.equal(response.status, 400);
  assert.deepEqual(JSON.parse(response.body), { error: { code: 'invalid_body', message: 'invalid_body' } });
});

test('integration: upstream framing, schema, redirects, byte and complete-response deadlines', async t => {
  const stack = cleanupStack(t);
  const dir = await privateDir(stack);
  let redirected = 0;
  const destination = createServer((_req, res) => { redirected++; res.end(); });
  stack.push(() => deadline(new Promise<void>(resolve => {
    destination.close(() => resolve());
    destination.closeAllConnections();
  }), 2000));
  destination.listen(0, '127.0.0.1');
  await deadline(once(destination, 'listening'), 2000);
  const address = destination.address();
  assert.ok(address && typeof address !== 'string');

  let mode = 'bad-json';
  let attempts = 0;
  let heldResolve: (() => void) | undefined;
  const peer = createServer((req, res) => {
    attempts++;
    assert.equal(req.url, '/value');
    const headers = ['Content-Type', 'application/json'];
    const valid = '{"value":"local-only"}';
    if (mode === 'duplicate') {
      // Put the duplicate beyond Node's default field-count limit, within 8192 bytes.
      for (let i = 0; i < 1050; i++) headers.push('X', 'y');
      headers.push('content-type', 'application/json');
    }
    if (mode === 'coding') headers.push('Content-Encoding', 'gzip');
    if (mode === 'redirect') headers.push('Location', `http://127.0.0.1:${address.port}/target`);
    res.writeHead(mode === 'redirect' ? 307 : mode === '421' ? 421 : 200, headers);
    if (mode === 'hold') {
      res.write(valid);
      if (attempts === 8) heldResolve?.();
      return;
    }
    if (mode === 'timeout') { res.write(valid); return; }
    if (mode === 'oversize') { res.end(valid + ' '.repeat(8192)); return; }
    if (mode === 'bad-json') { res.end('{'); return; }
    if (mode === 'bad-schema') { res.end('{"value":"local-only","extra":true}'); return; }
    res.end(valid);
  });
  stack.push(() => deadline(new Promise<void>(resolve => {
    peer.close(() => resolve());
    peer.closeAllConnections();
  }), 2000));
  peer.listen(join(dir, 'provider.sock'));
  await deadline(once(peer, 'listening'), 2000);
  const url = base(await start(stack, 'gateway', dir).ready);

  for (const failure of ['bad-json', 'bad-schema', 'oversize', 'coding', 'duplicate', 'redirect', '421', 'timeout']) {
    mode = failure;
    const before = attempts;
    const started = performance.now();
    await errorResponse(await get(url, '/value'), 502, 'upstream_failure');
    assert.equal(attempts - before, 1, failure);
    assert.equal(redirected, 0, failure);
    if (failure === 'timeout') {
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 450 && elapsed < 1500, `complete-response deadline elapsed ${elapsed}ms`);
    }
  }

  mode = 'hold';
  attempts = 0;
  const held = new Promise<void>(resolve => { heldResolve = resolve; });
  const inflight = Promise.all(Array.from({ length: 8 }, async () =>
    errorResponse(await get(url, '/value'), 502, 'upstream_failure')));
  try {
    await deadline(held, 1000);
    await errorResponse(await get(url, '/value'), 503, 'busy');
    assert.equal((await get(url, '/health')).status, 200);
    assert.equal(attempts, 8);
  } finally {
    await inflight;
  }
  mode = 'success';
  assert.deepEqual(await (await get(url, '/value')).json(), { value: 'local-only' });
});


test('unit: malformed UTF-8 inside a JSON string is rejected before schema checks', () => {
  const malformed = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  assert.throws(() => decodeUtf8(malformed), TypeError);
  assert.equal(decodeUtf8(Buffer.from('{"note":"�"}')), '{"note":"�"}');
});


test('integration: a continuously arriving Unix response cannot renew its total deadline', async t => {
  const stack = cleanupStack(t);
  const dir = await privateDir(stack);
  let finishBody = false;
  let resolveClosed = () => {};
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const peer = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"value":"local-only"}');
    let ticks = 0;
    const timer = setInterval(() => {
      res.write(' ');
      if (++ticks === 7) { finishBody = true; clearInterval(timer); res.end(); }
    }, 100);
    res.once('close', () => { clearInterval(timer); resolveClosed(); });
  });
  stack.push(() => deadline(new Promise<void>(resolve => {
    peer.close(() => resolve());
    peer.closeAllConnections();
  }), 2000));
  peer.listen(join(dir, 'provider.sock'));
  await deadline(once(peer, 'listening'), 2000);
  const url = base(await start(stack, 'gateway', dir).ready);
  await errorResponse(await get(url, '/value'), 502, 'upstream_failure');
  assert.equal(finishBody, false, 'valid body would finish at700ms if total deadline were weakened');
  await deadline(closed, 1000);
  assert.equal(finishBody, false, 'upstream closed before its normal end');
});
