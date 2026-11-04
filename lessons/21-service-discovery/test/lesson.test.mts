import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, RoundRobin } from '../model.mts';

test('unit: exact expiry, renewal, removal and bounded capacity', () => {
  let time = 0;
  const registry = new Registry(() => time, 1);
  const a = registry.register('a', 'http://127.0.0.1:1234', 100);
  time = 99;
  assert.equal(registry.list().length, 1);
  registry.renew('a', a.owner, 100);
  time = 100;
  assert.equal(registry.list().length, 1);
  assert.throws(() => registry.register('b', 'http://127.0.0.1:1235', 100));
  time = 199;
  assert.equal(registry.list().length, 0);
  assert.throws(() => registry.renew('a', a.owner, 100));
  assert.throws(() => registry.remove('a', a.owner));
  const newer = registry.register('a', a.url, 100);
  assert.notEqual(newer.owner, a.owner);
  assert.throws(() => registry.renew('a', a.owner, 100));
  assert.throws(() => registry.remove('a', a.owner));
  assert.equal(registry.list().length, 1);
  registry.remove('a', newer.owner);
  assert.equal(registry.list().length, 0);
});
test('unit: validation and active ownership cannot be replaced', () => {
  const registry = new Registry(() => 0);
  for (const url of ['http://example.com:80', 'http://127.0.0.1:12/path', 'http://user@127.0.0.1:12', 'https://127.0.0.1:12', 'http://127.0.0.1:65536']) {
    assert.throws(() => registry.register('a', url, 100));
  }
  assert.throws(() => registry.register('../a', 'http://127.0.0.1:12', 100));
  for (const lease of [0, 99, 5001, NaN]) assert.throws(() => registry.register('a', 'http://127.0.0.1:12', lease));
  const member = registry.register('a', 'http://127.0.0.1:12', 100);
  assert.throws(() => registry.register('a', member.url, 100));
  member.url = 'mutated';
  assert.equal(registry.list()[0]?.url, 'http://127.0.0.1:12');
});
test('unit: deterministic round robin follows changing membership', () => {
  const registry = new Registry(() => 0);
  const a = registry.register('a', 'http://127.0.0.1:12', 100);
  const b = registry.register('b', 'http://127.0.0.1:13', 100);
  const rr = new RoundRobin();
  assert.equal(rr.next([b, a])?.id, 'a');
  assert.equal(rr.next([a, b])?.id, 'b');
  assert.equal(rr.next([a])?.id, 'a');
  assert.equal(rr.next([]), undefined);
  assert.equal(rr.next([b])?.id, 'b');
});

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as pause } from 'node:timers/promises';
import { startService } from '../../../test/support.mts';
import type { RunningService } from '../../../test/support.mts';
import { request } from '../transport.mts';

