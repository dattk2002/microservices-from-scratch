import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from '../../lib/http.mts';
export type Actor = 'a' | 'b';
export type Element = 'red' | 'green' | 'blue';
export type Tag = {actor: Actor; seq: number};
export type Add = Tag & {element: Element};
export type Snapshot = {adds: Add[]; removed: Tag[]};
export function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value,k));
}
export function actor(value: unknown): value is Actor { return value === 'a' || value === 'b'; }
export function element(value: unknown): value is Element { return value === 'red' || value === 'green' || value === 'blue'; }
function bad(): never { throw new HttpError(400,'invalid_body','Invalid request body'); }
export function elementBody(value: unknown): Element {
  if (!object(value,['element']) || !element(value.element)) bad();
  return value.element;
}
const key = (tag: Tag) => `${tag.actor}${tag.seq}`;
const compare = (a: Tag,b: Tag) => a.actor.localeCompare(b.actor) || a.seq-b.seq;
export function parseSnapshot(value: unknown): Snapshot {
  if (!object(value,['adds','removed']) || !Array.isArray(value.adds) || !Array.isArray(value.removed) || value.adds.length>16 || value.removed.length>16) bad();
  const adds: Add[] = []; const removed: Tag[] = []; const highest = {a:0,b:0};
  for (const row of value.adds) {
    if (!object(row,['actor','seq','element']) || !actor(row.actor) || typeof row.seq!=='number' || !Number.isInteger(row.seq) || row.seq<1 || row.seq>8 || !element(row.element)) bad();
    const add = {actor:row.actor,seq:row.seq,element:row.element};
    if (row.seq !== highest[row.actor]+1 || (adds.length>0 && compare(adds[adds.length-1]!,add)>=0)) bad();
    highest[row.actor] = row.seq; adds.push(add);
  }
  const known = new Set(adds.map(key));
  for (const row of value.removed) {
    if (!object(row,['actor','seq']) || !actor(row.actor) || typeof row.seq!=='number' || !Number.isInteger(row.seq)) bad();
    const tag = {actor:row.actor,seq:row.seq};
    if (!known.has(key(tag)) || (removed.length>0 && compare(removed[removed.length-1]!,tag)>=0)) bad();
    removed.push(tag);
  }
  return {adds,removed};
}
export class Store {
  readonly db: DatabaseSync; readonly actor: Actor;
  constructor(db: DatabaseSync, id: Actor) {
    this.db=db; this.actor=id;
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS identity(actor TEXT NOT NULL); CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), snapshot TEXT NOT NULL)');
    db.exec('BEGIN IMMEDIATE');
    try {
      const stored = db.prepare('SELECT actor FROM identity').get();
      if (stored && stored.actor!==id) throw new Error('Replica identity mismatch');
      if (!stored) db.prepare('INSERT INTO identity VALUES (?)').run(id);
      db.prepare('INSERT OR IGNORE INTO state VALUES (1, ?)').run('{"adds":[],"removed":[]}');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  snapshot(): Snapshot {
    const row=this.db.prepare('SELECT snapshot FROM state WHERE id=1').get();
    if (!row || typeof row.snapshot!=='string') throw new Error('Missing state');
    return parseSnapshot(JSON.parse(row.snapshot));
  }
  private change(update: (s: Snapshot) => Snapshot): Snapshot {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const next=update(this.snapshot());
      this.db.prepare('UPDATE state SET snapshot=? WHERE id=1').run(JSON.stringify(next));
      this.db.exec('COMMIT'); return next;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  add(value: Element): Snapshot {
    return this.change(s => {
      const seq=s.adds.filter(t=>t.actor===this.actor).length+1;
      if (seq>8) throw new HttpError(429,'exhausted','Actor add history exhausted');
      s.adds.push({actor:this.actor,seq,element:value}); s.adds.sort(compare); return s;
    });
  }
  remove(value: Element): Snapshot {
    return this.change(s=> {
      const removed=new Map(s.removed.map(t=>[key(t),t]));
      for (const tag of s.adds) if (tag.element===value) removed.set(key(tag),{actor:tag.actor,seq:tag.seq});
      s.removed=[...removed.values()].sort(compare); return s;
    });
  }
  merge(value: unknown): Snapshot {
    const incoming=parseSnapshot(value);
    return this.change(s=> {
      const adds=new Map(s.adds.map(t=>[key(t),t]));
      for (const tag of incoming.adds) {
        const old=adds.get(key(tag));
        if (old && old.element!==tag.element) throw new HttpError(409,'conflicting_tag','Tag already names another element');
        adds.set(key(tag),tag);
      }
      const removed=new Map([...s.removed,...incoming.removed].map(t=>[key(t),t]));
      return {adds:[...adds.values()].sort(compare),removed:[...removed.values()].sort(compare)};
    });
  }
  values(): Element[] {
    const s=this.snapshot(); const removed=new Set(s.removed.map(key));
    return [...new Set(s.adds.filter(t=>!removed.has(key(t))).map(t=>t.element))].sort();
  }
}
