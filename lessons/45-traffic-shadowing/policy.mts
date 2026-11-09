export type Product = {id:string; price:number; currency:'VND'};
export function object(value:unknown): value is Record<string,unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function product(value:unknown, id:string):Product {
  if (!object(value) || value.id !== id || typeof value.price !== 'number' || !Number.isSafeInteger(value.price) || value.price < 0 || value.currency !== 'VND' || Object.keys(value).length !== 3) throw new Error('Invalid product');
  return {id,price:value.price,currency:'VND'};
}
export function compare(a:Product,b:Product):'matched'|'mismatched' {
  return a.id === b.id && a.price === b.price && a.currency === b.currency ? 'matched' : 'mismatched';
}
export function increment(n:number) { return Math.min(1000000,n+1); }
export class Mirrors {
  private tasks = new Set<Promise<void>>();
  private counts = {started:0,skipped:0,matched:0,mismatched:0,failed:0};
  private last: 'matched'|'mismatched'|undefined;
  start(work:()=>Promise<'matched'|'mismatched'>):void {
    if (this.tasks.size >= 2) { this.counts.skipped = increment(this.counts.skipped); return; }
    this.counts.started = increment(this.counts.started);
    const task = Promise.resolve().then(work).then(result => {
      this.counts[result] = increment(this.counts[result]); this.last = result;
    }, () => { this.counts.failed = increment(this.counts.failed); }).finally(() => { this.tasks.delete(task); });
    this.tasks.add(task);
  }
  stats() { return {active:this.tasks.size,...this.counts,...(this.last ? {last:this.last} : {})}; }
  async drain():Promise<void> { await Promise.all([...this.tasks]); }
}
