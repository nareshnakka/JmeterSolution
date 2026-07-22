import type ExcelJS from 'exceljs'
import type { AzureResources, LiveMetrics, TestRun, TransactionMetric } from '../types'
import {
  computeAggregateSummaryAvgs,
  type AggregateSummaryConfig,
} from './aggregateSummaryAvgs'
import { computeAzureResourceAverages } from './azureResourceAverages'
import { filterTransactionsByKind } from './transactionKind'

export interface RepoReportMeta {
  run: TestRun | null
  metrics: LiveMetrics | null
  config: AggregateSummaryConfig
  scenarioDetails?: string[]
  /** Azure Monitor samples for this run (CPU/Memory averages in the summary). */
  azureResources?: AzureResources | null
}

/** A = labels, B = samples/values, C = response time (with Excel data bars). */
const COL_LABEL = 1
const COL_SAMPLES = 2
const COL_RESPONSE = 3

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: 'FF000000' } },
  left: { style: 'thin', color: { argb: 'FF000000' } },
  bottom: { style: 'thin', color: { argb: 'FF000000' } },
  right: { style: 'thin', color: { argb: 'FF000000' } },
}

const FONT = { name: 'Calibri', size: 11 } as const
const FONT_BOLD = { name: 'Calibri', size: 11, bold: true } as const

let excelJsLoad: Promise<typeof ExcelJS> | null = null

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

async function loadExcelJS(): Promise<typeof ExcelJS> {
  if (excelJsLoad) return excelJsLoad

  excelJsLoad = (async () => {
    // ExcelJS writeBuffer expects Node Buffer in some browser builds.
    if (!(globalThis as { Buffer?: unknown }).Buffer) {
      const { Buffer } = await import('buffer')
      ;(globalThis as { Buffer: typeof Buffer }).Buffer = Buffer
      if (typeof window !== 'undefined') {
        ;(window as unknown as { Buffer: typeof Buffer }).Buffer = Buffer
      }
    }

    const mod = await import('exceljs')
    const candidate = (mod as { default?: typeof ExcelJS }).default ?? (mod as typeof ExcelJS)
    if (candidate && typeof candidate.Workbook === 'function') {
      return candidate
    }
    const nested = (candidate as { default?: typeof ExcelJS } | undefined)?.default
    if (nested && typeof nested.Workbook === 'function') {
      return nested
    }
    throw new Error('ExcelJS Workbook is unavailable in this browser build')
  })()

  try {
    return await excelJsLoad
  } catch (err) {
    excelJsLoad = null
    throw err
  }
}

/** Warm the ExcelJS chunk so the first Export Report click is much faster. */
export function prefetchExcelJS(): void {
  void loadExcelJS().catch(() => {
    /* ignore — export will retry */
  })
}

function styleMetaLabel(cell: ExcelJS.Cell): void {
  cell.font = FONT_BOLD
  cell.alignment = { vertical: 'middle', horizontal: 'left' }
  cell.border = THIN_BORDER
}

function styleMetaValue(cell: ExcelJS.Cell, opts?: { bold?: boolean }): void {
  cell.font = opts?.bold ? FONT_BOLD : FONT
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  cell.border = THIN_BORDER
}

/** Label in A; merge B:C for value; center-align the value. */
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
}

/**
 * Build an .xlsx Repo report:
 * - Summary values: B:C merged + center aligned
 * - Table: Label | Samples | Response Time
 * - Response Time uses Excel data-bar conditional formatting (not solid cell fills)
 */
