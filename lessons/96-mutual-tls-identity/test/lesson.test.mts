import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { IncomingMessage, ServerResponse } from 'node:http';
import { connect, createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { startService } from '../../../test/support.mts';
import { tlsFiles } from '../config.mts';
import { bodylessRoute, representation, trackConnections, validJsonMedia } from '../wire.mts';
import { exchange, fixture, rawHttp, stalled, until } from './network.mts';
import { endpoint, identity, parseValue, required } from '../contracts.mts';
import { generatePKI, writePKI } from '../pki.mts';

test('unit: a failed spawn rejects without awaiting a nonexistent process exit', async () => {
  let timer: NodeJS.Timeout | undefined;
  try {
    // Restore the executable synchronously before yielding to other test work.
    const started = (() => {
      const original = process.execPath;
      try {
        process.execPath = '/no-such-lesson96-node';
        return startService(new URL('../provider.mts', import.meta.url));
      } finally {
        process.execPath = original;
      }
    })();
    const outcome = await Promise.race([
      started.then(() => 'unexpected success', (error: unknown) =>
        error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'ENOENT' : 'wrong error'),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve('stalled cleanup'), 500); }),
    ]);
    assert.equal(outcome, 'ENOENT');
  } finally {
    clearTimeout(timer);
  }
});

test('unit: identity requires an authenticated peer with the exact pin', () => {
  assert.equal(identity(true, 'AA', 'AA'), 'gateway');
  assert.equal(identity(false, 'AA', 'AA'), undefined);
  assert.equal(identity(true, 'BB', 'AA'), undefined);
  assert.equal(identity(true, undefined, 'AA'), undefined);
});

test('unit: only a literal loopback HTTPS origin with an explicit port is accepted', () => {
  assert.equal(endpoint('https://127.0.0.1:9443/').origin, 'https://127.0.0.1:9443');
  assert.equal(endpoint('https://127.0.0.1:443').origin, 'https://127.0.0.1');
  for (const input of [undefined, 'http://127.0.0.1:9443', 'https://127.1:9443',
    'https://127.0.0.1:9443/a', 'https://127.0.0.1:9443?', 'https://127.0.0.1:9443#',
    'https://u@127.0.0.1:9443', 'https://127.0.0.1:65536', 'https://127.0.0.1:0']) {
    assert.throws(() => endpoint(input));
  }
});

test('unit: missing and whitespace-only environment values fail configuration', () => {
  assert.equal(required({ CA: '/some path/ca.pem' }, 'CA'), '/some path/ca.pem');
  assert.throws(() => required({}, 'CA'));
  assert.throws(() => required({ CA: '  ' }, 'CA'));
});

test('unit: value requires exact JSON schema and fatal UTF-8', () => {
  assert.deepEqual(parseValue(Buffer.from('{"value":"trusted"}')), { value: 'trusted' });
  for (const body of ['null', '[]', '"trusted"', '{"value":true}', '{"value":"trusted","x":0}']) {
    assert.throws(() => parseValue(Buffer.from(body)));
  }
  assert.throws(() => parseValue(Buffer.from([0xff])));
});

