import { test } from 'node:test';
import assert from 'node:assert/strict';

// Dynamic loading makes the pre-implementation failure an explicit assertion.
test('unit: histogram exposes cumulative buckets, count and injected-clock sum', async () => {
  const module = await import('../metrics.mts').catch(() => undefined);
  assert.ok(module, 'Metrics implementation must exist and expose real observations');
  let now = 0;
  const metrics = new module.Metrics(() => now);
  const done = metrics.begin('/work', 'GET');
  now = 250;
  done('ok', 200);
  done('cancelled', 0);
  const output = metrics.render();
  assert.match(output, /http_request_duration_seconds_bucket\{route="\/work",method="GET",le="0.1"\} 0/);
  assert.match(output, /http_request_duration_seconds_bucket\{route="\/work",method="GET",le="0.5"\} 1/);
  assert.match(output, /http_request_duration_seconds_bucket\{route="\/work",method="GET",le="\+Inf"\} 1/);
  assert.match(output, /http_request_duration_seconds_count\{route="\/work",method="GET"\} 1/);
  assert.match(output, /http_request_duration_seconds_sum\{route="\/work",method="GET"\} 0.25/);
  assert.match(output, /http_requests_total\{route="\/work",method="GET",outcome="ok",status="200"\} 1/);
  assert.match(output, /http_active_requests\{route="\/work",method="GET"\} 0/);
  assert.doesNotMatch(output, /outcome="cancelled"/);
});

