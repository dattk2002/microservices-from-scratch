import assert from 'node:assert/strict';
import {createServer, IncomingMessage} from 'node:http';
import type {RequestListener, ServerResponse} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {startService} from '../../../test/support.mts';
import {Socket} from 'node:net';
import {readJson} from '../http.mts';
import {EventEmitter, once} from 'node:events';
import {exact} from '../schema.mts';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { Pool } from '../pool.mts';
import { hash } from '../worker.mts';

const input = {text: 'é', iterations: 1};
const digest = '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c';
const idleWorker = () => new Worker('require("node:worker_threads").parentPort.on("message", () => {})', {eval: true});

test('unit: hashes UTF-8 and feeds raw digest bytes to round two', () => {
  assert.equal(hash('é', 1), digest);
  assert.equal(hash('é', 2), '51e152f7ea52d1e9d514df73ad3f12503a1da79e891d61e2033f2da2f2b51425');
});

test('unit: six admissions, queued abort frees capacity and expired queue is cleared', async () => {
  let now = 0;
  const pool = new Pool(idleWorker, () => now);
  try {
    const abort = new AbortController();
    const jobs = Array.from({length: 6}, (_, index) => pool.submit(input, index === 2 ? abort.signal : undefined));
    assert.equal(pool.stats().active, 2);
    assert.equal(pool.stats().queued, 4);
    assert.deepEqual(await pool.submit(input), {code: 'busy'});
    abort.abort();
    assert.deepEqual(await jobs[2], {code: 'cancelled'});
    const replacement = pool.submit(input);
    now = 400;
    assert.deepEqual(await replacement, {code: 'deadline_exceeded'});
    assert.equal(pool.stats().queued, 0);
  } finally {
    await pool.close();
  }
});

test('unit: actual thread returns a known digest and exits on shutdown', async () => {
  const pool = new Pool();
  try {
    assert.deepEqual(await pool.submit(input), {digest});
  } finally {
    await pool.close();
  }
  assert.equal(pool.stats().live, 0);
});

test('unit: wrong reply ID fails the job without retry and replacement waits for exit', async () => {
  const live = new Set<Worker>();
  const history: string[] = [];
  let peak = 0;
  let assignments = 0;
  let pool: Pool | undefined;
  class TrackedWorker extends Worker {
    override postMessage(...args: Parameters<Worker['postMessage']>): void {
      assignments++;
      super.postMessage(...args);
    }
  }
  try {
    let created = 0;
    pool = new Pool(() => {
      const index = created++;
      const worker = index === 0
        ? new TrackedWorker('const p = require("node:worker_threads").parentPort; p.once("message", () => p.postMessage({id: "wrong", digest: "0".repeat(64)}))', {eval: true})
        : new TrackedWorker(new URL('../worker.mts', import.meta.url), {
          workerData: 'bounded-hash-v1', resourceLimits: {maxOldGenerationSizeMb: 32, stackSizeMb: 2},
        });
      live.add(worker);
      worker.once('exit', () => {
        live.delete(worker);
        history.push('exit ' + index);
      });
      history.push('start ' + index);
      peak = Math.max(peak, live.size);
      return worker;
    });
    const running = pool;
    assert.deepEqual(await running.submit(input), {code: 'worker_failure'});
    await until(async () => running.stats(), state => state.replacements >= 1);
    assert.deepEqual(history, ['start 0', 'start 1', 'exit 0', 'start 2']);
    assert.equal(peak, 2);
    assert.deepEqual(running.stats(), {active: 0, queued: 0, live: 2, replacements: 1});
    assert.equal(assignments, 1);
    assert.deepEqual(await Promise.all([running.submit(input), running.submit(input)]), [{digest}, {digest}]);
    assert.equal(assignments, 3);
    assert.equal(running.stats().replacements, 1);
  } finally {
    try {
      await pool?.close();
    } finally {
      await Promise.all([...live].map(worker => worker.terminate()));
    }
  }
  assert.equal(live.size, 0);
});

test('unit: gateway only preserves recognized upstream status and envelope pairs', async () => {
  const {classify} = await import('../gateway.mts');
  assert.deepEqual(classify(504, {error: {code: 'deadline_exceeded', message: 'deadline_exceeded'}}),
    {status: 504, code: 'deadline_exceeded'});
  assert.equal(classify(504, {error: {code: 'internal_error', message: 'internal_error'}}), undefined);
  assert.equal(classify(503, {error: {code: 'busy', message: 'try again'}}), undefined);
  assert.equal(classify(302, {digest}), undefined);
  assert.equal(classify(200, [{digest}]), undefined);
});

