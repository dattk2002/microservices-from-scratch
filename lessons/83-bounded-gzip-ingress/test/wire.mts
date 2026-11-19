import { gzipSync } from 'node:zlib';

export const boundaryMessage = {id: 'a', text: 'A'.repeat(82)};
// Encode just the text token. A trailing JSON space changes the byte count by one.
export const escapedBoundary = `{"id":"a","text":"${'\\u0041'.repeat(82)}"}`;

export function gzipAtSize(wire: string, size: number): Buffer {
  const gzip = gzipSync(wire);
  const header = Buffer.from(gzip.subarray(0, 10));
  header[3] = 4; // FEXTRA, with a single valid subfield of the required size.
  const extraLength = size - gzip.length - 2;
  const extra = Buffer.alloc(2 + extraLength);
  extra.writeUInt16LE(extraLength, 0);
  extra.write('LX', 2, 'ascii');
  extra.writeUInt16LE(extraLength - 4, 4);
  return Buffer.concat([header, extra, gzip.subarray(10)]);
}

export function badChecksum(gzip: Buffer): Buffer {
  const broken = Buffer.from(gzip);
  const crcStart = broken.length - 8;
  broken.writeUInt32LE((broken.readUInt32LE(crcStart) ^ 1) >>> 0, crcStart);
  return broken;
}

export function errorBody(code: string) {
  return {error: {code, message: code}};
}
