import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseVariant, parseAccept } from '../accept.mts';

import { validateReply } from '../representation.mts';
for (const [header, expected] of [
  ['application/json;q=0,*/*;q=1', 'text/plain'],
  ['application/json;q=0.1,application/*;q=1,text/plain;q=0.2', 'text/plain'],
  ['application/json;q=0,text/plain;q=0,*/*', undefined],
  [undefined, 'application/json'],
  [' IMAGE/PNG, TeXT/PLAIN \t; Q=1.000 ', 'text/plain'],
  ['application/*,text/plain', 'text/plain'],
  ['text/plain,application/json', 'application/json'],
  ['image/png', undefined],
  ['text/plain;q=0.001,application/json;q=0.002', 'application/json'],
  ['text/plain;q=1.,application/json;q=0.', 'text/plain'],
] satisfies ReadonlyArray<readonly [string | undefined, string | undefined]>) {
  test(`unit: choose for ${JSON.stringify(header)}`, () => {
    assert.equal(chooseVariant(parseAccept(header)), expected);
  });
}

test('unit: normalize media and express quality in thousandths', () => {
  assert.deepEqual(parseAccept(' Text/Plain ; Q=0.03 , application/* '), [
    { media: 'text/plain', quality: 30 }, { media: 'application/*', quality: 1000 },
  ]);
});

for (const header of [
  '', ' ', ',text/plain', 'text/plain,', 'text/plain,,application/json',
  'text', 'text /plain', 'text/', '/plain', '*/plain', '*/*x', 'text/pl*ain',
  'text/plain, TEXT/PLAIN;q=0', '*/*,*/*;q=0',
  'text/plain;charset=utf-8', 'text/plain;q=1;ext=x', 'text/plain;q=1;q=0',
  'text/plain;q="1"', 'text/plain;q=.5', 'text/plain;q=01',
  'text/plain;q=1.001', 'text/plain;q=0.1234', 'text/plain;q=2',
  'text/plain;q=-0', 'text/plain;q=1e0', 'text/plain;q=',
  'text/plain;q =1', 'text/plain;q= 1', 'text/plain\r\n', 'text/é',
  'x/'.padEnd(1025, 'a'), Array.from({ length: 17 }, (_, i) => `x/${i}`).join(','),
]) {
  test(`unit: reject malformed or oversized Accept ${JSON.stringify(header.slice(0, 80))}`, () => {
    assert.throws(() => parseAccept(header), { message: 'invalid_accept' });
  });
}

test('unit: accept the inclusive byte and range limits', () => {
  assert.equal(parseAccept('x/'.padEnd(1024, 'a')).length, 1);
  assert.equal(parseAccept(Array.from({ length: 16 }, (_, i) => `x/${i}`).join(',')).length, 16);
});

test('unit: entrypoints import silently', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    '--input-type=module', '--eval',
    `await import(${JSON.stringify(new URL('../provider.mts', import.meta.url).href)});
     await import(${JSON.stringify(new URL('../gateway.mts', import.meta.url).href)});`,
  ], { timeout: 3000 });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('integration: independent processes negotiate exact representations and route contracts', async t => {
  const { start, exchange } = await import('./support.mts');
  const provider = await start(t, 'provider');
  const gateway = await start(t, 'gateway', { PROVIDER_ORIGIN: provider.origin });
  for (const origin of [provider.origin, gateway.origin]) {
    const get = (path: string, headers?: Record<string, string | string[]>, method?: string) =>
      exchange(origin, path, headers, method);
    assert.equal((await get('/health')).status, 200);
    for (const [path, method] of [['/greeting', 'GET'], ['/missing', 'GET'], ['/greeting', 'POST']]) {
      const malformed = await exchange(origin, path ?? '', ['Host', 'first.invalid', 'Host', 'second.invalid'], method);
      assert.equal(malformed.status, 400);
    }
    const json = await get('/greeting');
    assert.equal(json.status, 200);
    assert.equal(json.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(json.headers.vary, 'Accept');
    assert.deepEqual(json.body, Buffer.from('{"greeting":"xin-chao"}'));
    const plain = await get('/greeting', { accept: ['application/json;q=0', '*/*;q=1'] });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(plain.headers.vary, 'Accept');
    assert.deepEqual(plain.body, Buffer.from('xin-chao\n'));
    const refused = await get('/greeting', { accept: 'image/png' });
    assert.equal(refused.status, 406);
    assert.equal(refused.headers.vary, 'Accept');
    assert.equal(refused.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(refused.body.toString(), '{"error":{"code":"not_acceptable","message":"not_acceptable"}}');
    for (const accept of [
      ['text/plain', 'TEXT/PLAIN'], 'text/plain;q="1"',
      ['x/'.padEnd(600, 'a'), 'y/'.padEnd(600, 'a')],
    ]) {
      const invalid = await get('/greeting', { accept });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.toString(), '{"error":{"code":"invalid_accept","message":"invalid_accept"}}');
    }
    const wrong = await get('/health', {}, 'POST');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.allow, 'GET');
    assert.equal((await get('/missing')).status, 404);
    assert.equal((await get('/greeting?')).status, 400);
    assert.equal((await get('/health', { 'content-length': '1' })).status, 400);
  }
  await provider.stop();
  assert.equal((await exchange(gateway.origin, '/health')).status, 200);
  assert.equal((await exchange(gateway.origin, '/greeting')).status, 502);
});

