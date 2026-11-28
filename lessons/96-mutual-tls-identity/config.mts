import { createPrivateKey, X509Certificate } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { createSecureContext } from 'node:tls';
import { required } from './contracts.mts';

export function port(env: NodeJS.ProcessEnv): number {
  const input = env.PORT;
  if (input === undefined) return 0;
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(input) || input.trim() !== input || Number(input) > 65535) {
    throw new Error('Invalid PORT');
  }
  return Number(input);
}

function pem(env: NodeJS.ProcessEnv, name: string, label: string): string {
  const path = required(env, name);
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error('Expected regular file');
      const buffer = Buffer.alloc(8193);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > 8192) throw new Error('PEM too large');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)).trim();
      const pattern = new RegExp(`^-----BEGIN ${label}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+\\r?\\n-----END ${label}-----$`);
      if (!pattern.test(text)) throw new Error('Expected a single PEM object');
      return text + '\n';
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new Error(`Invalid ${name}`);
  }
}

export function certificate(env: NodeJS.ProcessEnv, name: string): X509Certificate {
  return new X509Certificate(pem(env, name, 'CERTIFICATE'));
}

export function tlsFiles(env: NodeJS.ProcessEnv) {
  const ca = pem(env, 'TLS_CA', 'CERTIFICATE');
  const cert = pem(env, 'TLS_CERT', 'CERTIFICATE');
  const key = pem(env, 'TLS_KEY', 'PRIVATE KEY');
  const authority = new X509Certificate(ca);
  const leaf = new X509Certificate(cert);
  if (!authority.ca || !authority.verify(authority.publicKey) || leaf.ca ||
      !leaf.checkPrivateKey(createPrivateKey(key))) throw new Error('Invalid TLS CA or certificate/key pair');
  const options = { ca, cert, key, minVersion: 'TLSv1.3' as const };
  createSecureContext(options);
  return options;
}
