import { isAbsolute, join } from 'node:path';

export const MAX_BYTES = 8192;
export const DEADLINE_MS = 500;

type DirectoryMetadata = { directory: boolean; uid: number; mode: number; canonical: string };

export function socketPath(dir: string, uid: number, metadata: DirectoryMetadata): string {
  if (!isAbsolute(dir) || dir.includes('\0') || !metadata.directory || metadata.canonical !== dir
    || metadata.uid !== uid || (metadata.mode & 0o7777) !== 0o700) {
    throw new Error('SOCKET_DIR must be an absolute canonical directory owned by the current uid with mode 0700');
  }
  const path = join(dir, 'provider.sock');
  if (Buffer.byteLength(path, 'utf8') > 100) throw new Error('Socket path exceeds 100 UTF-8 bytes');
  return path;
}

export function parseValue(bytes: Buffer): { value: 'local-only' } {
  const text = decodeUtf8(bytes);
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).length !== 1 || !('value' in value) || value.value !== 'local-only') {
    throw new Error('Unexpected value envelope');
  }
  // JSON.parse keeps the last duplicate key. The validated shape has just one string member.
  const members = [...text.matchAll(/"(?:[^"\\]|\\.)*"[ \t\r\n]*:|"(?:[^"\\]|\\.)*"/g)]
    .filter(([token]) => token.endsWith(':'));
  if (members.length !== 1) throw new Error('Duplicate value member');
  return { value: value.value };
}

export function jsonMedia(media: string): boolean {
  return /^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?$/i.test(media);
}

export function fields(raw: string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const value = raw[i + 1];
    if (raw[i]?.toLowerCase() === name && value !== undefined) {
      values.push(value.replace(/^[ \t]+|[ \t]+$/g, ''));
    }
  }
  return values;
}

export function safeFraming(raw: string[]): boolean {
  const length = fields(raw, 'content-length');
  const transfer = fields(raw, 'transfer-encoding');
  return fields(raw, 'trailer').length === 0 && length.length <= 1 && transfer.length <= 1
    && (length[0] === undefined || (/^[0-9]+$/.test(length[0]) && Number(length[0]) <= MAX_BYTES))
    && (transfer[0] === undefined || (length.length === 0 && transfer[0].toLowerCase() === 'chunked'));
}


export function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
