import type { AggregateKindFilter, TransactionMetric, TransactionKind } from '../types'

export function resolveTransactionKind(metric: TransactionMetric): TransactionKind {
  return metric.kind === 'request' ? 'request' : 'transaction'
}

export function filterTransactionsByKind(
  transactions: TransactionMetric[],
  kindFilter: AggregateKindFilter
): TransactionMetric[] {
  if (kindFilter === 'all') return transactions
  return transactions.filter((t) => resolveTransactionKind(t) === kindFilter)
}
