import { HttpError } from '../../lib/http.mts';
export class Permit {
 active=false;
 async run<T>(work:()=>Promise<T>):Promise<T>{
 if(this.active)throw new HttpError(409,'busy','Execution busy');
 this.active=true;try{return await work();}finally{this.active=false;}
 }
}
