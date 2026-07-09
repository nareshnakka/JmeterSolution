import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import ErrorDetailModal from '../components/ErrorDetailModal'
import JmeterLogConsole from '../components/JmeterLogConsole'
import HostResourceChart from '../components/HostResourceChart'
import {
  ActiveUsersChart,
  ErrorsOverTimeChart,
  ResponseTimeChart,
  ThroughputChart,
} from '../components/live/LiveDashboardCharts'
import { useToast } from '../components/Toast'
import type { ErrorSample, LiveMetrics, TestRun, TransactionMetric, TransactionTotals } from '../types'
import { timelineScaleForSeconds } from '../utils/timeline'
import { computeTransactionTotals, metricToTotals } from '../utils/transactionTotals'
import { filterTransactionsByKind } from '../utils/transactionKind'
import { defaultSortDir, sortTransactions, type AggregateSortField, type SortDir } from '../utils/sortTransactions'
import type { AggregateKindFilter } from '../types'

const DEFAULT_REFRESH_SECONDS = 10

type GraphSeries = { label: string; points: { t: number; avg_ms: number }[] }
type ErrorGraphSeries = { label: string; points: { t: number; errors: number }[] }

function SortableAggregateHeader({
  field,
  label,
  sortField,
  sortDir,
  onSort,
}: {
  field: AggregateSortField
  label: string
  sortField: AggregateSortField
  sortDir: SortDir
  onSort: (field: AggregateSortField) => void
}) {
  const active = sortField === field
  return (
    <th className="compare-sortable" onClick={() => onSort(field)} title="Click to sort">
      {label}
      <span className="compare-sort-indicator">{active ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</span>
    </th>
  )
}

export default function LiveDashboard() {
  const { runId } = useParams()
  const id = Number(runId)
  const toast = useToast()
  const [run, setRun] = useState<TestRun | null>(null)
  const [metrics, setMetrics] = useState<LiveMetrics | null>(null)
  const lastActiveThreadsRef = useRef(0)
  const [stopping, setStopping] = useState(false)
  const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set())
  const [labelFilter, setLabelFilter] = useState('')
  const [kindFilter, setKindFilter] = useState<AggregateKindFilter>('all')
  const [sortField, setSortField] = useState<AggregateSortField>('label')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [graphData, setGraphData] = useState<GraphSeries[]>([])
  const [graphMode, setGraphMode] = useState<'individual' | 'cumulative'>('cumulative')
  const [errorsGraphData, setErrorsGraphData] = useState<ErrorGraphSeries[]>([])
  const [errorsGraphMode, setErrorsGraphMode] = useState<'individual' | 'all'>('all')
  const [errorFilter, setErrorFilter] = useState('')
  const [displayedErrors, setDisplayedErrors] = useState<ErrorSample[]>([])
  const [errorsLoading, setErrorsLoading] = useState(false)
  const [viewingError, setViewingError] = useState<ErrorSample | null>(null)
  const [refreshIntervalSeconds, setRefreshIntervalSeconds] = useState(DEFAULT_REFRESH_SECONDS)
  const [refreshGeneration, setRefreshGeneration] = useState(0)
  const [transactionTotals, setTransactionTotals] = useState<TransactionTotals | null>(null)

  const refreshPollMs = refreshIntervalSeconds * 1000
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const wsConnectedRef = useRef(false)
  const graphIsActiveRef = useRef(true)
  const errorsGraphIsActiveRef = useRef(false)
  const errorSearchRef = useRef('')
  const skipSearchRefreshRef = useRef(true)

  useEffect(() => {
    api.getConfig()
      .then((cfg) => {
        setRefreshIntervalSeconds(
          cfg.live_dashboard_refresh_interval_seconds ?? DEFAULT_REFRESH_SECONDS
        )
      })
      .catch(console.error)
  }, [])

  useEffect(() => {
    api.getTestRun(id).then(setRun).catch(console.error)
  }, [id])

  useEffect(() => {
    lastActiveThreadsRef.current = 0
    setMetrics(null)
    setGraphData([])
    setErrorsGraphData([])
    setDisplayedErrors([])
    setSelectedLabels(new Set())
    setGraphMode('cumulative')
    setErrorsGraphMode('all')
    setErrorFilter('')
    setKindFilter('all')
    setSortField('label')
    setSortDir('asc')
    setRefreshGeneration(0)
    skipSearchRefreshRef.current = true
  }, [id])

  const applyMetrics = useCallback((m: LiveMetrics) => {
    if (m.active_threads > 0) {
      lastActiveThreadsRef.current = m.active_threads
    }
    setMetrics((prev) => {
      if (
        prev &&
        prev.status === m.status &&
        prev.active_threads === m.active_threads &&
        prev.total_samples === m.total_samples &&
        prev.total_errors === m.total_errors &&
        Math.abs(prev.elapsed_seconds - m.elapsed_seconds) < 0.5 &&
        prev.transactions.length === m.transactions.length
      ) {
        return prev
      }
      return m
    })
  }, [])

  const isTerminalStatus = useCallback((status?: string) => {
    return status === 'completed' || status === 'failed' || status === 'cancelled'
  }, [])

  const syncRunRecord = useCallback(async () => {
    try {
      const updated = await api.getTestRun(id)
      setRun(updated)
      return updated
    } catch {
      return null
    }
  }, [id])

  const handleTerminalStatus = useCallback(
    (status: string) => {
      setStopping(false)
      setMetrics((prev) => (prev ? { ...prev, status } : prev))
      setRun((prev) => (prev ? { ...prev, status } : prev))
      void syncRunRecord()
    },
    [syncRunRecord]
  )

  const effectiveErrorSearch = useMemo(
    () => (errorFilter.trim() || labelFilter.trim()),
    [errorFilter, labelFilter]
  )

  useEffect(() => {
    errorSearchRef.current = effectiveErrorSearch
  }, [effectiveErrorSearch])

  const loadGraph = useCallback(async (cumulative: boolean) => {
    const labels = cumulative ? ['ALL'] : Array.from(selectedLabels)
    if (!cumulative && labels.length === 0) return
    setGraphMode(cumulative ? 'cumulative' : 'individual')
    try {
      const data = await api.getGraph(id, labels, cumulative)
      setGraphData(data.series)
    } catch {
      /* graph data may not exist yet */
    }
  }, [id, selectedLabels])

  const loadErrorsGraph = useCallback(async (allLabels: boolean) => {
    const labels = allLabels ? ['ALL'] : Array.from(selectedLabels)
    if (!allLabels && labels.length === 0) return
    setErrorsGraphMode(allLabels ? 'all' : 'individual')
    try {
      const data = await api.getErrorsGraph(id, labels)
      setErrorsGraphData(data.series)
    } catch {
      /* error graph data may not exist yet */
    }
  }, [id, selectedLabels])

  const selectedLabelsKey = useMemo(() => Array.from(selectedLabels).sort().join('\0'), [selectedLabels])
  const graphIsActive = graphMode === 'cumulative' || selectedLabels.size > 0
  const errorsGraphIsActive =
    errorsGraphMode === 'all' ||
    selectedLabels.size > 0 ||
    (metrics?.total_errors ?? 0) > 0

  useEffect(() => {
    graphIsActiveRef.current = graphIsActive
  }, [graphIsActive])

  useEffect(() => {
    errorsGraphIsActiveRef.current = errorsGraphIsActive
  }, [errorsGraphIsActive])

  const refreshDashboard = useCallback(async (options?: { showErrorsLoading?: boolean; skipMetrics?: boolean }) => {
    if (refreshInFlightRef.current) {
      pendingRefreshRef.current = true
      return
    }
    refreshInFlightRef.current = true
    try {
      if (!options?.skipMetrics) {
        try {
          const m = await api.getMetrics(id)
          applyMetrics(m)
          if (isTerminalStatus(m.status)) {
            handleTerminalStatus(m.status)
          }
        } catch {
          /* JTL may not exist yet at test start */
        }
      }

      const secondary: Promise<void>[] = []
      const skipErrorsFetch = wsConnectedRef.current && !errorSearchRef.current

      if (options?.showErrorsLoading) {
        setErrorsLoading(true)
      }
      if (!skipErrorsFetch) {
        secondary.push(
          api.getRunErrors(id, errorSearchRef.current || undefined)
            .then((data) => setDisplayedErrors(data))
            .catch(() => setDisplayedErrors([]))
            .finally(() => {
              if (options?.showErrorsLoading) setErrorsLoading(false)
            })
        )
      } else if (options?.showErrorsLoading) {
        setErrorsLoading(false)
      }

      if (graphIsActiveRef.current) {
        const cumulative = graphMode === 'cumulative'
        const labels = cumulative ? ['ALL'] : Array.from(selectedLabels)
        if (cumulative || labels.length > 0) {
          secondary.push(
            api.getGraph(id, labels, cumulative)
              .then((data) => setGraphData(data.series))
              .catch(() => {})
          )
        }
      }

      if (errorsGraphIsActiveRef.current) {
        const allLabels = errorsGraphMode === 'all'
        const labels = allLabels ? ['ALL'] : Array.from(selectedLabels)
        if (allLabels || labels.length > 0) {
          secondary.push(
            api.getErrorsGraph(id, labels)
              .then((data) => setErrorsGraphData(data.series))
              .catch(() => {})
          )
        }
      }

      await Promise.all(secondary)
      setRefreshGeneration((g) => g + 1)
    } finally {
      refreshInFlightRef.current = false
      if (pendingRefreshRef.current) {
        pendingRefreshRef.current = false
        void refreshDashboard(options)
      }
    }
  }, [id, applyMetrics, graphMode, errorsGraphMode, selectedLabels, handleTerminalStatus, isTerminalStatus])

  const liveStatus = metrics?.status || run?.status
  const pollIntervalMs = refreshPollMs

  useEffect(() => {
    let cancelled = false

    async function tick(showErrorsLoading: boolean) {
      if (cancelled) return
      const skipMetrics = wsConnectedRef.current && !isTerminalStatus(liveStatus)
      await refreshDashboard({ showErrorsLoading, skipMetrics })
    }

    void tick(true)
    const interval = setInterval(() => void tick(false), pollIntervalMs)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [pollIntervalMs, refreshDashboard, liveStatus, isTerminalStatus])

  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/test-runs/${id}`)

    ws.onopen = () => {
      wsConnectedRef.current = true
    }
    ws.onclose = () => {
      wsConnectedRef.current = false
    }

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.type === 'metrics' && msg.data) {
        applyMetrics(msg.data as LiveMetrics)
        if (!errorSearchRef.current && (msg.data as LiveMetrics).errors?.length) {
          setDisplayedErrors((msg.data as LiveMetrics).errors)
        }
        if (isTerminalStatus(msg.data.status)) {
          handleTerminalStatus(msg.data.status)
          void refreshDashboard()
        }
      }
      if (msg.type === 'finished') {
        const status = msg.data?.status as string | undefined
        if (status) {
          handleTerminalStatus(status)
        } else {
          setStopping(false)
        }
        void refreshDashboard()
      }
    }

    return () => ws.close()
  }, [id, applyMetrics, refreshDashboard, handleTerminalStatus, isTerminalStatus])

  useEffect(() => {
    if (graphMode === 'cumulative') {
      void loadGraph(true)
    } else if (selectedLabels.size > 0) {
      void loadGraph(false)
    } else {
      setGraphData([])
    }
  }, [graphMode, selectedLabelsKey, loadGraph])

  useEffect(() => {
    if (errorsGraphMode === 'all') {
      void loadErrorsGraph(true)
    } else if (selectedLabels.size > 0) {
      void loadErrorsGraph(false)
    } else {
      setErrorsGraphData([])
    }
  }, [errorsGraphMode, selectedLabelsKey, loadErrorsGraph])

  useEffect(() => {
    if (skipSearchRefreshRef.current) {
      skipSearchRefreshRef.current = false
      return
    }
    void refreshDashboard({ showErrorsLoading: true })
  }, [effectiveErrorSearch, refreshDashboard])

  const filteredTransactions = useMemo(() => {
    if (!metrics) return []
    let rows = filterTransactionsByKind(metrics.transactions, kindFilter)
    if (!labelFilter) return rows
    const q = labelFilter.toLowerCase()
    return rows.filter((t) => t.label.toLowerCase().includes(q))
  }, [metrics, labelFilter, kindFilter])

  useEffect(() => {
    if (!metrics || filteredTransactions.length === 0) {
      setTransactionTotals(null)
      return
    }
    let cancelled = false
    void api
      .getAggregateTotal(id, kindFilter, labelFilter.trim() || undefined)
      .then((total) => {
        if (!cancelled) setTransactionTotals(metricToTotals(total))
      })
      .catch(() => {
        if (!cancelled) {
          setTransactionTotals(
            computeTransactionTotals(filteredTransactions, metrics.elapsed_seconds)
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [id, metrics, kindFilter, labelFilter, filteredTransactions])

  const sortedTransactions = useMemo(
    () => sortTransactions(filteredTransactions, sortField, sortDir),
    [filteredTransactions, sortField, sortDir]
  )

  const handleAggregateSort = useCallback((field: AggregateSortField) => {
    if (sortField === field) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(defaultSortDir(field))
    }
  }, [sortField])

  const usersChartData = metrics?.active_users_series ?? []
  const throughputChartData = metrics?.throughput_series ?? []

  const elapsedDisplay = useMemo(() => {
    if (!metrics) return '—'
    const scale = timelineScaleForSeconds(metrics.elapsed_seconds)
    return scale.formatWithUnit(metrics.elapsed_seconds)
  }, [metrics])

  const displayActiveThreads =
    metrics && metrics.active_threads > 0
      ? metrics.active_threads
      : lastActiveThreadsRef.current

  const isRunning =
    !stopping &&
    !isTerminalStatus(liveStatus) &&
    (liveStatus === 'running' || liveStatus === 'pending')

  const toggleLabel = useCallback((label: string) => {
    setSelectedLabels((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }, [])

  const selectAll = useCallback(() => {
    if (!metrics) return
    setSelectedLabels(new Set(metrics.transactions.map((t) => t.label)))
  }, [metrics])

  const clearSelection = useCallback(() => {
    setSelectedLabels(new Set())
    if (graphMode !== 'cumulative') {
      setGraphData([])
    }
    if (errorsGraphMode !== 'all') {
      setErrorsGraphData([])
    }
  }, [errorsGraphMode, graphMode])

  async function stopTest() {
    if (!isRunning || stopping) return
    if (!window.confirm('Stop this test run and terminate JMeter?')) return
    setStopping(true)
    try {
      await api.cancelTestRun(id)
      toast.success(`Test run #${id} stopped`)
      const updated = await api.getTestRun(id)
      setRun(updated)
      setMetrics((prev) => (prev ? { ...prev, status: 'cancelled' } : prev))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to stop test')
      setStopping(false)
    }
  }

  return (
    <>
      <div className="breadcrumb">
        <Link to="/runs">Test Runs</Link> / <span>Run #{id}</span>
        {run && (
          <>
            {' '}/ <span>{run.release_name} → {run.build_name} → {run.scenario_name}</span>
          </>
        )}
      </div>
      <div className="dashboard-header">
        <h1 className="page-title dashboard-title">
          Live Dashboard — Run #{id}
          {(metrics || run) && (
            <span
              className={`badge badge-${stopping ? 'cancelled' : liveStatus}`}
              style={{ marginLeft: '0.75rem', verticalAlign: 'middle' }}
            >
              {stopping ? 'stopping…' : liveStatus}
            </span>
          )}
        </h1>
        {isRunning && (
          <button
            type="button"
            className="btn btn-danger dashboard-stop-btn"
            disabled={stopping}
            onClick={stopTest}
          >
            {stopping ? 'Stopping…' : 'Stop Test'}
          </button>
        )}
      </div>

      {metrics && (
        <div className="stat-row">
          <div className="stat"><div className="value">{displayActiveThreads}</div><div className="label">Active Users</div></div>
          <div className="stat"><div className="value">{metrics.total_samples}</div><div className="label">Samples</div></div>
          <div className="stat"><div className="value">{metrics.total_errors}</div><div className="label">Errors</div></div>
          <div className="stat"><div className="value">{elapsedDisplay}</div><div className="label">Elapsed</div></div>
        </div>
      )}

      <div className="grid-2">
        <ActiveUsersChart
          data={usersChartData}
          elapsedSeconds={metrics?.elapsed_seconds}
          refreshIntervalSeconds={refreshIntervalSeconds}
        />
        <ThroughputChart
          data={throughputChartData}
          elapsedSeconds={metrics?.elapsed_seconds}
          refreshIntervalSeconds={refreshIntervalSeconds}
        />
      </div>

      <ResponseTimeChart
          graphData={graphData}
          graphMode={graphMode}
          selectedLabels={selectedLabels}
          refreshIntervalSeconds={refreshIntervalSeconds}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
          onGraphSelected={() => void loadGraph(false)}
          onCumulativeGraph={() => void loadGraph(true)}
      />

      <ErrorsOverTimeChart
        errorsGraphData={errorsGraphData}
        errorsGraphMode={errorsGraphMode}
        selectedLabels={selectedLabels}
        totalErrors={metrics?.total_errors ?? 0}
        refreshIntervalSeconds={refreshIntervalSeconds}
        onAllErrors={() => void loadErrorsGraph(true)}
        onGraphSelectedErrors={() => void loadErrorsGraph(false)}
      />

      <div className="card">
        <h2>Aggregate Report (live)</h2>
        <div className="aggregate-report-filters">
          <div className="aggregate-kind-filters" role="radiogroup" aria-label="Sample type">
            <label className="aggregate-kind-option">
              <input
                type="radio"
                name="aggregate-kind"
                value="transaction"
                checked={kindFilter === 'transaction'}
                onChange={() => setKindFilter('transaction')}
              />
              Transactions
            </label>
            <label className="aggregate-kind-option">
              <input
                type="radio"
                name="aggregate-kind"
                value="request"
                checked={kindFilter === 'request'}
                onChange={() => setKindFilter('request')}
              />
              APIs / Requests
            </label>
            <label className="aggregate-kind-option">
              <input
                type="radio"
                name="aggregate-kind"
                value="all"
                checked={kindFilter === 'all'}
                onChange={() => setKindFilter('all')}
              />
              All
            </label>
          </div>
          <input
            className="aggregate-label-filter"
            placeholder="Filter by label…"
            value={labelFilter}
            onChange={(e) => setLabelFilter(e.target.value)}
          />
        </div>
        <table>
          <thead>
            <tr>
              <th></th>
              <SortableAggregateHeader
                field="label"
                label="Label"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="samples"
                label="# Samples"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="avg_ms"
                label="Avg (ms)"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="min_ms"
                label="Min"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="max_ms"
                label="Max"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="median_ms"
                label="Median"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="p90_ms"
                label="90% Line"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="p95_ms"
                label="95% Line"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="p99_ms"
                label="99% Line"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="error_pct"
                label="Error %"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
              <SortableAggregateHeader
                field="throughput"
                label="Throughput"
                sortField={sortField}
                sortDir={sortDir}
                onSort={handleAggregateSort}
              />
            </tr>
          </thead>
          <tbody>
            {sortedTransactions.map((t: TransactionMetric) => (
              <tr
                key={`${t.label}-${t.kind ?? 'unknown'}`}
                className={selectedLabels.has(t.label) ? 'selected' : ''}
                onClick={() => toggleLabel(t.label)}
                style={{ cursor: 'pointer' }}
              >
                <td><input type="checkbox" checked={selectedLabels.has(t.label)} readOnly /></td>
                <td>{t.label}</td>
                <td>{t.samples}</td>
                <td>{t.avg_ms}</td>
                <td>{t.min_ms}</td>
                <td>{t.max_ms}</td>
                <td>{t.median_ms}</td>
                <td>{t.p90_ms}</td>
                <td>{t.p95_ms}</td>
                <td>{t.p99_ms}</td>
                <td style={{ color: t.error_pct > 0 ? 'var(--danger)' : undefined }}>{t.error_pct}%</td>
                <td>{t.throughput}/s</td>
              </tr>
            ))}
          </tbody>
          {transactionTotals && (
            <tfoot>
              <tr className="aggregate-total-row">
                <td />
                <td><strong>TOTAL</strong></td>
                <td><strong>{transactionTotals.samples}</strong></td>
                <td><strong>{transactionTotals.avg_ms}</strong></td>
                <td><strong>{transactionTotals.min_ms}</strong></td>
                <td><strong>{transactionTotals.max_ms}</strong></td>
                <td><strong>{transactionTotals.median_ms}</strong></td>
                <td><strong>{transactionTotals.p90_ms}</strong></td>
                <td><strong>{transactionTotals.p95_ms}</strong></td>
                <td><strong>{transactionTotals.p99_ms}</strong></td>
                <td style={{ color: transactionTotals.error_pct > 0 ? 'var(--danger)' : undefined }}>
                  <strong>{transactionTotals.error_pct}%</strong>
                </td>
                <td><strong>{transactionTotals.throughput}/s</strong></td>
              </tr>
            </tfoot>
          )}
        </table>
        {metrics && filteredTransactions.length === 0 && (
          <p className="empty">No rows match the current filters</p>
        )}
      </div>

      <div className="card">
        <h2>Errors &amp; Exceptions</h2>
        <div className="filters">
          <input
            placeholder="Search errors (label, code, message, URL, thread)…"
            value={errorFilter}
            onChange={(e) => setErrorFilter(e.target.value)}
          />
        </div>
        {labelFilter.trim() && !errorFilter.trim() && (
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
            Also filtering by transaction search: &quot;{labelFilter.trim()}&quot;
          </p>
        )}
        <div className="error-panel">
          {displayedErrors.length ? displayedErrors.map((e, i) => (
            <div key={`${e.sample_index}-${e.timestamp}-${i}`} className="error-item">
              <div className="error-item-header">
                <div>
                  <strong>{e.label}</strong> [{e.response_code}] {e.response_message}
                </div>
                <button
                  type="button"
                  className="btn btn-secondary error-view-btn"
                  onClick={() => setViewingError(e)}
                >
                  View
                </button>
              </div>
              {e.failure_message && <div>{e.failure_message}</div>}
              {e.url && <div style={{ color: 'var(--muted)' }}>{e.url}</div>}
              <div style={{ color: 'var(--muted)' }}>{e.thread_name}</div>
            </div>
          )) : (
            <p className="empty">
              {errorsLoading
                ? 'Loading errors…'
                : effectiveErrorSearch
                  ? 'No errors match your search'
                  : 'No errors'}
            </p>
          )}
        </div>
        {(metrics?.total_errors ?? 0) > 0 ? (
          <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.5rem' }}>
            Showing {displayedErrors.length} error(s)
            {effectiveErrorSearch ? ` matching "${effectiveErrorSearch}"` : ''}
            {' · '}{metrics?.total_errors ?? 0} total in run
          </p>
        ) : null}
      </div>

      {viewingError && (
        <ErrorDetailModal
          runId={id}
          error={viewingError}
          onClose={() => setViewingError(null)}
        />
      )}

      <JmeterLogConsole
        runId={id}
        isRunning={!isTerminalStatus(liveStatus) && liveStatus === 'running'}
        refreshIntervalMs={refreshPollMs}
        refreshGeneration={refreshGeneration}
      />

      <HostResourceChart
        runId={id}
        isRunning={!isTerminalStatus(liveStatus) && liveStatus === 'running'}
        refreshIntervalMs={refreshPollMs}
        refreshGeneration={refreshGeneration}
      />

      {run?.run_dir && (
        <div className="card">
          <h2>Artifacts</h2>
          <div className="toolbar">
            <a href={api.downloadUrl(id, 'results.jtl')} className="btn btn-secondary">Download JTL</a>
            <a href={api.downloadUrl(id, 'jmeter.log')} className="btn btn-secondary">Download Log</a>
          </div>
          <p style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>
            Server path: {run.run_dir}
          </p>
        </div>
      )}
    </>
  )
}
