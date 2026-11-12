import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Clock = {wall:number,counter:number};
export type Replica = 'a'|'b';
export type Event = {id:string,payload:string,stamp:Clock & {replica:Replica}};
export function fail(status:number): never { throw new HttpError(status,'rejected','Request rejected'); }
export function object(v:unknown, keys:string[]): v is Record<string,unknown> {
  return typeof v==='object' && v!==null && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
}
export function integer(v:unknown,min:number,max:number): v is number {return typeof v==='number' && Number.isSafeInteger(v) && v>=min && v<=max;}
export function token(v:unknown,max:number): v is string {return typeof v==='string' && new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`).test(v);}
export function clock(v:unknown): v is Clock {return object(v,['wall','counter']) && integer(v.wall,0,9000000000000) && integer(v.counter,0,65535);}
export function event(v:unknown): v is Event {
  return object(v,['id','payload','stamp']) && token(v.id,16) && token(v.payload,32) && object(v.stamp,['wall','counter','replica']) && integer(v.stamp.wall,0,9000000000000) && integer(v.stamp.counter,0,65535) && (v.stamp.replica==='a'||v.stamp.replica==='b');
}
export function advance(last:Clock,now:number,remote?:Clock):Clock {
  const wall=Math.max(now,last.wall,remote?.wall??0);
  const counter=wall===last.wall && remote?.wall===wall ? Math.max(last.counter,remote.counter)+1 : wall===last.wall ? last.counter+1 : remote?.wall===wall ? remote.counter+1 : 0;
  if(counter>65535) fail(429);
  return {wall,counter};
}
export function compare(a:Event['stamp'],b:Event['stamp']):number {return a.wall-b.wall || a.counter-b.counter || a.replica.localeCompare(b.replica);}
type State={replica:Replica,clock:Clock,created:Event[],received:{event:Event,clock:Clock}[]};
export class Store {
  readonly db:DatabaseSync;
  readonly replica:Replica;
  constructor(path:string,replica:Replica) {
    this.replica=replica; this.db=new DatabaseSync(path);
    try {
      this.db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
      const row=this.db.prepare('SELECT data FROM state WHERE id=1').get();
      if(!row) this.db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify({replica,clock:{wall:0,counter:0},created:[],received:[]}));
      else if(this.state().replica!==replica) throw new Error('Database replica identity mismatch');
    } catch(e) {this.db.close(); throw e;}
  }
  state():State {
    const row=this.db.prepare('SELECT data FROM state WHERE id=1').get();
    if(typeof row?.data!=='string') throw new Error('Missing state');
    const v:unknown=JSON.parse(row.data);
    if(!object(v,['replica','clock','created','received'])||(v.replica!=='a'&&v.replica!=='b')||!clock(v.clock)||!Array.isArray(v.created)||!v.created.every(event)||!Array.isArray(v.received)) throw new Error('Corrupt state');
    const received:{event:Event,clock:Clock}[]=[];
    for(const r of v.received) {if(!object(r,['event','clock'])||!event(r.event)||!clock(r.clock)) throw new Error('Corrupt receive');received.push({event:r.event,clock:r.clock});}
    return {replica:v.replica,clock:v.clock,created:v.created,received};
  }
  change<T>(fn:(s:State)=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try {const s=this.state(); const result=fn(s); this.db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(s)); this.db.exec('COMMIT'); return result;}
    catch(e) {this.db.exec('ROLLBACK'); throw e;}
  }
  create(v:unknown,now:number) {
    if(!object(v,['id','payload'])||!token(v.id,16)||!token(v.payload,32)) fail(400);
    const id=v.id,payload=v.payload;
    return this.change(s=>{
      const old=s.created.find(e=>e.id===id);
      if(old) {if(old.payload!==payload) fail(409); return {status:200,body:old};}
      if(s.created.length>=8) fail(429);
      s.clock=advance(s.clock,now);
      const e={id,payload,stamp:{...s.clock,replica:this.replica}};
      s.created.push(e); s.created.sort((a,b)=>a.id.localeCompare(b.id));
      return {status:201,body:e};
    });
  }
  receive(v:unknown,now:number) {
    if(!event(v)||v.stamp.replica===this.replica) fail(400);
    return this.change(s=>{
      const old=s.received.find(r=>r.event.id===v.id && r.event.stamp.replica===v.stamp.replica);
      if(old) {if(old.event.payload!==v.payload||compare(old.event.stamp,v.stamp)!==0) fail(409); return {status:200,body:{clock:old.clock}};}
      if(s.received.length>=8) fail(429);
      if(v.stamp.wall>now+1000) fail(422);
      s.clock=advance(s.clock,now,v.stamp);
      s.received.push({event:v,clock:s.clock}); s.received.sort((a,b)=>a.event.stamp.replica.localeCompare(b.event.stamp.replica)||a.event.id.localeCompare(b.event.id));
      return {status:201,body:{clock:s.clock}};
    });
  }
}
