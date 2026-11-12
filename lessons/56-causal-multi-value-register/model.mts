import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Actor='a'|'b';
export type Context={a:number;b:number};
export type Sibling={dot:{actor:Actor;counter:number};value:string|null};
export type State={context:Context;siblings:Sibling[]};
export function fail(status=400):never {throw new HttpError(status,'register_error','Invalid or conflicting register operation');}
function record(x:unknown):x is Record<string,unknown> {return typeof x==='object'&&x!==null&&!Array.isArray(x);}
export function object(x:unknown,keys:string[]):Record<string,unknown> {
 if(!record(x)||Object.keys(x).length!==keys.length||!keys.every(k=>Object.hasOwn(x,k))) return fail();
 return x;
}
export function actor(x:unknown):Actor {if(x!=='a'&&x!=='b') return fail();return x;}
function integer(x:unknown):number {if(typeof x!=='number'||!Number.isInteger(x)||x<0||x>16)return fail();return x;}
function context(x:unknown):Context {const o=object(x,['a','b']);return {a:integer(o.a),b:integer(o.b)};}
function value(x:unknown):string|null {if(x===null)return null;if(typeof x!=='string'||! /^[A-Za-z0-9_-]{1,32}$/.test(x))return fail();return x;}
export function validateState(x:unknown):State {
 const o=object(x,['context','siblings']),c=context(o.context);
 if(!Array.isArray(o.siblings)||o.siblings.length>2)return fail();
 const siblings:Sibling[]=o.siblings.map((s:unknown)=>{const v=object(s,['dot','value']),d=object(v.dot,['actor','counter']);const a=actor(d.actor),n=integer(d.counter);if(n===0||n!==c[a])return fail();return {dot:{actor:a,counter:n},value:value(v.value)};});
 if(siblings.length===2&&siblings[0]!.dot.actor>=siblings[1]!.dot.actor)return fail();
 if((siblings.length===0)!==(c.a===0&&c.b===0))return fail();
 return {context:c,siblings};
}
export function merge(left:unknown,right:unknown):State {
 const a=validateState(left),b=validateState(right),siblings:Sibling[]=[];
 for(const who of ['a','b'] as const) {
 const x=a.siblings.find(s=>s.dot.actor===who),y=b.siblings.find(s=>s.dot.actor===who);
 if(x&&y&&x.dot.counter===y.dot.counter){if(x.value!==y.value)return fail(409);siblings.push(x);}
 else {if(x&&x.dot.counter>b.context[who])siblings.push(x);if(y&&y.dot.counter>a.context[who])siblings.push(y);}
 }
 try{return validateState({context:{a:Math.max(a.context.a,b.context.a),b:Math.max(a.context.b,b.context.b)},siblings});}catch{return fail(409);}
}
export class Store {
 readonly db:DatabaseSync;
 readonly identity:Actor;
 constructor(path:string,id:Actor) {
 this.identity=actor(id);this.db=new DatabaseSync(path);
 try {
 this.db.exec('CREATE TABLE IF NOT EXISTS register (id INTEGER PRIMARY KEY CHECK(id=1), actor TEXT NOT NULL, state TEXT NOT NULL)');
 const row=this.db.prepare('SELECT actor FROM register WHERE id=1').get();
 if(row&&row.actor!==id)throw new Error('Database belongs to another replica');
 if(!row)this.db.prepare('INSERT INTO register VALUES (1,?,?)').run(id,JSON.stringify({context:{a:0,b:0},siblings:[]}));
 this.read();
 }catch(e){this.db.close();throw e;}
 }
 read():State {const row=this.db.prepare('SELECT state FROM register WHERE id=1').get();if(typeof row?.state!=='string')throw new Error('Corrupt database');return validateState(JSON.parse(row.state));}
 private transaction(change:(s:State)=>State):State {
 this.db.exec('BEGIN IMMEDIATE');
 try {const next=change(this.read());this.db.prepare('UPDATE register SET state=? WHERE id=1').run(JSON.stringify(next));this.db.exec('COMMIT');return next;}catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 write(input:unknown):State {
 const o=object(input,['context','value']),c=context(o.context),v=value(o.value);
 return this.transaction(s=>{if(c.a!==s.context.a||c.b!==s.context.b)return fail(409);if(c[this.identity]===16)return fail(429);const next={...c,[this.identity]:c[this.identity]+1};return validateState({context:next,siblings:[{dot:{actor:this.identity,counter:next[this.identity]},value:v}]});});
 }
 merge(input:unknown):State {const incoming=validateState(input);return this.transaction(s=>merge(s,incoming));}
 close(){this.db.close();}
}
