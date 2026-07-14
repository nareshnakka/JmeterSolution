import type ExcelJS from 'exceljs'
import type { LiveMetrics, TestRun, TransactionMetric } from '../types'
import {
  computeAggregateSummaryAvgs,
  type AggregateSummaryConfig,
} from './aggregateSummaryAvgs'
import { filterTransactionsByKind } from './transactionKind'

export interface RepoReportMeta {
  run: TestRun | null
  metrics: LiveMetrics | null
  config: AggregateSummaryConfig
  scenarioDetails?: string[]
}

/** Compact columns: A = labels, B = samples/values, C = response time. */
const COL_LABEL = 1
const COL_SAMPLES = 2
const COL_RESPONSE = 3

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FF000000' } },
}

function formatReportDate(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}

function formatDuration(seconds?: number | null): string {
  if (seconds == null || seconds <= 0) return ''
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const mins = Math.floor((total % 3600) / 60)
  if (hours > 0 && mins > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'} ${mins} min${mins === 1 ? '' : 's'}`
  }
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`
  if (mins > 0) return `${mins} min${mins === 1 ? '' : 's'}`
  return `${total} sec`
}

function peakUsers(metrics: LiveMetrics | null): number | null {
  if (!metrics) return null
  const series = metrics.active_users_series ?? []
  let peak = metrics.active_threads || 0
  for (const point of series) {
    if (typeof point.users === 'number' && point.users > peak) peak = point.users
  }
  return peak > 0 ? peak : null
}

function versionLabel(run: TestRun | null): string {
  if (!run) return ''
  const release = run.release_name?.trim() || ''
  const build = run.build_name?.trim() || ''
  if (release && build) return `${release} - Build ${build}`
  return release || build || ''
}

function scenarioValueLines(run: TestRun | null, extra?: string[]): string[] {
  const lines: string[] = []
  if (run?.scenario_name?.trim()) lines.push(run.scenario_name.trim())
  if (run?.application_name?.trim()) lines.push(run.application_name.trim())
  if (run?.scenario_tags?.length) {
    for (const tag of run.scenario_tags) {
      if (tag.trim()) lines.push(tag.trim())
    }
  }
  if (extra) {
    for (const line of extra) {
      if (line.trim()) lines.push(line.trim())
    }
  }
  if (run?.notes?.trim()) {
    for (const line of run.notes.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (/cpu|doc records/i.test(trimmed)) continue
      lines.push(trimmed)
    }
  }
  return lines
}

function styleMetaLabel(cell: ExcelJS.Cell): void {
  cell.font = { name: 'Calibri', size: 11, bold: true }
  cell.alignment = { vertical: 'middle', horizontal: 'left' }
  cell.border = THIN_BORDER
}

function styleMetaValue(cell: ExcelJS.Cell, opts?: { bold?: boolean }): void {
  cell.font = { name: 'Calibri', size: 11, bold: opts?.bold ?? false }
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  cell.border = THIN_BORDER
}

/** Write label in A; merge B:C for the value and center-align. */
function writeMetaRow(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  label: string,
  value: string | number | null | undefined
): void {
  const labelCell = sheet.getCell(rowNumber, COL_LABEL)
  labelCell.value = label
  styleMetaLabel(labelCell)

  sheet.mergeCells(rowNumber, COL_SAMPLES, rowNumber, COL_RESPONSE)
  const valueCell = sheet.getCell(rowNumber, COL_SAMPLES)
  valueCell.value = value ?? ''
  styleMetaValue(valueCell, { bold: typeof value === 'number' })
  // Keep border on trailing merge cell so the merged block edges render cleanly
  sheet.getCell(rowNumber, COL_RESPONSE).border = THIN_BORDER
}

/**
 * Build the aggregate report workbook:
 * A = labels; meta values span merged B:C (center); table uses B = Samples, C = Response Time.
 * Omits Observation (CPU) and No. of Doc Records.
 */
export async function buildAggregateRepoWorkbook(
  transactions: TransactionMetric[],
  meta: RepoReportMeta
): Promise<ExcelJS.Workbook> {
  const ExcelJSMod = await import('exceljs')
  const ExcelJS = ExcelJSMod.default

  const transactionRows = filterTransactionsByKind(transactions, 'transaction')
  const avgs = computeAggregateSummaryAvgs(transactionRows, meta.config)
  const totalAvg = avgs[0]?.avg_ms
  const loadAvg = avgs[1]?.avg_ms
  const submitAvg = avgs[2]?.avg_ms

  const users = peakUsers(meta.metrics)
  const dateText = formatReportDate(
    meta.run?.started_at || meta.run?.finished_at || meta.run?.created_at
  )
  const durationText = formatDuration(meta.metrics?.elapsed_seconds)
  const scenarioLines = scenarioValueLines(meta.run, meta.scenarioDetails)

  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'JMeter Agent'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Repo Report', {
    views: [{ showGridLines: true }],
  })

  sheet.getColumn(1).width = 48
  sheet.getColumn(2).width = 18
  sheet.getColumn(3).width = 16

  let row = 1
  writeMetaRow(sheet, row++, 'SmartSolve Version', versionLabel(meta.run) || '')
  writeMetaRow(sheet, row++, 'Date', dateText)

  if (scenarioLines.length === 0) {
    writeMetaRow(sheet, row++, 'Scenario', '')
  } else {
    writeMetaRow(sheet, row++, 'Scenario', scenarioLines[0])
    for (let i = 1; i < scenarioLines.length; i++) {
      const labelCell = sheet.getCell(row, COL_LABEL)
      labelCell.value = ''
      styleMetaLabel(labelCell)
      sheet.mergeCells(row, COL_SAMPLES, row, COL_RESPONSE)
      const valueCell = sheet.getCell(row, COL_SAMPLES)
      valueCell.value = scenarioLines[i]
      styleMetaValue(valueCell)
      sheet.getCell(row, COL_RESPONSE).border = THIN_BORDER
      row++
    }
  }

  writeMetaRow(
    sheet,
    row++,
    'Users',
    users != null ? `${users} Unique Users` : ''
  )
  writeMetaRow(sheet, row++, 'Ramp up duration', '')
  writeMetaRow(sheet, row++, 'Duration', durationText)
  writeMetaRow(sheet, row++, 'Thinktime', '')
  writeMetaRow(
    sheet,
    row++,
    'Average Response Time',
    totalAvg != null ? Math.round(totalAvg) : ''
  )
  writeMetaRow(
    sheet,
    row++,
    'Average Load Response time',
    loadAvg != null ? Math.round(loadAvg) : ''
  )
  writeMetaRow(
    sheet,
    row++,
    'Average Submit Response time',
    submitAvg != null ? Math.round(submitAvg) : ''
  )

  // Blank separator row (row 14 in sample)
  row++

  const headerRow = row
  const labelHeader = sheet.getCell(headerRow, COL_LABEL)
  labelHeader.value = 'Label'
  labelHeader.font = { name: 'Calibri', size: 11, bold: true }
  labelHeader.alignment = { vertical: 'middle', horizontal: 'left' }
  labelHeader.border = THIN_BORDER

  const samplesHeader = sheet.getCell(headerRow, COL_SAMPLES)
  samplesHeader.value = 'Samples'
  samplesHeader.font = { name: 'Calibri', size: 11, bold: true }
  samplesHeader.alignment = { vertical: 'middle', horizontal: 'center' }
  samplesHeader.border = THIN_BORDER

  const responseHeader = sheet.getCell(headerRow, COL_RESPONSE)
  responseHeader.value = 'Response Time'
  responseHeader.font = { name: 'Calibri', size: 11, bold: true }
  responseHeader.alignment = { vertical: 'middle', horizontal: 'center' }
  responseHeader.border = THIN_BORDER

  row++
  const dataStart = row

  for (const tx of transactionRows) {
    const labelCell = sheet.getCell(row, COL_LABEL)
    labelCell.value = tx.label
    labelCell.font = { name: 'Calibri', size: 11 }
    labelCell.alignment = { vertical: 'middle', horizontal: 'left' }
    labelCell.border = THIN_BORDER

    const samplesCell = sheet.getCell(row, COL_SAMPLES)
    samplesCell.value = tx.samples
    samplesCell.font = { name: 'Calibri', size: 11 }
    samplesCell.alignment = { vertical: 'middle', horizontal: 'center' }
    samplesCell.border = THIN_BORDER

    const responseCell = sheet.getCell(row, COL_RESPONSE)
    responseCell.value = Math.round(tx.avg_ms)
    responseCell.font = { name: 'Calibri', size: 11 }
    responseCell.alignment = { vertical: 'middle', horizontal: 'center' }
    responseCell.border = THIN_BORDER

    row++
  }

  const dataEnd = row - 1
  if (dataEnd >= dataStart) {
    sheet.addConditionalFormatting({
      ref: `${sheet.getCell(dataStart, COL_RESPONSE).address}:${sheet.getCell(dataEnd, COL_RESPONSE).address}`,
      rules: [
        {
          type: 'dataBar',
          priority: 1,
          cfvo: [{ type: 'min' }, { type: 'max' }],
          color: { argb: 'FF5B9BD5' },
          gradient: true,
          showValue: true,
        } as ExcelJS.DataBarRuleType & { color: { argb: string } },
      ],
    })
  }

  return workbook
}

function sanitizeFilenamePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run'
}

export async function downloadAggregateRepoReport(options: {
  transactions: TransactionMetric[]
  meta: RepoReportMeta
  runId: number
}): Promise<boolean> {
  const { transactions, meta, runId } = options
  const rows = filterTransactionsByKind(transactions, 'transaction')
  if (rows.length === 0) return false

  const workbook = await buildAggregateRepoWorkbook(transactions, meta)
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const scenarioPart = sanitizeFilenamePart(meta.run?.scenario_name || 'scenario')
  link.href = url
  link.download = `repo-report-run-${runId}-${scenarioPart}.xlsx`
  link.click()
  URL.revokeObjectURL(url)
  return true
}
