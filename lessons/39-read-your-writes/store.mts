import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Item={id:string;value:string};
export type Snapshot={items:Item[];commitVersion:number};
export function bad():never {throw new HttpError(400,'invalid','Invalid bounded input');}
export function record(v:unknown):Record<string,unknown> {if(typeof v!=='object'||v===null||Array.isArray(v)) return bad();return Object.fromEntries(Object.entries(v));}
export function version(v:unknown):number {if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)return bad();return v;}
export function identity(v:unknown):string {if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(v))return bad();return v;}
export function item(v:unknown):Item {const r=record(v);if(typeof r.value!=='string'||r.value.length>256)return bad();return {id:identity(r.id),value:r.value};}
export function snapshot(v:unknown):Snapshot {
 const r=record(v), n=version(r.commitVersion);
 if(!Array.isArray(r.items)||r.items.length>16)return bad();
 const items=r.items.map(item).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
 if(new Set(items.map(x=>x.id)).size!==items.length||items.length>n)return bad();
 return {items,commitVersion:n};
}
export function minVersion(v:string|null):number {if(v===null)return 0;if(!/^(0|[1-9][0-9]*)$/.test(v))return bad();return version(Number(v));}
export function fallback(status:number,body:unknown,minimum:number,expectedSource:'primary'|'replica'='replica'):boolean {
 try {const r=record(body);return status===425&&r.source===expectedSource&&r.error==='lag'&&version(r.commitVersion)<minimum;}catch{return false;}
}
export class Store {
 readonly db:DatabaseSync;
 constructor(path:string) {this.db=new DatabaseSync(path);this.db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); INSERT OR IGNORE INTO state VALUES (1,'{\"items\":[],\"commitVersion\":0}');");}
 snapshot():Snapshot {const row=this.db.prepare('SELECT body FROM state WHERE id=1').get();return snapshot(JSON.parse(typeof row?.body==='string'?row.body:bad()));}
 private transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try {const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private save(s:Snapshot) {this.db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(s));}
 write(id:string,value:string) {const next=item({id,value});return this.transaction(()=>{const s=this.snapshot();if(s.commitVersion===Number.MAX_SAFE_INTEGER)throw new HttpError(409,'exhausted','Version exhausted');const items=s.items.filter(x=>x.id!==id);items.push(next);const updated=snapshot({items,commitVersion:s.commitVersion+1});this.save(updated);return {item:next,commitVersion:updated.commitVersion};});}
 apply(v:unknown):string {const next=snapshot(v);return this.transaction(()=>{const old=this.snapshot();if(next.commitVersion<old.commitVersion)return 'older';if(next.commitVersion===old.commitVersion){if(JSON.stringify(next)!==JSON.stringify(old))throw new HttpError(409,'conflict','Equal version differs');return 'duplicate';}this.save(next);return 'applied';});}
 close(){this.db.close();}
}
