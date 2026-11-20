import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../../lib/http.mts';
import { trimOws } from './headers.mts';

export type Receipt = {bytes: number; sha256: string};

const MAX_CONTENT_BYTES = 1024;
const BUDGET_MS = 500;

export function upstreamFailure(): HttpError {
  return new HttpError(502, 'upstream_failure', 'upstream_failure');
}

function parseDigest(rawTrailers: readonly string[]): Buffer {
  const [name, field] = rawTrailers;
  if (rawTrailers.length !== 2 || name?.toLowerCase() !== 'content-digest' || field === undefined) {
    throw upstreamFailure();
  }
  const value = trimOws(field);
  const member = /^sha-256=:([A-Za-z0-9+/]{43}=):$/.exec(value);
  const encoded = member?.[1];
  if (member?.[0] !== value || encoded === undefined) throw upstreamFailure();

  // Buffer accepts noncanonical base64, including nonzero bits in the padding sextet.
  const expected = Buffer.from(encoded, 'base64');
  if (expected.length !== 32 || expected.toString('base64') !== encoded) throw upstreamFailure();
  return expected;
}

export class BlobVerification {
  readonly #hash = createHash('sha256');
  readonly #startedAt: number;
  readonly #now: () => number;
  #bytes = 0;

  constructor(now: () => number) {
    this.#now = now;
    this.#startedAt = now();
  }

  remainingMs(): number {
    return BUDGET_MS - (this.#now() - this.#startedAt);
  }

  checkDeadline(): void {
    if (this.remainingMs() <= 0) throw upstreamFailure();
  }

  add(chunk: Uint8Array): void {
    this.checkDeadline();
    if (this.#bytes + chunk.byteLength > MAX_CONTENT_BYTES) throw upstreamFailure();
    this.#bytes += chunk.byteLength;
    this.#hash.update(chunk);
  }

  finish(complete: boolean, rawTrailers: readonly string[]): Receipt {
    this.checkDeadline();
    if (!complete) throw upstreamFailure();
    const expected = parseDigest(rawTrailers);
    const actual = this.#hash.digest();
    if (!timingSafeEqual(actual, expected)) throw upstreamFailure();
    return {bytes: this.#bytes, sha256: actual.toString('hex')};
  }
}

export async function ingestBlob(
  read: (verification: BlobVerification, signal: AbortSignal) => Promise<Receipt>,
  commit: (receipt: Receipt) => void,
  signal: AbortSignal,
  now: () => number = () => performance.now(),
): Promise<Receipt> {
  const verification = new BlobVerification(now);
  if (signal.aborted) throw upstreamFailure();
  const receipt = await read(verification, signal);
  if (signal.aborted) throw upstreamFailure();
  verification.checkDeadline();
  commit(receipt);
  return receipt;
}
