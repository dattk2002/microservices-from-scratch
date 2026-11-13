import { HttpError } from '../../lib/http.mts';

export type Replica = 'a' | 'b';
export type Snapshot = {spent:{a:number;b:number};transferred:{ab:number;ba:number}};
export type Envelope = {replica:Replica;snapshot:Snapshot;rights:{a:number;b:number};remaining:number};
export const invariantError = {error:{code:'invariant_conflict',message:'Snapshot violates escrow invariants'}};

export function invalid(): never { throw new HttpError(400,'invalid_request','Invalid request'); }
export function object(value:unknown): value is Record<string,unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function exact(value:unknown, fields:readonly string[]): value is Record<string,unknown> {
  return object(value) && Object.keys(value).length === fields.length && fields.every(key=>Object.hasOwn(value,key));
}
export function replica(value:unknown): Replica { if(value!=='a' && value!=='b') return invalid(); return value; }
function coordinate(value:unknown, max:number):number {
  if(typeof value!=='number' || !Number.isSafeInteger(value) || value<0 || value>max) return invalid();
  return value;
}
export function initial():Snapshot { return {spent:{a:0,b:0},transferred:{ab:0,ba:0}}; }
export function rights(s:Snapshot):{a:number;b:number} {
  return {a:3+s.transferred.ba-s.transferred.ab-s.spent.a,b:3+s.transferred.ab-s.transferred.ba-s.spent.b};
}
export function validate(s:Snapshot):Snapshot {
  const r=rights(s);
  if(r.a<0 || r.a>6 || r.b<0 || r.b>6 || s.spent.a+s.spent.b>6) {
    throw new HttpError(409,invariantError.error.code,invariantError.error.message);
  }
  return s;
}
export function parseSnapshot(value:unknown):Snapshot {
  if(!exact(value,['spent','transferred']) || !exact(value.spent,['a','b']) || !exact(value.transferred,['ab','ba'])) return invalid();
  return validate({spent:{a:coordinate(value.spent.a,6),b:coordinate(value.spent.b,6)},transferred:{ab:coordinate(value.transferred.ab,16),ba:coordinate(value.transferred.ba,16)}});
}
export function joinSnapshots(x:Snapshot,y:Snapshot):Snapshot {
  return validate({spent:{a:Math.max(x.spent.a,y.spent.a),b:Math.max(x.spent.b,y.spent.b)},transferred:{ab:Math.max(x.transferred.ab,y.transferred.ab),ba:Math.max(x.transferred.ba,y.transferred.ba)}});
}
export function envelope(id:Replica,snapshot:Snapshot):Envelope {
  return {replica:id,snapshot,rights:rights(snapshot),remaining:6-snapshot.spent.a-snapshot.spent.b};
}
export function parseEnvelope(value:unknown,expected:Replica):Envelope {
  if(!exact(value,['replica','snapshot','rights','remaining']) || value.replica!==expected || !exact(value.rights,['a','b'])) return invalid();
  const result=envelope(expected,parseSnapshot(value.snapshot));
  if(value.rights.a!==result.rights.a || value.rights.b!==result.rights.b || value.remaining!==result.remaining) return invalid();
  return result;
}
export function amount(value:unknown):number {
  if(!exact(value,['amount']) || typeof value.amount!=='number' || !Number.isSafeInteger(value.amount) || value.amount<1 || value.amount>6) return invalid();
  return value.amount;
}
export function origin(raw:unknown):string {
  if(typeof raw!=='string') throw new Error('Origin required');
  const u=new URL(raw);
  if(u.protocol!=='http:' || u.hostname!=='127.0.0.1' || u.username || u.password || u.pathname!=='/' || u.search || u.hash) throw new Error('Expected loopback HTTP origin');
  return u.origin;
}
export function isInvariantError(value:unknown):boolean {
  return exact(value,['error']) && exact(value.error,['code','message']) && value.error.code===invariantError.error.code && value.error.message===invariantError.error.message;
}
