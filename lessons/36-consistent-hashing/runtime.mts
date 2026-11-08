import { HttpError } from '../../lib/http.mts';
import { validKey, catalogue } from './cache.mts';
import type { Member } from './ring.mts';
export function pathKey(url: string | undefined, prefix: string): string | undefined {
  if (!url?.startsWith(prefix)) return undefined;
  let key: string;
  try {key=decodeURIComponent(url.slice(prefix.length));} catch {throw new HttpError(400,'invalid_key','Invalid encoded key');}
  if(!validKey(key)) throw new HttpError(400,'invalid_key','Key needs 1..64 well-formed UTF-16 units');
  return key;
}
export function origin(name: string, legacyName?: string): string {
  const raw = process.env[name] ?? (legacyName === undefined ? undefined : process.env[legacyName]);
  if(!raw) throw new Error(`Missing ${name}`);
  const url = new URL(raw);
  if(url.protocol!=='http:' || url.username || url.password || url.search || url.hash || url.pathname!=='/') throw new Error(`Invalid ${name}`);
  return url.origin;
}
// 64 UTF-16 units * 6 bytes worst JSON escaping + 64 hex value + fixed fields < 640.
export const REPLY_BYTES = 640;
export async function upstream(base: string, key: string, member: Member, timeout: number) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),timeout);
  try {
    const res = await fetch(`${base}/objects/${encodeURIComponent(key)}`,{redirect:'error',signal:controller.signal});
    if(res.status!==200 || res.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json' || !res.body) throw new Error('Bad upstream status/type');
    const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while(true) {
        const next = await reader.read(); if(next.done) break;
        size+=next.value.byteLength;
        if(size>REPLY_BYTES) {controller.abort(); throw new Error('Reply too large');}
        chunks.push(next.value);
      }
    } finally {reader.releaseLock();}
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(typeof value!=='object' || value===null || Array.isArray(value)) throw new Error('Bad reply');
    if(!('key' in value) || value.key!==key || !('owner' in value) || typeof value.owner!=='string' || value.owner!==member || !('hit' in value) || typeof value.hit!=='boolean' || !('value' in value) || typeof value.value!=='string' || value.value!==catalogue(key) || Object.keys(value).sort().join(',')!=='hit,key,owner,value') throw new Error('Bad reply schema');
    return {key,owner:member,hit:value.hit,value:value.value};
  } finally {clearTimeout(timer); controller.abort();}
}
