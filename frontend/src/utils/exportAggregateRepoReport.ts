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

function escapeXml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function cell(
  text: string | number,
  options?: {
    styleId?: string
    mergeAcross?: number
    type?: 'String' | 'Number'
  }
): string {
  const styleId = options?.styleId
  const mergeAcross = options?.mergeAcross
  const attrs = [
    styleId ? `ss:StyleID="${styleId}"` : '',
    mergeAcross != null ? `ss:MergeAcross="${mergeAcross}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const attrPrefix = attrs ? ` ${attrs}` : ''
  const value = String(text)
  const forceType = options?.type
  const isNumber =
    forceType === 'Number' ||
    (forceType !== 'String' &&
      (typeof text === 'number' || (/^-?\d+(\.\d+)?$/.test(value) && value !== '')))
  if (isNumber && value !== '') {
    return `<Cell${attrPrefix}><Data ss:Type="Number">${escapeXml(value)}</Data></Cell>`
  }
  return `<Cell${attrPrefix}><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`
}

function row(cells: string[], height = 18): string {
  return `<Row ss:AutoFitHeight="0" ss:Height="${height}">${cells.join('')}</Row>`
}

function blankRow(): string {
  return '<Row ss:AutoFitHeight="0" ss:Height="10"/>'
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

/** Label in A; value merged across B:C and center-aligned. */
function metaRow(label: string, value?: string | number | null, valueStyle = 'Value'): string {
  const valueText = value == null ? '' : value
  return row([
    cell(label, { styleId: 'Label' }),
    cell(valueText, {
      styleId: valueStyle,
      mergeAcross: 1,
      type: typeof valueText === 'number' ? 'Number' : 'String',
    }),
  ])
}

function barStyleId(avgMs: number, maxMs: number): string {
  if (maxMs <= 0) return 'Bar1'
  const ratio = avgMs / maxMs
  if (ratio >= 0.75) return 'Bar4'
  if (ratio >= 0.5) return 'Bar3'
  if (ratio >= 0.25) return 'Bar2'
  return 'Bar1'
}

/**
 * Build SpreadsheetML workbook (Excel-compatible .xls) with:
 * A = labels; merged B:C = summary values (center); table B = Samples, C = Response Time.
 */
export function buildAggregateRepoReportXml(
  transactions: TransactionMetric[],
  meta: RepoReportMeta
): string {
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
  const maxResponse = transactionRows.reduce((m, t) => Math.max(m, t.avg_ms || 0), 0)

  const rowsXml: string[] = []
  rowsXml.push(metaRow('SmartSolve Version', versionLabel(meta.run) || ''))
  rowsXml.push(metaRow('Date', dateText))

  if (scenarioLines.length === 0) {
    rowsXml.push(metaRow('Scenario', ''))
  } else {
    rowsXml.push(metaRow('Scenario', scenarioLines[0]))
    for (let i = 1; i < scenarioLines.length; i++) {
      rowsXml.push(metaRow('', scenarioLines[i]))
    }
  }

  rowsXml.push(metaRow('Users', users != null ? `${users} Unique Users` : ''))
  rowsXml.push(metaRow('Ramp up duration', ''))
  rowsXml.push(metaRow('Duration', durationText))
  rowsXml.push(metaRow('Thinktime', ''))
  rowsXml.push(
    metaRow(
      'Average Response Time',
      totalAvg != null ? Math.round(totalAvg) : '',
      'Result'
    )
  )
  rowsXml.push(
    metaRow(
      'Average Load Response time',
      loadAvg != null ? Math.round(loadAvg) : '',
      'Result'
    )
  )
  rowsXml.push(
    metaRow(
      'Average Submit Response time',
      submitAvg != null ? Math.round(submitAvg) : '',
      'Result'
    )
  )

  rowsXml.push(blankRow())

  rowsXml.push(
    row([
      cell('Label', { styleId: 'Header' }),
      cell('Samples', { styleId: 'HeaderNum' }),
      cell('Response Time', { styleId: 'HeaderNum' }),
    ])
  )

  for (const tx of transactionRows) {
    const avg = Math.round(tx.avg_ms)
    rowsXml.push(
      row([
        cell(tx.label, { styleId: 'TxLabel' }),
        cell(tx.samples, { styleId: 'Num', type: 'Number' }),
        cell(avg, { styleId: barStyleId(tx.avg_ms, maxResponse), type: 'Number' }),
      ])
    )
  }

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
  <Title>Repo Aggregate Report</Title>
 </DocumentProperties>
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Color="#000000"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Label">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Value">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Result">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Header">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="HeaderNum">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="TxLabel">
   <Alignment ss:Horizontal="Left" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Num">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Bar1">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
   <Interior ss:Color="#DEEBF7" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Bar2">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
   <Interior ss:Color="#BDD7EE" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Bar3">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11"/>
   <Interior ss:Color="#9DC3E6" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
  <Style ss:ID="Bar4">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1"/>
   <Interior ss:Color="#5B9BD5" ss:Pattern="Solid"/>
   <Borders>
    <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/>
   </Borders>
  </Style>
 </Styles>
 <Worksheet ss:Name="Repo Report">
  <Table ss:DefaultRowHeight="18">
   <Column ss:Index="1" ss:AutoFitWidth="0" ss:Width="320"/>
   <Column ss:Index="2" ss:AutoFitWidth="0" ss:Width="90"/>
   <Column ss:Index="3" ss:AutoFitWidth="0" ss:Width="110"/>
   ${rowsXml.join('\n   ')}
  </Table>
 </Worksheet>
</Workbook>
`
}

function sanitizeFilenamePart(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run'
}

export function downloadAggregateRepoReport(options: {
  transactions: TransactionMetric[]
  meta: RepoReportMeta
  runId: number
}): boolean {
  const { transactions, meta, runId } = options
  const rows = filterTransactionsByKind(transactions, 'transaction')
  if (rows.length === 0) return false

  const xml = buildAggregateRepoReportXml(transactions, meta)
  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  const scenarioPart = sanitizeFilenamePart(meta.run?.scenario_name || 'scenario')
  link.href = url
  link.download = `repo-report-run-${runId}-${scenarioPart}.xls`
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
  return true
}
