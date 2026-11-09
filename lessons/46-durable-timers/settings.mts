import { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
import { record } from './store.mts';
export function controls():boolean {
  const raw=process.env.TEACHING_CONTROLS;
  if(raw!==undefined&&raw!=='1')throw new Error('TEACHING_CONTROLS must be absent or 1');
  return raw==='1';
}
export function empty(value:unknown):void {
  if(Object.keys(record(value)).length!==0)throw new HttpError(400,'invalid_body','Expected empty object');
}
export function originSetting():string {
  const raw=process.env.RECEIVER_ORIGIN;if(!raw)throw new Error('RECEIVER_ORIGIN is required');
  const url=new URL(raw);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Expected receiver origin only');
  return url.origin;
}
export function openDatabase():DatabaseSync {
  const path=process.env.DB_PATH;if(!path)throw new Error('Independent DB_PATH is required');
  return new DatabaseSync(path);
}