test('unit: fresh certificates carry correct trust, SAN, role and dates', () => {
  const pki = generatePKI();
  assert.ok(pki);
  const ca = new X509Certificate(pki.ca);
  const server = new X509Certificate(pki.server.cert);
  const gateway = new X509Certificate(pki.gateway.cert);
  const alternate = new X509Certificate(pki.alternate.cert);
  const expired = new X509Certificate(pki.expired.cert);
  assert.equal(ca.ca, true);
  assert.equal(ca.verify(ca.publicKey), true);
  assert.equal(server.ca, false);
  assert.equal(server.verify(ca.publicKey), true);
  assert.equal(server.checkHost('provider.local', { subject: 'never' }), 'provider.local');
  assert.deepEqual(server.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.deepEqual(gateway.keyUsage, ['1.3.6.1.5.5.7.3.2']);
  assert.equal(gateway.subjectAltName, 'DNS:gateway.local');
  assert.equal(gateway.verify(ca.publicKey), true);
  assert.equal(alternate.verify(ca.publicKey), true);
  assert.equal(alternate.subject, gateway.subject);
  assert.equal(identity(true, gateway.fingerprint256, gateway.fingerprint256), 'gateway');
  assert.equal(identity(true, alternate.fingerprint256, gateway.fingerprint256), undefined);
  assert.equal(new X509Certificate(pki.outsider.cert).verify(ca.publicKey), false);
  assert.ok(server.validFromDate.getTime() < Date.now());
  assert.ok(server.validToDate.getTime() > Date.now());
  assert.ok(expired.validToDate.getTime() < Date.now());
});

test('unit: duplicate JSON keys and valid oversized JSON fail validation', () => {
  assert.throws(() => parseValue(Buffer.from('{"value":"trusted","val\\u0075e":"trusted"}')));
  const oversized = Buffer.from('{"value":"trusted"}' + ' '.repeat(8192));
  const value: unknown = JSON.parse(oversized.toString());
  assert.deepEqual(value, { value: 'trusted' });
  assert.throws(() => parseValue(oversized));
});

test('unit: representation rejects duplicates before normalization and ambiguous framing', () => {
  assert.throws(() => representation(['Content-Type', 'application/json', 'content-type', 'application/json']));
  assert.throws(() => representation(['Content-Length', '15', 'Transfer-Encoding', 'chunked']));
  assert.throws(() => representation(['Transfer-Encoding', 'gzip, chunked']));
  assert.throws(() => representation(['Trailer', 'Content-Type']));
  assert.throws(() => representation(['Connection', 'close', 'connection', 'keep-alive']));
  assert.equal(validJsonMedia('Application/JSON; charset="UTF-8"'), true);
  for (const value of ['application/jsonx', 'application/json;charset=ascii',
    'application/json; charset = utf-8', 'application/json;charset=utf-8;charset=utf-8']) {
    assert.equal(validJsonMedia(value), false);
  }
});

test('unit: TLS configuration rejects missing paths and malformed local files', () => {
  assert.throws(() => tlsFiles({}), /TLS_CA/);
  assert.throws(() => tlsFiles({ TLS_CA: new URL(import.meta.url).pathname }), /TLS_CA/);
});

test('unit: connection progress cannot extend the provider lifetime', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = createServer();
  const stop = trackConnections(server, 500);
  const socket = new Socket();
  t.after(() => { stop(); socket.destroy(); });
  server.emit('connection', socket);
  t.mock.timers.tick(300);
  socket.emit('data', Buffer.from([0x16]));
  t.mock.timers.tick(199);
  assert.equal(socket.destroyed, false);
  t.mock.timers.tick(1);
  assert.equal(socket.destroyed, true);
});

test('unit: shutdown destroys pending sockets before their deadlines', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const server = createServer();
  const stop = trackConnections(server, 500);
  const socket = new Socket();
  t.after(() => socket.destroy());
  server.emit('connection', socket);
  assert.equal(socket.destroyed, false);
  stop();
  assert.equal(socket.destroyed, true);
});

test('unit: a bodyless GET advertising upgrade cannot reach business logic', async () => {
  const socket = new Socket();
  try {
    const request = new IncomingMessage(socket);
    request.method = 'GET';
    request.url = '/value';
    request.rawHeaders = ['Host', 'localhost', 'Connection', 'Upgrade', 'Upgrade', 'websocket'];
    request.complete = true;
    request.push(null);
    const response = new ServerResponse(request);
    assert.equal(await bodylessRoute(request, response), undefined);
    assert.equal(response.statusCode, 400);
  } finally {
    socket.destroy();
  }
});

test('unit: PKI refuses a private destination below a writable non-sticky ancestor', (t) => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'lesson96-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shared = join(root, 'shared');
  const directory = join(shared, 'private');
  mkdirSync(shared, { mode: 0o700 });
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(shared, 0o777);
  assert.throws(() => writePKI(directory), /Unsafe PKI/);
  assert.deepEqual(readdirSync(directory), []);
  chmodSync(shared, 0o1777);
  assert.ok(writePKI(directory).server.cert);
  assert.throws(() => writePKI(directory), /already exists/);
  const privateChild = join(root, 'new-private');
  assert.ok(writePKI(privateChild).server.cert);
});

test('unit: legacy provider certificate is CA-valid with a matching CN and no SAN', () => {
  const pki = generatePKI();
  const certificate = new X509Certificate(pki.legacyCnOnly.cert);
  assert.equal(certificate.verify(new X509Certificate(pki.ca).publicKey), true);
  assert.deepEqual(certificate.keyUsage, ['1.3.6.1.5.5.7.3.1']);
  assert.equal(certificate.checkHost('provider.local'), 'provider.local');
  assert.equal(certificate.subjectAltName, undefined);
  assert.equal(certificate.checkHost('provider.local', { subject: 'never' }), undefined);
});

