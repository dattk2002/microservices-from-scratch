import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, json } from '../../lib/http.mts';

export function safe(handler: (req: IncomingMessage, res: ServerResponse)=>Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void>=>{
    try { await handler(req,res); }
    catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const code=error instanceof HttpError ? error.code : 'internal_error';
      res.setHeader('connection','close');
      json(res,error instanceof HttpError ? error.status : 500,{error:{code,message:code}});
    }
  };
}
export function method(req: IncomingMessage, res: ServerResponse, allowed: string): void {
  if (req.method === allowed) return;
  res.setHeader('allow',allowed);
  throw new HttpError(405,'method_not_allowed','method_not_allowed');
}
