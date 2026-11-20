import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assertError, gatewayEntry, patch, peerEntry, storeEntry, until, wire, withDb, withService,
} from './wire.mts';

async function mode(origin: string, value: string) {
  const reply = await wire(origin, { path: '/mode?name=' + encodeURIComponent(value) });
  assert.equal(reply.status, 200);
  assert.deepEqual(reply.body, { mode: value });
}

async function stats(origin: string) {
  const reply = await wire(origin, { path: '/stats' });
  assert.equal(reply.status, 200);
  const value = reply.body;
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert.ok('hits' in value && typeof value.hits === 'number');
  assert.ok('held' in value && typeof value.held === 'number');
  assert.ok('cancelled' in value && typeof value.cancelled === 'number');
  assert.ok('last' in value);
  return { hits: value.hits, held: value.held, cancelled: value.cancelled, last: value.last };
}

test('integration: gateway preserves patch semantics and rejects local invalid input without dialing', async () => {
  await withService(peerEntry, {}, peer =>
    withService(gatewayEntry, { STORE_ORIGIN: peer.url }, async gateway => {
      const media = ['content-type', 'application/merge-patch+json'];
      assertError(await wire(gateway.url, { method: 'PATCH', fields: media, body: '{}' }), 428, 'precondition_required');
      assertError(await patch(gateway.url, '"v00"', '{}'), 400, 'invalid_precondition');
      assertError(await patch(gateway.url, '"v0"', '{}', ['content-encoding', 'gzip']), 415, 'unsupported_media_type');
      assertError(await patch(gateway.url, '"v0"', '{"name":1e1000}'), 400, 'invalid_body');
      assertError(await patch(gateway.url, '"v0"', '{"name":1e1000,"name":"Grace"}'), 400, 'invalid_body');
      const tooDeepWithNonFinite = '['.repeat(9) + '1e1000' + ']'.repeat(9);
      assertError(await patch(gateway.url, '"v0"', tooDeepWithNonFinite), 400, 'invalid_body');
      for (const body of ['NaN', '{"note":Infinity}']) {
        assertError(await patch(gateway.url, '"v0"', body), 400, 'invalid_json');
      }
      assertError(await patch(gateway.url, '"v0"', '{}'.padEnd(8193)), 413, 'body_too_large');
      assertError(await patch(gateway.url, '"v0"', '['.repeat(9) + '0' + ']'.repeat(9)), 413, 'body_too_large');
      assert.equal((await stats(peer.url)).hits, 0);

      const read = await wire(gateway.url);
      assert.equal(read.status, 200);
      assert.equal(read.etag, '"v2"');
      assert.deepEqual(read.body, { name: 'Peer', tags: ['test'] });
      const body = '{"note":null,"unknown":{"field":null},"tags":[null]}';
      const changed = await patch(gateway.url, '"v1"', body);
      assert.equal(changed.status, 200);
      assert.equal(changed.etag, '"v2"');
      assert.deepEqual((await stats(peer.url)).last, {
        method: 'PATCH', media: 'application/merge-patch+json', tag: '"v1"', encoding: 'identity', body,
      });
      assert.equal((await stats(peer.url)).hits, 2);
    }));
});

test('integration: gateway validates every semantic status and rejects malformed peer representations', async () => {
  await withService(peerEntry, {}, peer =>
    withService(gatewayEntry, { STORE_ORIGIN: peer.url }, async gateway => {
      for (const [status, code] of [[412, 'precondition_failed'], [422, 'invalid_document'],
        [409, 'revision_exhausted'], [413, 'body_too_large']] as const) {
        await mode(peer.url, String(status));
        assertError(await patch(gateway.url, '"v1"', '{}'), status, code);
        assertError(await wire(gateway.url), 502, 'upstream_failure');
        await mode(peer.url, `wrong-${status}`);
        assertError(await patch(gateway.url, '"v1"', '{}'), 502, 'upstream_failure');
      }
      for (const kind of ['wrong-message', 'array-error', 'null-error', 'extra-error', 'weak-tag', 'missing-tag',
        'duplicate-tag', 'duplicate-media', 'duplicate-coding', 'bad-profile', 'array-profile', 'bad-media',
        'bad-coding', 'invalid-json', 'invalid-utf8', 'non-finite', 'overwritten-number-profile',
        'overwritten-number-error', 'too-large', 'truncated']) {
        await mode(peer.url, kind);
        assertError(await patch(gateway.url, '"v1"', '{}'), 502, 'upstream_failure');
      }
      await mode(peer.url, 'max-bytes');
      const max = await wire(gateway.url);
      assert.equal(max.status, 200);
      assert.equal(max.etag, '"v2"');
      assert.deepEqual(max.body, { name: 'Peer', tags: ['test'] });

      await mode(peer.url, 'ok');
      assertError(await patch(gateway.url, '"v0"', '{}'), 502, 'upstream_failure');
      const same = await patch(gateway.url, '"v2"', '{}');
      assert.equal(same.status, 200);
      assert.equal(same.etag, '"v2"');
    }));
});