class ManualWorker extends EventEmitter {
  messages: unknown[] = [];
  terminationRequested = false;

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  async terminate(): Promise<number> {
    this.terminationRequested = true;
    return 0;
  }

  succeed(): void {
    const message = this.messages.at(-1);
    assert.ok(exact(message, ['id', 'input']));
    this.emit('message', {id: message.id, digest});
  }
}

function manualPool(now: () => number) {
  const workers: ManualWorker[] = [];
  const pool = new Pool(() => {
    const worker = new ManualWorker();
    workers.push(worker);
    return worker;
  }, now);
  const close = async () => {
    const closed = pool.close();
    for (const worker of workers) worker.emit('exit', 0);
    await closed;
  };
  return {pool, workers, close};
}

for (const event of ['error', 'messageerror', 'exit', 'malformed', 'wrong ID']) {
  for (const elapsed of [399, 400]) {
    test(`unit: ${event} at ${elapsed}ms resolves against the monotonic deadline`, async () => {
      let now = 0;
      const {pool, workers, close} = manualPool(() => now);
      try {
        const job = pool.submit(input);
        const [worker] = workers;
        assert.ok(worker);
        now = elapsed;
        if (event === 'malformed') worker.emit('message', null);
        else if (event === 'wrong ID') worker.emit('message', {id: 'wrong', digest});
        else worker.emit(event, new Error('worker failed'));
        assert.deepEqual(await job, {code: elapsed === 400 ? 'deadline_exceeded' : 'worker_failure'});
      } finally {
        await close();
      }
    });
  }
}

async function readWireJson(source: string): Promise<unknown> {
  const socket = new Socket();
  try {
    const message = new IncomingMessage(socket);
    const result = readJson(message, performance.now() + 500, new AbortController().signal);
    message.complete = true;
    message.push(Buffer.from(source));
    message.push(null);
    return await result;
  } finally {
    socket.destroy();
  }
}

for (const source of [
  '{"text":"","text":"é","iterations":1}',
  '{"digest":"bad","digest":"' + digest + '"}',
  String.raw`{"error":{"code":"internal_error","\u0063ode":"deadline_exceeded","message":"deadline_exceeded"}}`,
]) {
  test(`unit: wire JSON rejects duplicate members in ${source}`, async () => {
    await assert.rejects(readWireJson(source));
  });
}

test('unit: wire JSON preserves quoted syntax and allows the same key in separate objects', async () => {
  assert.deepEqual(await readWireJson(String.raw`[{"text":"\\"}, { "text" : "\"text\": {} []" }]`),
    [{text: '\\'}, {text: '"text": {} []'}]);
});

test('unit: scheduler dispatches oldest first and skips expired queued work', async () => {
  let now = 0;
  const {pool, workers, close} = manualPool(() => now);
  try {
    const first = pool.submit(input);
    const second = pool.submit(input);
    const expired = pool.submit({...input, text: 'expired'});
    now = 20;
    const older = pool.submit({...input, text: 'older'});
    const newer = pool.submit({...input, text: 'newer'});
    const [left, right] = workers;
    assert.ok(left && right);
    now = 400;
    left.succeed();
    assert.deepEqual(await first, {code: 'deadline_exceeded'});
    assert.equal(left.terminationRequested, true);
    assert.equal(workers.length, 2);
    left.emit('exit', 1);
    const replacement = workers[2];
    assert.ok(replacement);
    const assigned = replacement.messages[0];
    assert.ok(exact(assigned, ['id', 'input']));
    assert.deepEqual(assigned.input, {...input, text: 'older'});
    assert.deepEqual(await expired, {code: 'deadline_exceeded'});
    replacement.succeed();
    assert.deepEqual(await older, {digest});
    const next = replacement.messages[1];
    assert.ok(exact(next, ['id', 'input']));
    assert.deepEqual(next.input, {...input, text: 'newer'});
    assert.notEqual(assigned.id, next.id);
    replacement.emit('message', {id: assigned.id, digest});
    assert.deepEqual(await newer, {code: 'worker_failure'});
    right.emit('exit', 1);
    assert.deepEqual(await second, {code: 'deadline_exceeded'});
  } finally {
    await close();
  }
});

