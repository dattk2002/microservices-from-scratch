export function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value==='object' && value!==null && !Array.isArray(value) && Object.keys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));
}
function bounded(value: unknown, max: number): value is number {
  return typeof value==='number' && Number.isInteger(value) && value>=1 && value<=max;
}
export class Tracker {
  private last: {incarnation:number;sequence:number;receivedAt:number}|null=null;
  private intervals: number[]=[];
  accept(value: unknown, now: number): void {
    if(!object(value,['incarnation','sequence']) || !bounded(value.incarnation,8) || !bounded(value.sequence,32)) throw new Error('Invalid heartbeat');
    const {incarnation,sequence}=value;
    if(this.last) {
      if(incarnation<this.last.incarnation || (incarnation===this.last.incarnation && sequence<this.last.sequence)) throw new Error('Stale heartbeat');
      if(incarnation===this.last.incarnation && sequence===this.last.sequence) return;
      if(incarnation>this.last.incarnation) this.intervals=[];
      else if(now>this.last.receivedAt) this.intervals=[...this.intervals,now-this.last.receivedAt].slice(-4);
    }
    this.last={incarnation,sequence,receivedAt:now};
  }
  state(now: number) {
    const last=this.last ? {...this.last}:null;
    const intervals=[...this.intervals];
    if(!last) return {status:'unknown',phiMilli:null,intervals,last};
    if(intervals.length<3) return {status:'warming',phiMilli:null,intervals,last};
    const numerator=Math.max(0,now-last.receivedAt)*intervals.length;
    const denominator=intervals.reduce((a,b)=>a+b,0)*Math.LN10;
    return {status:numerator>=2*denominator?'suspect':'healthy',phiMilli:Math.floor(1000*numerator/denominator),intervals,last};
  }
}
