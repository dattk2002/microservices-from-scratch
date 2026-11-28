import type { Address } from './cache.mts';

export const HOSTNAME = 'provider.lesson.test';

export function answer(packet: Buffer, address: Address): Buffer | undefined {
  if (packet.length < 12 || packet.length > 512) return;
  const flags = packet.readUInt16BE(2);
  const additional = packet.readUInt16BE(10);
  if ((flags & ~0x0100) !== 0 || packet.readUInt16BE(4) !== 1 ||
      packet.readUInt16BE(6) !== 0 || packet.readUInt16BE(8) !== 0 || additional > 1) return;
  let end = 12;
  for (const label of HOSTNAME.split('.')) {
    if (packet[end++] !== label.length || end + label.length > packet.length ||
        packet.toString('latin1', end, end + label.length).toLowerCase() !== label) return;
    end += label.length;
  }
  if (end + 5 > packet.length || packet[end] !== 0 ||
      packet.readUInt16BE(end + 1) !== 1 || packet.readUInt16BE(end + 3) !== 1) return;
  end += 5;
  // Some clients advertise EDNS(0), optionally with a single DNS COOKIE.
  if (additional === 1) {
    const options = end + 11;
    if (packet.length < options || packet[end] !== 0 ||
        packet.readUInt16BE(end + 1) !== 41 || packet.readUInt32BE(end + 5) !== 0) return;
    const size = packet.readUInt16BE(end + 9);
    if (packet.length !== options + size) return;
    if (size !== 0) {
      if (size < 12 || packet.readUInt16BE(options) !== 10) return;
      const cookieSize = packet.readUInt16BE(options + 2);
      if (size !== 4 + cookieSize || (cookieSize !== 8 && (cookieSize < 16 || cookieSize > 40))) return;
    }
  } else if (packet.length !== end) return;

  const response = Buffer.alloc(end + 16);
  packet.copy(response, 0, 0, end);
  response.writeUInt16BE(0x8400 | flags, 2);
  response.writeUInt16BE(1, 6);
  response.writeUInt16BE(0, 10);
  response.writeUInt16BE(0xc00c, end);
  response.writeUInt16BE(1, end + 2);
  response.writeUInt16BE(1, end + 4);
  response.writeUInt32BE(1, end + 6);
  response.writeUInt16BE(4, end + 10);
  response.writeUInt32BE(address === '127.0.0.2' ? 0x7f000002 : 0x7f000001, end + 12);
  return response;
}