test('unit: restart window admits an exit at 10000ms and degradation persists', async () => {
  let now = 0;
  const {pool, workers, close} = manualPool(() => now);
  try {
    for (const index of [0, 2, 3]) workers[index]?.emit('exit', 1);
    assert.equal(pool.stats().replacements, 3);
    now = 10000;
    for (const index of [4, 5, 6, 7]) workers[index]?.emit('exit', 1);
    assert.equal(pool.stats().replacements, 6);
    assert.deepEqual(await pool.submit(input), {code: 'degraded'});
    now = 30000;
    assert.deepEqual(await pool.submit(input), {code: 'degraded'});
  } finally {
    await close();
  }
});

for (const reason of ['shutting_down', 'degraded']) {
  test(`unit: ${reason} queue drain honors the deadline at 400ms`, async () => {
    let now = 0;
    const {pool, workers, close} = manualPool(() => now);
    try {
      if (reason === 'degraded') {
        for (const index of [0, 2, 3]) workers[index]?.emit('exit', 1);
        assert.equal(pool.stats().replacements, 3);
      }
      void pool.submit(input);
      void pool.submit(input);
      const atDeadline = pool.submit(input);
      now = 1;
      const beforeDeadline = pool.submit(input);
      assert.equal(pool.stats().queued, 2);

      now = 400;
      if (reason === 'shutting_down') {
        void pool.close();
      } else {
        const worker = workers[4];
        assert.ok(worker);
        worker.emit('exit', 1);
        assert.equal(pool.stats().replacements, 3);
      }
      assert.deepEqual(await Promise.all([atDeadline, beforeDeadline]), [
        {code: 'deadline_exceeded'}, {code: reason},
      ]);
      assert.equal(pool.stats().queued, 0);
    } finally {
      await close();
    }
  });
}

test('unit: abort terminates a real assigned worker and starts exactly one replacement', async () => {
  const workers: Worker[] = [];
  const pool = new Pool(() => {
    const worker = idleWorker();
    workers.push(worker);
    return worker;
  });
  try {
    const controller = new AbortController();
    const result = pool.submit(input, controller.signal);
    const first = workers[0];
    assert.ok(first);
    const exited = once(first, 'exit');
    controller.abort();
    assert.equal(workers.length, 2);
    assert.deepEqual(await result, {code: 'cancelled'});
    await exited;
    assert.equal(workers.length, 3);
    assert.equal(pool.stats().live, 2);
  } finally {
    await pool.close();
  }
});

async function until<T>(observe: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const value = await observe();
    if (ready(value)) return value;
    await delay(5);
  }
  throw new Error('required state was not observed');
}

const computeEntry = new URL('../compute.mts', import.meta.url);
const gatewayEntry = new URL('../gateway.mts', import.meta.url);

async function http(url: string, options: Parameters<typeof fetch>[1] = {}) {
  const response = await fetch(url, {...options, signal: AbortSignal.timeout(2000)});
  const body: unknown = await response.json();
  return {status: response.status, body, allow: response.headers.get('allow')};
}

const post = (url: string, value: unknown) => http(url + '/hash', {
  method: 'POST', body: JSON.stringify(value), headers: {'content-type': 'application/json'},
});

const errorBody = (code: string) => ({error: {code, message: code}});

test('integration: independent production processes hash Unicode and enforce HTTP routes', async () => {
  const compute = await startService(computeEntry);
  try {
    const gateway = await startService(gatewayEntry, {COMPUTE_ORIGIN: compute.url});
    try {
      assert.deepEqual(await post(gateway.url, input), {status: 200, body: {digest}, allow: null});
      for (const origin of [compute.url, gateway.url]) {
        for (const invalid of [null, [], {...input, extra: true}, {...input, iterations: '1'},
          {...input, iterations: {toString: null}}, {...input, text: 'é'.repeat(513)}]) {
          assert.equal((await post(origin, invalid)).status, 400);
        }
        const encoded = '{"text":"' + '\\u0000'.repeat(1024) + '","iterations":1}';
        const jsonOptions = {method: 'POST', headers: {'content-type': 'application/json'}};
        assert.equal((await http(origin + '/hash', {...jsonOptions, body: encoded})).status, 200);
        assert.equal((await http(origin + '/hash', {
          ...jsonOptions, body: '{"text":"","text":"é","iterations":1}',
        })).status, 400);
        // Whitespace changes the wire length while preserving both JSON tokens and schema.
        assert.equal((await http(origin + '/hash', {...jsonOptions, body: encoded.padEnd(8193)})).status, 400);
        const malformedUtf8 = Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xc3, 0x28]),
          Buffer.from('","iterations":1}')]);
        assert.equal((await http(origin + '/hash', {...jsonOptions, body: malformedUtf8})).status, 400);
        assert.equal((await http(origin + '/health?debug')).status, 400);
        assert.equal((await http(origin + '/unknown')).status, 404);
        assert.deepEqual(await http(origin + '/hash'),
          {status: 405, body: errorBody('method_not_allowed'), allow: 'POST'});
      }
    } finally {
      await gateway.stop();
    }
  } finally {
    await compute.stop();
  }
});

