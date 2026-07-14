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
  it('matches Repo sample layout: A labels, F samples/values, G response time', async () => {
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
    expect(sheet.getCell('F1').value).toBe('11.2026 R2 - Build 42')
    expect(sheet.getCell('A2').value).toBe('Date')
    expect(sheet.getCell('F2').value).toBe('6/27/2026')
    expect(sheet.getCell('A3').value).toBe('Scenario')
    expect(sheet.getCell('F3').value).toBe('Standard DB')
    expect(sheet.getCell('A4').value).toBe('')
    expect(sheet.getCell('F4').value).toBe('Doc 2026.R2.24')

    expect(sheet.getCell('A5').value).toBe('Users')
    expect(sheet.getCell('F5').value).toBe('100 Unique Users')
    expect(sheet.getCell('A6').value).toBe('Ramp up duration')
    expect(sheet.getCell('A7').value).toBe('Duration')
    expect(sheet.getCell('F7').value).toBe('2 hours')
    expect(sheet.getCell('A8').value).toBe('Thinktime')
    expect(sheet.getCell('A9').value).toBe('Average Response Time')
    expect(sheet.getCell('A10').value).toBe('Average Load Response time')
    expect(sheet.getCell('A11').value).toBe('Average Submit Response time')
    expect(typeof sheet.getCell('F9').value).toBe('number')
    expect(typeof sheet.getCell('F10').value).toBe('number')
    expect(typeof sheet.getCell('F11').value).toBe('number')

    // Blank row 12, headers on 13
    expect(sheet.getCell('A13').value).toBe('Label')
    expect(sheet.getCell('F13').value).toBe('Samples')
    expect(sheet.getCell('G13').value).toBe('Response Time')

    expect(sheet.getCell('A14').value).toBe('AAB_L_Dashboard')
    expect(sheet.getCell('F14').value).toBe(1132)
    expect(sheet.getCell('G14').value).toBe(3758)
    expect(sheet.getCell('A15').value).toBe('AAE_S_CreateDocument_Submit')
    expect(sheet.getCell('F15').value).toBe(1120)
    expect(sheet.getCell('G15').value).toBe(5127)

    // Requests excluded; ignored fields absent
    const allLabels: string[] = []
    sheet.eachRow((r) => {
      const v = r.getCell(1).value
      if (typeof v === 'string') allLabels.push(v)
    })
    expect(allLabels).not.toContain('GET /health')
    expect(allLabels).not.toContain('Observation')
    expect(allLabels).not.toContain('No. of Doc Records')
  })
})
