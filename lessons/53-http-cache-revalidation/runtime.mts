import { HttpError, readJson, json } from '../../lib/http.mts';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {object} from './model.mts';
export const bad=()=>new HttpError(400,'invalid_input','Invalid input');
export async function input(req:IncomingMessage){try{return object(await readJson(req));}catch{throw bad();}}
export function clock(){
  const controls=process.env.TEACHING_CONTROLS==='1';const raw=process.env.TEACHING_EPOCH_SECONDS;
  if(raw!==undefined&&(!controls||! /^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)>253402300499))throw new Error('Invalid teaching epoch');
  let offset=0;
  return {controls,now:()=> (raw===undefined?Math.floor(Date.now()/1000):Number(raw))+offset,
    async route(req:IncomingMessage,res:ServerResponse){
      if(req.url!=='/teaching/advance'||!controls)return false;
      if(req.method!=='POST')throw bad();const v=await input(req);
      if(typeof v.seconds!=='number'||!Number.isInteger(v.seconds)||v.seconds<1||v.seconds>60||offset+v.seconds>300)throw bad();
      offset+=v.seconds;json(res,200,{offset});return true;
    }};
}
export function send(res:ServerResponse,status:number,body:unknown,headers:Record<string,string>){res.writeHead(status,{'content-type':'application/json',...headers});res.end(status===304?undefined:JSON.stringify(body));}
