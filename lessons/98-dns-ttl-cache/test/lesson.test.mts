import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import { createServer, IncomingMessage, type RequestListener } from 'node:http';
import { Socket } from 'node:net';
import { createSocket } from 'node:dgram';
import { setTimeout as delay } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import { Cache, type Record4 } from '../cache.mts';
import { HttpError, readJson } from '../http.mts';
import { answer } from '../wire.mts';

async function decodeJson(body: string) {
  const socket = new Socket();
  try {
    const message = new IncomingMessage(socket);
    message.rawHeaders = ['Content-Type', 'application/json'];
    message.complete = true;
    const result = readJson(message, new AbortController().signal, performance.now() + 500);
    message.push(Buffer.from(body));
    message.push(null);
    return await result;
  } finally {
    socket.destroy();
  }
}

test('unit: JSON rejects duplicate decoded keys at any object depth', async () => {
  for (const body of [
    '{"instance":"a","instance":"b"}',
    String.raw`{"instance":"a","inst\u0061nce":"b"}`,
    String.raw`{"error":[{"code":"x","\u0063ode":"y"}]}`,
  ]) {
    await assert.rejects(decodeJson(body), { name: 'Error', message: 'bad_request' });
  }
});

test('unit: JSON handles quoted key-like text and separate object scopes', async () => {
  assert.deepEqual(await decodeJson(JSON.stringify({
    list: [{ code: 'x' }, { code: 'y' }],
    text: '"code": "\\quoted" } , "code":',
    literals: [true, false, null, -12.5e4],
  })), {
    list: [{ code: 'x' }, { code: 'y' }],
    text: '"code": "\\quoted" } , "code":',
    literals: [true, false, null, -125000],
  });
});

test('unit: JSON rejects nesting deeper than the scanner budget', async () => {
  const body = '['.repeat(65) + 'null' + ']'.repeat(65);
  await assert.rejects(decodeJson(body), (error) => error instanceof HttpError && error.status === 400);
});

test('unit: earliest TTL expires at the exact boundary even after a hit', async () => {
  let now = 0;
  const cache = new Cache(async () => [
    { address: '127.0.0.1', ttl: 2 }, { address: '127.0.0.2', ttl: 1 },
  ], () => now);
  const { signal } = new AbortController();
  assert.equal(await cache.get(signal), '127.0.0.1');
  now = 999;
  await cache.get(signal);
  assert.deepEqual(cache.stats, { cacheHits: 1, dnsQueries: 1 });
  now = 1000;
  await cache.get(signal);
  assert.deepEqual(cache.stats, { cacheHits: 1, dnsQueries: 2 });
});

test('unit: zero TTL bypasses storage and long TTL is capped at 30 seconds', async () => {
  let now = 0;
  let ttl = 0;
  const cache = new Cache(async () => [{ address: '127.0.0.1', ttl }], () => now);
  const { signal } = new AbortController();
  await cache.get(signal);
  ttl = 100;
  await cache.get(signal);
  now = 29_999;
  await cache.get(signal);
  assert.deepEqual(cache.stats, { cacheHits: 1, dnsQueries: 2 });
  now = 30_000;
  await cache.get(signal);
  assert.equal(cache.stats.dnsQueries, 3);
});

test('unit: invalid records and lookup errors never populate the cache', async () => {
  let queries = 0;
  const cache = new Cache(async () => {
    queries++;
    if (queries === 1) throw new Error('NXDOMAIN');
    return [{ address: queries === 2 ? '127.0.0.3' : '127.0.0.2', ttl: 1 }];
  });
  const { signal } = new AbortController();
  await assert.rejects(cache.get(signal), /NXDOMAIN/);
  await assert.rejects(cache.get(signal), /invalid DNS/);
  assert.equal(await cache.get(signal), '127.0.0.2');
});

