export const BIN_COUNT = 11;
export const ALGORITHM = 'log2-harmonic-v1';

type Quantile = { total: number; rank: number | null; bin: number | null; estimate: number | null };

// For a validated positive integer in [1, 1024], the highest set bit is floor(log2(value)).
export function binIndex(value: number): number {
  return 31 - Math.clz32(value);
}

export function mergeBins(a: readonly number[], b: readonly number[]): number[] {
  return a.map((count, bin) => {
    const other = b[bin];
    if (other === undefined) throw new Error('Missing bin');
    return count + other;
  });
}

export function quantile(a: readonly number[], b: readonly number[], p: number): Quantile {
  const bins = mergeBins(a, b);
  const total = bins.reduce((sum, count) => sum + count, 0);
  if (total === 0) return { total: 0, rank: null, bin: null, estimate: null };

  const rank = Math.max(1, Math.ceil(p * total / 100));
  let cumulative = 0;
  for (const [bin, count] of bins.entries()) {
    cumulative += count;
    if (cumulative >= rank) return { total, rank, bin, estimate: 4 * 2 ** bin / 3 };
  }
  throw new Error('Rank outside histogram');
}
