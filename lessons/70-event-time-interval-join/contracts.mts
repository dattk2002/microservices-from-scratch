import { HttpError } from '../../lib/http.mts';
export type Side = 'left' | 'right';
export type Event = {id: string; side: Side; key: 'a' | 'b'; time: number; value: number};
export type Watermarks = {left: number; right: number};
export type Pair = {leftId: string; rightId: string; key: 'a' | 'b'; leftTime: number; rightTime: number; final: boolean};
export type State = {watermarks: Watermarks; events: Event[]; pairs: Pair[]};
export function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
export function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return object(v) && Object.keys(v).length === keys.length && keys.every(k=>Object.hasOwn(v,k));
}
export function integer(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}
export function side(v: unknown): v is Side { return v === 'left' || v === 'right'; }
export function eventValid(v: unknown): v is Event {
  return exact(v,['id','side','key','time','value']) && typeof v.id === 'string' && /^[a-z0-9]{1,16}$/.test(v.id)
    && side(v.side) && (v.key === 'a' || v.key === 'b') && integer(v.time,0,100) && integer(v.value,0,9);
}
export function watermarkValid(v: unknown): v is {side: Side; time: number} {
  return exact(v,['side','time']) && side(v.side) && integer(v.time,0,104);
}
export function input(path: string, v: unknown): Event | {side: Side; time: number} {
  if (path === '/events' && eventValid(v)) return v;
  if (path === '/watermark' && watermarkValid(v)) return v;
  throw new HttpError(400,'invalid_request','Invalid request');
}
export const messages = {
  late_event: 'Event is behind its side watermark',
  id_conflict: 'Event id already has different content',
  capacity: 'Retained event capacity reached',
  watermark_regression: 'Watermark cannot move backwards',
};
export function reject(code: keyof typeof messages): never {
  throw new HttpError(code === 'capacity' ? 429 : 409,code,messages[code]);
}
export function replyValid(path: string, request: Event | {side: Side; time: number}, status: number, v: unknown): boolean {
  if (path === '/events' && 'id' in request && (status === 201 || status === 200)) {
    return exact(v,['id','duplicate']) && v.id === request.id && v.duplicate === (status === 200);
  }
  if (path === '/watermark' && status === 200) {
    return exact(v,['watermarks']) && exact(v.watermarks,['left','right'])
      && integer(v.watermarks.left,-1,104) && integer(v.watermarks.right,-1,104)
      && v.watermarks[request.side] === request.time;
  }
  if (!exact(v,['error']) || !exact(v.error,['code','message'])) return false;
  const allowed = path === '/events' ? (status === 429 ? ['capacity'] : status === 409 ? ['late_event','id_conflict'] : [])
    : status === 409 ? ['watermark_regression'] : [];
  const error=v.error;
  return typeof error.code === 'string' && allowed.includes(error.code)
    && Object.entries(messages).some(([code,message])=>error.code === code && error.message === message);
}
export function origin(raw: string | undefined): string {
  if (!raw) throw new Error('JOIN_ORIGIN required');
  const u=new URL(raw);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.port === '0' || u.username || u.password
    || u.pathname !== '/' || u.search || u.hash) throw new Error('JOIN_ORIGIN must be a loopback HTTP origin');
  return u.origin;
}