test('unit: every record must meet address, count and unsigned TTL limits', async () => {
  const valid = { address: '127.0.0.1', ttl: 1 };
  const invalid = [
    [], Array.from({ length: 9 }, () => valid),
    ...[-1, 0.5, Infinity, NaN, 0x100000000].map((ttl) => [valid, { ...valid, ttl }]),
    [valid, { address: '8.8.8.8', ttl: 1 }],
    [valid, { address: '127.000.0.2', ttl: 1 }],
  ];
  const { signal } = new AbortController();
  for (const records of invalid) {
    const cache = new Cache(async () => records);
    await assert.rejects(cache.get(signal), /invalid DNS/);
  }
});

test('unit: cancellation isolates waiters and abandons a refresh when the last waiter leaves', async () => {
  let finish: ((records: Record4[]) => void) | undefined;
  const result = new Promise<Record4[]>((resolve) => { finish = resolve; });
  const lookupSignals: AbortSignal[] = [];
  const cache = new Cache(async (signal) => {
    lookupSignals.push(signal);
    return result;
  });
  const first = new AbortController();
  const second = new AbortController();
  const a = cache.get(first.signal);
  const b = cache.get(second.signal);
  first.abort();
  await assert.rejects(a, { name: 'AbortError' });
  assert.equal(lookupSignals[0]?.aborted, false);
  second.abort();
  await assert.rejects(b, { name: 'AbortError' });
  assert.equal(lookupSignals[0]?.aborted, true);
  const next = cache.get(new AbortController().signal);
  assert.ok(finish);
  finish([{ address: '127.0.0.2', ttl: 1 }]);
  assert.equal(await next, '127.0.0.2');
  assert.equal(cache.stats.dnsQueries, 2);
});

test('unit: a surviving waiter receives the original refresh result', async () => {
  const cache = new Cache(async (signal) => {
    await Promise.resolve();
    signal.throwIfAborted();
    return [{ address: '127.0.0.1', ttl: 0 }];
  });
  const first = new AbortController();
  const cancelled = cache.get(first.signal);
  const survivor = cache.get(new AbortController().signal);
  first.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(await survivor, '127.0.0.1');
  assert.equal(cache.stats.dnsQueries, 1);
});

function question() {
  return Buffer.from('1234010000010000000000000870726f7669646572066c6573736f6e04746573740000010001', 'hex');
}

test('unit: DNS response echoes the question and encodes a one-second A record', () => {
  assert.equal(answer(question(), '127.0.0.2')?.toString('hex'),
    '1234850000010001000000000870726f7669646572066c6573736f6e04746573740000010001c00c000100010000000100047f000002');
});

test('unit: DNS ignores truncation, bad lengths, compression loops and error responses', () => {
  const badLength = question();
  badLength[12] = 63;
  const response = question();
  response.writeUInt16BE(0x8103, 2);
  const truncated = question();
  truncated.writeUInt16BE(0x0300, 2);
  for (const packet of [question().subarray(0, -1), badLength, response, truncated,
    Buffer.from('123401000001000000000000c00c00010001', 'hex'), Buffer.alloc(513)]) {
    assert.equal(answer(packet, '127.0.0.1'), undefined);
  }
});

async function service(t: TestContext, entry: string, env: Record<string, string> = {}) {
  const running = await startService(new URL(`../${entry}.mts`, import.meta.url), env);
  t.after(running.stop);
  return running;
}

async function http(base: string, path: string, init: RequestInit = {}) {
  const res = await fetch(base + path, { ...init, signal: AbortSignal.timeout(1500), redirect: 'error' });
  const body: unknown = await res.json();
  return { status: res.status, body, allow: res.headers.get('allow') };
}

function field(value: unknown, name: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected object');
  const field: unknown = Object.getOwnPropertyDescriptor(value, name)?.value;
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) throw new Error(`invalid ${name}`);
  return field;
}

function localPort(url: string) { return new URL(url).port; }

function post(value: unknown) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) };
}

