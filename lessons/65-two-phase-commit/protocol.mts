import { HttpError } from '../../lib/http.mts';
export type ParticipantId = 'a'|'b';
export type Vote = 'yes'|'no';
export type Decision = 'commit'|'abort';
export type LocalPhase = 'prepared'|'rejected'|'committed'|'aborted';
export type Tuple = {txId:string;amount:number};
export type LocalRecord = Tuple & {phase:LocalPhase};
export type Transaction = Tuple & {
 phase:'preparing'|Decision;
 votes:Record<ParticipantId,Vote|null>;
 acks:Record<ParticipantId,boolean>;
};
export type Origins = Record<ParticipantId,string>;
export function fail(status:number, code:string):never { throw new HttpError(status,code,code); }
export function object(value:unknown):value is Record<string,unknown> { return typeof value==='object' && value!==null && !Array.isArray(value); }
export function exact(value:unknown, keys:readonly string[]):value is Record<string,unknown> {
 return object(value) && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
}
export function fields(value:unknown, keys:readonly string[]) {
 if(!exact(value,keys))fail(400,'invalid_body');
 return value;
}
export function txId(value:unknown):value is string { return typeof value==='string' && /^[A-Za-z0-9_-]{1,16}$/.test(value); }
export function amount(value:unknown):value is number { return typeof value==='number' && Number.isSafeInteger(value) && value>=1 && value<=4; }
export function parseTxId(value:unknown) { if(!txId(value))fail(400,'invalid_body');return value; }
export function parseAmount(value:unknown) { if(!amount(value))fail(400,'invalid_body');return value; }
export function parseDecision(value:unknown):Decision { if(value!=='commit' && value!=='abort')fail(400,'invalid_body');return value; }
export function tuple(value:unknown):Tuple {
 const b=fields(value,['txId','amount']);return {txId:parseTxId(b.txId),amount:parseAmount(b.amount)};
}
export function localRecord(value:unknown):value is LocalRecord {
 return exact(value,['txId','amount','phase']) && txId(value.txId) && amount(value.amount) &&
 (value.phase==='prepared'||value.phase==='rejected'||value.phase==='committed'||value.phase==='aborted');
}
export function transaction(value:unknown):value is Transaction {
 if(!exact(value,['txId','amount','phase','votes','acks']) || !txId(value.txId) || !amount(value.amount) ||
 (value.phase!=='preparing'&&value.phase!=='commit'&&value.phase!=='abort') || !exact(value.votes,['a','b']) || !exact(value.acks,['a','b']))return false;
 const {a,b}=value.votes;
 if((a!==null&&a!=='yes'&&a!=='no')||(b!==null&&b!=='yes'&&b!=='no')||typeof value.acks.a!=='boolean'||typeof value.acks.b!=='boolean')return false;
 if(value.phase==='preparing')return a!=='no'&&b!=='no'&&!(a==='yes'&&b==='yes')&&!value.acks.a&&!value.acks.b;
 if(value.phase==='commit')return a==='yes'&&b==='yes';
 return true;
}
export function voteReply(value:unknown, expected:Tuple):value is Tuple & {vote:Vote} {
 return exact(value,['txId','amount','vote']) && value.txId===expected.txId && value.amount===expected.amount && (value.vote==='yes'||value.vote==='no');
}
export function decisionReply(value:unknown, expected:Tuple, decision:Decision):boolean {
 return exact(value,['txId','amount','phase']) && value.txId===expected.txId && value.amount===expected.amount && value.phase===(decision==='commit'?'committed':'aborted');
}
export function origins(a:unknown,b:unknown):Origins {
 function normalize(raw:unknown) {
  if(typeof raw!=='string')throw new Error('A_ORIGIN/B_ORIGIN required');
  const u=new URL(raw);
  if(u.protocol!=='http:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!['127.0.0.1','localhost','[::1]'].includes(u.hostname))throw new Error('Expected a fixed loopback HTTP origin');
  return u.origin;
 }
 const result={a:normalize(a),b:normalize(b)};
 if(result.a===result.b)throw new Error('Participant origins must be distinct');
 return result;
}
