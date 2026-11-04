import { serve, json, numberSetting } from '../../lib/http.mts';
import { context, childContext, encode, beginSpan, bindCompletion, type Operation, type SpanRecord } from './tracing.mts';

export async function start(operation:Operation) {
  // Configuration and all mutable state belong to this running instance.
  const deadline = numberSetting('DEADLINE_MS',1000,20,10000);
  const controls = process.env.TEACHING_CONTROLS === '1';
  const downstream = operation === 'catalog' ? undefined : new URL(process.env.DOWNSTREAM_URL ?? (operation === 'gateway' ? 'http://127.0.0.1:3023' : 'http://127.0.0.1:3024'));
  if (downstream && (downstream.protocol !== 'http:' || downstream.hostname !== '127.0.0.1' || downstream.username || downstream.password || downstream.search || downstream.hash || downstream.pathname !== '/')) throw new Error('Expected loopback HTTP origin');
  const records: SpanRecord[] = [];
  const waiters = new Set<(fail:boolean)=>void>();
  let arrivals = 0;
  return serve(operation,operation === 'gateway' ? 3022 : operation === 'orders' ? 3023 : 3024, async (req,res) => {
    const path = req.url?.split('?')[0];
    if (controls && req.method === 'GET' && path === '/observe') {
      json(res,200,{records,active:waiters.size,arrivals}); return;
    }
    if (controls && req.method === 'POST' && (path === '/release' || path === '/fail')) {
      for (const release of [...waiters]) release(path === '/fail');
      json(res,200,{released:true}); return;
    }
    const ctx = childContext(typeof req.headers.traceparent === 'string' ? req.headers.traceparent : undefined);
    await context.run(ctx,async () => {
      const span = beginSpan(operation,ctx,r => { if (records.length === 128) records.shift(); records.push(r); });
      bindCompletion(res,span,() => res.statusCode);
      const controller = new AbortController();
      let expired = false;
      const timer = setTimeout(() => { expired = true; controller.abort(); },deadline);
      const disconnect = () => { if (!res.writableFinished) controller.abort(); };
      res.once('close',disconnect);
      res.setHeader('traceparent',encode(ctx));
      try {
        if (req.method !== 'GET' || path !== '/order') { json(res,404,{error:'route_not_found'}); return; }
        if (operation === 'catalog') {
          if (controls && req.headers['x-teaching-hold'] === '1') {
            arrivals++;
            await new Promise<void>((resolve,reject) => {
              const abort = () => { cleanup(); reject(new Error('cancelled')); };
              const release = (fail:boolean) => { cleanup(); fail ? reject(new Error('dependency_failed')) : resolve(); };
              const cleanup = () => { waiters.delete(release); controller.signal.removeEventListener('abort',abort); };
              waiters.add(release); controller.signal.addEventListener('abort',abort,{once:true});
              if (controller.signal.aborted) abort();
            });
          }
          if (!res.destroyed) json(res,200,{sku:'book',available:true});
        } else {
          const active = context.getStore();
          if (!active || !downstream) throw new Error('Missing context');
          const response = await fetch(new URL('/order',downstream),{
            headers:{traceparent:encode(active), ...(controls && req.headers['x-teaching-hold'] === '1' ? {'x-teaching-hold':'1'} : {})},
            signal:controller.signal,
          });
          // Consume under the same deadline; never copy dependency bodies or headers into spans.
          await response.arrayBuffer();
          if (!res.destroyed) json(res,response.ok ? 200 : 502,response.ok ? {order:'ready'} : {error:'dependency_failed'});
        }
      } catch {
        if (!res.destroyed) json(res,expired ? 504 : 502,{error:expired ? 'deadline_exceeded' : 'dependency_failed'});
      } finally {
        clearTimeout(timer); res.off('close',disconnect);
      }
    });
  });
}
