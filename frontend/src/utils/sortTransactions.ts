import type { TransactionMetric } from '../types'

export type AggregateSortField =
  | 'label'
  | 'samples'
  | 'avg_ms'
  | 'min_ms'
  | 'max_ms'
  | 'median_ms'
  | 'p90_ms'
  | 'p95_ms'
  | 'p99_ms'
  | 'error_pct'
  | 'throughput'

export type SortDir = 'asc' | 'desc'

export function sortTransactions(
  transactions: TransactionMetric[],
  field: AggregateSortField,
  dir: SortDir
): TransactionMetric[] {
  const mult = dir === 'asc' ? 1 : -1
  return [...transactions].sort((a, b) => {
    if (field === 'label') {
      return mult * a.label.localeCompare(b.label)
    }
    const av = a[field]
    const bv = b[field]
    if (av < bv) return -mult
    if (av > bv) return mult
    return a.label.localeCompare(b.label)
  })
}

export function defaultSortDir(field: AggregateSortField): SortDir {
  return field === 'label' ? 'asc' : 'desc'
}
