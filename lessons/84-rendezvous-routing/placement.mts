import { createHash } from 'node:crypto';

export type Member = 'a' | 'b' | 'c';

export function scoreFor(key: string, member: Member): string {
  return createHash('sha256').update(`${key}:${member}`, 'utf8').digest('hex');
}

export function ownerFor(
  key: string,
  members: readonly Member[],
  score: typeof scoreFor = scoreFor,
): Member {
  let winner: Member | undefined;
  let highest = '';
  for (const member of members) {
    const candidate = score(key, member);
    if (winner === undefined || candidate > highest || (candidate === highest && member < winner)) {
      winner = member;
      highest = candidate;
    }
  }
  if (winner === undefined) throw new Error('Membership is empty');
  return winner;
}
