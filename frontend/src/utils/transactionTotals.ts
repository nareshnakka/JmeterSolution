import type { TransactionMetric, TransactionTotals } from '../types'

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Map server-computed TOTAL metric to table footer fields. */
export function metricToTotals(metric: TransactionMetric): TransactionTotals {
  return {
    samples: metric.samples,
    errors: metric.errors,
    error_pct: metric.error_pct,
    avg_ms: metric.avg_ms,
    min_ms: metric.min_ms,
    max_ms: metric.max_ms,
    median_ms: metric.median_ms,
    p90_ms: metric.p90_ms,
    p95_ms: metric.p95_ms,
    p99_ms: metric.p99_ms,
    throughput: metric.throughput,
  }
}

/** Fallback when the aggregate-total API is unavailable. */
export function computeTransactionTotals(
  transactions: TransactionMetric[],
  elapsedSeconds?: number
): TransactionTotals | null {
  if (transactions.length === 0) return null

  const samples = transactions.reduce((sum, t) => sum + t.samples, 0)
  if (samples === 0) return null

  const errors = transactions.reduce((sum, t) => sum + t.errors, 0)
  const weighted = (pick: (t: TransactionMetric) => number) =>
    transactions.reduce((sum, t) => sum + pick(t) * t.samples, 0) / samples

  const throughput =
    elapsedSeconds && elapsedSeconds > 0
      ? round2(samples / elapsedSeconds)
      : round2(transactions.reduce((sum, t) => sum + t.throughput, 0))

  return {
    samples,
    errors,
    error_pct: round2((100 * errors) / samples),
    avg_ms: round2(weighted((t) => t.avg_ms)),
    min_ms: round2(Math.min(...transactions.map((t) => t.min_ms))),
    max_ms: round2(Math.max(...transactions.map((t) => t.max_ms))),
    median_ms: round2(weighted((t) => t.median_ms)),
    p90_ms: round2(weighted((t) => t.p90_ms)),
    p95_ms: round2(weighted((t) => t.p95_ms)),
    p99_ms: round2(weighted((t) => t.p99_ms)),
    throughput,
  }
}
