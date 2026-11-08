import { hash } from './ring.mts';
export function validKey(value: unknown): value is string {
  return typeof value==='string' && value.length>=1 && value.length<=64 && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}
export function catalogue(key: string): string { return hash(`catalogue-v1:${key}`); }
export class Cache {
  private readonly entries = new Map<string,string>();
  get(key: string): {value: string; hit: boolean} {
    if (!validKey(key)) throw new Error('Invalid key');
    const old = this.entries.get(key);
    const value = old ?? catalogue(key);
    this.entries.delete(key); this.entries.set(key,value);
    if(this.entries.size>32) {
      const oldest = this.entries.keys().next().value;
      if(oldest!==undefined) this.entries.delete(oldest);
    }
    return {value,hit:old!==undefined};
  }
}
