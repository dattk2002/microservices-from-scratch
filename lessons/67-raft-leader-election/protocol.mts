import { HttpError } from '../../lib/http.mts';
export type Id = 'a'|'b'|'c';
export type Role = 'follower'|'candidate'|'leader';
export type State = {id:Id;term:number;votedFor:Id|null;role:Role;lastLogIndex:number;lastLogTerm:number};
export type Vote = {term:number;candidateId:Id;lastLogIndex:number;lastLogTerm:number};
export type VoteReply = {id:Id;term:number;granted:boolean};
export type Heartbeat = {term:number;leaderId:Id};
export type Peer = {id:Id;origin:string};
export type Peers = readonly [Peer,Peer];
export function fail(status:number,code:string):never {throw new HttpError(status,code,code);}
export function exact(value:unknown,keys:readonly string[]):value is Record<string,unknown> {
  return typeof value==='object' && value!==null && !Array.isArray(value) &&
    Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));
}
export function id(value:unknown):value is Id {return value==='a'||value==='b'||value==='c';}
export function integer(value:unknown,min:number,max:number):value is number {
  return typeof value==='number' && Number.isSafeInteger(value) && value>=min && value<=max;
}
export function logTuple(index:unknown,term:unknown):boolean {
  return integer(index,0,4) && integer(term,0,4) && ((index===0 && term===0)||(index>0 && term>0));
}
export function parseVote(value:unknown):Vote {
  if(!exact(value,['term','candidateId','lastLogIndex','lastLogTerm']) || !integer(value.term,1,16) ||
     !id(value.candidateId) || !integer(value.lastLogIndex,0,4) || !integer(value.lastLogTerm,0,4) ||
     !logTuple(value.lastLogIndex,value.lastLogTerm))fail(400,'invalid_body');
  return {term:value.term,candidateId:value.candidateId,lastLogIndex:value.lastLogIndex,lastLogTerm:value.lastLogTerm};
}
export function parseHeartbeat(value:unknown):Heartbeat {
  if(!exact(value,['term','leaderId']) || !integer(value.term,1,16) || !id(value.leaderId))fail(400,'invalid_body');
  return {term:value.term,leaderId:value.leaderId};
}
export function voteReply(value:unknown,expected:Id):value is VoteReply {
  return exact(value,['id','term','granted']) && value.id===expected && integer(value.term,0,16) &&
    typeof value.granted==='boolean' && (!value.granted || value.term>=1);
}
export function configurePeers(self:Id,oneId:unknown,oneOrigin:unknown,twoId:unknown,twoOrigin:unknown):Peers {
  if(!id(oneId)||!id(twoId)||oneId===self||twoId===self||oneId===twoId)throw new Error('Expected the other two distinct peer ids');
  const normalize=(raw:unknown)=>{
    if(typeof raw!=='string')throw new Error('Peer origin required');
    const u=new URL(raw);
    if(u.protocol!=='http:' || u.hostname!=='127.0.0.1' || u.username || u.password ||
       u.pathname!=='/' || u.search || u.hash)throw new Error('Expected a fixed 127.0.0.1 HTTP origin');
    return u.origin;
  };
  const a=normalize(oneOrigin), b=normalize(twoOrigin);
  if(a===b)throw new Error('Peer origins must be distinct');
  return [{id:oneId,origin:a},{id:twoId,origin:b}];
}
// These are the complete errors /vote can produce in this lesson. Unknown codes,
// including a well-shaped internal_error, never acquire business meaning.
export function knownVoteError(status:number,value:unknown):boolean {
  if(!exact(value,['error']) || !exact(value.error,['code','message']))return false;
  const messages:Readonly<Record<string,readonly [number,string]>>={
    invalid_body:[400,'invalid_body'],
    invalid_json:[400,'Body must be valid JSON'],
    body_too_large:[413,'JSON body exceeds 8192 bytes'],
    unsupported_media_type:[415,'Use application/json'],
    request_aborted:[400,'Request was interrupted']
  };
  if(typeof value.error.code!=='string')return false;
  const expected=Object.hasOwn(messages,value.error.code)?messages[value.error.code]:undefined;
  return expected!==undefined && status===expected[0] && value.error.message===expected[1];
}
export function persistentPath(value:unknown):string {
  if(typeof value!=='string' || value.length===0 || value===':memory:' || /^file:/i.test(value) || value.includes('\0')) {
    throw new Error('DB_PATH must name a persistent file');
  }
  return value;
}
