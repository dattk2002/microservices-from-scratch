import { HttpError } from '../../lib/http.mts';

export type Shard = 'a'|'b';
export type Item = {id:string,score:number};
export type Query = {k:number,a:number,b:number};
export type Origins = {a:string,b:string};
export function fail(status:number,code:string):never {throw new HttpError(status,code,code);}
export function invalid():never {return fail(400,'invalid_request');}
export function upstreamFailure():never {return fail(502,'upstream_failure');}
export function exact(v:unknown,keys:readonly string[]):v is Record<string,unknown> {
  return typeof v==='object'&&v!==null&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
}
export function integer(v:unknown,min:number,max:number):v is number {
  return typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=max;
}
export function owned(id:unknown,shard:Shard):id is string {
  return typeof id==='string'&&new RegExp(`^${shard}[0-7]$`).test(id);
}
export function compare(x:Item,y:Item):number {
  return y.score-x.score||(x.id<y.id?-1:x.id>y.id?1:0);
}
export function mergeTop(a:readonly Item[],b:readonly Item[],k:number):Item[] {
  return [...a,...b].sort(compare).slice(0,k);
}
export function itemList(v:unknown,shard:Shard,max:number,ordered:boolean):v is Item[] {
  if(!Array.isArray(v)||v.length>max) return false;
  const ids=new Set<string>();let previous:Item|undefined;
  for(const x of v) {
    if(!exact(x,['id','score'])||!owned(x.id,shard)||!integer(x.score,0,100)||ids.has(x.id)) return false;
    const item={id:x.id,score:x.score};
    if(ordered&&previous&&compare(previous,item)>=0) return false;
    ids.add(item.id);previous=item;
  }
  return true;
}
export function validateReply(v:unknown,shard:Shard,revision:number,k:number):Item[] {
  if(!exact(v,['shard','revision','items'])||v.shard!==shard||!integer(v.revision,0,16)||v.revision!==revision||!itemList(v.items,shard,k,true)) upstreamFailure();
  return v.items;
}
export function decimal(raw:string|undefined,min:number,max:number):number {
  if(raw===undefined||!/^(?:0|[1-9][0-9]*)$/.test(raw)) invalid();
  const n=Number(raw);if(!integer(n,min,max)) invalid();return n;
}
export function parameters(p:URLSearchParams,keys:readonly string[]):void {
  if([...p].length!==keys.length||!keys.every(k=>p.has(k))) invalid();
}
export function parseQuery(p:URLSearchParams):Query {
  parameters(p,['k','a','b']);
  return {k:decimal(p.get('k')??undefined,1,8),a:decimal(p.get('a')??undefined,0,16),b:decimal(p.get('b')??undefined,0,16)};
}
function origin(raw:string):string {
  const u=new URL(raw);
  if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||u.port==='0') throw new Error('Expected a loopback HTTP origin');
  return u.origin;
}
export function origins(a:string,b:string):Origins {
  const result={a:origin(a),b:origin(b)};
  if(result.a===result.b) throw new Error('Shard origins must be distinct');return result;
}
export function validateHost(host:unknown):void {
  if(host!==undefined&&host!=='127.0.0.1') throw new Error('HOST must be 127.0.0.1');
}

export function privateDatabaseFile(raw: string | undefined): string {
  if (!raw || raw === ':memory:') throw new Error('Private DB_PATH file required');
  return raw;
}
export function listenerIsUpstream(config: Origins, port: number): boolean {
  return port !== 0 && Object.values(config).includes(new URL(`http://127.0.0.1:${port}`).origin);
}
