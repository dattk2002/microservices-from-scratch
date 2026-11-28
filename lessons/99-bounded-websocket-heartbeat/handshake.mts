import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function fields(request: IncomingMessage, name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === name) values.push(request.rawHeaders[i + 1] ?? '');
  }
  return values;
}

export function websocketAccept(key: string): string {
  return createHash('sha1').update(key + MAGIC).digest('base64');
}

export function upgradeHeaders(message: IncomingMessage): boolean {
  const connection = fields(message, 'connection').flatMap((value) =>
    value.split(',').map((token) => token.trim().toLowerCase()));
  const upgrades = fields(message, 'upgrade');
  return connection.includes('upgrade') && connection.every((token) => TOKEN.test(token))
    && upgrades.length === 1 && upgrades[0]?.toLowerCase() === 'websocket';
}