import { Metrics, escapeLabel } from '../metrics.mts';
test('unit: escaping and finite labels resist arbitrary input', () => {
  assert.equal(escapeLabel('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
  const metrics = new Metrics(() => 0);
  for (let i = 0; i < 100; i++) metrics.begin(`/private/${i}`, `CUSTOM${i}`)('error', 900 + i);
  const output = metrics.render();
  assert.match(output, /route="unknown",method="OTHER",outcome="error",status="other"\} 100/);
  assert.equal(output.split('\n').filter(line => line.startsWith('http_request_duration_seconds_bucket')).length, 5);
  assert.doesNotMatch(output, /private|CUSTOM/);
});
test('unit: concurrent observations and cancellation return gauge to zero', () => {
  let now = 0;
  const metrics = new Metrics(() => now);
  const first = metrics.begin('/work', 'GET');
  const second = metrics.begin('/work', 'GET');
  assert.match(metrics.render(), /http_active_requests\{route="\/work",method="GET"\} 2/);
  now = 1000; first('error', 502);
  now = 2000; second('cancelled', 0); second('ok', 200);
  assert.match(metrics.render(), /http_active_requests\{route="\/work",method="GET"\} 0/);
  assert.match(metrics.render(), /seconds_sum\{route="\/work",method="GET"\} 3/);
  assert.match(metrics.render(), /le="1"\} 1/);
  assert.match(metrics.render(), /le="\+Inf"\} 2/);
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';

test('unit: importing entrypoints ignores invalid runtime configuration and exits silently', async () => {
  const entries = ['gateway.mts', 'downstream.mts'].map(name => new URL(`../${name}`, import.meta.url).href);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `for (const entry of ${JSON.stringify(entries)}) await import(entry);`], {
    env: { PATH: process.env.PATH ?? '', PORT: 'invalid', WORK_MS: '-1', DEADLINE_MS: 'invalid', DOWNSTREAM_URL: 'not a URL' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(signal, null); assert.equal(code, 0);
    assert.equal(stdout, ''); assert.equal(stderr, '');
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

async function scrape(service: RunningService): Promise<string> {
  const response = await fetch(`${service.url}/metrics`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/plain; version=0.0.4/);
  return response.text();
}
function sample(text: string, name: string, labels: string): number {
  const prefix = `${name}{${labels}} `;
  const line = text.split('\n').find(value => value.startsWith(prefix));
  assert.ok(line, `Missing ${prefix} in ${text}`);
  return Number(line.slice(prefix.length));
}
const work = 'route="/work",method="GET"';
function total(text: string): number {
  return text.split('\n').filter(line => line.startsWith('http_requests_total{')).reduce((sum, line) => sum + Number(line.slice(line.lastIndexOf(' ') + 1)), 0);
}
async function until(service: RunningService, predicate: (text: string) => boolean): Promise<string> {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    const text = await scrape(service);
    if (predicate(text)) return text;
    await pause(10);
  }
  assert.fail('Metrics did not reach expected state within 4 seconds');
}
const entry = (name: string) => new URL(`../${name}.mts`, import.meta.url);

test('integration: independent processes expose exact counters, synchronized gauge and bounded unknown routes', async () => {
  const downstream = await startService(entry('downstream'), { WORK_MS: '800' });
  let gateway: RunningService | undefined;
  const requests: Promise<Response>[] = [];
  try {
    gateway = await startService(entry('gateway'), { DOWNSTREAM_URL: downstream.url, DEADLINE_MS: '3000' });
    assert.notEqual(gateway.child.pid, downstream.child.pid);
    assert.equal(total(await scrape(gateway)), 0);
    assert.equal(total(await scrape(downstream)), 0);
    for (let i = 0; i < 2; i++) requests.push(fetch(`${gateway.url}/work`, { signal: AbortSignal.timeout(5000) }));
    const inFlight = (text: string) => text.includes(`http_active_requests{${work}} 2`);
    await until(downstream, inFlight);
    await until(gateway, inFlight);
    for (const response of await Promise.all(requests)) { assert.equal(response.status, 200); await response.text(); }
    for (const service of [gateway, downstream]) {
      const text = await until(service, value => total(value) === 2);
      assert.equal(sample(text, 'http_requests_total', `${work},outcome="ok",status="200"`), 2);
      assert.equal(sample(text, 'http_active_requests', work), 0);
      assert.equal(sample(text, 'http_request_duration_seconds_bucket', `${work},le="+Inf"`), 2);
      assert.equal(sample(text, 'http_request_duration_seconds_count', work), 2);
      assert.ok(sample(text, 'http_request_duration_seconds_sum', work) > 0);
      assert.equal(total(await scrape(service)), 2, 'Scrapes must not count themselves');
      const baseline = text.split('\n').filter(line => line.startsWith('http_')).length;
      for (let i = 0; i < 25; i++) {
        const response = await fetch(`${service.url}/missing-${i}?requestId=${i}`, { signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 404); await response.text();
      }
      const unknown = await until(service, value => total(value) === 27);
      assert.equal(sample(unknown, 'http_requests_total', 'route="unknown",method="GET",outcome="error",status="404"'), 25);
      assert.equal(unknown.split('\n').filter(line => line.startsWith('http_')).length, baseline + 9);
      assert.doesNotMatch(unknown, /missing-|requestId/);
    }
  } finally { await Promise.allSettled(requests); await gateway?.stop(); await downstream.stop(); }
});

test('integration: dependency rejection and deadline clean active gauges', async () => {
  for (const scenario of [
    { env: { FAIL_WORK: '1', WORK_MS: '0' }, deadline: '1000', status: 502, downstreamOutcome: 'error', downstreamStatus: '500' },
    { env: { FAIL_WORK: '0', WORK_MS: '1000' }, deadline: '150', status: 504, downstreamOutcome: 'cancelled', downstreamStatus: 'other' },
  ]) {
    const downstream = await startService(entry('downstream'), scenario.env);
    let gateway: RunningService | undefined;
    try {
      gateway = await startService(entry('gateway'), { DOWNSTREAM_URL: downstream.url, DEADLINE_MS: scenario.deadline });
      const response = await fetch(`${gateway.url}/work`, { signal: AbortSignal.timeout(3000) });
      assert.equal(response.status, scenario.status); await response.text();
      const gatewayText = await until(gateway, text => total(text) === 1);
      assert.equal(sample(gatewayText, 'http_requests_total', `${work},outcome="error",status="${scenario.status}"`), 1);
      assert.equal(sample(gatewayText, 'http_active_requests', work), 0);
      const downstreamText = await until(downstream, text => total(text) === 1);
      assert.equal(sample(downstreamText, 'http_requests_total', `${work},outcome="${scenario.downstreamOutcome}",status="${scenario.downstreamStatus}"`), 1);
      assert.equal(sample(downstreamText, 'http_active_requests', work), 0);
    } finally { await gateway?.stop(); await downstream.stop(); }
  }
});

test('integration: caller disconnect aborts dependency and records completion exactly once', async () => {
  const downstream = await startService(entry('downstream'), { WORK_MS: '2500' });
  let gateway: RunningService | undefined;
  const caller = new AbortController();
  let request: Promise<unknown> | undefined;
  try {
    gateway = await startService(entry('gateway'), { DOWNSTREAM_URL: downstream.url, DEADLINE_MS: '5000' });
    request = fetch(`${gateway.url}/work`, { signal: caller.signal }).then(async response => {
      await response.text(); return 'unexpected response';
    }, (error: unknown) => error);
    await until(downstream, text => text.includes(`http_active_requests{${work}} 1`));
    caller.abort();
    const result = await request;
    assert.ok(result instanceof Error && result.name === 'AbortError');
    for (const service of [gateway, downstream]) {
      const text = await until(service, value => total(value) === 1);
      assert.equal(sample(text, 'http_requests_total', `${work},outcome="cancelled",status="other"`), 1);
      assert.equal(sample(text, 'http_active_requests', work), 0);
    }
    await pause(100);
    assert.equal(total(await scrape(gateway)), 1);
    assert.equal(total(await scrape(downstream)), 1);
  } finally { caller.abort(); await request; await gateway?.stop(); await downstream.stop(); }
});
