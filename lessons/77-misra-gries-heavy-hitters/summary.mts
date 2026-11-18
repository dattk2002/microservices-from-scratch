export type Source = 'a' | 'b';
export type Counter = { key: string; count: number };
export type Summary = {
  id: Source;
  algorithm: 'mg3-v1';
  total: number;
  dropped: number;
  counters: Counter[];
};

export function emptySummary(id: Source): Summary {
  return { id, algorithm: 'mg3-v1', total: 0, dropped: 0, counters: [] };
}

function byKey(a: Counter, b: Counter): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function addKey(summary: Summary, key: string): Summary {
  const next = { ...summary, total: summary.total + 1 };
  if (summary.counters.some(counter => counter.key === key)) {
    next.counters = summary.counters.map(counter =>
      counter.key === key ? { key, count: counter.count + 1 } : counter);
  } else if (summary.counters.length < 3) {
    next.counters = [...summary.counters, { key, count: 1 }].sort(byKey);
  } else {
    // The incoming key and one occurrence of each tracked key cancel.
    next.counters = summary.counters
      .map(counter => ({ key: counter.key, count: counter.count - 1 }))
      .filter(counter => counter.count > 0);
    next.dropped++;
  }
  return next;
}

export type HeavyHitters = {
  total: number;
  dropped: number;
  candidates: { key: string; lower: number; upper: number }[];
};

export function mergeSummaries(a: Summary, b: Summary): HeavyHitters {
  const counts = new Map<string, number>();
  for (const { key, count } of [...a.counters, ...b.counters]) {
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  let dropped = a.dropped + b.dropped;
  while (counts.size > 3) {
    const minimum = Math.min(...counts.values());
    for (const [key, count] of counts) {
      if (count === minimum) counts.delete(key);
      else counts.set(key, count - minimum);
    }
    // Each key loses at most minimum, even when more than four keys lose mass.
    dropped += minimum;
  }
  const sorted = Array.from(counts, ([key, count]) => ({ key, count })).sort(byKey);
  return {
    total: a.total + b.total,
    dropped,
    candidates: sorted.map(({ key, count }) => ({ key, lower: count, upper: count + dropped })),
  };
}
