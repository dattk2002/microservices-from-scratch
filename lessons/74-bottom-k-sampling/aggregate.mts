import { HttpError, json, methodNotAllowed, numberSetting } from '../../lib/http.mts';
import { algorithm, mergeSamples, origins, snapshotValid } from './contracts.mts';
import type { Entry, SampleId, Snapshot } from './contracts.mts';
import { listen } from './runtime.mts';

async function fetchSnapshot(origin: string, id: SampleId, signal: AbortSignal, fetcher: typeof fetch): Promise<Snapshot> {
  const response=await fetcher(origin+'/snapshot',{method:'GET',redirect:'error',signal});
  if (!response.body) throw new Error('Missing upstream body');
  const reader=response.body.getReader();
  // Cancellation also interrupts a stalled body, rather than only timing headers.
  const cancel=()=>{ void reader.cancel().catch(()=>{}); };
  signal.addEventListener('abort',cancel,{once:true});
  let complete=false;
  try {
    signal.throwIfAborted();
    if (response.status !== 200 || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new Error('Unexpected upstream status or content type');
    }
    const chunks: Uint8Array[]=[];
    let size=0;
    while (true) {
      const part=await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size+=part.value.byteLength;
      if (size > 8192) throw new Error('Upstream body too large');
      chunks.push(part.value);
    }
    const value: unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!snapshotValid(value,id)) throw new Error('Invalid upstream snapshot');
    signal.throwIfAborted();
    complete=true;
    return value;
  } finally {
    signal.removeEventListener('abort',cancel);
    if (!complete) await reader.cancel().catch(()=>{});
    reader.releaseLock();
  }
}

export async function collectSamples(pair: readonly [string,string], fetcher: typeof fetch = fetch): Promise<{algorithm: typeof algorithm; sample: Entry[]}> {
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),500);
  try {
    const [a,b]=await Promise.all([
      fetchSnapshot(pair[0],'a',controller.signal,fetcher),
      fetchSnapshot(pair[1],'b',controller.signal,fetcher),
    ]);
    controller.signal.throwIfAborted();
    return {algorithm,sample:mergeSamples(a.sample,b.sample)};
  } catch { throw new HttpError(502,'upstream_failure','upstream_failure'); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function main(): Promise<void> {
  const pair=origins(process.env.SOURCE_A_ORIGIN,process.env.SOURCE_B_ORIGIN);
  const port=numberSetting('PORT',7076,0,65535);
  if (port !== 0 && pair.includes(new URL(`http://127.0.0.1:${port}`).origin)) throw new Error('Aggregate and source origins must be distinct');
  await listen('bottom4-aggregate',7076,async (req,res)=>{
    if (req.url !== '/sample') throw new HttpError(404,'not_found','not_found');
    if (req.method !== 'GET') methodNotAllowed(res,'GET');
    json(res,200,await collectSamples(pair));
  });
}
if (import.meta.main) await main();
