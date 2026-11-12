import { HttpError } from '../../lib/http.mts';
export function object(value:unknown, keys:string[]): Record<string,unknown> {
  if(typeof value!=='object'||value===null||Array.isArray(value)||Object.keys(value).length!==keys.length||!keys.every(k=>Object.hasOwn(value,k))) throw new HttpError(400,'invalid_body','Invalid body');
  return Object.fromEntries(Object.entries(value));
}
export function idBody(value:unknown):string {
  const {id}=object(value,['id']);
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,16}$/.test(id))throw new HttpError(400,'invalid_body','Invalid body');
  return id;
}
export function lookup(id:string):number|undefined {
  return /^[a-h]$/.test(id)?(id.charCodeAt(0)-96)*10:undefined;
}
export function validReply(value:unknown,id:string,status:number):boolean {
  try {
    if(status===200){const body=object(value,['id','value']);return body.id===id&&lookup(id)!==undefined&&body.value===lookup(id);}
    if(status===404||status===503){const body=object(value,['error']);const error=object(body.error,['code','message']);return status===404?error.code==='not_found'&&error.message==='Unknown id':error.code==='unavailable'&&error.message==='Worker unavailable';}
  }catch{return false;}
  return false;
}
export function origin(raw:string|undefined):string {
  if(!raw)throw new Error('WORKER_ORIGIN required');
  const url=new URL(raw);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Invalid WORKER_ORIGIN');
  return url.origin;
}
