import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { correlationId, context, logLine } from '../context.mts';

test('unit: accept bounded IDs and replace missing, duplicate or unsafe input', () => {
  assert.equal(correlationId('order_A-19'), 'order_A-19');
  assert.equal(correlationId('a'.repeat(64)), 'a'.repeat(64));
  const generated = [undefined, '', 'a'.repeat(65), 'two ids', 'bad\nline', 'trailing\n', 'trailing\r\n', 'é', ['one', 'two'], 'a,b']
    .map(value => correlationId(value));
  for (const id of generated) assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(new Set(generated).size, generated.length);
});

test('unit: asynchronous interleaving isolates context and restores it after errors', async () => {
  const lines: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = context.run({ id: 'first' }, async () => {
    lines.push(logLine('gateway', 'request_started'));
    await gate;
    lines.push(logLine('gateway', 'request_finished', 200));
  });
  await context.run({ id: 'second' }, async () => {
    await Promise.resolve();
    lines.push(logLine('catalog', 'request_started'));
    release();
  });
  await first;
  assert.deepEqual(lines.map(line => object(JSON.parse(line)).correlationId), ['first', 'second', 'first']);
  assert.throws(() => context.run({ id: 'failed' }, () => { throw new Error('failure'); }));
  assert.equal(context.getStore(), undefined);
  assert.throws(() => logLine('gateway', 'request_started'), /context/);
});

test('unit: JSON log schema is an allowlist with no request secrets', () => {
  const extra = { id: 'safe-id', authorization: 'SECRET' };
  const line = context.run(extra, () =>
    logLine('gateway', 'request_finished', 502));
  const record: unknown = JSON.parse(line);
  assert.deepEqual(Object.keys(object(JSON.parse(line))).sort(),
    ['timestamp', 'level', 'service', 'event', 'correlationId', 'status'].sort());
  assert.ok(typeof record === 'object' && record !== null);
  assert.equal(object(JSON.parse(line)).status, 502);
  assert.equal(object(JSON.parse(line)).level, 'error');
  const timestamp = object(JSON.parse(line)).timestamp;
  assert.equal(typeof timestamp, 'string');
  assert.ok(Number.isFinite(Date.parse(String(timestamp))));
  assert.ok(!line.includes('SECRET'));
});

import type { TestContext } from 'node:test';
import { createInterface } from 'node:readline';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

type RecordValue = Record<string, unknown>;
function assertRecord(value: unknown): asserts value is RecordValue {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
}
function object(value: unknown): RecordValue {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value));
  assertRecord(value);
  return value;
}
function capture(service: RunningService) {
  assert.ok(service.child.stdout);
  const records: RecordValue[] = [];
  const lines = createInterface({ input: service.child.stdout });
  lines.on('line', line => { records.push(object(JSON.parse(line))); });
  return { records, close: () => lines.close() };
}
async function setup(t: TestContext, catalogEnv: Record<string, string> = {}, gatewayEnv: Record<string, string> = {}) {
  const services: RunningService[] = [];
  const captures: ReturnType<typeof capture>[] = [];
  t.after(async () => {
    try { await Promise.all(services.map(service => service.stop())); }
    finally { for (const output of captures) output.close(); }
  });
  const catalog = await startService(new URL('../catalog.mts', import.meta.url), catalogEnv);
  services.push(catalog);
  const catalogLogs = capture(catalog); captures.push(catalogLogs);
  const gateway = await startService(new URL('../gateway.mts', import.meta.url), { CATALOG_URL: catalog.url, ...gatewayEnv });
  services.push(gateway);
  const gatewayLogs = capture(gateway); captures.push(gatewayLogs);
  assert.notEqual(catalog.child.pid, gateway.child.pid);
  return { catalog, gateway, catalogLogs: catalogLogs.records, gatewayLogs: gatewayLogs.records };
}
async function waitFor(check: () => boolean) {
  const until = performance.now() + 3000;
  while (!check()) {
    assert.ok(performance.now() < until, 'expected log records before deadline');
    await sleep(10);
  }
}
function get(service: RunningService, id?: string, path = '/quote', method = 'GET') {
  return fetch(`${service.url}${path}`, {
    method, headers: { ...(id === undefined ? {} : { 'x-correlation-id': id }),
      authorization: 'Bearer DO_NOT_LOG', cookie: 'session=DO_NOT_LOG' },
    signal: AbortSignal.timeout(5000),
  });
}
function events(records: RecordValue[], id: string) {
  return records.filter(record => record.correlationId === id).map(record => record.event);
}