test('unit: entrypoints import silently despite invalid runtime configuration', async () => {
  const script = ['registry', 'catalog', 'client'].map(name =>
    `await import(${JSON.stringify(new URL(`../${name}.mts`, import.meta.url).href)});`).join('\n');
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: {PATH:process.env.PATH ?? '', PORT:'invalid', HOST:'not-loopback', CAPACITY:'invalid',
      INSTANCE_ID:'../bad', REGISTRY_URL:'not-a-url', LEASE_MS:'invalid'},
    stdio:['ignore','pipe','pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
  try {
    const code = await new Promise<number | null>((resolve,reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
    assert.equal(code, 0, stderr);
    assert.equal(stdout, ''); assert.equal(stderr, '');
  } finally { clearTimeout(timer); if (child.exitCode === null) child.kill('SIGKILL'); }
});

async function eventually(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = performance.now() + 5000;
  do {
    if (await check()) return;
    await pause(20);
  } while (performance.now() < deadline);
  assert.fail(message);
}
async function members(registry: RunningService): Promise<{id:string; url:string}[]> {
  const response = await request(`${registry.url}/services/catalog`);
  assert.equal(response.status, 200);
  const body = await response.json() as {members:{id:string;url:string}[]};
  return body.members;
}

test('integration: independent processes distribute, fail boundedly, expire and recover', {timeout:14000}, async () => {
  const running: RunningService[] = [];
  const start = async (name: string, env: Record<string,string> = {}) => {
    const service = await startService(new URL(`../${name}.mts`, import.meta.url), env);
    running.push(service); return service;
  };
  try {
    const registry = await start('registry');
    const env = {REGISTRY_URL:registry.url, LEASE_MS:'1000'};
    const a = await start('catalog', {...env, INSTANCE_ID:'a', LEASE_MS:'3000'});
    const b = await start('catalog', {...env, INSTANCE_ID:'b'});
    await eventually(async () => (await members(registry)).length === 2, 'Both registrations visible');
    const client = await start('client', {REGISTRY_URL:registry.url});
    const hit = async () => {
      const response = await request(`${client.url}/product`);
      assert.equal(response.status, 200);
      return (await response.json() as {instance:string}).instance;
    };
    assert.equal(await hit(), 'a');
    assert.equal(await hit(), 'b');
    const exited = once(a.child, 'exit', {signal:AbortSignal.timeout(2000)});
    a.child.kill('SIGKILL');
    await exited;
    assert.ok((await members(registry)).some(m => m.id === 'a'), 'Lease still visible after process death');
    const begin = performance.now();
    const failed = await request(`${client.url}/product`);
    assert.equal(failed.status, 503);
    await failed.arrayBuffer();
    assert.ok(performance.now() - begin < 1200, 'Upstream failure must be bounded');
    await eventually(async () => {
      const list = await members(registry);
      return list.length === 1 && list[0]?.id === 'b';
    }, 'Killed instance expires');
    assert.equal(await hit(), 'b');
    const replacement = await start('catalog', {...env, INSTANCE_ID:'a', LEASE_MS:'3000'});
    assert.notEqual(replacement.url, a.url);
    await eventually(async () => (await members(registry)).some(m => m.id === 'a' && m.url === replacement.url), 'Replacement visible');
    assert.equal(await hit(), 'a');
    assert.equal(await hit(), 'b');
    await b.stop();
    await eventually(async () => !(await members(registry)).some(m => m.id === 'b'), 'Graceful deregistration');
    assert.equal(await hit(), 'a');
    await registry.stop();
    const unavailable = await request(`${client.url}/product`);
    assert.equal(unavailable.status, 503);
    await unavailable.arrayBuffer();
  } finally { for (const service of running.reverse()) await service.stop(); }
});

test('integration: empty discovery, capacity and stale HTTP ownership are explicit', {timeout:10000}, async () => {
  const running: RunningService[] = [];
  try {
    const registry = await startService(new URL('../registry.mts', import.meta.url), {CAPACITY:'1'});
    running.push(registry);
    const client = await startService(new URL('../client.mts', import.meta.url), {REGISTRY_URL:registry.url});
    running.push(client);
    const empty = await request(`${client.url}/product`);
    assert.equal(empty.status, 503); await empty.arrayBuffer();
    // These are syntactically valid, loopback-only registrations; no caller URL is proxied.
    const register = () => request(`${registry.url}/registrations`, 'POST', {id:'a', url:client.url, lease:5000});
    const firstResponse = await register();
    assert.equal(firstResponse.status, 201);
    const first = await firstResponse.json() as {owner:string};
    const full = await request(`${registry.url}/registrations`, 'POST', {id:'b', url:client.url, lease:1000});
    assert.equal(full.status, 503); await full.arrayBuffer();
    const removed = await request(`${registry.url}/remove`, 'POST', {id:'a', owner:first.owner});
    assert.equal(removed.status, 200); await removed.arrayBuffer();
    assert.equal((await members(registry)).length, 0);
    const secondResponse = await register();
    assert.equal(secondResponse.status, 201);
    const second = await secondResponse.json() as {owner:string};
    // Extend the current owner first so unrelated expiry cannot explain the stale-owner rejection.
    const renewed = await request(`${registry.url}/renew`, 'POST', {id:'a', owner:second.owner, lease:5000});
    assert.equal(renewed.status, 200); await renewed.arrayBuffer();
    for (const route of ['renew','remove']) {
      const stale = await request(`${registry.url}/${route}`, 'POST', {id:'a', owner:first.owner, lease:5000});
      assert.equal(stale.status, 409); await stale.arrayBuffer();
    }
    assert.equal((await members(registry)).length, 1);
  } finally { for (const service of running.reverse()) await service.stop(); }
});
