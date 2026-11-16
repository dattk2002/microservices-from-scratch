import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { serve, json, readJson, HttpError, methodNotAllowed } from '../../lib/http.mts';
import { exact, revision, key, value, buildBits, invalid, semantic, routeRevision, validFilter, validateHost } from './protocol.mts';
import type { Filter } from './protocol.mts';

type Snapshot={revision:number,bits:string,items:Record<string,string>};
type State={identity:string,revision:number,items:Record<string,string>,snapshots:Snapshot[]};
function dictionary(v:unknown):v is Record<string,string> {
  return typeof v==='object'&&v!==null&&!Array.isArray(v)&&Object.keys(v).length<=32&&Object.entries(v).every(([k,x])=>key(k)&&value(x));
}
function parseState(raw:unknown):State {
  if(!exact(raw,['identity','revision','items','snapshots'])||typeof raw.identity!=='string'||!revision(raw.revision)||!dictionary(raw.items)||!Array.isArray(raw.snapshots)||raw.snapshots.length>4) throw new Error('Corrupt catalog state');
  const snapshots:Snapshot[]=[];
  for(const s of raw.snapshots) {
    if(!exact(s,['revision','bits','items'])||!revision(s.revision)||s.revision>raw.revision||!dictionary(s.items)||!validFilter({revision:s.revision,m:32,k:2,bits:s.bits},s.revision)||s.bits!==buildBits(Object.keys(s.items))||typeof s.bits!=='string'||snapshots.some(p=>p.revision===s.revision)) throw new Error('Corrupt snapshot');
    snapshots.push({revision:s.revision,bits:s.bits,items:s.items});
  }
  return {identity:raw.identity,revision:raw.revision,items:raw.items,snapshots};
}
export class Catalog {
  private readonly db:DatabaseSync;
  private constructor(db:DatabaseSync) {this.db=db;}
  static async open(file:string,identity:string):Promise<Catalog> {
    if(!/^[A-Za-z0-9_-]{1,32}$/.test(identity)) throw new Error('Invalid CATALOG_ID');
    const {DatabaseSync}=await import('node:sqlite');
    const db=new DatabaseSync(file);
    try {
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)');
      const c=new Catalog(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        if(!db.prepare('SELECT id FROM catalog WHERE id=1').get()) db.prepare('INSERT INTO catalog VALUES(1,?)').run(JSON.stringify({identity,revision:0,items:{},snapshots:[]}));
        if(c.read().identity!==identity) throw new Error('Catalog identity mismatch');
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
      return c;
    } catch(error) {db.close();throw error;}
  }
  close():void {this.db.close();}
  private read():State {
    const row=this.db.prepare('SELECT data FROM catalog WHERE id=1').get();
    if(typeof row?.data!=='string') throw new Error('Missing catalog state');
    const raw:unknown=JSON.parse(row.data);return parseState(raw);
  }
  private change(fn:(s:State)=>void):{revision:number} {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const s=this.read();fn(s);
      this.db.prepare('UPDATE catalog SET data=? WHERE id=1').run(JSON.stringify(s));
      this.db.exec('COMMIT');return {revision:s.revision};
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  write(k:unknown,body:unknown):{revision:number} {
    if(!key(k)||!exact(body,['value'])||!value(body.value)) invalid();
    const v=body.value;
    return this.change(s=>{
      if(s.items[k]===v) return;
      if(s.revision===16) semantic(409,'revision_exhausted');
      s.items[k]=v;s.revision++;
    });
  }
  publish(body:unknown):{revision:number} {
    if(!exact(body,[])) invalid();
    return this.change(s=>{
      if(s.snapshots.some(p=>p.revision===s.revision)) return;
      if(s.snapshots.length===4) semantic(429,'snapshot_capacity');
      s.snapshots.push({revision:s.revision,bits:buildBits(Object.keys(s.items)),items:{...s.items}});
    });
  }
  private snapshot(r:unknown):Snapshot {
    if(!revision(r)) invalid();
    const snap=this.read().snapshots.find(s=>s.revision===r);
    if(!snap) semantic(404,'unknown_snapshot');return snap;
  }
  filter(r:unknown):Filter {const s=this.snapshot(r);return {revision:s.revision,m:32,k:2,bits:s.bits};}
  item(r:unknown,k:unknown):{revision:number,key:string,value:string} {
    if(!key(k)) invalid();
    const s=this.snapshot(r),v=s.items[k];
    if(v===undefined) semantic(404,'absent');
    return {revision:s.revision,key:k,value:v};
  }
  state():{identity:string,revision:number,keys:string[],published:{revision:number,count:number,bits:string}[]} {
    const s=this.read();return {identity:s.identity,revision:s.revision,keys:Object.keys(s.items).sort(),published:s.snapshots.map(p=>({revision:p.revision,count:Object.keys(p.items).length,bits:p.bits}))};
  }
}
export function catalogHandler(c:Catalog,teaching:boolean) {
  const counts={filters:0,items:0};
  return async(req:IncomingMessage,res:ServerResponse):Promise<void>=>{
    const u=new URL(req.url??'/','http://catalog');
    if(u.search!=='') invalid();
    const parts=u.pathname.split('/');
    const route=parts[1];
    if(route==='stats'&&parts.length===2&&teaching) {
      if(req.method!=='GET') methodNotAllowed(res,'GET');json(res,200,counts);return;
    }
    if(route==='state'&&parts.length===2) {
      if(req.method!=='GET') methodNotAllowed(res,'GET');json(res,200,c.state());return;
    }
    if(route==='publish'&&parts.length===2) {
      if(req.method!=='POST') methodNotAllowed(res,'POST');json(res,200,c.publish(await readJson(req)));return;
    }
    if(route==='items'&&parts.length===3) {
      if(req.method!=='PUT') methodNotAllowed(res,'PUT');json(res,200,c.write(parts[2],await readJson(req)));return;
    }
    if(route==='filter'&&parts.length===3) {
      if(req.method!=='GET') methodNotAllowed(res,'GET');const r=routeRevision(parts[2]);counts.filters++;json(res,200,c.filter(r));return;
    }
    if(route==='snapshots'&&parts.length===5&&parts[3]==='items') {
      if(req.method!=='GET') methodNotAllowed(res,'GET');const r=routeRevision(parts[2]);if(!key(parts[4])) invalid();counts.items++;json(res,200,c.item(r,parts[4]));return;
    }
    throw new HttpError(404,'not_found','not_found');
  };
}
export async function main():Promise<void> {
  validateHost(process.env.HOST);
  const file=process.env.DB_PATH,id=process.env.CATALOG_ID;
  if(!file||!id) throw new Error('DB_PATH and CATALOG_ID are required');
  const c=await Catalog.open(file,id);
  try {
    const server=await serve('bloom-catalog',3068,catalogHandler(c,process.env.TEACHING_CONTROLS==='1'));
    server.once('close',()=>c.close());
  } catch(error) {c.close();throw error;}
}
if(import.meta.main) main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:'Startup failed');process.exitCode=1;});
