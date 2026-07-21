import { describe, expect, it } from 'vitest'
import { buildAggregateRepoWorkbook } from './exportAggregateRepoReport'
import { DEFAULT_AGGREGATE_SUMMARY_CONFIG } from './aggregateSummaryAvgs'
import type { LiveMetrics, TestRun, TransactionMetric } from '../types'

function tx(
  label: string,
  avg_ms: number,
  samples: number,
  kind: 'transaction' | 'request' = 'transaction'
): TransactionMetric {
  return {
    label,
    kind,
    samples,
    errors: 0,
    error_pct: 0,
    avg_ms,
    min_ms: avg_ms,
    max_ms: avg_ms,
    median_ms: avg_ms,
    p90_ms: avg_ms,
    p95_ms: avg_ms,
    p99_ms: avg_ms,
    throughput: 1,
  }
}

describe('buildAggregateRepoWorkbook', () => {
  it('uses Response Time data bars (not solid cell fills) and merged summary values', async () => {
    const rows = [
      tx('AAB_L_Dashboard', 3758, 1132),
      tx('AAE_S_CreateDocument_Submit', 5127, 1120),
      tx('GET /health', 50, 5, 'request'),
    ]
    const run: TestRun = {
      id: 42,
      scenario_id: 1,
      run_type: 'adhoc',
      status: 'completed',
      created_at: '2026-06-27T10:00:00Z',
      started_at: '2026-06-27T10:00:00Z',
      release_name: '11.2026 R2',
      build_name: '42',
      scenario_name: 'Standard DB',
      application_name: 'Doc 2026.R2.24',
    }
    const metrics = {
      active_threads: 100,
      elapsed_seconds: 7200,
      active_users_series: [{ t: 1, users: 100 }],
    } as LiveMetrics

    const workbook = await buildAggregateRepoWorkbook(rows, {
      run,
      metrics,
      config: DEFAULT_AGGREGATE_SUMMARY_CONFIG,
    })
    const sheet = workbook.getWorksheet('Repo Report')
    expect(sheet).toBeTruthy()
    if (!sheet) return

    expect(sheet.getCell('A1').value).toBe('SmartSolve Version')
    expect(sheet.getCell('B1').value).toBe('11.2026 R2 - Build 42')
    expect(sheet.getCell('B1').isMerged).toBe(true)
    expect(sheet.getCell('B1').alignment?.horizontal).toBe('center')

    expect(sheet.getCell('A13').value).toBe('Label')
    expect(sheet.getCell('B13').value).toBe('Samples')
    expect(sheet.getCell('C13').value).toBe('Response Time')

    expect(sheet.getCell('A14').value).toBe('AAB_L_Dashboard')
    expect(sheet.getCell('B14').value).toBe(1132)
    expect(sheet.getCell('C14').value).toBe(3758)
    // No solid fill — data bars are conditional formatting
    expect(sheet.getCell('C14').fill).toBeUndefined()
    expect(sheet.getCell('C15').value).toBe(5127)
    expect(sheet.getCell('C15').fill).toBeUndefined()

    const rules = (sheet as unknown as { conditionalFormattings?: { ref: string; rules: { type: string }[] }[] })
      .conditionalFormattings
    expect(rules?.some((cf) => cf.rules.some((r) => r.type === 'dataBar'))).toBe(true)

    const buf = await workbook.xlsx.writeBuffer()
    expect(buf.byteLength).toBeGreaterThan(1000)
  })

  it('falls back to request rows when no transaction controllers exist', async () => {
    const rows = [tx('GET /health', 50, 5, 'request'), tx('POST /login', 120, 3, 'request')]
    const workbook = await buildAggregateRepoWorkbook(rows, {
      run: null,
      metrics: null,
      config: DEFAULT_AGGREGATE_SUMMARY_CONFIG,
    })
    const sheet = workbook.getWorksheet('Repo Report')
    expect(sheet).toBeTruthy()
    if (!sheet) return
    const labels: string[] = []
    sheet.eachRow((row) => {
      const v = row.getCell(1).value
      if (typeof v === 'string' && (v === 'GET /health' || v === 'POST /login')) labels.push(v)
    })
    expect(labels).toEqual(['GET /health', 'POST /login'])
  })

  it('uses provided tableRows for the Excel body', async () => {
    const all = [tx('Keep', 100, 10), tx('Skip', 200, 10)]
    const workbook = await buildAggregateRepoWorkbook(
      all,
      { run: null, metrics: null, config: DEFAULT_AGGREGATE_SUMMARY_CONFIG },
      [all[0]]
    )
    const sheet = workbook.getWorksheet('Repo Report')
    expect(sheet).toBeTruthy()
    if (!sheet) return
    const labels: string[] = []
    sheet.eachRow((row) => {
      const v = row.getCell(1).value
      if (typeof v === 'string' && (v === 'Keep' || v === 'Skip')) labels.push(v)
    })
    expect(labels).toEqual(['Keep'])
  })
})
