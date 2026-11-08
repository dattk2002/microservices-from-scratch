import { hash, owner } from './ring.mts';
import type { Member } from './ring.mts';
function modulo(key: string, members: readonly Member[]): Member {
  const member = members[Number.parseInt(hash(key).slice(0,8),16)%members.length];
  if(!member) throw new Error('Empty members');
  return member;
}
export function movement() {
  const before: Member[] = ['a','b']; const added: Member[] = ['a','b','c']; const removed: Member[] = ['a','c'];
  let ringAdd=0; let ringRemove=0; let moduloAdd=0; let moduloRemove=0;
  for(let i=0;i<512;i++) {
    const key=`catalogue-${i}`;
    if(owner(key,before)!==owner(key,added)) ringAdd++;
    if(owner(key,added)!==owner(key,removed)) ringRemove++;
    if(modulo(key,before)!==modulo(key,added)) moduloAdd++;
    if(modulo(key,added)!==modulo(key,removed)) moduloRemove++;
  }
  return {sample:512,ringAdd,ringRemove,moduloAdd,moduloRemove};
}
if(import.meta.main) console.log(JSON.stringify(movement()));
