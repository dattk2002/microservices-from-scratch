export type Moments = Readonly<{ n: number; mean: number; m2: number }>;
export type Statistics = {
  n: number;
  mean: number | null;
  populationVariance: number | null;
  sampleVariance: number | null;
};

export const emptyMoments: Moments = { n: 0, mean: 0, m2: 0 };

export function add(state: Moments, value: number): Moments {
  const n = state.n + 1;
  const delta = value - state.mean;
  const mean = state.mean + delta / n;
  const m2 = state.m2 + delta * (value - mean);
  return { n, mean, m2 };
}

export function merge(a: Moments, b: Moments): Moments {
  if (a.n === 0) return b;
  if (b.n === 0) return a;

  const n = a.n + b.n;
  const delta = b.mean - a.mean;
  const mean = a.mean + delta * b.n / n;
  // This term accounts for the separation between the two local means.
  const m2 = a.m2 + b.m2 + delta * delta * a.n * b.n / n;
  return { n, mean, m2 };
}

export function summarize({ n, mean, m2 }: Moments): Statistics {
  return {
    n,
    mean: n === 0 ? null : mean,
    populationVariance: n === 0 ? null : m2 / n,
    sampleVariance: n < 2 ? null : m2 / (n - 1),
  };
}
