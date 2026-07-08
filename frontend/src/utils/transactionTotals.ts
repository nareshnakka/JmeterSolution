import type { TransactionMetric } from '../types'

export interface TransactionTotals {
  samples: number
  errors: number
  error_pct: number
  avg_ms: number
  min_ms: number
  max_ms: number
  median_ms: number
  p90_ms: number
  p95_ms: number
  throughput: number
}

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Aggregate per-label metrics into a TOTAL row (weighted by sample count). */
export function computeTransactionTotals(
  transactions: TransactionMetric[]
): TransactionTotals | null {
  if (transactions.length === 0) return null

  const samples = transactions.reduce((sum, t) => sum + t.samples, 0)
  if (samples === 0) return null

  const errors = transactions.reduce((sum, t) => sum + t.errors, 0)
  const weighted = (pick: (t: TransactionMetric) => number) =>
    transactions.reduce((sum, t) => sum + pick(t) * t.samples, 0) / samples

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
    throughput: round2(transactions.reduce((sum, t) => sum + t.throughput, 0)),
  }
}
