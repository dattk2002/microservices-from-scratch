export function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}
export function routeLabel(path: string): string {
  return path === '/work' ? '/work' : 'unknown';
}
export function methodLabel(method: string): string {
  return method === 'GET' || method === 'POST' ? method : 'OTHER';
}
export type Outcome = 'ok' | 'error' | 'cancelled';
const bounds = [0.1, 0.5, 1, 5, Infinity];
type Series = { route: string; method: string; active: number; count: number; sum: number; buckets: number[]; counters: Map<string, number> };
export class Metrics {
  private readonly series = new Map<string, Series>();
  private readonly clock: () => number;
  constructor(clock: () => number = () => performance.now()) { this.clock = clock; }
  begin(path: string, verb: string): (outcome: Outcome, status: number) => void {
    const route = routeLabel(path), method = methodLabel(verb), key = `${route}:${method}`;
    let series = this.series.get(key);
    if (!series) {
      series = { route, method, active: 0, count: 0, sum: 0, buckets: bounds.map(() => 0), counters: new Map() };
      this.series.set(key, series);
    }
    const target = series;
    target.active++;
    const start = this.clock();
    let completed = false;
    return (outcome, status) => {
      if (completed) return;
      completed = true;
      target.active--;
      const duration = Math.max(0, (this.clock() - start) / 1000);
      target.count++;
      target.sum += duration;
      bounds.forEach((bound, index) => { if (duration <= bound) target.buckets[index] = (target.buckets[index] ?? 0) + 1; });
      // Runtime normalization also protects callers outside TypeScript.
      const safeOutcome = outcome === 'ok' || outcome === 'cancelled' ? outcome : 'error';
      const safeStatus = [200, 400, 404, 405, 500, 502, 504].includes(status) ? String(status) : 'other';
      const counter = `outcome="${safeOutcome}",status="${safeStatus}"`;
      target.counters.set(counter, (target.counters.get(counter) ?? 0) + 1);
    };
  }
  render(): string {
    const lines = [
      '# HELP http_requests_total Completed business requests.', '# TYPE http_requests_total counter',
      '# HELP http_active_requests Business requests currently running.', '# TYPE http_active_requests gauge',
      '# HELP http_request_duration_seconds Business request duration in seconds.', '# TYPE http_request_duration_seconds histogram',
    ];
    for (const s of this.series.values()) {
      const labels = `route="${escapeLabel(s.route)}",method="${escapeLabel(s.method)}"`;
      for (const [counter, count] of s.counters) lines.push(`http_requests_total{${labels},${counter}} ${count}`);
      lines.push(`http_active_requests{${labels}} ${s.active}`);
      bounds.forEach((bound, index) => lines.push(`http_request_duration_seconds_bucket{${labels},le="${bound === Infinity ? '+Inf' : bound}"} ${s.buckets[index]}`));
      lines.push(`http_request_duration_seconds_count{${labels}} ${s.count}`, `http_request_duration_seconds_sum{${labels}} ${s.sum}`);
    }
    return lines.join('\n') + '\n';
  }
}
