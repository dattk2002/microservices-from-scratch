import { HttpError } from '../../lib/http.mts';
export const users = ['alice','bob','carol'];
export const groups = ['eng','ops','leads'];
export const documents = ['plan','runbook'];
export function bad(): never { throw new HttpError(400,'invalid_input','Invalid input'); }
export function record(v: unknown): Record<string,unknown> {
 if (v === null || typeof v !== 'object' || Array.isArray(v)) return bad();
 return v as Record<string,unknown>;
}
export function member(v: unknown, domain: readonly string[]): string {
 if (typeof v !== 'string' || !domain.includes(v)) return bad(); return v;
}
export function minimum(v: unknown): number {
 if (v === undefined) return 0;
 if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 64) return bad(); return v;
}
export type Tuple = {objectType:string;object:string;relation:string;subjectType:string;subject:string};
export function tuple(v: unknown): Tuple {
 const r = record(v);
 const objectType = member(r.objectType,['group','document']);
 const subjectType = member(r.subjectType,['user','group']);
 return {objectType, object:member(r.object,objectType === 'group' ? groups : documents),
 relation:member(r.relation,objectType === 'group' ? ['member'] : ['viewer','editor']),
 subjectType,subject:member(r.subject,subjectType === 'group' ? groups : users)};
}
export function key(t: Tuple): string { return JSON.stringify([t.objectType,t.object,t.relation,t.subjectType,t.subject]); }