test('integration: compute health observes a full burst, expires held work and recovers', async () => {
  const compute = await startService(new URL('./compute-fixture.mts', import.meta.url));
  try {
    const inspect = async () => {
      const response = await http(compute.url + '/health');
      assert.equal(response.status, 200);
      assert.ok(exact(response.body, ['ok', 'active', 'queued', 'live', 'replacements']));
      return response.body;
    };
    const started = performance.now();
    const jobs = Promise.allSettled(Array.from({length: 6}, () => post(compute.url, {text: 'hold', iterations: 1})));
    // Observe both pending assignments and four queued requests before sending the seventh.
    try {
      await until(inspect, state => state.active === 2 && state.queued === 4);
      assert.deepEqual(await post(compute.url, input), {status: 503, body: errorBody('busy'), allow: null});
    } finally {
      const results = await jobs;
      for (const result of results) {
        assert.deepEqual(result, {status: 'fulfilled', value: {status: 504, body: errorBody('deadline_exceeded'), allow: null}});
      }
    }
    assert.ok(performance.now() - started >= 400);
    await until(inspect, state => state.live === 2 && state.replacements === 2);
    assert.deepEqual(await post(compute.url, input), {status: 200, body: {digest}, allow: null});
  } finally {
    await compute.stop();
  }
});

async function fixture(handler: RequestListener) {
  const server = createServer({requestTimeout: 1000, headersTimeout: 1000, connectionsCheckingInterval: 100}, handler);
  const stop = async () => {
    const closed = new Promise<void>(resolve => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => reject(new Error('fixture startup timed out')), 1000);
      server.once('error', error => {
        clearTimeout(startup);
        reject(error);
      });
      server.listen(0, '127.0.0.1', () => {
        clearTimeout(startup);
        resolve();
      });
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {url: 'http://127.0.0.1:' + address.port, stop};
  } catch (error) {
    await stop();
    throw error;
  }
}

test('integration: gateway validates semantic errors and rejects redirects without a second attempt', async () => {
  let redirected = 0;
  const destination = await fixture((_request, response) => {
    redirected++;
    response.end();
  });
  try {
    let mode = 'deadline';
    let attempts = 0;
    let unfinishedPeerClosed = false;
    const upstream = await fixture((request, response) => {
      attempts++;
      request.resume();
      response.setHeader('content-type', 'application/json;charset=utf-8');
      if (mode === 'hang') return;
      if (mode === 'unfinished-deadline') {
        request.socket.once('close', () => { unfinishedPeerClosed = true; });
        response.writeHead(504, {'transfer-encoding': 'chunked'});
        response.write(JSON.stringify(errorBody('deadline_exceeded')));
        return; // Keep the connection open without sending the terminating chunk.
      }
      if (mode === 'duplicate-digest') {
        response.writeHead(200);
        response.end('{"digest":"bad","digest":"' + digest + '"}');
        return;
      }
      if (mode === 'duplicate-code') {
        response.writeHead(504);
        response.end('{"error":{"code":"internal_error","\\u0063ode":"deadline_exceeded","message":"deadline_exceeded"}}');
        return;
      }
      if (mode === 'redirect') {
        response.writeHead(307, {location: destination.url + '/hash'});
        response.end(JSON.stringify({digest}));
        return;
      }
      if (mode === 'late-duplicate') {
        const headers = ['content-type', 'application/json'];
        for (let i = 0; i < 105; i++) headers.push('x-padding-' + i, 'x');
        headers.push('Content-Type', 'application/json');
        response.removeHeader('content-type');
        response.writeHead(200, headers);
        response.end(JSON.stringify({digest}));
        return;
      }
      if (mode === 'oversize') {
        response.writeHead(200);
        response.end(' '.repeat(8192) + JSON.stringify({digest}));
        return;
      }
      response.writeHead(mode === 'wrong-busy' ? 503 : mode === 'misdirected' ? 421 : 504);
      response.end(JSON.stringify(errorBody(mode === 'deadline' ? 'deadline_exceeded' : 'internal_error')));
    });
    try {
      const gateway = await startService(gatewayEntry, {COMPUTE_ORIGIN: upstream.url});
      try {
        assert.deepEqual(await post(gateway.url, input),
          {status: 504, body: errorBody('deadline_exceeded'), allow: null});
        for (const next of ['wrong-deadline', 'wrong-busy', 'misdirected', 'late-duplicate', 'oversize',
          'duplicate-digest', 'duplicate-code', 'hang', 'unfinished-deadline', 'redirect']) {
          mode = next;
          const before = attempts;
          const started = performance.now();
          assert.deepEqual(await post(gateway.url, input),
            {status: 502, body: errorBody('upstream_failure'), allow: null}, next);
          assert.equal(attempts, before + 1, next);
          if (next === 'redirect') assert.equal(redirected, 0);
          if (next === 'unfinished-deadline') {
            assert.ok(performance.now() - started >= 500);
            await until(async () => unfinishedPeerClosed, closed => closed);
            assert.ok(performance.now() - started < 1000, 'gateway must close the peer near its 500 ms deadline');
          }
        }
      } finally {
        await gateway.stop();
      }
    } finally {
      await upstream.stop();
    }
  } finally {
    await destination.stop();
  }
});

