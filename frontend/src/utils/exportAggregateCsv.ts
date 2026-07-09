import type { TransactionMetric, TransactionTotals } from '../types'

const HEADERS = [
  'Label',
  '# Samples',
  'Avg (ms)',
  'Min',
  'Max',
  'Median',
  '90% Line',
  '95% Line',
  '99% Line',
  'Error %',
  'Throughput',
] as const

function escapeCsvCell(value: string | number): string {
  const text = String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function rowFromMetric(label: string, metric: {
  samples: number
  avg_ms: number
  min_ms: number
  max_ms: number
  median_ms: number
  p90_ms: number
  p95_ms: number
  p99_ms: number
  error_pct: number
  throughput: number
}): string[] {
  return [
    label,
    String(metric.samples),
    String(metric.avg_ms),
    String(metric.min_ms),
    String(metric.max_ms),
    String(metric.median_ms),
    String(metric.p90_ms),
    String(metric.p95_ms),
    String(metric.p99_ms),
    String(metric.error_pct),
    String(metric.throughput),
  ]
}

function rowFromTransaction(metric: TransactionMetric): string[] {
  return rowFromMetric(metric.label, metric)
}

function rowFromTotals(totals: TransactionTotals): string[] {
  return rowFromMetric('TOTAL', totals)
}

export function buildAggregateReportCsv(
  rows: TransactionMetric[],
  totals: TransactionTotals | null
): string {
  const lines = [HEADERS.join(',')]
  for (const row of rows) {
    lines.push(rowFromTransaction(row).map(escapeCsvCell).join(','))
  }
  if (totals) {
    lines.push(rowFromTotals(totals).map(escapeCsvCell).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

function sanitizeFilenamePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'all'
}

export function downloadAggregateReportCsv(options: {
  rows: TransactionMetric[]
  totals: TransactionTotals | null
  runId: number
  kindFilter: string
  labelFilter?: string
}): boolean {
  const { rows, totals, runId, kindFilter, labelFilter } = options
  if (rows.length === 0) return false

  const csv = buildAggregateReportCsv(rows, totals)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const kindPart = sanitizeFilenamePart(kindFilter)
  const labelPart = labelFilter?.trim() ? `-${sanitizeFilenamePart(labelFilter)}` : ''
  link.href = url
  link.download = `aggregate-report-run-${runId}-${kindPart}${labelPart}.csv`
  link.click()
  URL.revokeObjectURL(url)
  return true
}
