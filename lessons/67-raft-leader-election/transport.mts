import type { ReadableStreamReadResult } from 'node:stream/web';
import { knownVoteError, voteReply } from './protocol.mts';
import type { Peer, Vote, VoteReply } from './protocol.mts';

export async function readPeerJson(response:Response,signal:AbortSignal):Promise<unknown> {
  if(!response.body)throw new Error('upstream_missing_body');
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  try {
    while(true) {
      signal.throwIfAborted();
      // Explicit abort handling also covers a response whose headers have arrived
      // but whose final body bytes never arrive. Every read shares the same signal.
      const chunk=await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve,reject)=>{
        const abort=()=>reject(new Error('upstream_aborted'));
        signal.addEventListener('abort',abort,{once:true});
        reader.read().then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
        if(signal.aborted)abort();
      });
      if(chunk.done)break;
      size+=chunk.value.byteLength;
      if(size>8192)throw new Error('upstream_body_too_large');
      chunks.push(chunk.value);
    }
    signal.throwIfAborted();
    const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
    const value:unknown=JSON.parse(text);
    return value;
  } finally {
    // Do not let an untrusted stream's cancellation extend the election deadline.
    void reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}
export async function sendVote(peer:Peer,body:Vote,signal:AbortSignal):Promise<VoteReply> {
  const response=await fetch(`${peer.origin}/vote`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
    redirect:'error',signal
  });
  const value=await readPeerJson(response,signal);
  if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new Error('upstream_media_type');
  if(response.status!==200) {
    if(!knownVoteError(response.status,value))throw new Error('upstream_invalid_error');
    throw new Error('upstream_rejected_vote_request');
  }
  if(!voteReply(value,peer.id))throw new Error('upstream_invalid_vote');
  return value;
}
