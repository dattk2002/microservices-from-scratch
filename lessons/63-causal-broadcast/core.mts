import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';

export const members = ['a','b','c'] as const;
export type Member = typeof members[number];
export type Clock = Record<Member,number>;
export type Event = {sender:Member;seq:number;clock:Clock;value:string};
type State = {node:Member;clock:Clock;delivered:Event[];pending:Event[]};
export const messages = {
  invalid_request:'Invalid request', event_conflict:'Event conflicts with retained identity',
  buffer_full:'Pending buffer is full', counter_limit:'Local counter reached 8',
  unknown_event:'Event is not delivered', upstream_failure:'Invalid upstream response',
} as const;
export function fail(status:number, code:keyof typeof messages): never { throw new HttpError(status,code,messages[code]); }
export function object(value:unknown): value is Record<string,unknown> { return typeof value==='object' && value!==null && !Array.isArray(value); }
export function exact(value:unknown, keys:readonly string[]): value is Record<string,unknown> {
  return object(value) && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
}
export function member(value:unknown): value is Member { return value==='a'||value==='b'||value==='c'; }
export function integer(value:unknown,min:number,max:number): value is number { return typeof value==='number' && Number.isInteger(value) && value>=min && value<=max; }
function clock(value:unknown): value is Clock { return exact(value,members) && members.every(k=>integer(value[k],0,8)); }
function safeValue(value:unknown): value is string {return typeof value==='string' && /^[A-Za-z0-9_-]{1,16}$/.test(value);}
export function isEvent(value:unknown): value is Event {
  return exact(value,['sender','seq','clock','value']) && member(value.sender) && integer(value.seq,1,8) && clock(value.clock) && value.clock[value.sender]===value.seq && safeValue(value.value);
}
function decode(raw:unknown): State {
  if(typeof raw!=='string') throw new Error('Corrupt snapshot');
  const s:unknown=JSON.parse(raw);
  if(!exact(s,['node','clock','delivered','pending']) || !member(s.node) || !clock(s.clock) || !Array.isArray(s.delivered) || !s.delivered.every(isEvent) || !Array.isArray(s.pending) || !s.pending.every(isEvent)) throw new Error('Corrupt snapshot');
  return {node:s.node,clock:s.clock,delivered:s.delivered,pending:s.pending};
}
function compare(a:Event,b:Event) {return members.indexOf(a.sender)-members.indexOf(b.sender)||a.seq-b.seq;}
function eligible(s:State,e:Event) {return e.seq===s.clock[e.sender]+1 && members.every(k=>k===e.sender||e.clock[k]<=s.clock[k]);}
function deliver(s:State,e:Event) {s.clock[e.sender]=e.seq;s.delivered.push(e);}
function drain(s:State) {
  s.pending.sort(compare);
  for(;;) {
    const index=s.pending.findIndex(e=>eligible(s,e));
    if(index<0) return;
    const [e]=s.pending.splice(index,1);
    if(e) deliver(s,e);
  }
}
export class Replica {
  readonly db:DatabaseSync;
  readonly node:Member;
  constructor(db:DatabaseSync,node:Member) {
    this.db=db;this.node=node;
    db.exec('CREATE TABLE IF NOT EXISTS replica (id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)');
    const existing=db.prepare('SELECT snapshot FROM replica WHERE id=1').get();
    if(existing) {if(decode(existing.snapshot).node!==node) throw new Error('Replica identity mismatch');}
    else db.prepare('INSERT INTO replica VALUES(1,?)').run(JSON.stringify({node,clock:{a:0,b:0,c:0},delivered:[],pending:[]}));
  }
  state():State {
    const row=this.db.prepare('SELECT snapshot FROM replica WHERE id=1').get();
    return decode(row?.snapshot);
  }
  private transaction<T>(action:(state:State)=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const s=this.state(), result=action(s);
      this.db.prepare('UPDATE replica SET snapshot=? WHERE id=1').run(JSON.stringify(s));
      this.db.exec('COMMIT'); return result;
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  publish(body:unknown):Event {
    if(!exact(body,['value'])||!safeValue(body.value)) fail(400,'invalid_request');
    const value=body.value;
    return this.transaction(s=>{
      if(s.clock[this.node]===8) fail(429,'counter_limit');
      const e:Event={sender:this.node,seq:s.clock[this.node]+1,clock:{...s.clock,[this.node]:s.clock[this.node]+1},value};
      deliver(s,e);drain(s);return e;
    });
  }
  receive(body:unknown):{status:number;body:{status:'buffered'|'delivered'}} {
    if(!isEvent(body)) fail(400,'invalid_request');
    // Copy at the public boundary; callers never own retained mutable objects.
    const e:Event={...body,clock:{...body.clock}};
    return this.transaction(s=>{
      const old=[...s.delivered,...s.pending].find(x=>x.sender===e.sender&&x.seq===e.seq);
      if(old) {
        if(old.value!==e.value || members.some(k=>old.clock[k]!==e.clock[k])) fail(409,'event_conflict');
        return {status:200,body:{status:s.delivered.some(x=>x.sender===e.sender&&x.seq===e.seq)?'delivered':'buffered'}};
      }
      if(e.sender===this.node) fail(409,'event_conflict');
      if(eligible(s,e)) {deliver(s,e);drain(s);return {status:200,body:{status:'delivered'}};}
      if(s.pending.length===4) fail(429,'buffer_full');
      s.pending.push(e);s.pending.sort(compare);
      return {status:202,body:{status:'buffered'}};
    });
  }
  get(sender:Member,seq:number):Event {
    const e=this.state().delivered.find(e=>e.sender===sender&&e.seq===seq);
    if(!e) fail(404,'unknown_event');return e;
  }
}
