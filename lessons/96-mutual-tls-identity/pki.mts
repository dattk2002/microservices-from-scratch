import { generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type Pair = { cert: string; key: string };
export type PKI = {
  ca: string; otherCa: string; server: Pair; gateway: Pair;
  alternate: Pair; outsider: Pair; expired: Pair; wrongHost: Pair; legacyCnOnly: Pair;
};

function der(tag: number, ...parts: Buffer[]): Buffer {
  const contents = Buffer.concat(parts);
  // These small certificates use at most two octets for the long-form length.
  const size = contents.length;
  if (size > 65535) throw new Error('DER object too large');
  const length = size < 128 ? [size] : size < 256 ? [0x81, size] : [0x82, size >> 8, size & 255];
  return Buffer.concat([Buffer.from([tag, ...length]), contents]);
}

function seq(...parts: Buffer[]): Buffer {
  return der(0x30, ...parts);
}

// Only the OIDs used below are supported. Each supplied byte is a complete arc
// after the combined first two arcs, except where explicitly base-128 encoded.
function oid(...bytes: number[]): Buffer {
  return der(0x06, Buffer.from(bytes));
}

function name(commonName: string): Buffer {
  return seq(der(0x31, seq(oid(85, 4, 3), der(0x0c, Buffer.from(commonName)))));
}

function time(timestamp: number): Buffer {
  const iso = new Date(timestamp).toISOString();
  const digits = iso.slice(0, 19).replace(/\D/g, '');
  // RFC 5280 uses UTCTime for years 1950 through 2049.
  const utc = iso >= '1950' && iso < '2050';
  return der(utc ? 0x17 : 0x18, Buffer.from(`${utc ? digits.slice(2) : digits}Z`));
}

function extension(id: Buffer, critical: boolean, value: Buffer): Buffer {
  return seq(id, ...(critical ? [der(0x01, Buffer.from([255]))] : []), der(0x04, value));
}

function pemCertificate(raw: Buffer): string {
  const lines = raw.toString('base64').match(/.{1,64}/g);
  if (!lines) throw new Error('Empty certificate');
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

type Role = 'ca' | 'server' | 'client' | 'legacy-server';
type Issuer = { name: string; key: KeyObject; certificate: X509Certificate };

// Educational certificate generator with a fixed profile and short validity.
function issue(subject: string, role: Role, now: number, issuer?: Issuer, expired = false) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = seq(oid(42, 134, 72, 206, 61, 4, 3, 2)); // ecdsa-with-SHA256
  const ca = role === 'ca';
  const extensions = [
    extension(oid(85, 29, 19), true, ca ? seq(der(0x01, Buffer.from([255]))) : seq()),
    extension(oid(85, 29, 15), true, der(0x03, Buffer.from(ca ? [2, 0x04] : [7, 0x80]))),
  ];
  const purpose = role === 'client' ? 2 : 1;
  if (!ca) {
    if (role !== 'legacy-server') {
      extensions.push(extension(oid(85, 29, 17), false, seq(der(0x82, Buffer.from(subject)))));
    }
    extensions.push(extension(oid(85, 29, 37), false, seq(oid(43, 6, 1, 5, 5, 7, 3, purpose))));
  }
  const serial = randomBytes(16);
  serial.writeUInt8((serial.readUInt8(0) & 0x3f) | 0x40, 0);
  const start = now - (expired ? 120_000 : 60_000);
  const end = now + (expired ? -60_000 : 86_400_000);
  const tbs = seq(der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, serial), algorithm,
    name(issuer?.name ?? subject), seq(time(start), time(end)), name(subject),
    keys.publicKey.export({ type: 'spki', format: 'der' }), der(0xa3, seq(...extensions)));
  const signature = sign('sha256', tbs, issuer?.key ?? keys.privateKey);
  const cert = pemCertificate(seq(tbs, algorithm, der(0x03, Buffer.from([0]), signature)));
  const certificate = new X509Certificate(cert);
  const expectedSan = role === 'legacy-server' ? undefined : subject;
  if (!certificate.verify(issuer?.certificate.publicKey ?? keys.publicKey) ||
      !certificate.checkPrivateKey(keys.privateKey) || certificate.ca !== ca ||
      (certificate.validToDate.getTime() <= now) !== expired ||
      certificate.validFromDate.getTime() >= now ||
      (!ca && (certificate.checkHost(subject, { subject: 'never' }) !== expectedSan ||
        certificate.keyUsage?.join(',') !== `1.3.6.1.5.5.7.3.${purpose}`))) {
    throw new Error('Generated certificate failed verification');
  }
  return {
    name: subject, certificate, key: keys.privateKey,
    pair: { cert, key: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  };
}

export function generatePKI(): PKI {
  const now = Date.now();
  const ca = issue('Lesson CA', 'ca', now);
  const other = issue('Other CA', 'ca', now);
  return {
    ca: ca.pair.cert, otherCa: other.pair.cert,
    server: issue('provider.local', 'server', now, ca).pair,
    gateway: issue('gateway.local', 'client', now, ca).pair,
    alternate: issue('gateway.local', 'client', now, ca).pair,
    outsider: issue('gateway.local', 'client', now, other).pair,
    expired: issue('gateway.local', 'client', now, ca, true).pair,
    wrongHost: issue('wrong.local', 'server', now, ca).pair,
    // A negative fixture for gateways that fall back to the legacy Common Name.
    legacyCnOnly: issue('provider.local', 'legacy-server', now, ca).pair,
  };
}

function checkAncestors(path: string, uid: number): void {
  const parent = dirname(path);
  if (parent !== path) checkAncestors(parent, uid);
  const stat = lstatSync(path);
  // In a trusted sticky directory, the next component must also be trusted:
  // its owner, the parent owner and root are the only users who may rename it.
  if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) {
    throw new Error('Unsafe PKI ancestor');
  }
}

export function writePKI(directory: string): PKI {
  const path = resolve(directory);
  const parent = dirname(path);
  const uid = process.getuid?.();
  if (uid === undefined || parent === path) throw new Error('Unsafe PKI directory');
  checkAncestors(parent, uid);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || stat.uid !== uid) throw new Error('Unsafe PKI directory');

  const pki = generatePKI();
  const files = new Map([['ca.pem', pki.ca], ['other-ca.pem', pki.otherCa]]);
  for (const name of ['server', 'gateway', 'alternate', 'outsider', 'expired', 'wrongHost', 'legacyCnOnly'] as const) {
    files.set(`${name}.pem`, pki[name].cert);
    files.set(`${name}.key`, pki[name].key);
  }
  for (const name of files.keys()) {
    if (lstatSync(join(path, name), { throwIfNoEntry: false })) throw new Error('PKI file already exists');
  }
  for (const [name, data] of files) writeFileSync(join(path, name), data, { mode: 0o600, flag: 'wx' });
  return pki;
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || !process.argv[2]) throw new Error('Missing directory');
    writePKI(process.argv[2]);
  } catch {
    console.error('PKI setup failed. Use a private directory with unused fixture filenames.');
    process.exitCode = 1;
  }
}
