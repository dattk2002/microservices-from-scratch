import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { startService, jsonRequest } from '../../../test/support.mts';

const pair = generateKeyPairSync('ed25519');
const claims = { iss: 'demo-issuer', aud: 'reports', sub: 'invoice-worker', scope: 'reports:read', iat: 100, nbf: 100, exp: 160 };
function token(payload: object = claims, header: object = { alg: 'EdDSA', typ: 'service+jwt', kid: 'demo-1' }) {
  const input = [header, payload].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
async function moduleUnderTest() {
  const module = await import('../auth.mts').catch(() => null);
  assert.ok(module, 'the narrow verifier must be implemented');
  return module;
}
test('unit: signed identity, exact time boundaries and scope policy', async () => {
  const m = await moduleUnderTest();
  let now = 100;
  const verify = m.verifier(pair.publicKey, () => now);
  assert.equal(verify(token()).sub, 'invoice-worker');
  assert.equal(m.allowed(verify(token())), true);
  assert.equal(m.allowed(verify(token({ ...claims, scope: 'reports:write' }))), false);
  assert.equal(m.allowed(verify(token({ ...claims, sub: 'other-service' }))), false);
  now = 159; assert.doesNotThrow(() => verify(token()));
  now = 160; assert.throws(() => verify(token()), /invalid authentication/);
  now = 99; assert.throws(() => verify(token()));
});
test('unit: reject tampering, malformed profile, untrusted metadata and unsafe time claims', async () => {
  const m = await moduleUnderTest(); const verify = m.verifier(pair.publicKey, () => 100);
  const badClaims = [
    { aud: 'elsewhere' }, { iss: 'other' }, { iat: 101 }, { nbf: 101 }, { nbf: 99 },
    { exp: 100 }, { exp: 161 }, { iat: 0.5 }, { exp: Number.MAX_SAFE_INTEGER + 1 },
    { sub: 3 }, { scope: ['reports:read'] }, { exp: '160' },
  ];
  for (const change of badClaims) assert.throws(() => verify(token({ ...claims, ...change })));
  for (const change of [{ alg: 'none' }, { alg: 'HS256' }, { typ: 'JWT' }, { kid: 'unknown' }, { jku: 'https://evil.invalid/key' }, { crit: [] }]) {
    assert.throws(() => verify(token(claims, { alg: 'EdDSA', typ: 'service+jwt', kid: 'demo-1', ...change })));
  }
  const good = token();
  const foreign = generateKeyPairSync('ed25519');
  const input = good.split('.').slice(0, 2).join('.');
  assert.throws(() => verify(`${input}.${sign(null, Buffer.from(input), foreign.privateKey).toString('base64url')}`));
  assert.throws(() => verify(`${Buffer.from('{broken').toString('base64url')}.${good.split('.')[1]}.${good.split('.')[2]}`));
  assert.equal(verify(m.issue(pair.privateKey, 100)).sub, 'invoice-worker');
  assert.throws(() => m.issue(pair.publicKey, 100));
  assert.throws(() => m.issue(pair.privateKey, Number.MAX_SAFE_INTEGER));
  for (const url of [undefined, 'https://127.0.0.1:1234', 'http://example.com:1234', 'http://user:pass@127.0.0.1:1234', 'http://127.0.0.1:1234/reports', 'http://127.0.0.1:1234/?key=x']) assert.throws(() => m.loopbackURL(url));
  assert.equal(m.loopbackURL('http://127.0.0.1:1234'), 'http://127.0.0.1:1234');
  for (const bad of ['', 'x'.repeat(4097), good + '=', good + '.extra', good.replace(/.$/, '!'), token({ ...claims, aud: 'elsewhere' }).split('.').slice(0, 2).join('.') + '.' + good.split('.')[2]]) assert.throws(() => verify(bad));
  const parts = good.split('.');
  assert.throws(() => verify(`${parts[0]}=.${parts[1]}.${parts[2]}`));
  assert.throws(() => m.verifier(generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey));
});
test('unit: importing entrypoints ignores invalid configuration and exits silently', () => {
  for (const entry of ['caller.mts', 'resource.mts', 'demo.mts']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', 'await import(process.argv[1])', new URL(`../${entry}`, import.meta.url).href], {
      encoding: 'utf8', timeout: 2000, env: { PORT: 'invalid', PUBLIC_KEY: 'invalid', PRIVATE_KEY: 'invalid', RESOURCE_URL: 'invalid', HOST: 'invalid' },
    });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  }
});
test('unit: configuration fails closed before listening without leaking key input', async () => {
  const { main: resource } = await import('../resource.mts');
  const { main: caller } = await import('../caller.mts');
  const names = ['PORT', 'HOST', 'PUBLIC_KEY', 'PRIVATE_KEY', 'RESOURCE_URL'];
  const saved = new Map(names.map(name => [name, process.env[name]]));
  try {
    process.env.HOST = '127.0.0.1'; process.env.PORT = '0';
    process.env.PUBLIC_KEY = 'sentinel-secret'; process.env.PRIVATE_KEY = 'sentinel-secret';
    process.env.RESOURCE_URL = 'http://127.0.0.1:3018';
    await assert.rejects(resource(), { message: 'invalid key configuration' });
    await assert.rejects(caller(), { message: 'invalid key configuration' });
    process.env.PRIVATE_KEY = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    process.env.RESOURCE_URL = 'https://127.0.0.1:3018';
    await assert.rejects(caller(), { message: 'invalid resource configuration' });
    process.env.RESOURCE_URL = 'http://127.0.0.1:3018';
    process.env.PORT = 'bad';
    await assert.rejects(caller(), { message: 'Invalid PORT' });
    process.env.PORT = '0'; process.env.HOST = '0.0.0.0';
    await assert.rejects(caller(), { message: 'invalid host configuration' });
  } finally {
    for (const name of names) {
      const value = saved.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('integration: separate caller and resource enforce authentication and permission contracts', async t => {
  const publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const resource = await startService(new URL('../resource.mts', import.meta.url), { PUBLIC_KEY: publicKey });
  t.after(() => resource.stop());
  const caller = await startService(new URL('../caller.mts', import.meta.url), { PRIVATE_KEY: privateKey, RESOURCE_URL: resource.url });
  t.after(() => caller.stop()); assert.notEqual(caller.child.pid, resource.child.pid);
  const success = await jsonRequest(`${caller.url}/call`, { report: 'monthly' });
  assert.equal(success.status, 200); assert.deepEqual(await success.json(), { report: 'monthly', requestedBy: 'invoice-worker' });
  const now = Math.floor(Date.now() / 1000);
  const current = { ...claims, iat: now, nbf: now, exp: now + 60 };
  const good = token(current);
  const cases: [string | undefined, number][] = [
    [undefined, 401], [good.slice(0, -3) + 'AAA', 401],
    [token({ ...current, iat: now - 61, nbf: now - 61, exp: now - 1 }), 401],
    [token({ ...current, aud: 'other' }), 401], [token({ ...current, scope: 'reports:write' }), 403],
    [token({ ...current, sub: 'other' }), 403],
    [token(current, { alg: 'EdDSA', typ: 'service+jwt', kid: 'unknown' }), 401],
    [token(current, { alg: 'HS256', typ: 'service+jwt', kid: 'demo-1' }), 401],
  ];
  for (const [value, expected] of cases) {
    const response = await jsonRequest(`${resource.url}/reports`, { report: 'monthly' }, value === undefined ? {} : { authorization: `Bearer ${value}` });
    assert.equal(response.status, expected);
    if (expected === 401) assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.doesNotMatch(await response.text(), /demo-1|BEGIN|eyJ/);
  }
});
