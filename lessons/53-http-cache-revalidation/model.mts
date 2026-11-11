export type Language = 'en'|'vi';
export type Policy = 'public,max-age=5,must-revalidate'|'private'|'no-store';
export type Document = {language:Language;version:number;text:string};
export function object(value:unknown): Record<string,unknown> {
  if(typeof value!=='object'||value===null||Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string,unknown>;
}
export function language(value:unknown):Language {
  if(value===undefined)return 'en';
  if(typeof value!=='string'||(value!=='en'&&value!=='vi'))throw new Error('Invalid language'); return value;
}
export function policy(value:unknown):Policy {
  if(typeof value!=='string'||!['public,max-age=5,must-revalidate','private','no-store'].includes(value))throw new Error('Invalid policy');
  return value as Policy;
}
export function parseDocument(value:unknown, expected:Language):Document {
  const v=object(value);
  if(v.language!==expected||typeof v.version!=='number'||!Number.isInteger(v.version)||v.version<1||v.version>8||typeof v.text!=='string'||! /^[A-Za-z0-9_-]{1,32}$/.test(v.text))throw new Error('Invalid representation');
  return {language:expected,version:v.version,text:v.text};
}
export function initialAge(request:number,response:number,date:number,age:number):number {return Math.max(0,response-date,age+Math.max(0,response-request));}
export const BODY_LIMIT=1024; // maximal escaped keys + language + 32-character text < 512 bytes; extra whitespace bounded too.
type Entry={body:Document;etag:string;policy:Policy;date:string;initial:number;received:number};
export type Result=Entry&{age:number;kind:'miss'|'hit'|'revalidated'|'bypass'};
export class Cache {
  private entries=new Map<Language,Entry>();
  private generations=new Map<Language,number>();
  private now:()=>number;
  private upstream:(language:Language,etag?:string)=>Promise<Response>;
  constructor(now:()=>number,upstream:(language:Language,etag?:string)=>Promise<Response>){this.now=now;this.upstream=upstream;}
  private age(e:Entry){return e.initial+Math.max(0,this.now()-e.received);}
  state(){return [...this.entries].sort(([a],[b])=>a.localeCompare(b)).map(([language,e])=>({language,etag:e.etag,version:e.body.version,age:Math.floor(this.age(e))}));}
  async get(lang:Language):Promise<Result>{
    const old=this.entries.get(lang);
    if(old&&this.age(old)<5)return {...old,age:Math.floor(this.age(old)),kind:'hit'};
    const generation=this.generations.get(lang)??0;
    const sent=this.now(); const response=await this.upstream(lang,old?.etag); const received=this.now();
    if(response.status!==200&&response.status!==304)throw new Error('Upstream status');
    const h=response.headers; const p=policy(h.get('cache-control'));
    if(h.get('vary')?.toLowerCase()!=='accept-language')throw new Error('Invalid Vary');
    const date=h.get('date'); const dateMs=date===null?NaN:Date.parse(date);
    if(!date||!Number.isFinite(dateMs)||new Date(dateMs).toUTCString()!==date)throw new Error('Invalid Date');
    const raw=h.get('age'); if(raw===null||! /^(0|[1-9][0-9]{0,8})$/.test(raw))throw new Error('Invalid Age');
    let body:Document;
    if(response.status===304){if(!old||h.get('etag')!==old.etag)throw new Error('Unsolicited304'); body=old.body;}
    else {
      const reader=response.body?.getReader(); if(!reader)throw new Error('Missing body');
      const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>BODY_LIMIT)throw new Error('Oversized body');chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>{});}
      body=parseDocument(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,lang);
    }
    const etag=`"${lang}-${body.version}"`; if(h.get('etag')!==etag)throw new Error('Invalid ETag');
    const entry:Entry={body,etag,policy:p,date,initial:initialAge(sent,received,dateMs/1000,Number(raw)),received};
    if((this.generations.get(lang)??0)===generation){
      this.generations.set(lang,generation+1);
      if(p==='public,max-age=5,must-revalidate')this.entries.set(lang,entry);else this.entries.delete(lang);
    }
    return {...entry,age:Math.floor(this.age(entry)),kind:p!=='public,max-age=5,must-revalidate'?'bypass':response.status===304?'revalidated':'miss'};
  }
}
