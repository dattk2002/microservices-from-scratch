import {serve, json, readJson, numberSetting} from '../../lib/http.mts';
import {performance} from 'node:perf_hooks';
import {Snapshot, record, integer} from './policy.mts';
import {origin, upstream, badInput} from './transport.mts';
export async function main() {
  const control = origin('CONTROL_ORIGIN'), stable = origin('STABLE_ORIGIN'), canary = origin('CANARY_ORIGIN');
  let offset = 0;
  const cache = new Snapshot(numberSetting('TTL_MS',10000,1,60000), () => performance.now()+offset);
  await serve('flag-gateway',4042,async(req,res) => {
    if ((req.url?.length ?? 0) > 512 || (req.headers.authorization?.length ?? 0) > 256) { json(res,400,{error:'bounded_request'}); return; }
    if (req.method === 'POST' && req.url === '/refresh') {
      try { const config = cache.accept(await upstream(`${control}/config`)); json(res,200,{version:config.version}); }
      catch { json(res,502,{error:'refresh_failed'}); } return;
    }
    if (req.method === 'POST' && req.url === '/teaching/advance' && process.env.TEACHING_CONTROLS === '1') {
      try { const b = record(await readJson(req)); offset += integer(b.ms,0,60000); json(res,200,{advanced:b.ms}); } catch { badInput(); } return;
    }
    const url = new URL(req.url ?? '/', 'http://gateway');
    if (req.method === 'GET' && url.pathname === '/hello') {
      const subject = url.searchParams.get('subject');
      if (!subject || !/^[A-Za-z0-9_-]{1,64}$/.test(subject) || url.searchParams.size !== 1) badInput();
      const decision = cache.choose(subject);
      try {
        const reply = record(await upstream(`${decision.variant === 'canary' ? canary : stable}/hello`));
        if (Object.keys(reply).length !== 1 || reply.variant !== decision.variant) throw new Error('invalid backend');
        json(res,200,{...decision, backend:reply.variant});
      } catch { json(res,502,{error:'backend_failed',...decision}); } return;
    }
    json(res,404,{error:'not_found'});
  });
}
if (import.meta.main) await main();