function setup(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'lesson96-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pki = writePKI(dir);
  const env = (pair: string, ca = 'ca') => ({
    TLS_CA: join(dir, `${ca}.pem`),
    TLS_CERT: join(dir, `${pair}.pem`),
    TLS_KEY: join(dir, `${pair}.key`),
  });
  return { pki, env, pin: join(dir, 'gateway.pem') };
}

async function service(t: TestContext, name: 'provider' | 'gateway', env: Record<string, string>) {
  const running = await startService(new URL(`../${name}.mts`, import.meta.url), env);
  t.after(running.stop);
  return running;
}

const origin = (port: number) => `https://127.0.0.1:${port}`;
const tlsOrigin = (url: string) => url.replace(/^http:/, 'https:');
const error = (code: string) => ({ error: { code, message: code } });

async function expectError(url: string, status: number, code: string) {
  const result = await exchange(url).result;
  assert.equal(result.status, status);
  assert.deepEqual(result.body, error(code));
}

test('integration: provider requires mTLS and pins the actual gateway certificate', async (t) => {
  const { pki, env, pin } = setup(t);
  const provider = await service(t, 'provider', { ...env('server'), GATEWAY_PIN_CERT: pin });
  const providerURL = tlsOrigin(provider.url);
  const gateway = await service(t, 'gateway', { ...env('gateway'), PROVIDER_ORIGIN: providerURL });
  const forwarded = await exchange(gateway.url + '/value', {
    headers: { authorization: 'local-only', 'x-service-identity': 'fake' },
  }).result;
  assert.equal(forwarded.status, 200);
  assert.deepEqual(forwarded.body, { value: 'trusted' });

  const auth = { ca: pki.ca, servername: 'provider.local' };
  const health = await exchange(providerURL + '/health', { ...auth, ...pki.gateway }).result;
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok' });
  for (const peer of [{}, pki.outsider, pki.expired]) {
    await assert.rejects(exchange(providerURL + '/value', {
      ...auth, ...peer, headers: { 'x-service-identity': 'gateway' },
    }).result, (reason: unknown) => reason instanceof Error &&
      'code' in reason && typeof reason.code === 'string' && (reason.code.startsWith('ERR_SSL_') || reason.code === 'ECONNRESET'));
  }
  const denied = await exchange(providerURL + '/value', {
    ...auth, ...pki.alternate,
    headers: { 'x-service-identity': 'gateway', 'x-client-fingerprint': new X509Certificate(pki.gateway.cert).fingerprint256 },
  }).result;
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.body, error('forbidden'));

  const url = new URL(provider.url);
  const pendingHandshake = connect(Number(url.port), '127.0.0.1');
  pendingHandshake.on('error', () => {});
  try {
    const closed = new Promise<void>((resolve) => pendingHandshake.once('close', () => resolve()));
    // This connection sends no ClientHello. Stop must close it as well as HTTP sockets.
    await new Promise<void>((resolve, reject) => {
      pendingHandshake.once('connect', resolve);
      pendingHandshake.once('error', reject);
      pendingHandshake.setTimeout(2000, () => pendingHandshake.destroy(new Error('Handshake test deadline')));
    });
    await provider.stop();
    await closed;
    assert.equal(provider.child.exitCode, 0, 'provider should stop cleanly');
  } finally {
    pendingHandshake.destroy();
  }
  assert.deepEqual((await exchange(gateway.url + '/health').result).body, { status: 'ok' });
  await expectError(gateway.url + '/value', 502, 'upstream_failure');
});

test('integration: wrong trust anchor and wrong server SAN fail before business HTTP', async (t) => {
  const { pki, env } = setup(t);
  const server = await fixture(t, pki);
  const wrongHost = await fixture(t, pki, pki.wrongHost);
  const legacy = await fixture(t, pki, pki.legacyCnOnly);
  const wrongTrust = await service(t, 'gateway', {
    ...env('gateway', 'other-ca'), PROVIDER_ORIGIN: origin(server.port),
  });
  const wrongName = await service(t, 'gateway', {
    ...env('gateway'), PROVIDER_ORIGIN: origin(wrongHost.port),
  });
  const cnOnly = await service(t, 'gateway', {
    ...env('gateway'), PROVIDER_ORIGIN: origin(legacy.port),
  });
  await expectError(cnOnly.url + '/value', 502, 'upstream_failure');
  assert.equal(legacy.hits(), 0);
  await expectError(wrongTrust.url + '/value', 502, 'upstream_failure');
  await expectError(wrongName.url + '/value', 502, 'upstream_failure');
  assert.equal(server.hits(), 0);
  assert.equal(wrongHost.hits(), 0);
});

