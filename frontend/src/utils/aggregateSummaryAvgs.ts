import type { TransactionMetric } from '../types'
import { filterTransactionsByKind } from './transactionKind'

export interface AggregateSummaryConfig {
  aggregate_total_avg_title: string
  aggregate_total_avg_filter: string
  aggregate_total_avg_exclude: string
  aggregate_load_avg_title: string
  aggregate_load_avg_filter: string
  aggregate_submit_avg_title: string
  aggregate_submit_avg_filter: string
}

export interface AggregateSummaryAvg {
  title: string
  avg_ms: number | null
}

export const DEFAULT_AGGREGATE_SUMMARY_CONFIG: AggregateSummaryConfig = {
  aggregate_total_avg_title: 'Total Avg',
  aggregate_total_avg_filter: '',
  aggregate_total_avg_exclude: '',
  aggregate_load_avg_title: 'Load Avg',
  aggregate_load_avg_filter: '_L_',
  aggregate_submit_avg_title: 'Submit Avg',
  aggregate_submit_avg_filter: '_S_',
}

/** Always excluded from Total Avg (substring, case-insensitive). */
export const TOTAL_AVG_BUILTIN_EXCLUDES = ['login', 'log_in']

function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** Arithmetic mean of each transaction row's Avg (ms) column. */
export function computeMeanRowAvgMs(transactions: TransactionMetric[]): number | null {
  if (transactions.length === 0) return null
  const sum = transactions.reduce((acc, t) => acc + t.avg_ms, 0)
  return round2(sum / transactions.length)
}

function filterTransactionsByLabel(
  transactions: TransactionMetric[],
  labelFilter: string
): TransactionMetric[] {
  const q = labelFilter.trim().toLowerCase()
  if (!q) return transactions
  return transactions.filter((t) => t.label.toLowerCase().includes(q))
}

export function parseAggregateExcludeList(exclude: string): string[] {
  return exclude
    .split(/[,\n]/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
}

export function excludeTransactionsByLabel(
  transactions: TransactionMetric[],
  excludeList: string[]
): TransactionMetric[] {
  if (excludeList.length === 0) return transactions
  return transactions.filter((t) => {
    const label = t.label.toLowerCase()
    return !excludeList.some((q) => label.includes(q))
  })
}

function totalAvgIncludeRows(
  transactionRows: TransactionMetric[],
  config: AggregateSummaryConfig
): TransactionMetric[] {
  const totalFilter = config.aggregate_total_avg_filter.trim()
  if (totalFilter) {
    return filterTransactionsByLabel(transactionRows, totalFilter)
  }
  // Empty filter = all transactions (requests already removed).
  return transactionRows
}

export function computeAggregateSummaryAvgs(
  transactions: TransactionMetric[] | undefined,
  config: AggregateSummaryConfig
): AggregateSummaryAvg[] {
  const transactionRows = filterTransactionsByKind(transactions ?? [], 'transaction')

  const loadFilter = config.aggregate_load_avg_filter
  const submitFilter = config.aggregate_submit_avg_filter
  const excludeList = [
    ...TOTAL_AVG_BUILTIN_EXCLUDES,
    ...parseAggregateExcludeList(config.aggregate_total_avg_exclude),
  ]

  const totalRows = excludeTransactionsByLabel(
    totalAvgIncludeRows(transactionRows, config),
    excludeList
  )

  const buckets = [
    {
      title: config.aggregate_total_avg_title.trim() || DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_total_avg_title,
      rows: totalRows,
    },
    {
      title: config.aggregate_load_avg_title.trim() || DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_load_avg_title,
      rows: filterTransactionsByLabel(transactionRows, loadFilter),
    },
    {
      title: config.aggregate_submit_avg_title.trim() || DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_submit_avg_title,
      rows: filterTransactionsByLabel(transactionRows, submitFilter),
    },
  ]

  return buckets.map(({ title, rows }) => ({
    title,
    avg_ms: computeMeanRowAvgMs(rows),
  }))
}
