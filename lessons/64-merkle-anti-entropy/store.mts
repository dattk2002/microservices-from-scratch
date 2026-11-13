import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage,ServerResponse } from 'node:http';
import { serve,json,HttpError,methodNotAllowed } from '../../lib/http.mts';
import { KEYS,exact,revision,key,value,path,patch,tree,invalid,stale,capacity,publicBody,query,queryRevision } from './protocol.mts';
import type { Value,Key,Root,TreeNode } from './protocol.mts';

type State={replica:string,revision:number,values:Value[]};
export class Store {
  private readonly db:DatabaseSync;
  private constructor(db:DatabaseSync) {this.db=db;}
  static async open(file:string,replica:string):Promise<Store> {
    if(!/^[A-Za-z0-9_-]{1,16}$/.test(replica)) throw new Error('Invalid REPLICA_ID');
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(file);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
      const s=new Store(db);
      if(!db.prepare('SELECT id FROM state WHERE id=1').get()) db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify({replica,revision:0,values:Array<null>(8).fill(null)}));
      if(s.state().replica!==replica) throw new Error('Database replica identity mismatch');
      return s;
    } catch(error) {db.close();throw error;}
  }
  close():void {this.db.close();}
  private state():State {
    const row=this.db.prepare('SELECT data FROM state WHERE id=1').get();
    if(typeof row?.data!=='string') throw new Error('Missing state');
    const s:unknown=JSON.parse(row.data);
    if(!exact(s,['replica','revision','values'])||typeof s.replica!=='string'||!revision(s.revision)||!Array.isArray(s.values)||s.values.length!==8||!s.values.every(value)) throw new Error('Corrupt state');
    return {replica:s.replica,revision:s.revision,values:s.values};
  }
  root():Root {const s=this.state();return {revision:s.revision,hash:tree(s.values).get('')!};}
  node(p:unknown,r:unknown):TreeNode {
    if(!path(p)||!revision(r)) invalid();
    const s=this.state();if(s.revision!==r) stale();
    const nodes=tree(s.values);
    return {revision:r,path:p,hash:nodes.get(p)!,children:p.length===3?null:{left:nodes.get(p+'0')!,right:nodes.get(p+'1')!}};
  }
  record(k:unknown,r:unknown):Root & {key:Key,value:Value} {
    if(!key(k)||!revision(r)) invalid();
    const s=this.state();if(s.revision!==r) stale();
    const i=KEYS.indexOf(k);
    return {revision:r,key:k,value:s.values[i]!,hash:tree(s.values).get(i.toString(2).padStart(3,'0'))!};
  }
  private change(fn:(s:State)=>boolean):{revision:number} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const s=this.state();
      if(fn(s)) {
        if(s.revision===32) capacity();
        s.revision++;
        this.db.prepare('UPDATE state SET data=? WHERE id=1').run(JSON.stringify(s));
      }
      this.db.exec('COMMIT');return {revision:s.revision};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  write(body:unknown):{revision:number} {
    if(!exact(body,['key','value'])||!key(body.key)||!value(body.value)) invalid();
    const k=body.key,v=body.value;
    return this.change(s=>{const i=KEYS.indexOf(k);if(s.values[i]===v)return false;s.values[i]=v;return true;});
  }
  apply(body:unknown):{revision:number} {
    if(!exact(body,['expectedRevision','records'])||!revision(body.expectedRevision)) invalid();
    return this.change(s=>{
      if(s.revision!==body.expectedRevision) stale();
      const records=patch(body.records);
      let changed=false;
      for(const r of records) {const i=KEYS.indexOf(r.key);if(s.values[i]!==r.value){s.values[i]=r.value;changed=true;}}
      return changed;
    });
  }
}

export function storeHandler(store:Store,teaching:boolean) {
  const counts={root:0,node:0,record:0,apply:0};
  return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    const url=new URL(req.url??'/','http://store');
    if(url.pathname==='/teaching/stats'&&teaching) {
      if(req.method!=='GET') methodNotAllowed(res,'GET');query(url,[]);json(res,200,counts);return;
    }
    const methods:Record<string,string>={'/root':'GET','/node':'GET','/record':'GET','/write':'POST','/apply':'POST'};
    const method=methods[url.pathname];
    if(!method) throw new HttpError(404,'not_found','Route not found');
    if(req.method!==method) methodNotAllowed(res,method);
    if(url.pathname==='/root'){query(url,[]);counts.root++;json(res,200,store.root());}
    else if(url.pathname==='/node'){const q=query(url,['path','revision']);counts.node++;json(res,200,store.node(q.path,queryRevision(q.revision)));}
    else if(url.pathname==='/record'){const q=query(url,['key','revision']);counts.record++;json(res,200,store.record(q.key,queryRevision(q.revision)));}
    else {
      query(url,[]);const body=await publicBody(req);
      if(url.pathname==='/write') json(res,200,store.write(body));
      else {counts.apply++;json(res,200,store.apply(body));}
    }
  };
}
export async function main():Promise<void> {
  const file=process.env.DB_PATH,replica=process.env.REPLICA_ID;
  if(!file||!replica) throw new Error('DB_PATH and REPLICA_ID are required');
  const store=await Store.open(file,replica);
  try {
    const server=await serve('merkle-store',3064,storeHandler(store,process.env.TEACHING_CONTROLS==='1'));
    server.once('close',()=>store.close());
  } catch(error) {store.close();throw error;}
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
