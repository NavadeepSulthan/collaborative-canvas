export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) return { count: 0, mean: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 };
  const sorted = Float64Array.from(values).sort();
  const at = (p: number) =>
    round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!);
  return {
    count: sorted.length,
    mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50: at(0.5),
    p90: at(0.9),
    p95: at(0.95),
    p99: at(0.99),
    max: round(sorted[sorted.length - 1]!),
  };
}

export function round(value: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${round(bytes / 1e9, 2)} GB`;
  if (bytes >= 1e6) return `${round(bytes / 1e6, 1)} MB`;
  return `${round(bytes / 1e3, 1)} KB`;
}
