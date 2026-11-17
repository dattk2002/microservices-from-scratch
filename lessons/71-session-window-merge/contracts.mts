import { HttpError } from '../../lib/http.mts';
import type { Event } from './core.mts';
export type Watermark = {time: number};
export function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).length === keys.length && keys.every(k=>Object.hasOwn(v,k));
}
export function integer(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}
export function eventValid(v: unknown): v is Event {
  return exact(v,['id','key','time','value']) && typeof v.id === 'string' && /^[a-z0-9]{1,16}$/.test(v.id)
    && (v.key === 'a' || v.key === 'b') && integer(v.time,0,100) && integer(v.value,0,9);
}
export function watermarkValid(v: unknown): v is Watermark {
  return exact(v,['time']) && integer(v.time,0,103);
}
export function input(path: string, v: unknown): Event | Watermark {
  if (path === '/events' && eventValid(v)) return v;
  if (path === '/watermark' && watermarkValid(v)) return v;
  throw new HttpError(400,'invalid_request','invalid_request');
}
export function reject(code: 'id_conflict' | 'late_event' | 'capacity' | 'watermark_regression'): never {
  throw new HttpError(code === 'capacity' ? 429 : 409,code,code);
}
export function replyValid(path: string, request: Event | Watermark, status: number, v: unknown): boolean {
  if (path === '/events' && 'id' in request && (status === 201 || status === 200)) {
    return exact(v,['id','duplicate']) && v.id === request.id && v.duplicate === (status === 200);
  }
  if (path === '/watermark' && !('id' in request) && status === 200) {
    return exact(v,['watermark']) && v.watermark === request.time;
  }
  if (!exact(v,['error']) || !exact(v.error,['code','message'])) return false;
  const code=v.error.code;
  const allowed=path === '/events' ? (status === 409 && (code === 'late_event' || code === 'id_conflict'))
    || (status === 429 && code === 'capacity')
    : path === '/watermark' && status === 409 && code === 'watermark_regression';
  return allowed && v.error.message === code;
}
export function origin(raw: string | undefined): string {
  if (!raw) throw new Error('SESSION_ORIGIN required');
  const url=new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '0' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('SESSION_ORIGIN must be a loopback HTTP origin');
  return url.origin;
}
