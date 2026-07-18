import { describe, expect, it } from 'vitest'
import type { TransactionMetric } from '../types'
import { filterTransactionsByOutcome } from './transactionKind'

function row(label: string, errors: number, samples = 10): TransactionMetric {
  return {
    label,
    kind: 'transaction',
    samples,
    errors,
    error_pct: samples ? (100 * errors) / samples : 0,
    avg_ms: 100,
    min_ms: 50,
    max_ms: 200,
    median_ms: 100,
    p90_ms: 150,
    p95_ms: 180,
    p99_ms: 190,
    throughput: 1,
  }
}

describe('filterTransactionsByOutcome', () => {
  const rows = [row('OK', 0), row('Bad', 2), row('AlsoOK', 0)]

  it('keeps only pass rows', () => {
    expect(filterTransactionsByOutcome(rows, 'pass').map((r) => r.label)).toEqual(['OK', 'AlsoOK'])
  })

  it('keeps only fail rows', () => {
    expect(filterTransactionsByOutcome(rows, 'fail').map((r) => r.label)).toEqual(['Bad'])
  })

  it('keeps all rows', () => {
    expect(filterTransactionsByOutcome(rows, 'all')).toHaveLength(3)
  })
})
