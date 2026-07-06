import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../api'
import CompareResultsTable from '../components/CompareResultsTable'
import RunTags from '../components/RunTags'
import TestRunTableFilters from '../components/TestRunTableFilters'
import type { CompareNavigationState, CompareSummary, TestRun, TransactionMetric } from '../types'
import { isComparableTestRun } from '../types'
import {
  EMPTY_RUN_FILTERS,
  filterTestRuns,
  hasActiveRunFilters,
  type TestRunColumnFilters,
} from '../utils/testRunFilters'
import type { CompareRow, RunMetrics } from '../components/CompareResultsTable'

function statusBadge(status: string) {
  return <span className={`badge badge-${status}`}>{status}</span>
}

type SortField = 'transaction' | 'avg_ms' | 'delta' | 'delta_pct'
type SortDir = 'asc' | 'desc'

function metricFor(summary: CompareSummary, label: string): TransactionMetric | undefined {
  return summary.transactions.find((t) => t.label === label)
}

function toRunMetrics(m: TransactionMetric | undefined): RunMetrics {
  if (!m) {
    return { avg_ms: null, p90_ms: null, count: null, error_pct: null }
  }
  return {
    avg_ms: m.avg_ms,
    p90_ms: m.p90_ms,
    count: m.samples,
    error_pct: m.error_pct,
  }
}

export default function ComparePage() {
  const location = useLocation()
  const [runs, setRuns] = useState<TestRun[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [summaries, setSummaries] = useState<CompareSummary[]>([])
  const [runFilters, setRunFilters] = useState<TestRunColumnFilters>(EMPTY_RUN_FILTERS)
  const [transactionFilter, setTransactionFilter] = useState('')
  const [sortField, setSortField] = useState<SortField>('transaction')
  const [sortDir, setSortDir] = useState<SortDir>('asc')

  useEffect(() => {
    api.listTestRuns().then(setRuns).catch(console.error)
  }, [])

  useEffect(() => {
    const state = location.state as CompareNavigationState | null
    if (state?.selectedRunIds?.length) {
      setSelected(new Set(state.selectedRunIds))
      setSummaries([])
    }
  }, [location.state])

  const comparableRuns = useMemo(() => {
    const base = runs.filter((r) => isComparableTestRun(r.status))
    return filterTestRuns(base, runFilters)
  }, [runs, runFilters])

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function compare() {
    const ids = Array.from(selected)
    if (ids.length < 2) {
      alert('Select at least 2 test runs to compare')
      return
    }
    const data = await api.compareRuns(ids)
    setSummaries(data)
    setTransactionFilter('')
    setSortField('transaction')
    setSortDir('asc')
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'transaction' ? 'asc' : 'desc')
    }
  }

  const compareRows = useMemo((): CompareRow[] => {
    if (summaries.length < 2) return []

    const labels = [...new Set(summaries.flatMap((s) => s.transactions.map((t) => t.label)))]

    let rows: CompareRow[] = labels.map((label) => {
      const runMetrics = summaries.map((s) => toRunMetrics(metricFor(s, label)))
      const avg1 = runMetrics[0]?.avg_ms ?? null
      const avg2 = runMetrics[1]?.avg_ms ?? null
      const delta =
        avg1 != null && avg2 != null ? Math.round((avg2 - avg1) * 100) / 100 : null
      const delta_pct =
        avg1 != null && avg2 != null && avg1 !== 0
          ? Math.round(((avg2 - avg1) / avg1) * 10000) / 100
          : null

      return { label, runs: runMetrics, delta, delta_pct }
    })

    if (transactionFilter.trim()) {
      const q = transactionFilter.trim().toLowerCase()
      rows = rows.filter((r) => r.label.toLowerCase().includes(q))
    }

    const dir = sortDir === 'asc' ? 1 : -1
    rows.sort((a, b) => {
      let cmp = 0
      if (sortField === 'transaction') {
        cmp = a.label.localeCompare(b.label)
      } else if (sortField === 'avg_ms') {
        const av = a.runs[0]?.avg_ms
        const bv = b.runs[0]?.avg_ms
        if (av == null && bv == null) cmp = 0
        else if (av == null) cmp = 1
        else if (bv == null) cmp = -1
        else cmp = av < bv ? -1 : av > bv ? 1 : 0
      } else {
        const av = a[sortField]
        const bv = b[sortField]
        if (av == null && bv == null) cmp = 0
        else if (av == null) cmp = 1
        else if (bv == null) cmp = -1
        else cmp = av < bv ? -1 : av > bv ? 1 : 0
      }
      return cmp * dir
    })

    return rows
  }, [summaries, transactionFilter, sortField, sortDir])

  return (
    <>
      <h1 className="page-title">Comparison Dashboard</h1>

      <div className="card">
        <h2>Select Test Runs</h2>
        <p style={{ fontSize: '0.8125rem', color: 'var(--muted)', marginTop: '-0.25rem', marginBottom: '0.75rem' }}>
          Select 2 or more runs in comparison order. First selected run is the baseline for delta (2-run compare).
        </p>
        <div className="table-toolbar">
          <span className="table-toolbar-count">{comparableRuns.length} comparable run(s)</span>
          {hasActiveRunFilters(runFilters) && (
            <button type="button" className="btn btn-secondary" onClick={() => setRunFilters(EMPTY_RUN_FILTERS)}>
              Clear filters
            </button>
          )}
          <button className="btn" onClick={compare} disabled={selected.size < 2}>
            Compare Selected ({selected.size})
          </button>
        </div>
        <div className="table-scroll">
          <table className="table-with-filters">
            <thead>
              <tr>
                <th></th>
                <th>ID</th>
                <th>Release</th>
                <th>Build</th>
                <th>Application</th>
                <th>Scenario</th>
                <th>Tags</th>
                <th>Status</th>
                <th>Finished</th>
              </tr>
              <TestRunTableFilters
                filters={runFilters}
                onChange={setRunFilters}
                showRunType={false}
                showScheduled={false}
                showStarted={false}
                showFinished
              />
            </thead>
            <tbody>
              {comparableRuns.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'selected' : ''} onClick={() => toggle(r.id)} style={{ cursor: 'pointer' }}>
                  <td><input type="checkbox" checked={selected.has(r.id)} readOnly /></td>
                  <td>{r.id}</td>
                  <td>{r.release_name}</td>
                  <td>{r.build_name}</td>
                  <td>{r.application_name ?? '—'}</td>
                  <td>{r.scenario_name}</td>
                  <td><RunTags tags={r.scenario_tags} /></td>
                  <td>{statusBadge(r.status)}</td>
                  <td>{r.finished_at ? new Date(r.finished_at).toLocaleString() : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {comparableRuns.length === 0 && <p className="empty">No comparable test runs found</p>}
      </div>

      {summaries.length >= 2 && (
        <div className="card">
          <h2>Transaction Comparison</h2>
          <div className="table-toolbar">
            <span className="table-toolbar-count">
              {compareRows.length} transaction{compareRows.length !== 1 ? 's' : ''} · {summaries.length} test runs
            </span>
          </div>
          <CompareResultsTable
            summaries={summaries}
            rows={compareRows}
            transactionFilter={transactionFilter}
            onTransactionFilterChange={setTransactionFilter}
            sortField={sortField}
            sortDir={sortDir}
            onSort={handleSort}
          />
          {compareRows.length === 0 && <p className="empty">No transactions match the filter</p>}
        </div>
      )}
    </>
  )
}
