import { HttpError } from '../../lib/http.mts';
export function fail(code: string): never { throw new HttpError(422, code, code); }
export function object(v: unknown): Record<string, unknown> {
 if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('object');
 return Object.fromEntries(Object.entries(v));
}
export function keys(v: Record<string, unknown>, expected: string) { if (Object.keys(v).sort().join(',') !== expected) fail('shape'); }
export function integer(v: unknown, max = 1000000000): number {
 if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > max) return fail('integer'); return v;
}
export function id(v: unknown): string { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(v)) return fail('id'); return v; }
export function profile(v: unknown): string { if (typeof v !== 'string' || !['legacy', 'current'].includes(v)) return fail('profile'); return v; }
export function envelope(v: unknown) {
 const r = object(v); keys(r, 'id,payload,position,revision');
 const payload = object(r.payload);
 if (Buffer.byteLength(JSON.stringify(payload)) > 2048) fail('payload_size');
 return { id: id(r.id), position: integer(r.position), revision: integer(r.revision, 100), payload };
}
export function upcast(v: unknown, supported = 'current') {
 profile(supported); const e = envelope(v); const p = e.payload;
 if (e.revision !== 1 && (e.revision !== 2 || supported === 'legacy')) fail('unsupported_revision');
 let amountMinor: number;
 if (e.revision === 1) { keys(p, 'orderId,resourceVersion,totalCents'); amountMinor = integer(p.totalCents); }
 else {
  keys(p, 'amount,orderId,resourceVersion'); const a = object(p.amount); keys(a, 'amountMinor,currency');
  if (typeof a.currency !== 'string' || a.currency !== 'USD') fail('currency');
  amountMinor = integer(a.amountMinor);
 }
 return { id: e.id, position: e.position, orderId: id(p.orderId), resourceVersion: integer(p.resourceVersion), amountMinor, currency: 'USD' };
}
// Stable JSON fingerprint independent of object-key insertion order, including raw revision.
export function stable(v: unknown): string {
 if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? fail('json');
 if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
 return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, x]) => JSON.stringify(k) + ':' + stable(x)).join(',') + '}';
}
