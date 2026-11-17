export type Event = {id: string; key: 'a' | 'b'; time: number; value: number};
export type Session = {key: 'a' | 'b'; start: number; end: number; count: number; sum: number; final: boolean};
export type State = {watermark: number; sessions: Session[]};

export function sessions(events: readonly Event[], watermark: number): Session[] {
  const result: Session[]=[];
  const ordered=events.toSorted((a,b)=>a.key.localeCompare(b.key) || a.time-b.time || (a.id<b.id ? -1 : a.id>b.id ? 1 : 0));
  for (const event of ordered) {
    const previous=result.at(-1);
    if (previous && previous.key === event.key && event.time-previous.end <= 3) {
      previous.end=event.time; previous.count++; previous.sum+=event.value;
    } else result.push({key:event.key,start:event.time,end:event.time,count:1,sum:event.value,final:false});
  }
  for (const session of result) session.final=watermark >= session.end+3;
  return result;
}