test('integration: trickling an incomplete TLS record cannot renew the provider deadline', async (t) => {
  const { env, pin } = setup(t);
  const running = await service(t, 'provider', { ...env('server'), GATEWAY_PIN_CERT: pin });
  const socket = connect({
    host: '127.0.0.1', port: Number(new URL(running.url).port), signal: AbortSignal.timeout(2000),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    // TLS handshake record with a ClientHello whose declared body is never completed.
    socket.write(Buffer.from([0x16, 0x03, 0x01, 0x10, 0x00, 0x01, 0x00, 0x0f, 0xfc]));
    let drips = 0;
    const drip = setInterval(() => {
      drips++;
      socket.write(Buffer.from([0x03]));
    }, 80);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('close', (hadError) => {
          if (!hadError) resolve();
        });
        socket.on('error', (reason: NodeJS.ErrnoException) => {
          if (reason.code === 'ECONNRESET') resolve();
          else reject(reason);
        });
      });
      assert.ok(drips >= 3, 'the provider closed before the fixture established progress');
    } finally {
      clearInterval(drip);
    }
  } finally {
    socket.destroy();
  }
});

test('integration: both services reject raw upgrade requests with the normal route contract', async (t) => {
  const { pki, env, pin } = setup(t);
  const running = await service(t, 'provider', { ...env('server'), GATEWAY_PIN_CERT: pin });
  const upstream = await fixture(t, pki);
  const gateway = await service(t, 'gateway', { ...env('gateway'), PROVIDER_ORIGIN: origin(upstream.port) });
  const auth = { ca: pki.ca, ...pki.gateway };
  const upgrade = (method: string, path: string, extra = '') =>
    `${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${extra}\r\n`;
  for (const [url, tls] of [[running.url, auth], [gateway.url, undefined]] as const) {
    const method = await rawHttp(url, upgrade('POST', '/value'), tls);
    assert.match(method.headers, /^HTTP\/1\.1 405 /);
    assert.match(method.headers, /\r\nAllow: GET(?:\r\n|$)/i);
    assert.deepEqual(method.body, error('method_not_allowed'));

    const cases = [
      [upgrade('GET', '/value'), 400, 'bad_request'],
      [upgrade('GET', '/value?q=1'), 400, 'bad_request'],
      [upgrade('GET', '/missing'), 404, 'not_found'],
      [upgrade('POST', '/value', 'Content-Length: 1\r\n') + 'x', 400, 'bad_request'],
      [upgrade('POST', '/value', 'Host: duplicate\r\n'), 400, 'bad_request'],
      [upgrade('GET', '/value', 'Connection: close\r\n'), 400, 'bad_request'],
    ] as const;
    for (const [payload, status, code] of cases) {
      const response = await rawHttp(url, payload, tls);
      assert.ok(response.headers.startsWith(`HTTP/1.1 ${status} `), response.headers);
      assert.deepEqual(response.body, error(code));
    }
  }
  const denied = await rawHttp(running.url, upgrade('GET', '/value', 'X-Service-Identity: gateway\r\n'), {
    ca: pki.ca, ...pki.alternate,
  });
  assert.match(denied.headers, /^HTTP\/1\.1 403 /);
  assert.deepEqual(denied.body, error('forbidden'));
  assert.equal(upstream.hits(), 0);
});

test('integration: a stalled TLS peer consumes one bounded attempt', async (t) => {
  const { env } = setup(t);
  const peer = stalled(t);
  const gateway = await service(t, 'gateway', {
    ...env('gateway'), PROVIDER_ORIGIN: origin(await peer.port),
  });
  await expectError(gateway.url + '/value', 502, 'upstream_failure');
  assert.equal(peer.hits(), 1);
  await until(() => peer.closed() === 1);
  assert.equal((await exchange(gateway.url + '/health').result).status, 200);
});