test('integration: 421 is attempted once, redirects stay contained, and headers plus EOF share a deadline', async () => {
  await withService(peerEntry, {}, destination =>
    withService(peerEntry, { REDIRECT_TO: destination.url }, peer =>
      withService(gatewayEntry, { STORE_ORIGIN: peer.url }, async gateway => {
        assert.notEqual(destination.url, peer.url);
        await mode(peer.url, '421');
        const before = await stats(peer.url);
        assertError(await patch(gateway.url, '"v1"', '{}'), 502, 'upstream_failure');
        assert.equal((await stats(peer.url)).hits, before.hits + 1);

        await mode(peer.url, 'redirect');
        const redirectBefore = await stats(peer.url);
        const redirect = await patch(gateway.url, '"v1"', '{"note":"payload"}');
        assert.equal((await stats(destination.url)).hits, 0);
        assert.equal((await stats(peer.url)).hits, redirectBefore.hits + 1);
        assertError(redirect, 502, 'upstream_failure');

        for (const kind of ['missing-eof', 'split-deadline']) {
          await mode(peer.url, kind);
          const baseline = await stats(peer.url);
          assertError(await wire(gateway.url), 502, 'upstream_failure');
          const stopped = await until(() => stats(peer.url), value => value.cancelled === baseline.cancelled + 1);
          assert.equal(stopped.hits, baseline.hits + 1);
        }
        await mode(peer.url, 'ok');
        assert.equal((await wire(gateway.url)).status, 200);
      })));
});

test('integration: eight active calls reject a ninth without dialing and free permits on completion, abort and shutdown', async () => {
  await withDb(dbPath => withService(storeEntry, { DB_PATH: dbPath }, store =>
    withService(peerEntry, {}, peer =>
      withService(gatewayEntry, { STORE_ORIGIN: peer.url }, async gateway => {
        await mode(peer.url, 'hold');
        const calls = new AbortController();
        type Outcome = Awaited<ReturnType<typeof wire>> | null;
        const pending: Promise<Outcome>[] = [];
        function hold(signal: AbortSignal = calls.signal) {
          const result = wire(gateway.url, { signal }).catch(() => null);
          pending.push(result);
          return result;
        }
        try {
          const eight = Array.from({ length: 8 }, () => hold());
          const full = await until(() => stats(peer.url), value => value.held === 8);
          assert.equal(full.hits, 8);

          assertError(await wire(gateway.url), 503, 'busy');
          assertError(await patch(gateway.url, '"v01"', '{}'), 400, 'invalid_precondition');
          assert.equal((await stats(peer.url)).hits, 8);
          const local = await wire(store.url);
          assert.equal(local.status, 200);
          assert.equal(local.etag, '"v0"');

          assert.equal((await wire(peer.url, { path: '/release' })).status, 200);
          const firstFinished = await Promise.race(eight);
          assert.equal(firstFinished?.status, 200);
          hold();
          const recovered = await until(() => stats(peer.url), value => value.hits === 9);
          assert.equal(recovered.held, 8);
          assert.equal((await wire(peer.url, { path: '/release-all' })).status, 200);
          for (const outcome of await Promise.all(pending)) assert.equal(outcome?.status, 200);

          const disconnect = new AbortController();
          const disconnectedCallStarted = performance.now();
          const abandoned = hold(AbortSignal.any([calls.signal, disconnect.signal]));
          await until(() => stats(peer.url), value => value.held === 1);
          disconnect.abort();
          assert.equal(await abandoned, null);
          const cancelled = await until(() => stats(peer.url), value => value.held === 0 && value.cancelled === 1);
          assert.equal(cancelled.hits, 10);
          assert.ok(performance.now() - disconnectedCallStarted < 500, 'Peer must observe abort before its normal deadline');

          const duringShutdown = Array.from({ length: 8 }, () => hold());
          const fullAgain = await until(() => stats(peer.url), value => value.held === 8);
          assert.equal(fullAgain.hits, 18);
          await gateway.stop();
          for (const outcome of await Promise.all(duringShutdown)) assert.equal(outcome, null);
          const stopped = await until(() => stats(peer.url), value => value.held === 0 && value.cancelled === 9);
          assert.equal(stopped.hits, 18);
        } finally {
          calls.abort();
          await Promise.all(pending);
        }
      }))));
});