async function poll<T>(get: () => Promise<T>, match: (value: T) => boolean, ms: number) {
  const deadline = performance.now() + ms;
  do {
    const value = await get();
    if (match(value)) return value;
    await delay(20);
  } while (performance.now() < deadline);
  throw new Error('poll deadline exceeded');
}

test('integration: real DNS rotation respects TTL, and health survives DNS shutdown', async (t) => {
  const dns = await service(t, 'resolver');
  const a = await service(t, 'provider', { INSTANCE: 'a' });
  const b = await service(t, 'provider', { INSTANCE: 'b', PORT: localPort(a.url) });
  const { body: stats } = await http(dns.url, '/stats');
  const gateway = await service(t, 'gateway', {
    DNS_PORT: String(field(stats, 'dnsPort')), PROVIDER_PORT: localPort(a.url),
  });
  for (const body of [null, [], 'b', { instance: { toString: null } }, { instance: 'b', extra: 1 }]) {
    assert.equal((await http(dns.url, '/target', post(body))).status, 400);
  }
  assert.equal((await http(dns.url, '/target', {
    ...post({ instance: 'b' }), body: '{"instance":"b"}'.padEnd(8193),
  })).status, 413);
  assert.deepEqual(await http(dns.url, '/target', {
    ...post({ instance: 'b' }), body: String.raw`{"instance":"a","inst\u0061nce":"b"}`,
  }), { status: 400, body: { error: { code: 'bad_request', message: 'bad_request' } }, allow: null });
  const method = await http(dns.url, '/target');
  assert.equal(method.status, 405);
  assert.equal(method.allow, 'POST');
  assert.deepEqual((await http(gateway.url, '/value')).body, { instance: 'a' });
  assert.equal((await http(dns.url, '/target', post({ instance: 'b' }))).status, 200);
  assert.deepEqual((await http(gateway.url, '/value')).body, { instance: 'a' });
  assert.equal(field((await http(dns.url, '/stats')).body, 'dnsQueries'), 1);
  await poll(() => http(gateway.url, '/value'), ({ body }) =>
    typeof body === 'object' && body !== null && 'instance' in body && body.instance === 'b', 2200);
  assert.equal(field((await http(dns.url, '/stats')).body, 'dnsQueries'), 2);
  await b.stop();
  assert.equal((await http(gateway.url, '/value')).status, 502);
  assert.equal(field((await http(gateway.url, '/stats')).body, 'dnsQueries'), 2);
  await dns.stop();
  assert.deepEqual((await http(gateway.url, '/health')).body, { ok: true });
});

async function httpFixture(t: TestContext, host: string, handler: RequestListener, port = 0) {
  const server = createServer(handler);
  server.setTimeout(1500, (socket) => socket.destroy());
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error && server.listening) reject(error);
      else resolve();
    });
    server.closeAllConnections();
  }));
  const ready = once(server, 'listening', { signal: AbortSignal.timeout(1000) });
  server.listen(port, host);
  await ready;
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