test('integration: upstream wire failures are contained and the gateway recovers', async (t) => {
  const { pki, env } = setup(t);
  const server = await fixture(t, pki);
  const destination = await fixture(t, pki);
  const gateway = await service(t, 'gateway', { ...env('gateway'), PROVIDER_ORIGIN: origin(server.port) });
  const valueURL = gateway.url + '/value';
  const valid = '{"value":"trusted"}';

  for (const status of [302, 421]) {
    server.set((_request, response) => {
      response.writeHead(status, { location: origin(destination.port) + '/value' }).end();
    });
    const prev = server.hits();
    await expectError(valueURL, 502, 'upstream_failure');
    assert.equal(server.hits(), prev + 1);
    assert.equal(destination.hits(), 0);
  }

  // Keep the exact schema. Padding is JSON whitespace, so only the wire bound changes.
  const oversized = valid + ' '.repeat(8192);
  for (const [type, body] of [
    ['application/json', '{"value":"wrong"}'],
    ['text/plain', valid],
    ['application/json', oversized],
  ]) {
    server.set((_request, response) => response.writeHead(200, { 'content-type': type }).end(body));
    await expectError(valueURL, 502, 'upstream_failure');
  }

  // Do not end this valid chunked response: the byte guard must cancel the peer
  // without waiting for EOF or the gateway's total 500 ms deadline.
  let overflowClosed = false;
  let overflowStarted = 0;
  server.set((_request, response) => {
    overflowStarted = performance.now();
    response.once('close', () => { overflowClosed = true; });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(oversized);
  });
  await expectError(valueURL, 502, 'upstream_failure');
  await until(() => overflowClosed);
  assert.ok(performance.now() - overflowStarted < 400,
    'overflow must close the unfinished peer before the total deadline');

  server.set((_request, response) => {
    // Keep the duplicate below the byte cap but beyond the default header count.
    response.socket?.end('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' +
      'a:\r\n'.repeat(2000) + 'Content-Type: application/json\r\nConnection: close\r\n\r\n' + valid);
  });
  await expectError(valueURL, 502, 'upstream_failure');

  server.set((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(valid);
    response.addTrailers({ 'Content-Type': 'application/json' });
    response.end();
  });
  await expectError(valueURL, 502, 'upstream_failure');

  server.set((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write(valid);
    server.later(() => response.end(), 900);
  });
  await expectError(valueURL, 502, 'upstream_failure');

  server.set((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers['x-service-identity'], undefined);
    response.writeHead(200, { 'content-type': 'application/json;charset=utf-8' }).end(valid);
  });
  const recovered = await exchange(valueURL, {
    headers: { authorization: 'caller-only', 'x-service-identity': 'caller' },
  }).result;
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body, { value: 'trusted' });

  await expectError(gateway.url + '/value?q=1', 400, 'bad_request');
  await expectError(gateway.url + '/missing', 404, 'not_found');
  const method = await exchange(valueURL, { method: 'POST' }).result;
  assert.equal(method.status, 405);
  assert.equal(method.allow, 'GET');
  assert.deepEqual(method.body, error('method_not_allowed'));
  const body = await exchange(valueURL, { headers: { 'content-length': '1' } }).result;
  assert.equal(body.status, 400);
});

test('integration: capacity rejects excess and reopens after caller cancellation', async (t) => {
  const { pki, env } = setup(t);
  const server = await fixture(t, pki);
  let closed = 0;
  server.set((_request, response) => {
    response.once('close', () => { closed++; });
    response.writeHead(200, { 'content-type': 'application/json' }).flushHeaders();
  });
  const gateway = await service(t, 'gateway', { ...env('gateway'), PROVIDER_ORIGIN: origin(server.port) });
  const valueURL = gateway.url + '/value';
  const pending = Array.from({ length: 8 }, () => {
    const call = exchange(valueURL);
    const outcome = call.result.catch((reason: unknown) => reason);
    t.after(call.cancel);
    return { ...call, outcome };
  });
  await until(() => server.hits() === 8);
  await expectError(valueURL, 503, 'busy');
  const first = pending[0];
  assert.ok(first);
  first.cancel();
  await first.outcome;
  await until(() => closed >= 1);
  server.set((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"value":"trusted"}');
  });
  assert.deepEqual((await exchange(valueURL).result).body, { value: 'trusted' });
  assert.equal(server.hits(), 9);
  assert.equal(closed, 1, 'other held calls should still be active when the new call succeeds');
  for (const call of pending) call.cancel();
  await Promise.all(pending.map((call) => call.outcome));
});
