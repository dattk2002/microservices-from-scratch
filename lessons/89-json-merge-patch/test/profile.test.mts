import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertError, filler, gatewayEntry, patch, storeEntry, wire, withDb, withService } from './wire.mts';

const initial = { name: 'Ada', tags: [] };

test('integration: independent gateway and store merge replacements and deletions under strong validators', async () => {
  await withDb(dbPath => withService(storeEntry, { DB_PATH: dbPath }, store =>
    withService(gatewayEntry, { STORE_ORIGIN: store.url + '/' }, async gateway => {
      for (const origin of [store.url, gateway.url]) {
        const reply = await wire(origin);
        assert.equal(reply.status, 200);
        assert.equal(reply.etag, '"v0"');
        assert.deepEqual(reply.body, initial);
      }
      const added = await wire(gateway.url, { method: 'PATCH', fields: [
        'if-match', '"v0"', 'content-type', 'APPLICATION/MERGE-PATCH+JSON ; CHARSET="UTF-8"',
        'content-encoding', 'IDENTITY',
      ], body: '{"name":"Grace","tags":["one","two"],"note":"temporary"}' });
      assert.equal(added.etag, '"v1"');
      assert.deepEqual(added.body, { name: 'Grace', tags: ['one', 'two'], note: 'temporary' });
      const patched = await patch(gateway.url, '"v1"', '{"tags":["three"],"note":null}');
      assert.equal(patched.status, 200);
      assert.equal(patched.etag, '"v2"');
      assert.deepEqual(patched.body, { name: 'Grace', tags: ['three'] });
      const noop = await patch(gateway.url, '"v2"', '{"tags":["three"],"alien":null,"name":"Grace"}');
      assert.equal(noop.status, 200);
      assert.equal(noop.etag, '"v2"');
      assert.deepEqual(noop.body, patched.body);

      // The stale check precedes final profile validation, but follows input parsing.
      assertError(await patch(gateway.url, '"v0"', 'null'), 412, 'precondition_failed');
      assertError(await patch(gateway.url, '"v0"', '{'), 400, 'invalid_json');
      for (const invalid of ['null', '[]', '"root"', '{"name":null}', '{"note":7}', '{"tags":["same","same"]}',
        '{"unknown":true}', '{"__proto__":{"a":1}}']) {
        assertError(await patch(gateway.url, '"v2"', invalid), 422, 'invalid_document');
      }
      const stored = await wire(store.url);
      assert.equal(stored.etag, '"v2"');
      assert.deepEqual(stored.body, patched.body);
    })));
});

test('integration: one same-tag writer wins, no-ops survive the cap and the committed profile survives restart', async () => {
  await withDb(async dbPath => {
    const last = await withService(storeEntry, { DB_PATH: dbPath }, async store => {
      const both = await Promise.all([patch(store.url, '"v0"', '{"name":"First"}'), patch(store.url, '"v0"', '{"name":"Second"}')]);
      assert.deepEqual(both.map(reply => reply.status).sort(), [200, 412]);
      const loser = both.find(reply => reply.status === 412);
      const winner = both.find(reply => reply.status === 200);
      assert.ok(loser && winner);
      assertError(loser, 412, 'precondition_failed');
      assert.equal(winner.etag, '"v1"');
      const read = await wire(store.url);
      assert.equal(read.etag, '"v1"');
      assert.deepEqual(read.body, winner.body);
      for (let version = 1; version < 16; version++) {
        const changed = await patch(store.url, `"v${version}"`, JSON.stringify({ name: `Revision ${version + 1}` }));
        assert.equal(changed.status, 200);
        assert.equal(changed.etag, `"v${version + 1}"`);
      }
      const noop = await patch(store.url, '"v16"', '{"tags":[],"name":"Revision 16"}');
      assert.equal(noop.status, 200);
      assert.equal(noop.etag, '"v16"');
      assert.deepEqual(noop.body, { name: 'Revision 16', tags: [] });
      assertError(await patch(store.url, '"v16"', '{"note":"change"}'), 409, 'revision_exhausted');
      return noop;
    });
    await withService(storeEntry, { DB_PATH: dbPath }, async restarted => {
      const read = await wire(restarted.url);
      assert.equal(read.status, 200);
      assert.equal(read.etag, '"v16"');
      assert.deepEqual(read.body, last.body);
    });
  });
});

