import { createHash } from 'node:crypto';
export type Entry = {id: string; priority: string};
export type SampleId = 'a' | 'b';
export type Snapshot = {id: SampleId; algorithm: typeof algorithm; sample: Entry[]};
export const algorithm = 'bottom4-sha256-v1';
export function priority(id: string): string {
  return createHash('sha256').update(id,'utf8').digest('hex');
}
export function compareEntries(left: Entry, right: Entry): number {
  const a=left.priority, b=right.priority;
  return a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
export function bottom4(ids: readonly string[]): Entry[] {
  return [...new Set(ids)].map(id=>({id,priority:priority(id)})).sort(compareEntries).slice(0,4);
}
export function mergeSamples(...samples: readonly Entry[][]): Entry[] {
  return bottom4(samples.flatMap(sample=>sample.map(row=>row.id)));
}
export function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key=>Object.hasOwn(value,key));
}
export function eventValid(value: unknown): value is {id: string} {
  return exact(value,['id']) && typeof value.id === 'string' && /^[a-z0-9]{1,16}$/.test(value.id);
}
export function sampleValid(value: unknown): value is Entry[] {
  if (!Array.isArray(value) || value.length > 4) return false;
  const rows: readonly unknown[]=value;
  const entries: Entry[]=[];
  const seen=new Set<string>();
  for (const row of rows) {
    if (!exact(row,['id','priority']) || !eventValid({id:row.id}) || typeof row.id !== 'string'
      || typeof row.priority !== 'string' || !/^[a-f0-9]{64}$/.test(row.priority) || priority(row.id) !== row.priority
      || seen.has(row.id)) return false;
    const entry={id:row.id,priority:row.priority};
    const previous=entries.at(-1);
    if (previous && compareEntries(previous,entry) >= 0) return false;
    entries.push(entry); seen.add(row.id);
  }
  return true;
}
export function snapshotValid(value: unknown, id: SampleId): value is Snapshot {
  return exact(value,['id','algorithm','sample']) && value.id === id && value.algorithm === algorithm && sampleValid(value.sample);
}
function origin(raw: string | undefined): string {
  if (!raw) throw new Error('Source origin required');
  const url=new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '0' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Source must be a loopback HTTP origin');
  return url.origin;
}
export function origins(a: string | undefined, b: string | undefined): [string,string] {
  const pair: [string,string]=[origin(a),origin(b)];
  if (pair[0] === pair[1]) throw new Error('Source origins must be distinct');
  return pair;
}
