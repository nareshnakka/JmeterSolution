import { describe, expect, it } from 'vitest'
import {
  computeAggregateSummaryAvgs,
  computeMeanRowAvgMs,
  DEFAULT_AGGREGATE_SUMMARY_CONFIG,
} from './aggregateSummaryAvgs'
import type { TransactionMetric } from '../types'

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

describe('computeMeanRowAvgMs', () => {
  it('returns the arithmetic mean of row Avg (ms) values', () => {
    expect(computeMeanRowAvgMs([tx('A', 100, 1), tx('B', 200, 3)])).toBe(150)
  })

  it('does not weight by sample count', () => {
    expect(computeMeanRowAvgMs([tx('A', 100, 10), tx('B', 200, 1000)])).toBe(150)
  })

  it('returns null when no rows', () => {
    expect(computeMeanRowAvgMs([])).toBeNull()
  })
})

describe('computeAggregateSummaryAvgs', () => {
  it('computes total from all transactions except Login / Log_In labels', () => {
    const rows = [
      tx('Home_L_Page', 100, 10),
      tx('Home_S_Form', 200, 10),
      tx('Other_Transaction', 300, 10),
      tx('AAA_Login_User', 900, 10),
      tx('BBB_Log_In_SSO', 800, 10),
      tx('GET /health', 50, 5, 'request'),
    ]
    const result = computeAggregateSummaryAvgs(rows, DEFAULT_AGGREGATE_SUMMARY_CONFIG)
    expect(result).toHaveLength(3)
    // (100 + 200 + 300) / 3 — login rows and request excluded
    expect(result[0]).toEqual({ title: 'Total Avg', avg_ms: 200 })
    expect(result[1]).toEqual({ title: 'Load Avg', avg_ms: 100 })
    expect(result[2]).toEqual({ title: 'Submit Avg', avg_ms: 200 })
  })

  it('excludes login variants case-insensitively with any prefix/postfix', () => {
    const rows = [
      tx('Step_A', 100, 1),
      tx('PreLOGINPost', 999, 1),
      tx('user_log_in_flow', 888, 1),
      tx('LogIn', 777, 1),
      tx('LOG_IN', 666, 1),
    ]
    const result = computeAggregateSummaryAvgs(rows, DEFAULT_AGGREGATE_SUMMARY_CONFIG)
    expect(result[0].avg_ms).toBe(100)
  })

  it('respects custom load and submit filters; total still uses all tx minus login', () => {
    const rows = [
      tx('LOAD_step', 120, 2),
      tx('SUBMIT_step', 180, 2),
      tx('OTHER_step', 300, 2),
    ]
    const result = computeAggregateSummaryAvgs(rows, {
      ...DEFAULT_AGGREGATE_SUMMARY_CONFIG,
      aggregate_total_avg_title: 'All Tx',
      aggregate_load_avg_title: 'Load Step',
      aggregate_load_avg_filter: 'LOAD',
      aggregate_submit_avg_title: 'Submit Step',
      aggregate_submit_avg_filter: 'SUBMIT',
    })
    expect(result[0].title).toBe('All Tx')
    expect(result[0].avg_ms).toBe(200) // (120+180+300)/3
    expect(result[1].avg_ms).toBe(120)
    expect(result[2].avg_ms).toBe(180)
  })

  it('excludes configured labels from total avg only, and still drops login', () => {
    const rows = [
      tx('Home_L_Page', 100, 10),
      tx('Home_L_Init', 300, 10),
      tx('Home_S_Form', 200, 10),
      tx('AAA_Login', 500, 10),
    ]
    const result = computeAggregateSummaryAvgs(rows, {
      ...DEFAULT_AGGREGATE_SUMMARY_CONFIG,
      aggregate_total_avg_exclude: 'Home_L_Init',
    })
    expect(result[0].avg_ms).toBe(150)
    expect(result[1].avg_ms).toBe(200)
    expect(result[2].avg_ms).toBe(200)
  })

  it('uses total avg filter when set and applies exclusions plus login', () => {
    const rows = [
      tx('Home_L_Page', 100, 10),
      tx('Home_S_Form', 200, 10),
      tx('Home_S_Logout', 400, 10),
      tx('Home_S_Login', 900, 10),
    ]
    const result = computeAggregateSummaryAvgs(rows, {
      ...DEFAULT_AGGREGATE_SUMMARY_CONFIG,
      aggregate_total_avg_filter: '_S_',
      aggregate_total_avg_exclude: 'Logout',
    })
    expect(result[0].avg_ms).toBe(200)
  })
})
