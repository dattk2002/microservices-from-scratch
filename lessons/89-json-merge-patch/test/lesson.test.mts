import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { jsonEqual, mergePatch, validateJson } from '../merge.mts';
import type { Json } from '../merge.mts';
import { etagVersion, isProfile, matchesMedia, patchProfile, peerReply, storeOrigin } from '../contract.mts';
import { parseBody } from '../http.mts';

test('unit: RFC 7396 example deletes nested null members, replaces the array, and leaves inputs independent', () => {
  const target: Json = {
    title: 'Goodbye!', author: { givenName: 'John', familyName: 'Doe' },
    tags: ['example', 'sample'], content: 'This will be unchanged',
  };
  const patch: Json = {
    title: 'Hello!', phoneNumber: '+01-123-456-7890',
    author: { familyName: null }, tags: ['example'],
  };
  const originalTarget = JSON.stringify(target);
  const originalPatch = JSON.stringify(patch);
  const result = mergePatch(target, patch);

  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    phoneNumber: '+01-123-456-7890', tags: ['example'], author: { givenName: 'John' },
    content: 'This will be unchanged', title: 'Hello!',
  });
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  assert.ok(Array.isArray(result.tags));
  assert.ok(result.author && typeof result.author === 'object' && !Array.isArray(result.author));
  result.tags.push('new');
  result.author.givenName = 'Jane';
  assert.equal(JSON.stringify(target), originalTarget);
  assert.equal(JSON.stringify(patch), originalPatch);
});

test('unit: mutating returned nested array entries leaves both merge inputs independent', () => {
  const target = { retained: { items: [{ label: 'target' }] }, items: [{ label: 'discarded' }] };
  const patch = { items: [{ label: 'patch' }] };
  const result = mergePatch(target, patch);
  assert.ok(result && typeof result === 'object' && !Array.isArray(result));
  assert.ok(result.retained && typeof result.retained === 'object' && !Array.isArray(result.retained));
  assert.ok(Array.isArray(result.retained.items) && Array.isArray(result.items));
  const retained: Json | undefined = result.retained.items[0];
  const replacement: Json | undefined = result.items[0];
  assert.ok(retained && typeof retained === 'object' && !Array.isArray(retained));
  assert.ok(replacement && typeof replacement === 'object' && !Array.isArray(replacement));
  retained.label = 'changed target branch';
  replacement.label = 'changed patch branch';
  assert.deepEqual(target, { retained: { items: [{ label: 'target' }] }, items: [{ label: 'discarded' }] });
  assert.deepEqual(patch, { items: [{ label: 'patch' }] });
});

test('unit: scalar, null and arrays replace the root, while an object patch can start from an empty object', () => {
  assert.equal(mergePatch({ left: 1 }, null), null);
  assert.equal(mergePatch({ left: 1 }, 3), 3);
  assert.equal(JSON.stringify(mergePatch({ left: 1 }, [1, null])), '[1,null]');
  assert.equal(JSON.stringify(mergePatch('scalar', { right: { keep: 2, drop: null } })), '{"right":{"keep":2}}');
  assert.equal(JSON.stringify(mergePatch('scalar', {})), '{}');
  const base = { a: [1] };
  const copy = mergePatch(base, {});
  assert.equal(JSON.stringify(copy), '{"a":[1]}');
  assert.notEqual(copy, base);
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) assert.fail('Expected object');
  assert.notEqual(copy.a, base.a);
});

test('unit: own prototype-like member names follow JSON object rules', () => {
  const base: unknown = JSON.parse('{"__proto__":{"left":1},"constructor":{"prototype":{"a":1}}}');
  const patch: unknown = JSON.parse('{"__proto__":{"right":2},"constructor":{"prototype":{"a":null,"b":2}},"prototype":"literal"}');
  const ownRemoval: unknown = JSON.parse('{"__proto__":null}');
  validateJson(base);
  validateJson(patch);
  validateJson(ownRemoval);
  assert.equal(JSON.stringify(mergePatch(base, patch)),
    '{"__proto__":{"left":1,"right":2},"constructor":{"prototype":{"b":2}},"prototype":"literal"}');
  assert.equal(JSON.stringify(mergePatch(base, ownRemoval)),
    '{"constructor":{"prototype":{"a":1}}}');
  assert.equal(Object.hasOwn(Object.prototype, 'right'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'b'), false);
  const inherited = { kept: 1 };
  Object.setPrototypeOf(inherited, { inherited: 2 });
  assert.equal(JSON.stringify(mergePatch(inherited, {})), '{"kept":1}');
});

test('unit: non-enumerable patch members cannot delete enumerable target members', () => {
  const patch = Object.defineProperty({}, 'name', { value: null });
  assert.deepEqual(JSON.parse(JSON.stringify(mergePatch({ name: 'Ada' }, patch))), { name: 'Ada' });
});

test('unit: non-enumerable target members cannot suppress an enumerable patch addition', () => {
  const target = Object.defineProperty({}, 'nested', { value: { hidden: true } });
  assert.deepEqual(JSON.parse(JSON.stringify(mergePatch(target, { nested: { visible: true } }))), {
    nested: { visible: true },
  });
});