export async function buildAggregateRepoWorkbook(
  transactions: TransactionMetric[],
  meta: RepoReportMeta,
  tableRows?: TransactionMetric[]
): Promise<ExcelJS.Workbook> {
  const ExcelJSLib = await loadExcelJS()
  const transactionRows = filterTransactionsByKind(transactions, 'transaction')
  // Prefer explicit table rows (current aggregate filters). Fall back to transactions,
  // then to the full metrics list so API-only scenarios can still export.
  const exportRows =
    (tableRows && tableRows.length > 0
      ? tableRows
      : transactionRows.length > 0
        ? transactionRows
        : transactions) ?? []
  const avgs = computeAggregateSummaryAvgs(
    transactionRows.length > 0 ? transactionRows : exportRows,
    meta.config
  )
  const totalAvg = avgs[0]?.avg_ms
  const loadAvg = avgs[1]?.avg_ms
  const submitAvg = avgs[2]?.avg_ms

  const users = peakUsers(meta.metrics)
  const dateText = formatReportDate(
    meta.run?.started_at || meta.run?.finished_at || meta.run?.created_at
  )
  const durationText = formatDuration(meta.metrics?.elapsed_seconds)
  const scenarioLines = scenarioValueLines(meta.run, meta.scenarioDetails)

  const workbook = new ExcelJSLib.Workbook()
  workbook.creator = 'JMeter Agent'
  workbook.created = new Date()

  const sheet = workbook.addWorksheet('Repo Report', {
    views: [{ showGridLines: true }],
  })

  sheet.getColumn(1).width = 48
  sheet.getColumn(2).width = 14
  sheet.getColumn(3).width = 18

  let row = 1
  writeMetaRow(sheet, row++, 'SmartSolve Version', versionLabel(meta.run) || '')
  writeMetaRow(sheet, row++, 'Date', dateText)

  if (scenarioLines.length === 0) {
    writeMetaRow(sheet, row++, 'Scenario', '')
  } else {
    writeMetaRow(sheet, row++, 'Scenario', scenarioLines[0])
    for (let i = 1; i < scenarioLines.length; i++) {
      writeMetaRow(sheet, row++, '', scenarioLines[i])
    }
  }

  writeMetaRow(sheet, row++, 'Users', users != null ? `${users} Unique Users` : '')
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

  const azureAvgs = computeAzureResourceAverages(meta.azureResources)
  for (const server of azureAvgs.servers) {
    writeMetaRow(
      sheet,
      row++,
      `${server.name} Avg CPU (%)`,
      server.cpuAvg != null ? server.cpuAvg : '',
    )
    writeMetaRow(
      sheet,
      row++,
      `${server.name} Avg Memory (%)`,
      server.memAvg != null ? server.memAvg : '',
    )
  }
  if (azureAvgs.servers.length > 1) {
    writeMetaRow(
      sheet,
      row++,
      'Azure Total Avg CPU (%)',
      azureAvgs.totalCpu != null ? azureAvgs.totalCpu : '',
    )
    writeMetaRow(
      sheet,
      row++,
      'Azure Total Avg Memory (%)',
      azureAvgs.totalMem != null ? azureAvgs.totalMem : '',
    )
  }

  row++ // blank separator

  const headerRow = sheet.getRow(row)
  headerRow.getCell(COL_LABEL).value = 'Label'
  headerRow.getCell(COL_SAMPLES).value = 'Samples'
  headerRow.getCell(COL_RESPONSE).value = 'Response Time'
  headerRow.font = FONT_BOLD
  for (let c = COL_LABEL; c <= COL_RESPONSE; c++) {
    const cell = headerRow.getCell(c)
    cell.border = THIN_BORDER
    cell.alignment = {
      vertical: 'middle',
      horizontal: c === COL_LABEL ? 'left' : 'center',
    }
  }
  headerRow.commit()
  row++
  const dataStart = row

  // Bulk row insert is much faster than styling getCell() three times per label.
  if (exportRows.length > 0) {
    sheet.getColumn(COL_LABEL).alignment = { vertical: 'middle', horizontal: 'left' }
    sheet.getColumn(COL_SAMPLES).alignment = { vertical: 'middle', horizontal: 'center' }
    sheet.getColumn(COL_RESPONSE).alignment = { vertical: 'middle', horizontal: 'center' }

    sheet.addRows(exportRows.map((tx) => [tx.label, tx.samples, Math.round(tx.avg_ms)]))
    const dataEnd = dataStart + exportRows.length - 1

    // Light borders only (no per-cell fonts) — biggest ExcelJS cost was style spam.
    for (let r = dataStart; r <= dataEnd; r++) {
      const dataRow = sheet.getRow(r)
      dataRow.getCell(COL_LABEL).border = THIN_BORDER
      dataRow.getCell(COL_SAMPLES).border = THIN_BORDER
      dataRow.getCell(COL_RESPONSE).border = THIN_BORDER
      dataRow.commit()
    }

    const ref = `${sheet.getCell(dataStart, COL_RESPONSE).address}:${sheet.getCell(dataEnd, COL_RESPONSE).address}`
    try {
      sheet.addConditionalFormatting({
        ref,
        rules: [
          {
            type: 'dataBar',
            priority: 1,
            cfvo: [{ type: 'min' }, { type: 'max' }],
            color: { argb: 'FF5B9BD5' },
            gradient: true,
            showValue: true,
            border: false,
            negativeBarColorSameAsPositive: true,
          } as ExcelJS.DataBarRuleType & { color: { argb: string } },
        ],
      })
    } catch {
      // Data bars are cosmetic — never block the export if CF fails.
    }
  }

  return workbook
}

function sanitizeFilenamePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run'
}

function toBlobPart(buffer: ExcelJS.Buffer): BlobPart {
  const raw = buffer as unknown
  if (raw instanceof ArrayBuffer) return raw
  if (typeof Blob !== 'undefined' && raw instanceof Blob) return raw
  if (raw instanceof Uint8Array) {
    // Copy into a standalone ArrayBuffer — some browsers reject shared/detached views.
    return raw.slice().buffer
  }
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer
  }
  // Node Buffer polyfill / array-like
  try {
    return Uint8Array.from(raw as ArrayLike<number>).buffer
  } catch {
    throw new Error('Could not convert Excel workbook buffer for download')
  }
}

export async function downloadAggregateRepoReport(options: {
  transactions: TransactionMetric[]
  meta: RepoReportMeta
  runId: number
  /** Rows currently shown in the Aggregate Report table (preferred for the Excel body). */
  tableRows?: TransactionMetric[]
}): Promise<boolean> {
  const { transactions, meta, runId, tableRows } = options
  const transactionRows = filterTransactionsByKind(transactions, 'transaction')
  const exportRows =
    (tableRows && tableRows.length > 0
      ? tableRows
      : transactionRows.length > 0
        ? transactionRows
        : transactions) ?? []
  if (exportRows.length === 0) return false

  // Let the UI paint "Preparing…" before the heavy ExcelJS work.
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 0)
  })

  const workbook = await buildAggregateRepoWorkbook(transactions, meta, exportRows)
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([toBlobPart(buffer)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const scenarioPart = sanitizeFilenamePart(meta.run?.scenario_name || 'scenario')
  link.href = url
  link.download = `repo-report-run-${runId}-${scenarioPart}.xlsx`
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  return true
}