test('integration: bounded single flight, DNS and HTTP failures, and recovery', async (t) => {
  let redirects = 0;
  const redirectPort = await httpFixture(t, '127.0.0.1', (_req, res) => {
    redirects++;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"instance":"b"}');
  });
  let deniedHits = 0;
  const providerPort = await httpFixture(t, '127.0.0.3', (_req, res) => {
    deniedHits++;
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"instance":"a"}');
  });
  let mode: 'good' | 'redirect' | '421' | 'bad' | 'large' | 'slow' | 'duplicate' | 'trailer' | 'utf8' | 'duplicate-keys' | 'upgrade' | 'informational' | 'close' | 'delayed' = 'good';
  let providerHits = 0;
  let delayedCancelled = false;
  let upgradeCloses = 0;
  await httpFixture(t, '127.0.0.1', (_req, res) => {
    providerHits++;
    const json = '{"instance":"a"}';
    const type = { 'content-type': 'application/json' };
    switch (mode) {
      case 'redirect': res.writeHead(302, { location: `http://127.0.0.1:${redirectPort}/value` }).end(); break;
      case '421': res.writeHead(421, type).end(json); break;
      case 'bad': res.writeHead(200, type).end('{"instance":{"toString":null}}'); break;
      case 'large': res.writeHead(200, type).end(json.padEnd(8193)); break;
      case 'slow': res.writeHead(200, type).write(json); break;
      case 'duplicate-keys':
        res.writeHead(200, type).end(String.raw`{"instance":"a","inst\u0061nce":"b"}`);
        break;
      case 'upgrade':
        res.socket?.once('close', () => { upgradeCloses++; });
        res.socket?.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: lesson-test\r\n\r\n');
        break;
      case 'informational':
        res.writeEarlyHints({ link: '</example>; rel=preload' });
        res.writeHead(200, type).end(json);
        break;
      case 'close': res.destroy(); break;
      case 'delayed': {
        res.writeHead(200, type).write(json);
        const timer = setTimeout(() => res.end(), 300);
        res.once('close', () => {
          clearTimeout(timer);
          delayedCancelled = !res.writableEnded;
        });
        break;
      }
      case 'duplicate': {
        const header = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n' +
          'X:\r\n'.repeat(2010) + 'Content-Type: application/json\r\n' +
          `Content-Length: ${Buffer.byteLength(json)}\r\nConnection: close\r\n\r\n`;
        res.socket?.end(header + json);
        break;
      }
      case 'trailer':
        res.writeHead(200, type).write(json);
        res.addTrailers({ 'content-type': 'application/json' });
        res.end();
        break;
      case 'utf8': res.writeHead(200, type).end(Buffer.from([0xc0, 0xaf])); break;
      case 'good': res.writeHead(200, type).end(json); break;
    }
  }, providerPort);

  const dns = createSocket('udp4');
  const timers = new Set<ReturnType<typeof setTimeout>>();
  t.after(() => {
    for (const timer of timers) clearTimeout(timer);
    return new Promise<void>((resolve) => {
      try { dns.close(resolve); } catch { resolve(); }
    });
  });
  const ready = once(dns, 'listening', { signal: AbortSignal.timeout(1000) });
  dns.bind(0, '127.0.0.1');
  await ready;
  let dnsMode: 'hold' | 'good' | 'silent' | 'nx' | 'forbidden' | 'malformed' | 'delayed' | 'two-records' = 'hold';
  let queries = 0;
  let release: (() => void) | undefined;
  dns.on('message', (packet, remote) => {
    const reply = answer(packet, dnsMode === 'two-records' ? '127.0.0.2' : '127.0.0.1');
    if (!reply) return;
    queries++;
    if (dnsMode === 'silent') return;
    const tail = reply.length - 16;
    reply.writeUInt32BE(0, tail + 6);
    if (dnsMode === 'forbidden') reply[reply.length - 1] = 3;
    if (dnsMode === 'nx') {
      reply.writeUInt16BE(0x8503, 2);
      reply.writeUInt16BE(0, 6);
    }
    if (dnsMode === 'malformed') reply.writeUInt16BE(5, tail + 10);
    let wire = dnsMode === 'nx' ? reply.subarray(0, tail) : reply;
    if (dnsMode === 'two-records') {
      wire = Buffer.concat([reply, reply.subarray(tail)]);
      wire.writeUInt16BE(2, 6);
      wire[wire.length - 1] = 1;
    }
    const send = () => dns.send(wire, remote.port, remote.address, () => {});
    if (dnsMode === 'hold') {
      const timer = setTimeout(() => { timers.delete(timer); release = undefined; send(); }, 350);
      timers.add(timer);
      release = () => { clearTimeout(timer); timers.delete(timer); release = undefined; send(); };
    } else if (dnsMode === 'delayed') {
      const timer = setTimeout(() => { timers.delete(timer); send(); }, 300);
      timers.add(timer);
    } else send();
  });
  const gateway = await service(t, 'gateway', {
    DNS_PORT: String(dns.address().port), PROVIDER_PORT: String(providerPort),
  });
  const batch = Promise.allSettled(Array.from({ length: 8 }, () => http(gateway.url, '/value')));
  await poll(() => http(gateway.url, '/stats'), ({ body }) => field(body, 'active') === 8 && release !== undefined, 300);
  assert.equal((await http(gateway.url, '/value')).status, 503);
  assert.equal(queries, 1);
  release?.();
  for (const result of await batch) {
    assert.equal(result.status, 'fulfilled');
    assert.deepEqual(result.value.body, { instance: 'a' });
  }
  assert.equal(providerHits, 8);
  assert.equal(queries, 1);

  dnsMode = 'silent';
  assert.equal((await http(gateway.url, '/value')).status, 504);
  dnsMode = 'nx';
  assert.equal((await http(gateway.url, '/value')).status, 502);
  dnsMode = 'forbidden';
  assert.equal((await http(gateway.url, '/value')).status, 502);
  assert.equal(deniedHits, 0);
  dnsMode = 'malformed';
  const malformed = await http(gateway.url, '/value');
  assert.ok([502, 504].includes(malformed.status));
  assert.equal(providerHits, 8);

  dnsMode = 'good';
  mode = 'redirect';
  assert.equal((await http(gateway.url, '/value')).status, 502);
  assert.equal(redirects, 0);
  assert.equal(providerHits, 9);
  for (const next of ['421', 'bad', 'large', 'duplicate', 'trailer', 'utf8', 'slow'] as const) {
    mode = next;
    const result = await http(gateway.url, '/value');
    const code = next === 'slow' ? 'timeout' : 'upstream_failure';
    assert.equal(result.status, next === 'slow' ? 504 : 502);
    assert.deepEqual(result.body, { error: { code, message: code } });
  }
  assert.equal(providerHits, 16);
  mode = 'good';
  assert.deepEqual((await http(gateway.url, '/value')).body, { instance: 'a' });
  assert.equal(field((await http(gateway.url, '/stats')).body, 'active'), 0);

  const upstreamFailure = { error: { code: 'upstream_failure', message: 'upstream_failure' } };
  for (const next of ['duplicate-keys', 'informational', 'close', ...Array<'upgrade'>(9).fill('upgrade')] as const) {
    mode = next;
    const result = await http(gateway.url, '/value');
    assert.equal(result.status, 502, next);
    assert.deepEqual(result.body, upstreamFailure);
    assert.equal(field((await http(gateway.url, '/stats')).body, 'active'), 0);
  }
  await poll(async () => upgradeCloses, (count) => count === 9, 250);
  mode = 'good';
  assert.deepEqual((await http(gateway.url, '/value')).body, { instance: 'a' });

  dnsMode = 'delayed';
  mode = 'delayed';
  const hitsBeforeDeadline = providerHits;
  const timedOut = await http(gateway.url, '/value');
  assert.equal(timedOut.status, 504);
  assert.deepEqual(timedOut.body, { error: { code: 'timeout', message: 'timeout' } });
  assert.equal(providerHits, hitsBeforeDeadline + 1);
  await poll(async () => delayedCancelled, (cancelled) => cancelled, 250);
  assert.equal(field((await http(gateway.url, '/stats')).body, 'active'), 0);

  dnsMode = 'two-records';
  mode = 'good';
  const hitsBeforeRefusal = providerHits;
  const queriesBeforeRefusal = queries;
  const refused = await http(gateway.url, '/value');
  assert.equal(refused.status, 502);
  assert.deepEqual(refused.body, upstreamFailure);
  assert.equal(queries, queriesBeforeRefusal + 1);
  assert.equal(providerHits, hitsBeforeRefusal);

  dnsMode = 'good';
  assert.deepEqual((await http(gateway.url, '/value')).body, { instance: 'a' });
  assert.equal(field((await http(gateway.url, '/stats')).body, 'active'), 0);
});