test('integration: reject malformed provider replies, never retry or follow redirects', async t => {
  const { start, exchange, listen } = await import('./support.mts');
  let destinationHits = 0;
  const destination = await listen(t, (_req, res) => {
    destinationHits++;
    res.end('redirect reached');
  });

  const jsonType = 'application/json; charset=utf-8';
  const json = '{"greeting":"xin-chao"}';
  const validError = '{"error":{"code":"not_acceptable","message":"not_acceptable"}}';
  const jsonFields = ['Content-Type', jsonType, 'Vary', 'Accept'];
  const cases: ReadonlyArray<{
    name: string; body?: string | Buffer; fields?: string[]; accept?: string; status?: number; stall?: boolean;
  }> = [
    { name: 'invalid UTF-8', body: Buffer.from([0xff]) },
    { name: 'invalid JSON', body: '{' },
    { name: 'invalid success schema', body: '{"greeting":"other"}' },
    { name: 'extra success field', body: '{"greeting":"xin-chao","extra":0}' },
    { name: 'wrong text bytes', fields: ['Content-Type', 'text/plain; charset=utf-8', 'Vary', 'Accept'], body: 'xin-chao' },
    { name: 'unsupported variant', fields: ['Content-Type', 'image/png', 'Vary', 'Accept'] },
    { name: 'excluded JSON variant', accept: 'application/json;q=0,*/*' },
    { name: 'missing Vary', fields: ['Content-Type', jsonType] },
    { name: 'wrong Vary', fields: ['Content-Type', jsonType, 'Vary', 'Origin'] },
    { name: 'duplicate Vary', fields: [...jsonFields, 'Vary', 'Accept'] },
    { name: 'duplicate Content-Type', fields: [...jsonFields, 'Content-Type', jsonType] },
    { name: 'missing Content-Type', fields: ['Vary', 'Accept'] },
    { name: 'malformed MIME suffix', fields: ['Content-Type', jsonType + '; bad', 'Vary', 'Accept'] },
    { name: 'unexpected coding', fields: [...jsonFields, 'Content-Encoding', 'gzip'] },
    { name: 'duplicate coding', fields: [...jsonFields, 'Content-Encoding', 'identity', 'Content-Encoding', 'identity'] },
    { name: 'duplicate length', fields: [...jsonFields, 'Content-Length', String(json.length), 'Content-Length', String(json.length)] },
    { name: 'oversized valid JSON', body: ' '.repeat(8193 - json.length) + json },
    ...['null', '[]', '42', '{"error":[]}', '{"error":{"code":"internal_error","message":"internal_error"}}',
      '{"error":{"code":"not_acceptable","message":"wrong"}}',
      '{"error":{"code":"not_acceptable","message":"not_acceptable","extra":0}}'].map(body =>
      ({ name: `invalid 406 ${body}`, status: 406, body, accept: 'image/png' })),
    { name: 'spurious refusal', status: 406, body: validError },
    { name: 'unexpected status', status: 422, body: validError, accept: 'image/png' },
    { name: 'misdirected request', status: 421 },
    { name: 'redirect', status: 307, fields: ['Location', destination + '/capture'] },
    { name: 'headers followed by stalled body', stall: true },
  ];
  let mode: {
    body?: string | Buffer; fields?: string[]; status?: number; stall?: boolean;
  } = {};
  let hits = 0;
  let receivedAccept: string | undefined;
  const upstream = await listen(t, (req, res) => {
    hits++;
    receivedAccept = req.headers.accept;
    res.writeHead(mode.status ?? 200, mode.fields ?? jsonFields);
    if (mode.stall) {
      res.write('{"greeting":');
      return;
    }
    res.end(mode.body ?? json);
  });
  const gateway = await start(t, 'gateway', { PROVIDER_ORIGIN: upstream });
  for (const entry of cases) {
    mode = entry;
    const headers: Record<string, string> = {};
    if (entry.accept !== undefined) headers.accept = entry.accept;
    const before = hits;
    const reply = await exchange(gateway.origin, '/greeting', headers);
    assert.equal(destinationHits, 0, entry.name);
    assert.equal(hits, before + 1, entry.name);
    assert.equal(reply.status, 502, entry.name);
    assert.equal(reply.body.toString(), '{"error":{"code":"upstream_failure","message":"upstream_failure"}}', entry.name);
  }
  mode = { body: ' '.repeat(8192 - json.length) + json };
  const limit = await exchange(gateway.origin, '/greeting', { accept: ['application/json', 'text/plain;q=0'] });
  assert.equal(limit.status, 200);
  assert.equal(limit.body.toString(), json);
  assert.match(receivedAccept ?? '', /^application\/json,\s*text\/plain;q=0$/);
});

