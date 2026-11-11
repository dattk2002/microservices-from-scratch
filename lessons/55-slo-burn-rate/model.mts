import { DatabaseSync } from 'node:sqlite';
export type Bucket = {slot:number;total:number;bad:number};
export function object(value:unknown): Record<string,unknown> {
  if(typeof value!=='object'||value===null||Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string,unknown>;
}
function integer(value:unknown,min:number,max:number):number {
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max) throw new Error('Invalid integer');
  return value;
}
export function parseBucket(value:unknown):Bucket {
  const b=object(value);
  if(Object.keys(b).sort().join(',')!=='bad,slot,total') throw new Error('Invalid fields');
  const slot=integer(b.slot,0,11), total=integer(b.total,0,1000), bad=integer(b.bad,0,total);
  return {slot,total,bad};
}
export function parseEnd(value:unknown):number {
  const b=object(value);
  if(Object.keys(b).join(',')!=='end') throw new Error('Invalid fields');
  return integer(b.end,6,12);
}
export function parseSnapshot(value:unknown):Bucket[] {
  const snapshot=object(value);
  if(Object.keys(snapshot).join(',')!=='buckets'||!Array.isArray(snapshot.buckets)||snapshot.buckets.length>12) throw new Error('Invalid snapshot');
  const buckets=snapshot.buckets.map(parseBucket);
  let previous=-1;
  for(const b of buckets) {if(b.slot<=previous) throw new Error('Unsorted or duplicate'); previous=b.slot;}
  return buckets;
}
export function windowResult(buckets:Bucket[],end:number,w:number) {
  const selected=buckets.filter(b=>b.slot>=end-w&&b.slot<end);
  const total=selected.reduce((s,b)=>s+b.total,0), bad=selected.reduce((s,b)=>s+b.bad,0);
  const readiness=selected.length!==w?'missing':total===0?'no_traffic':total<100?'low_traffic':'ready';
  return {start:end-w,end,total,bad,readiness,burnMilli:readiness==='ready'?Math.floor(100000*bad/total):null};
}
export function evaluate(buckets:Bucket[],end:number) {
  const pair=(shortSize:number,longSize:number,threshold:number)=>{
    const short=windowResult(buckets,end,shortSize),long=windowResult(buckets,end,longSize);
    return {threshold,short,long,firing:[short,long].every(w=>w.readiness==='ready'&&100*w.bad>=threshold*w.total)};
  };
  const fast=pair(1,3,6),slow=pair(2,6,3);
  const decision=fast.firing||slow.firing?'alert':[fast.short,fast.long,slow.short,slow.long].every(w=>w.readiness==='ready')?'ok':'insufficient_data';
  return {end,sloBasisPoints:9900,fast,slow,decision};
}
export class Store {
  readonly db:DatabaseSync;
  constructor(path:string) {
    this.db=new DatabaseSync(path);
    try {this.db.exec('CREATE TABLE IF NOT EXISTS buckets(slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 0 AND 11), total INTEGER NOT NULL CHECK(total BETWEEN 0 AND 1000), bad INTEGER NOT NULL CHECK(bad BETWEEN 0 AND total))');}
    catch(error) {this.db.close();throw error;}
  }
  put(input:Bucket):number {
    const b=parseBucket(input);
    const old=this.db.prepare('SELECT slot,total,bad FROM buckets WHERE slot=?').get(b.slot);
    if(old) return old.total===b.total&&old.bad===b.bad?200:409;
    this.db.prepare('INSERT INTO buckets VALUES(?,?,?)').run(b.slot,b.total,b.bad);
    return 201;
  }
  all():Bucket[] {return this.db.prepare('SELECT slot,total,bad FROM buckets ORDER BY slot').all().map(parseBucket);}
}
