import type {
  AggregateKindFilter,
  AggregateOutcomeFilter,
  TransactionMetric,
  TransactionKind,
} from '../types'

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

/** Pass = no errors on the label; Fail = at least one error. */
export function filterTransactionsByOutcome(
  transactions: TransactionMetric[],
  outcomeFilter: AggregateOutcomeFilter
): TransactionMetric[] {
  if (outcomeFilter === 'all') return transactions
  if (outcomeFilter === 'pass') return transactions.filter((t) => t.errors === 0)
  return transactions.filter((t) => t.errors > 0)
}