test('integration: cap dependency concurrency at eight and release slots after deadline', async t => {
  const { start, exchange, listen } = await import('./support.mts');
  let hits = 0;
  let allStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { allStarted = resolve; });
  const upstream = await listen(t, (_req, _res) => {
    hits++;
    if (hits === 8) allStarted();
  });
  const gateway = await start(t, 'gateway', { PROVIDER_ORIGIN: upstream });
  const first = Promise.all(Array.from({ length: 8 }, () => exchange(gateway.origin, '/greeting')));
  void first.catch(() => {});
  const { setTimeout: delay } = await import('node:timers/promises');
  const deadline = new AbortController();
  try {
    await Promise.race([started, delay(1500, undefined, { signal: deadline.signal }).then(() => {
      throw new Error('Eight calls did not reach the peer');
    })]);
  } finally {
    deadline.abort();
  }
  const excess = await exchange(gateway.origin, '/greeting');
  assert.equal(excess.status, 503);
  assert.equal(excess.body.toString(), '{"error":{"code":"busy","message":"busy"}}');
  assert.equal((await exchange(gateway.origin, '/health')).status, 200);
  assert.deepEqual((await first).map(reply => reply.status), Array<number>(8).fill(502));
  assert.equal(hits, 8);
  assert.equal((await exchange(gateway.origin, '/greeting')).status, 502);
  assert.equal(hits, 9);
});

test('unit: validate acceptable JSON and reject a well-shaped unexpected error', () => {
  const fields = ['Content-Type', 'application/json; charset=utf-8', 'Vary', 'Accept'];
  assert.equal(validateReply(200, fields, Buffer.from('{"greeting":"xin-chao"}'), parseAccept(undefined)), 'application/json');
  assert.throws(() => validateReply(406, fields,
    Buffer.from('{"error":{"code":"internal_error","message":"internal_error"}}'), parseAccept('image/png')));
});


test('unit: conflicting duplicate JSON members cannot hide an invalid greeting or error', () => {
  const fields = ['Content-Type', 'application/json; charset=utf-8', 'Vary', 'Accept'];
  assert.throws(() => validateReply(200, fields,
    Buffer.from('{"greeting":"wrong","greeting":"xin-chao"}'), parseAccept(undefined)));
  for (const body of [
    '{"error":{"code":"internal_error","code":"not_acceptable","message":"not_acceptable"}}',
    '{"error":{"code":"not_acceptable","message":"wrong","message":"not_acceptable"}}',
    '{"error":null,"error":{"code":"not_acceptable","message":"not_acceptable"}}',
  ]) assert.throws(() => validateReply(406, fields, Buffer.from(body), parseAccept('image/png')));
});


test('integration: frequent bytes cannot extend the total response deadline and upstream is cancelled', async t => {
  const { start, exchange, listen } = await import('./support.mts');
  let finishBody = false;
  let resolveClosed = () => {};
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  const upstream = await listen(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', Vary: 'Accept' });
    res.write('{"greeting":"xin-chao"}');
    let ticks = 0;
    const timer = setInterval(() => {
      res.write(' ');
      if (++ticks === 7) {
        finishBody = true;
        clearInterval(timer);
        res.end();
      }
    }, 100);
    res.once('close', () => { clearInterval(timer); resolveClosed(); });
  });
  const gateway = await start(t, 'gateway', { PROVIDER_ORIGIN: upstream });
  const result = await exchange(gateway.origin, '/greeting');
  assert.equal(result.status, 502);
  assert.deepEqual(JSON.parse(result.body.toString()), { error: { code: 'upstream_failure', message: 'upstream_failure' } });
  assert.equal(finishBody, false, 'valid body would finish at700ms if total deadline were weakened');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('upstream connection was not cancelled')), 1000);
    })]);
  } finally { clearTimeout(timer); }
  assert.equal(finishBody, false, 'upstream closed before its normal end, not merely eventually');
});