test('integration: overlapping requests propagate real headers and keep both process logs isolated', async t => {
  const f = await setup(t, { DELAY_MS: '500' });
  const pending = get(f.gateway, 'trip-A', '/quote?token=DO_NOT_LOG');
  // Attach a rejection handler immediately while waiting for the downstream start log.
  const first = pending.then(value => ({ value }), (error: unknown) => ({ error }));
  await waitFor(() => events(f.catalogLogs, 'trip-A').includes('request_started'));
  const second = await get(f.gateway, 'trip-B');
  const result = await first;
  if ('error' in result) throw result.error;
  for (const [response, id] of [[result.value, 'trip-A'], [second, 'trip-B']] as const) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-correlation-id'), id);
    assert.deepEqual(await response.json(), { priceCents: 125, correlationId: id });
  }
  await waitFor(() => ['trip-A', 'trip-B'].every(id =>
    events(f.gatewayLogs, id).includes('request_finished') && events(f.catalogLogs, id).includes('request_finished')));
  assert.deepEqual(f.catalogLogs.slice(0, 2).map(record => record.event),
    ['request_started', 'request_started'], 'both downstream requests must start before either finishes');
  for (const id of ['trip-A', 'trip-B']) {
    assert.deepEqual(events(f.catalogLogs, id), ['request_started', 'request_finished']);
    assert.deepEqual(events(f.gatewayLogs, id), ['request_started', 'upstream_finished', 'request_finished']);
  }
  for (const [service, records] of [['gateway', f.gatewayLogs], ['catalog', f.catalogLogs]] as const) {
    for (const record of records) {
      assert.equal(record.service, service);
      assert.ok(record.correlationId === 'trip-A' || record.correlationId === 'trip-B');
      assert.deepEqual(Object.keys(record).sort(),
        (record.event === 'request_started'
          ? ['timestamp', 'level', 'service', 'event', 'correlationId']
          : ['timestamp', 'level', 'service', 'event', 'correlationId', 'status']).sort());
      if (record.event !== 'request_started') assert.equal(record.status, 200);
    }
    assert.ok(!JSON.stringify(records).includes('DO_NOT_LOG'));
  }
});

test('integration: absent and invalid IDs are generated once and observed by downstream', async t => {
  const f = await setup(t);
  const ids: string[] = [];
  for (const incoming of [undefined, 'invalid,id', 'x'.repeat(65)]) {
    const response = await get(f.gateway, incoming);
    assert.equal(response.status, 200);
    const id = response.headers.get('x-correlation-id');
    assert.ok(id); assert.match(id, /^[0-9a-f-]{36}$/); ids.push(id);
    assert.equal(object(await response.json()).correlationId, id);
    await waitFor(() => events(f.catalogLogs, id).includes('request_finished'));
    assert.deepEqual(events(f.catalogLogs, id), ['request_started', 'request_finished']);
  }
  assert.equal(new Set(ids).size, 3);
  // Catalog is also a boundary: it validates direct callers, not just the gateway.
  const direct = await get(f.catalog, 'invalid,id');
  assert.equal(direct.status, 200);
  assert.match(direct.headers.get('x-correlation-id') ?? '', /^[0-9a-f-]{36}$/);
});

test('integration: timeout and routing errors retain correlation without logging secrets', async t => {
  const f = await setup(t, { DELAY_MS: '300' }, { TIMEOUT_MS: '30' });
  const timeout = await get(f.gateway, 'slow-call');
  assert.equal(timeout.status, 504);
  assert.equal(timeout.headers.get('x-correlation-id'), 'slow-call');
  assert.deepEqual(await timeout.json(), { error: 'upstream_timeout' });
  const missing = await get(f.gateway, 'missing-route', '/missing?secret=DO_NOT_LOG');
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-correlation-id'), 'missing-route');
  await missing.arrayBuffer();
  const method = await get(f.gateway, 'wrong-method', '/quote', 'POST');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'GET');
  assert.equal(method.headers.get('x-correlation-id'), 'wrong-method');
  await method.arrayBuffer();
  await waitFor(() => events(f.gatewayLogs, 'wrong-method').includes('request_finished')
    && events(f.gatewayLogs, 'slow-call').includes('request_finished'));
  const failure = f.gatewayLogs.find(record => record.correlationId === 'slow-call' && record.event === 'request_finished');
  assert.equal(failure?.status, 504); assert.equal(failure?.level, 'error');
  assert.ok(!JSON.stringify(f.gatewayLogs).includes('DO_NOT_LOG'));
});
