import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

export type Identity = { sub: string; scope: string };
export const header = { alg: 'EdDSA', typ: 'service+jwt', kid: 'demo-1' };
function invalid(): never { throw new Error('invalid authentication'); }
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return Object.fromEntries(Object.entries(value));
}
function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return invalid();
  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.toString('base64url') !== segment) return invalid();
  return bytes;
}
function parse(segment: string): Record<string, unknown> {
  const bytes = decode(segment);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  // A deliberately narrow encoding: rejects duplicate names, whitespace and alternate escapes.
  if (JSON.stringify(value) !== text) return invalid();
  return object(value);
}
export function verifier(key: KeyObject, clock: () => number = () => Math.floor(Date.now() / 1000)) {
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') throw new Error('invalid verifier configuration');
  return (token: string): Identity => {
    try {
      if (token.length > 4096) return invalid();
      const parts = token.split('.');
      const [h, p, s] = parts;
      if (parts.length !== 3 || !h || !p || !s) return invalid();
      const metadata = parse(h);
      if (Object.keys(metadata).length !== 3 || metadata.alg !== 'EdDSA' || metadata.typ !== 'service+jwt' || metadata.kid !== 'demo-1') return invalid();
      const signature = decode(s);
      if (signature.length !== 64 || !verify(null, Buffer.from(`${h}.${p}`), key, signature)) return invalid();
      const c = parse(p);
      if (Object.keys(c).sort().join(',') !== 'aud,exp,iat,iss,nbf,scope,sub') return invalid();
      if (c.iss !== 'demo-issuer' || c.aud !== 'reports' || typeof c.sub !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(c.sub) || typeof c.scope !== 'string' || !/^[a-z:]+(?: [a-z:]+)*$/.test(c.scope) || c.scope.length > 128) return invalid();
      const { iat, nbf, exp } = c;
      const now = clock();
      if (typeof iat !== 'number' || typeof nbf !== 'number' || typeof exp !== 'number' || ![iat, nbf, exp, now].every(Number.isSafeInteger) || iat < 0 || !(iat <= nbf && nbf <= now && now < exp) || exp - iat > 60) return invalid();
      return { sub: c.sub, scope: c.scope };
    } catch { return invalid(); }
  };
}
export function allowed(identity: Identity): boolean {
  return identity.sub === 'invoice-worker' && identity.scope.split(' ').includes('reports:read');
}
export function issue(key: KeyObject, now = Math.floor(Date.now() / 1000)): string {
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519' || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 60)) throw new Error('invalid signer configuration');
  const payload = { iss: 'demo-issuer', aud: 'reports', sub: 'invoice-worker', scope: 'reports:read', iat: now, nbf: now, exp: now + 60 };
  const input = [header, payload].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${input}.${sign(null, Buffer.from(input), key).toString('base64url')}`;
}
export function configuredKey(kind: 'public' | 'private'): KeyObject {
  try {
    const pem = process.env[kind === 'public' ? 'PUBLIC_KEY' : 'PRIVATE_KEY'];
    if (!pem || pem.length > 2048) throw new Error();
    const key = kind === 'public' ? createPublicKey(pem) : createPrivateKey(pem);
    if (key.type !== kind || key.asymmetricKeyType !== 'ed25519') throw new Error();
    return key;
  } catch { throw new Error('invalid key configuration'); }
}
export function loopbackURL(raw: string | undefined): string {
  try {
    const url = new URL(raw ?? '');
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url.origin;
  } catch { throw new Error('invalid resource configuration'); }
}
export function loopbackHost() {
  if (process.env.HOST !== undefined && process.env.HOST !== '127.0.0.1') throw new Error('invalid host configuration');
}
