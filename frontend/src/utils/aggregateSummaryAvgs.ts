import type { TransactionMetric } from '../types'
import { filterTransactionsByKind } from './transactionKind'

export interface AggregateSummaryConfig {
  aggregate_total_avg_title: string
  aggregate_total_avg_filter: string
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
  aggregate_load_avg_title: 'Load Avg',
  aggregate_load_avg_filter: '_L_',
  aggregate_submit_avg_title: 'Submit Avg',
  aggregate_submit_avg_filter: '_S_',
}

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

export function computeAggregateSummaryAvgs(
  transactions: TransactionMetric[] | undefined,
  config: AggregateSummaryConfig
): AggregateSummaryAvg[] {
  const transactionRows = filterTransactionsByKind(transactions ?? [], 'transaction')

  const buckets = [
    {
      title: config.aggregate_total_avg_title.trim() || DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_total_avg_title,
      filter: config.aggregate_total_avg_filter,
    },
    {
      title: config.aggregate_load_avg_title.trim() || DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_load_avg_title,
      filter: config.aggregate_load_avg_filter,
    },
    {
      title: config.aggregate_submit_avg_title.trim() || DEFAULT_AGGREGATE_SUMMARY_CONFIG.aggregate_submit_avg_title,
      filter: config.aggregate_submit_avg_filter,
    },
  ]

  return buckets.map(({ title, filter }) => ({
    title,
    avg_ms: computeMeanRowAvgMs(filterTransactionsByLabel(transactionRows, filter)),
  }))
}
