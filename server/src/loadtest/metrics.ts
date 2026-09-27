// Measurement primitives for the order-book load harness. Kept dependency
// free so the harness compiles with the service and adds no runtime weight.

export interface LatencySummary {
  count: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

/** Exact percentiles over the retained samples. A 30 s run produces tens of
 *  thousands of samples at most, so keeping them all costs little and avoids
 *  the interpolation error of a bucketed estimate. */
export class Latency {
  private readonly samples: number[] = [];

  add(ms: number): void {
    this.samples.push(ms);
  }

  get count(): number {
    return this.samples.length;
  }

  summary(): LatencySummary {
    if (this.samples.length === 0) {
      return { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
    }
    const sorted = [...this.samples].sort((left, right) => left - right);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
      count: sorted.length,
      meanMs: round(total / sorted.length),
      p50Ms: round(quantile(sorted, 0.5)),
      p95Ms: round(quantile(sorted, 0.95)),
      p99Ms: round(quantile(sorted, 0.99)),
      maxMs: round(sorted[sorted.length - 1] ?? 0),
    };
  }
}

function quantile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Ordered count of labelled outcomes: status codes, rejection reasons. */
export class Tally {
  private readonly counts = new Map<string, number>();

  add(key: string, amount = 1): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + amount);
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  get total(): number {
    let sum = 0;
    for (const value of this.counts.values()) sum += value;
    return sum;
  }

  toObject(): Record<string, number> {
    return Object.fromEntries(
      [...this.counts.entries()].sort(
        (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
      ),
    );
  }
}

export interface EndpointReport extends LatencySummary {
  endpoint: string;
  statuses: Record<string, number>;
  errors: Record<string, number>;
  /** Completed requests per second over the scenario's measured window. */
  requestsPerSecond: number;
}

/** Per-endpoint latency plus the status and transport-error breakdown. */
export class EndpointMetrics {
  private readonly latency = new Map<string, Latency>();
  private readonly statuses = new Map<string, Tally>();
  private readonly errors = new Map<string, Tally>();

  record(endpoint: string, ms: number, status: number): void {
    this.latencyFor(endpoint).add(ms);
    this.tallyFor(this.statuses, endpoint).add(String(status));
  }

  recordError(endpoint: string, ms: number, reason: string): void {
    this.latencyFor(endpoint).add(ms);
    this.tallyFor(this.errors, endpoint).add(reason);
  }

  private latencyFor(endpoint: string): Latency {
    const existing = this.latency.get(endpoint);
    if (existing !== undefined) return existing;
    const created = new Latency();
    this.latency.set(endpoint, created);
    return created;
  }

  private tallyFor(map: Map<string, Tally>, endpoint: string): Tally {
    const existing = map.get(endpoint);
    if (existing !== undefined) return existing;
    const created = new Tally();
    map.set(endpoint, created);
    return created;
  }

  report(windowMs: number): EndpointReport[] {
    return [...this.latency.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([endpoint, latency]) => {
        const summary = latency.summary();
        return {
          endpoint,
          ...summary,
          statuses: this.statuses.get(endpoint)?.toObject() ?? {},
          errors: this.errors.get(endpoint)?.toObject() ?? {},
          requestsPerSecond:
            windowMs <= 0
              ? 0
              : Math.round((summary.count / windowMs) * 1000 * 10) / 10,
        };
      });
  }
}
