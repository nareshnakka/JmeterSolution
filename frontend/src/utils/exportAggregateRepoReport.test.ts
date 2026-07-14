import { describe, expect, it } from 'vitest'
import { buildAggregateRepoReportXml } from './exportAggregateRepoReport'
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

describe('buildAggregateRepoReportXml', () => {
  it('builds compact A/B/C layout with merged centered summary values', () => {
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

    const xml = buildAggregateRepoReportXml(rows, {
      run,
      metrics,
      config: DEFAULT_AGGREGATE_SUMMARY_CONFIG,
    })

    expect(xml).toContain('SmartSolve Version')
    expect(xml).toContain('11.2026 R2 - Build 42')
    expect(xml).toContain('ss:MergeAcross="1"')
    expect(xml).toContain('ss:Horizontal="Center"')
    expect(xml).toContain('Average Response Time')
    expect(xml).toContain('Average Load Response time')
    expect(xml).toContain('Average Submit Response time')
    expect(xml).toContain('AAB_L_Dashboard')
    expect(xml).toContain('AAE_S_CreateDocument_Submit')
    expect(xml).toContain('1132')
    expect(xml).toContain('3758')
    expect(xml).not.toContain('GET /health')
    expect(xml).not.toContain('Doc Records')
    expect(xml).not.toContain('CPU')
    expect(xml).toContain('100 Unique Users')
    expect(xml).toContain('Label')
    expect(xml).toContain('Samples')
    expect(xml).toContain('Response Time')
    // Only three columns declared
    expect(xml).toContain('ss:Index="1"')
    expect(xml).toContain('ss:Index="2"')
    expect(xml).toContain('ss:Index="3"')
    expect(xml).not.toContain('ss:Index="4"')
  })
})
