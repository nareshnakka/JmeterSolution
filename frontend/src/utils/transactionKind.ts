import type { AggregateKindFilter, TransactionMetric, TransactionKind } from '../types'

export function resolveTransactionKind(metric: TransactionMetric): TransactionKind {
  if (metric.kind === 'request') return 'request'
  return 'transaction'
}

export function filterTransactionsByKind(
  transactions: TransactionMetric[],
  kindFilter: AggregateKindFilter
): TransactionMetric[] {
  if (kindFilter === 'all') return transactions
  if (kindFilter === 'request') {
    const transactionLabels = new Set(
      transactions.filter((t) => resolveTransactionKind(t) === 'transaction').map((t) => t.label)
    )
    return transactions.filter(
      (t) => resolveTransactionKind(t) === 'request' && !transactionLabels.has(t.label)
    )
  }
  return transactions.filter((t) => resolveTransactionKind(t) === 'transaction')
}