test('integration: store and gateway reject malformed requests and structural overflow before mutation', async () => {
  await withDb(dbPath => withService(storeEntry, { DB_PATH: dbPath }, store =>
    withService(gatewayEntry, { STORE_ORIGIN: store.url }, async gateway => {
      const media = ['content-type', 'application/merge-patch+json'];
      const validHeaders = [...media, 'if-match', '"v0"'];
      const resultOverflow = JSON.stringify(Object.fromEntries(Array.from({ length: 127 }, (_, i) => [`new${i}`, i])));
      const inputOverflow = JSON.stringify(Array.from({ length: 128 }, () => 0));
      const depthOverflow = '['.repeat(9) + '0' + ']'.repeat(9);
      for (const origin of [store.url, gateway.url]) {
        assertError(await wire(origin, { path: '/unknown' }), 404, 'not_found');
        assertError(await wire(origin, { path: '/profile?x=1' }), 400, 'invalid_query');
        assertError(await wire(origin, { body: 'x' }), 400, 'invalid_body');
        const wrong = await wire(origin, { method: 'POST' });
        assertError(wrong, 405, 'method_not_allowed');
        assert.equal(wrong.allow, 'GET, PATCH');
        const unexpected = await wire(origin, {
          method: 'POST', fields: ['expect', 'other'], allowEmptyResponse: true,
        });
        assertError(unexpected, 405, 'method_not_allowed');
        assert.equal(unexpected.allow, 'GET, PATCH');
        assertError(await wire(origin, { method: 'PATCH', fields: media, body: '{}' }), 428, 'precondition_required');
        for (const badTag of ['*', 'W/"v0"', '"v0", "v1"', '"v01"', '"v17"']) {
          assertError(await patch(origin, badTag, '{}'), 400, 'invalid_precondition');
        }
        assertError(await patch(origin, '"v0"', '{}', [...filler(), 'if-match', '"v0"']), 400, 'invalid_precondition');
        assertError(await patch(origin, '"v0"', '{}', [...filler(), ...media]), 415, 'unsupported_media_type');
        assertError(await patch(origin, '"v0"', '{}', ['content-encoding', 'identity', 'content-encoding', 'identity']),
          415, 'unsupported_media_type');
        assertError(await patch(origin, '"v0"', '{}', ['content-encoding', 'gzip']), 415, 'unsupported_media_type');
        assertError(await wire(origin, { method: 'PATCH', fields: ['if-match', '"v0"'], body: '{}' }),
          415, 'unsupported_media_type');
        for (const contentType of ['application/json', 'application/merge-patch+json; charset=utf-8; charset=utf-8']) {
          assertError(await wire(origin, { method: 'PATCH', fields: ['if-match', '"v0"', 'content-type', contentType], body: '{}' }),
            415, 'unsupported_media_type');
        }
        assertError(await wire(origin, { method: 'PATCH', fields: validHeaders, body: Buffer.from([0x22, 0xff, 0x22]) }),
          400, 'invalid_json');
        assertError(await patch(origin, '"v0"', '{"name":1e1000}'), 400, 'invalid_body');
        assertError(await patch(origin, '"v0"', '{"name":1e1000,"name":"Grace"}'), 400, 'invalid_body');
        for (const token of ['NaN', 'Infinity']) {
          assertError(await patch(origin, '"v0"', `{"name":${token}}`), 400, 'invalid_json');
        }
        for (const over of [resultOverflow, inputOverflow, depthOverflow, '{}'.padEnd(8193)]) {
          assertError(await patch(origin, '"v0"', over), 413, 'body_too_large');
        }
        assertError(await wire(origin, { method: 'PATCH', fields: validHeaders, body: '{}'.padEnd(8193), chunked: true }),
          413, 'body_too_large');
        const exactBytes = await patch(origin, '"v0"', '{}'.padEnd(8192));
        assert.equal(exactBytes.status, 200);
        assert.equal(exactBytes.etag, '"v0"');
        assertError(await wire(origin, { method: 'PATCH', fields: validHeaders, body: '{}', pauseBody: true }),
          408, 'body_timeout');
        const unchanged = await wire(origin);
        assert.equal(unchanged.status, 200);
        assert.equal(unchanged.etag, '"v0"');
        assert.deepEqual(unchanged.body, initial);
      }
    })));
});
