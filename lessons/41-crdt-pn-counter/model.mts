import { HttpError } from '../../lib/http.mts';
export const actors = ['a','b','c'] as const;
export type Actor = typeof actors[number];
export type State = {p: Record<Actor,number>; n: Record<Actor,number>};
export function bad(status = 400): never { throw new HttpError(status,'invalid_request','Invalid input or capacity exceeded'); }
export function object(x: unknown): Record<string,unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return bad();
  return x as Record<string,unknown>;
}
export function keys(x: Record<string,unknown>, expected: string[]) {
  if (Object.keys(x).sort().join(',') !== expected.sort().join(',')) bad();
}
export function actor(x: unknown): Actor { if (x !== 'a' && x !== 'b' && x !== 'c') return bad(); return x; }
export function parseState(x: unknown): State {
  const o = object(x); keys(o,['p','n']);
  const parse = (v: unknown): Record<Actor,number> => {
    const r = object(v); keys(r,['a','b','c']);
    const coordinate = (v: unknown): number => { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 1_000_000) return bad(); return v; };
    return {a:coordinate(r.a),b:coordinate(r.b),c:coordinate(r.c)};
  };
  return {p:parse(o.p),n:parse(o.n)};
}
export function zero(): State { return {p:{a:0,b:0,c:0},n:{a:0,b:0,c:0}}; }
export function merge(x: State,y: State): State {
  return {p:{a:Math.max(x.p.a,y.p.a),b:Math.max(x.p.b,y.p.b),c:Math.max(x.p.c,y.p.c)},n:{a:Math.max(x.n.a,y.n.a),b:Math.max(x.n.b,y.n.b),c:Math.max(x.n.c,y.n.c)}};
}
export function value(s: State): number { return s.p.a+s.p.b+s.p.c-s.n.a-s.n.b-s.n.c; }
export function change(x: unknown): {id:string;delta:number} {
  const o=object(x); keys(o,['id','delta']);
  if(typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.id) || typeof o.delta !== 'number' || !Number.isInteger(o.delta) || o.delta===0 || Math.abs(o.delta)>1000) return bad();
  return {id:o.id,delta:o.delta};
}
