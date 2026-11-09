import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Job={tenant:'red'|'blue';id:string;value:number;seq:number;attempts:number;state:'pending'|'done'|'failed';result?:number};
function isObject(v:unknown):v is Record<string,unknown>{return typeof v==='object'&&v!==null&&!Array.isArray(v);}
export function object(v:unknown):Record<string,unknown>{
 if(!isObject(v))throw new HttpError(400,'input','Expected object');
 return v;
}
export function input(v:unknown):Pick<Job,'tenant'|'id'|'value'>{
 const x=object(v);
 if(typeof x.tenant!=='string'||(x.tenant!=='red'&&x.tenant!=='blue')||typeof x.id!=='string'||! /^[A-Za-z0-9_-]{1,32}$/.test(x.id)||typeof x.value!=='number'||!Number.isInteger(x.value)||x.value<1||x.value>100)throw new HttpError(400,'input','Invalid job');
 return {tenant:x.tenant,id:x.id,value:x.value};
}
function row(v:Record<string,unknown>):Job{
 const base=input(v);
 if(typeof v.seq!=='number'||typeof v.attempts!=='number'||(v.state!=='pending'&&v.state!=='done'&&v.state!=='failed'))throw new Error('Corrupt job');
 const j:Job={...base,seq:v.seq,attempts:v.attempts,state:v.state};
 if(typeof v.result==='number')j.result=v.result;
 return j;
}
export class Queue {
 readonly db:DatabaseSync;
 constructor(db:DatabaseSync){this.db=db;db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,tenant TEXT NOT NULL,id TEXT NOT NULL,value INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'pending',result INTEGER,UNIQUE(tenant,id));
 CREATE TABLE IF NOT EXISTS schedule(singleton INTEGER PRIMARY KEY CHECK(singleton=1),cursor INTEGER NOT NULL); INSERT OR IGNORE INTO schedule VALUES(1,0);`);}
 admit(value:unknown):Job{
 const x=input(value);const old=this.db.prepare('SELECT * FROM jobs WHERE tenant=? AND id=?').get(x.tenant,x.id);
 if(old){const j=row(old);if(j.value!==x.value)throw new HttpError(409,'conflict','Identity value conflict');return j;}
 if(this.snapshot().jobs.length>=16)throw new HttpError(429,'capacity','Retained identity capacity');
 this.db.prepare('INSERT INTO jobs(tenant,id,value) VALUES(?,?,?)').run(x.tenant,x.id,x.value);
 return row(this.db.prepare('SELECT * FROM jobs WHERE tenant=? AND id=?').get(x.tenant,x.id)!);
 }
 snapshot():{jobs:Job[];cursor:number}{const c=this.db.prepare('SELECT cursor FROM schedule').get()!;if(typeof c.cursor!=='number')throw new Error('Corrupt cursor');return {jobs:this.db.prepare('SELECT * FROM jobs ORDER BY seq LIMIT 16').all().map(row),cursor:c.cursor};}
 select():Job|undefined{
 this.db.exec('BEGIN IMMEDIATE');try{
 this.db.exec("UPDATE jobs SET state='failed' WHERE state='pending' AND attempts>=3");
 const cursor=this.snapshot().cursor;const ring=['red','red','blue'];let chosen:Job|undefined;
 for(let offset=0;offset<3;offset++){
 const slot=(cursor+offset)%3;const r=this.db.prepare("SELECT * FROM jobs WHERE tenant=? AND state='pending' ORDER BY seq LIMIT 1").get(ring[slot]!);
 if(r){chosen=row(r);chosen.attempts++;this.db.prepare('UPDATE jobs SET attempts=? WHERE seq=?').run(chosen.attempts,chosen.seq);this.db.prepare('UPDATE schedule SET cursor=?').run((slot+1)%3);break;}
 }
 this.db.exec('COMMIT');return chosen;
 }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 finish(j:Job,ok:boolean):void{this.db.prepare('UPDATE jobs SET state=?,result=? WHERE seq=?').run(ok?'done':j.attempts>=3?'failed':'pending',ok?j.value*2:null,j.seq);}
}
