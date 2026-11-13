import { createHash } from 'node:crypto';

// Independent byte construction; production hash helpers are never used by this oracle.
export type Cell = null | string;
export const keys = Array.from({length:8}, (_, i) => `k${i}`);
export function digest(bytes:Buffer):string { return createHash('sha256').update(bytes).digest('hex'); }
export function oracle(values:Cell[]) {
  const hashes = new Map<string,string>();
  values.forEach((value,i) => hashes.set(i.toString(2).padStart(3,'0'), digest(Buffer.concat([
    Buffer.from([0]), Buffer.from(JSON.stringify([`k${i}`,value])),
  ]))));
  for(let depth=2;depth>=0;depth--) {
    for(let i=0;i<2**depth;i++) {
      const path=depth===0?'':i.toString(2).padStart(depth,'0');
      hashes.set(path,digest(Buffer.concat([Buffer.from([1]),Buffer.from(hashes.get(path+'0')!,'hex'),Buffer.from(hashes.get(path+'1')!,'hex')])));
    }
  }
  return hashes;
}
export class Pair {
  source:Cell[]=Array<Cell>(8).fill(null);
  target:Cell[]=Array<Cell>(8).fill(null);
  sourceRevision=0;
  targetRevision=0;
  calls:{side:string,path:string,method:string,body:unknown}[]=[];
  hook:((side:string,url:URL,body:unknown)=>Response|undefined|Promise<Response|undefined>)|undefined;
  fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));
    const side=url.port==='10001'?'source':'target';
    const body:unknown=typeof init?.body==='string'?JSON.parse(init.body):undefined;
    this.calls.push({side,path:url.pathname+url.search,method:init?.method??'GET',body});
    const altered=await this.hook?.(side,url,body);
    if(altered) return altered;
    return this.respond(side,url,body);
  };
  respond(side:string,url:URL,body:unknown):Response {
    const values=side==='source'?this.source:this.target;
    const revision=side==='source'?this.sourceRevision:this.targetRevision;
    const hashes=oracle(values);
    if(url.pathname==='/root') return Response.json({revision,hash:hashes.get('')});
    if(url.pathname==='/apply') {
      if(typeof body!=='object'||body===null||!('expectedRevision' in body)||!('records' in body)) throw new Error('Bad test request');
      if(body.expectedRevision!==revision) return semantic(409);
      if(!Array.isArray(body.records)) throw new Error('Bad test patch');
      let changed=false;
      for(const record of body.records) {
        if(typeof record!=='object'||record===null||!('key' in record)||!('value' in record)||typeof record.key!=='string'||!(record.value===null||typeof record.value==='string')) throw new Error('Bad test record');
        const index=keys.indexOf(record.key);
        if(values[index]!==record.value) changed=true;
        values[index]=record.value;
      }
      if(changed) this.targetRevision++;
      return Response.json({revision:this.targetRevision});
    }
    if(url.searchParams.get('revision')!==String(revision)) return semantic(409);
    if(url.pathname==='/node') {
      const path=url.searchParams.get('path')??'';
      return Response.json({revision,path,hash:hashes.get(path),children:path.length===3?null:{left:hashes.get(path+'0'),right:hashes.get(path+'1')}});
    }
    if(url.pathname==='/record') {
      const key=url.searchParams.get('key')??'';
      const index=keys.indexOf(key);
      return Response.json({revision,key,value:values[index],hash:hashes.get(index.toString(2).padStart(3,'0'))});
    }
    throw new Error('Unexpected test URL');
  }
}
export function semantic(status:409|429):Response {
  return Response.json({error:status===409?{code:'revision_changed',message:'Revision changed'}:{code:'revision_limit',message:'Revision limit reached'}},{status});
}
export const source='http://127.0.0.1:10001';
export const target='http://127.0.0.1:10002';

// Escape decoded JSON STRING tokens, leaving null/boolean/number syntax intact.
export function escaped(data:unknown):string {
  return JSON.stringify(data).replace(/"(?:\\.|[^"\\])*"/g,token=>{
    const decoded:unknown=JSON.parse(token);
    if(typeof decoded!=='string') throw new Error('Expected string token');
    return '"'+[...decoded].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')+'"';
  });
}
