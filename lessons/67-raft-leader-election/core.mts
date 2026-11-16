import type { DatabaseSync } from 'node:sqlite';
import { configurePeers, exact, fail, id, integer, logTuple, parseHeartbeat, parseVote, voteReply } from './protocol.mts';
import type { Id, Peers, Role, State, Vote, VoteReply } from './protocol.mts';
import { sendVote } from './transport.mts';
export type SendVote = (peer:Peers[number],body:Vote,signal:AbortSignal)=>Promise<unknown>;

export class Replica {
  private readonly db:DatabaseSync;
  private role:Role='follower';
  private generation=0;
  private storageFailed=false;
  constructor(db:DatabaseSync,identity:Id,logIndex:number,logTerm:number) {
    if(!id(identity)||!logTuple(logIndex,logTerm))throw new Error('Invalid bootstrap identity/log');
    this.db=db;
    db.exec('PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS election (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        id TEXT NOT NULL CHECK(id IN ('a','b','c')),
        current_term INTEGER NOT NULL CHECK(current_term BETWEEN 0 AND 16),
        voted_for TEXT CHECK(voted_for IN ('a','b','c')),
        log_index INTEGER NOT NULL CHECK(log_index BETWEEN 0 AND 4),
        log_term INTEGER NOT NULL CHECK(log_term BETWEEN 0 AND 4)
      )`);
      const row=db.prepare('SELECT * FROM election WHERE singleton=1').get();
      if(row && (row.id!==identity||row.log_index!==logIndex||row.log_term!==logTerm))throw new Error('Database configuration mismatch');
      if(!row)db.prepare('INSERT INTO election VALUES (1,?,?,NULL,?,?)').run(identity,logTerm,logIndex,logTerm);
      this.state();
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  state():State {
    const row=this.db.prepare('SELECT * FROM election WHERE singleton=1').get();
    if(!row || !id(row.id) || !integer(row.current_term,0,16) ||
       (row.voted_for!==null && !id(row.voted_for)) || !integer(row.log_index,0,4) ||
       !integer(row.log_term,0,4) || !logTuple(row.log_index,row.log_term) || row.current_term<row.log_term ||
       (row.current_term===0 && row.voted_for!==null))throw new Error('Invalid persisted election state');
    return {id:row.id,term:row.current_term,votedFor:row.voted_for,role:this.role,lastLogIndex:row.log_index,lastLogTerm:row.log_term};
  }
  private requireStorage() {
    if(this.storageFailed)throw new Error('Replica storage failed; restart required');
  }
  private save(term:number,vote:Id|null) {
    // One FULL-synchronous SQLite commit precedes every observable vote/term reply.
    this.requireStorage();
    try {
      this.db.prepare('UPDATE election SET current_term=?,voted_for=? WHERE singleton=1').run(term,vote);
    } catch(error) {
      // An unpersisted observed term must never allow this process to vote again.
      this.storageFailed=true;
      this.role='follower';
      this.generation++;
      throw error;
    }
  }
  private advance(term:number) {
    if(term<=this.state().term)return;
    this.role='follower';
    this.generation++;
    this.save(term,null);
  }
  vote(body:unknown):VoteReply {
    this.requireStorage();
    const request=parseVote(body);
    this.advance(request.term);
    const s=this.state();
    const fresh=request.lastLogTerm>s.lastLogTerm ||
      (request.lastLogTerm===s.lastLogTerm && request.lastLogIndex>=s.lastLogIndex);
    const granted=request.term===s.term && fresh && (s.votedFor===null || s.votedFor===request.candidateId);
    if(granted)this.save(s.term,request.candidateId);
    return {id:s.id,term:s.term,granted};
  }
  heartbeat(body:unknown) {
    this.requireStorage();
    const request=parseHeartbeat(body);
    this.advance(request.term);
    const s=this.state();
    if(request.term<s.term)return {id:s.id,term:s.term,accepted:false};
    this.role='follower';
    this.generation++;
    return {id:s.id,term:s.term,accepted:true};
  }
  async campaign(body:unknown,peers:Peers,send:SendVote=sendVote):Promise<State> {
    this.requireStorage();
    if(!exact(body,[]))fail(400,'invalid_body');
    const s=this.state();
    // Validate even injected peer lists; each id/origin represents exactly one voter.
    const fixed=configurePeers(s.id,peers[0].id,peers[0].origin,peers[1].id,peers[1].origin);
    if(s.term===16)fail(409,'term_exhausted');
    const term=s.term+1;
    this.save(term,s.id);
    this.role='candidate';
    const generation=++this.generation;
    const votes=new Set<Id>([s.id]);
    const bodyVote:Vote={term,candidateId:s.id,lastLogIndex:s.lastLogIndex,lastLogTerm:s.lastLogTerm};
    const controller=new AbortController();
    const deadline=setTimeout(()=>controller.abort(new Error('Campaign deadline')),500);
    try {
      const results=await Promise.allSettled(fixed.map(async peer=>{
        let result:unknown;
        // Only RPC failures are ignored; local state failures must reach the caller.
        try {result=await send(peer,bodyVote,controller.signal);}
        catch {return;}
        this.requireStorage();
        if(!voteReply(result,peer.id))return;
        if(result.term>this.state().term)this.advance(result.term);
        if(result.term===term && result.granted)votes.add(peer.id);
      }));
      for(const result of results)if(result.status==='rejected')throw result.reason;
      this.requireStorage();
      if(this.generation===generation && this.state().term===term && this.role==='candidate' && votes.size>=2)this.role='leader';
      return this.state();
    } finally {clearTimeout(deadline);controller.abort();}
  }
}
