import { createHash } from 'node:crypto';
export type Member = 'a' | 'b' | 'c';
export type Token = {point: string; member: Member; index: number};
export function members(value: unknown): Member[] {
  if (!Array.isArray(value) || value.length<1 || value.length>3) throw new Error('Invalid members');
  const result: Member[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || (item !== 'a' && item !== 'b' && item !== 'c') || result.includes(item)) throw new Error('Invalid member');
    result.push(item);
  }
  return result.sort();
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function tokens(input: readonly Member[]): Token[] {
  return members(input).flatMap(member=>Array.from({length:16},(_,index)=>({point:hash(`${member}:${index}`),member,index})));
}
export function clockwise(point: string, input: readonly Token[]): Member {
  const sorted = [...input].sort((a,b)=>a.point<b.point?-1:a.point>b.point?1:a.member<b.member?-1:a.member>b.member?1:a.index-b.index);
  const token = sorted.find(t=>t.point>=point) ?? sorted[0];
  if (!token) throw new Error('Empty ring');
  return token.member;
}
export function owner(key: string, input: readonly Member[]): Member { return clockwise(hash(key),tokens(input)); }