test('integration: gateway admits eight dependency requests and releases their slots', async () => {
  const held = new Set<ServerResponse>();
  let upstreamRequests = 0;
  let release = false;
  const upstream = await fixture((request, response) => {
    request.resume();
    upstreamRequests++;
    response.setHeader('content-type', 'application/json');
    if (release) response.end(JSON.stringify({digest}));
    else {
      held.add(response);
      response.once('close', () => held.delete(response));
    }
  });
  try {
    const gateway = await startService(gatewayEntry, {COMPUTE_ORIGIN: upstream.url});
    try {
      const inflight = Promise.allSettled(Array.from({length: 8}, () => post(gateway.url, input)));
      try {
        await until(async () => held.size, size => size === 8);
        assert.deepEqual(await post(gateway.url, input),
          {status: 503, body: errorBody('busy'), allow: null});
        assert.equal(upstreamRequests, 8);
      } finally {
        release = true;
        for (const response of held) response.end(JSON.stringify({digest}));
        for (const result of await inflight) {
          assert.deepEqual(result, {status: 'fulfilled', value: {status: 200, body: {digest}, allow: null}});
        }
      }
      assert.equal((await post(gateway.url, input)).status, 200);
      assert.equal(upstreamRequests, 9);
    } finally {
      await gateway.stop();
    }
  } finally {
    await upstream.stop();
  }
});

test('integration: production compute answers health during concurrent CPU work', async () => {
  const compute = await startService(computeEntry);
  try {
    const jobs = Promise.allSettled(Array.from({length: 2}, () =>
      post(compute.url, {text: 'é', iterations: 200000})));
    try {
      await until(async () => {
        const response = await http(compute.url + '/health');
        assert.equal(response.status, 200);
        assert.ok(exact(response.body, ['ok', 'active', 'queued', 'live', 'replacements']));
        return response.body.active;
      }, active => typeof active === 'number' && active > 0);
    } finally {
      for (const result of await jobs) {
        assert.ok(result.status === 'fulfilled');
        assert.ok(result.value.status === 200 || result.value.status === 504);
      }
    }
  } finally {
    await compute.stop();
  }
});

test('integration: SIGTERM clears queued jobs and waits for assigned workers to exit', async () => {
  const compute = await startService(new URL('./compute-fixture.mts', import.meta.url));
  try {
    const jobs = Promise.allSettled(Array.from({length: 3}, () =>
      post(compute.url, {text: 'hold', iterations: 1})));
    await until(async () => {
      const {body} = await http(compute.url + '/health');
      assert.ok(exact(body, ['ok', 'active', 'queued', 'live', 'replacements']));
      return body;
    }, body => body.active === 2 && body.queued === 1);
    await compute.stop();
    assert.equal(compute.child.exitCode, 0);
    assert.equal(compute.child.signalCode, null);
    const statuses = (await jobs).map(result => {
      assert.ok(result.status === 'fulfilled');
      return result.value.status;
    }).sort();
    assert.deepEqual(statuses, [503, 504, 504]);
  } finally {
    await compute.stop();
  }
});