test('unit: arrays are copied and compared by own elements without inherited methods', () => {
  const array = [1];
  Object.setPrototypeOf(array, null);
  const result = mergePatch(null, array);
  assert.deepEqual(result, [1]);
  assert.notEqual(result, array);
  assert.equal(jsonEqual(array, [1]), true);
});

function nested(depth: number): Json {
  let value: Json = null;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

test('unit: each input is independently bounded at depth eight and 128 value nodes', () => {
  const atNodeLimit: Json = new Array<Json>(127).fill(null);
  const overNodeLimit: Json = new Array<Json>(128).fill(null);
  assert.equal(JSON.stringify(mergePatch(null, nested(8))), '[[[[[[[[null]]]]]]]]');
  assert.deepEqual(mergePatch(null, atNodeLimit), atNodeLimit);
  for (const overLimit of [nested(9), overNodeLimit]) {
    assert.throws(() => mergePatch(null, overLimit), { message: 'body_too_large' });
    assert.throws(() => mergePatch(overLimit, null), { message: 'body_too_large' });
  }
});

test('unit: a merge can exceed the result node or serialized UTF-8 byte limit', () => {
  const newMembers = Object.fromEntries(Array.from({ length: 127 }, (_, i) => [`new${i}`, i]));
  assert.throws(() => mergePatch({ name: 'Ada', tags: [] }, newMembers), { message: 'body_too_large' });
  const exactly8192 = 'é'.repeat(4095);
  assert.equal(mergePatch(null, exactly8192), exactly8192);
  assert.throws(() => mergePatch(null, exactly8192 + 'a'), { message: 'body_too_large' });
  assert.throws(() => mergePatch({ a: 'é'.repeat(2200) }, { b: 'é'.repeat(2200) }), { message: 'body_too_large' });
});

test('unit: non-finite parsed numbers are invalid before they can serialize as null', () => {
  const invalid: unknown = JSON.parse('{"array":[0,1e1000]}');
  assert.throws(() => validateJson(invalid), { message: 'invalid_body' });
  assert.throws(() => mergePatch(null, -Infinity), { message: 'invalid_body' });
});

test('unit: overflowing number tokens are invalid even when a later member replaces them', () => {
  for (const body of [
    '{"name":1e1000,"name":"Grace"}',
    '{"nested":[-1.25E+1000],"nested":false}',
    `{"value":${'9'.repeat(310)},"value":null}`,
  ]) {
    assert.throws(() => parseBody(Buffer.from(body)), { status: 400, code: 'invalid_body' });
  }
});

test('unit: the number check ignores JSON strings and preserves finite duplicate-member semantics', () => {
  const note = '"quoted" \\ 1e1000\u2028-1.25E+1000';
  const data = `{"name":1.25e+3,"name":"Grace","note":${JSON.stringify(note)},"1e1000":true}`;
  assert.deepEqual(parseBody(Buffer.from(data)), { name: 'Grace', note, '1e1000': true });
});

test('unit: malformed JSON takes precedence over a recognizable overflowing number token', () => {
  for (const body of ['{"name":1e1000,"name":}', '{"name":1e1000,"name":NaN}', 'Infinity']) {
    assert.throws(() => parseBody(Buffer.from(body)), { status: 400, code: 'invalid_json' });
  }
});

test('unit: JSON equality ignores member order and preserves array order and member identity', () => {
  assert.equal(jsonEqual({ name: 'Ada', tags: [], note: 'hello' }, { note: 'hello', tags: [], name: 'Ada' }), true);
  assert.equal(jsonEqual([{ x: 1, y: 2 }], [{ y: 2, x: 1 }]), true);
  assert.equal(jsonEqual({ tags: ['a', 'b'] }, { tags: ['b', 'a'] }), false);
  assert.equal(jsonEqual({ name: 'Ada' }, { note: 'Ada' }), false);
  assert.equal(jsonEqual({ note: null }, {}), false);
});

test('unit: non-enumerable members cannot stand in for missing enumerable members in equality', () => {
  const left = { x: 1 };
  const right = Object.defineProperty({ y: 2 }, 'x', { value: 1 });
  assert.equal(jsonEqual(left, right), false);
  assert.equal(jsonEqual(right, left), false);
  assert.equal(jsonEqual(right, { y: 2 }), true);
  assert.equal(jsonEqual({ y: 2 }, right), true);
});

test('unit: a valid profile has exactly its required members and optional note', () => {
  assert.equal(isProfile({ name: 'x'.repeat(32), tags: ['a'.repeat(16)], note: 'x'.repeat(64) }), true);
  for (const invalid of [
    null, [], { name: 'Ada' }, { name: '', tags: [] }, { name: 'é', tags: [] }, { name: 'Ada\n', tags: [] },
    { name: 'x'.repeat(33), tags: [] }, { name: 'Ada', tags: 'tag' }, { name: 'Ada', tags: ['a', 'a'] },
    { name: 'Ada', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
    { name: 'Ada', tags: ['a'.repeat(17)] }, { name: 'Ada', tags: ['a\n'] }, { name: 'Ada', tags: ['A'] },
    { name: 'Ada', tags: [], note: null }, { name: 'Ada', tags: [], note: '' },
    { name: 'Ada', tags: [], note: 'x'.repeat(65) }, { name: 'Ada', tags: [], extra: 1 },
  ]) assert.equal(isProfile(invalid), false, JSON.stringify(invalid));
});

test('unit: the store checks staleness before merge, then allows a no-op at the revision cap', () => {
  const base = { version: 16, profile: { name: 'Ada', tags: ['x'] } };
  assert.throws(() => patchProfile(base, 15, { name: null }), { message: 'precondition_failed' });
  assert.throws(() => patchProfile(base, 16, { name: null }), { message: 'invalid_document' });
  assert.equal(patchProfile(base, 16, { tags: ['x'], name: 'Ada' }), base);
  assert.throws(() => patchProfile(base, 16, { name: 'New' }), { message: 'revision_exhausted' });
  assert.deepEqual(JSON.parse(JSON.stringify(patchProfile({ ...base, version: 15 }, 15, { name: 'New' }))),
    { version: 16, profile: { name: 'New', tags: ['x'] } });
});

test('unit: only canonical in-range validators and unambiguous JSON media are accepted', () => {
  assert.equal(etagVersion('"v0"'), 0);
  assert.equal(etagVersion('"v16"'), 16);
  for (const tag of [undefined, '*', 'W/"v1"', '"v01"', '"v17"', '"V1"', '"v-1"', '"v0", "v1"']) {
    assert.equal(etagVersion(tag), undefined, tag);
  }
  assert.equal(matchesMedia(' APPLICATION/MERGE-PATCH+JSON \t; CHARSET = "UTF-8" ', 'patch'), true);
  assert.equal(matchesMedia('application/json', 'json'), true);
  for (const media of [undefined, 'application/json;', 'application/json; charset=utf-8; charset=utf-8',
    'application/json, application/json', 'application/json; charset="utf-8', 'application/json; profile=x',
    'application/json; charset=utf-16', 'application/merge-patch+json']) {
    assert.equal(matchesMedia(media, 'json'), false, media);
  }
});

test('unit: the peer may return only same/next patch versions and exact semantic errors', () => {
  const profile = { name: 'Ada', tags: [] };
  assert.deepEqual(peerReply(200, '"v3"', profile, 2), { status: 200, etag: '"v3"', body: profile });
  assert.deepEqual(peerReply(200, '"v16"', profile, 16), { status: 200, etag: '"v16"', body: profile });
  assert.throws(() => peerReply(200, '"v4"', profile, 2), { message: 'upstream_failure' });
  assert.throws(() => peerReply(200, '"v2"', { ...profile, extra: true }), { message: 'upstream_failure' });
  for (const [status, code] of [[412, 'precondition_failed'], [422, 'invalid_document'],
    [409, 'revision_exhausted'], [413, 'body_too_large']] as const) {
    const body = { error: { code, message: code } };
    assert.deepEqual(peerReply(status, undefined, body, 2), { status, body });
    for (const malformed of [null, [], [body], { error: { code: 'internal_error', message: 'internal_error' } },
      { error: { code, message: 'surprise' } }, { error: { code, message: code, extra: 1 } },
      { ...body, extra: 1 }]) {
      assert.throws(() => peerReply(status, undefined, malformed, 2), { message: 'upstream_failure' });
    }
    assert.throws(() => peerReply(status, undefined, body), { message: 'upstream_failure' });
  }
});

test('unit: STORE_ORIGIN is a fixed literal loopback HTTP origin', () => {
  assert.equal(storeOrigin('http://127.0.0.1:1/').origin, 'http://127.0.0.1:1');
  assert.equal(storeOrigin('http://127.0.0.1').origin, 'http://127.0.0.1');
  assert.equal(storeOrigin('http://127.0.0.1:65535').origin, 'http://127.0.0.1:65535');
  for (const raw of ['https://127.0.0.1', 'http://localhost', 'http://127.1', 'http://127.0.0.1:0',
    'http://127.0.0.1:65536', 'http://user@127.0.0.1', 'http://127.0.0.1?', 'http://127.0.0.1#',
    'http://127.0.0.1/profile', 'http://127.0.0.1/./', 'http://127.0.0.1/\n']) {
    assert.throws(() => storeOrigin(raw), /STORE_ORIGIN/);
  }
});

test('unit: importing entrypoints with invalid settings is silent and inert', async () => {
  const store = new URL('../store.mts', import.meta.url).href;
  const gateway = new URL('../gateway.mts', import.meta.url).href;
  const run = promisify(execFile);
  const { stdout, stderr } = await run(process.execPath, ['--v8-pool-size=1', '--input-type=module', '-e',
    `await import(${JSON.stringify(store)}); await import(${JSON.stringify(gateway)});`], {
    timeout: 3000,
    env: { PORT: 'invalid', STORE_ORIGIN: 'invalid', DB_PATH: '' },
  });
  assert.equal(stdout, '');
  assert.equal(stderr, '');
});
